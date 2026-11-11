import { introspectWorkflowInstance } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
	fromUtf8,
	generateMasterKey,
	Repository,
	restoreSql,
	splitLines,
} from "@gateweave/backup-core";
import { beforeEach, describe, expect, it } from "vitest";
import { R2Store } from "../src/bindings";
import type { BackupParams } from "../src/workflow";

const PEOPLE = [
	"INSERT INTO person (id, email, note, big, avatar) VALUES (1, 'ada@example.com', 'first line\nsecond', 9007199254740993, X'00ff10')",
	"INSERT INTO person (id, email, note, big, avatar) VALUES (2, 'grace@example.com', 'Grüße, 🙂', NULL, NULL)",
	"INSERT INTO person (id, email, note, big, avatar) VALUES (3, 'linus@example.com', '', -1, X'')",
];

async function clear(db: D1Database) {
	const tables = await db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'",
		)
		.all<{ name: string }>();
	for (const { name } of tables.results) await db.prepare(`DROP TABLE "${name}"`).run();
}

beforeEach(async () => {
	await clear(env.SOURCE_DB);
	await clear(env.RESTORE_DB);
	await env.CATALOG.batch([
		env.CATALOG.prepare("DELETE FROM run"),
		env.CATALOG.prepare("DELETE FROM snapshot"),
		env.CATALOG.prepare("DELETE FROM lock"),
	]);
	const listed = await env.VAULT.list();
	if (listed.objects.length > 0) await env.VAULT.delete(listed.objects.map((o) => o.key));
	await env.SOURCE_DB.batch([
		env.SOURCE_DB.prepare(
			"CREATE TABLE person (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, note TEXT, big INTEGER, avatar BLOB)",
		),
		...PEOPLE.map((sql) => env.SOURCE_DB.prepare(sql)),
	]);
});

/** Runs the Workflow to its end and says how it ended. */
async function backUp(id: string, params?: BackupParams) {
	await using instance = await introspectWorkflowInstance(env.BACKUP, id);
	await instance.modify(async (m) => {
		await m.disableRetryDelays();
	});
	await env.BACKUP.create({ id, params });
	// The wait that loses the race is rejected when the instance is disposed.
	const ended = await Promise.race([
		instance.waitForStatus("complete").then(
			() => "complete" as const,
			() => new Promise<never>(() => {}),
		),
		instance.waitForStatus("errored").then(
			() => "errored" as const,
			() => new Promise<never>(() => {}),
		),
	]);
	if (ended === "complete") return { ended, output: await instance.getOutput() };
	return { ended, error: await instance.getError() };
}

async function repository(source = "app") {
	return Repository.open(new R2Store(env.VAULT, `${source}/`), env.BACKUP_KEY);
}

/** Restores the snapshot into RESTORE_DB, as one batch, which rolls back if any of it fails. */
async function restore(repo: Repository, name: string) {
	const [file] = (await repo.manifest(name)).files;
	if (!file) throw new Error("The snapshot has no file.");
	const lines = splitLines(fromUtf8(await repo.readWholeFile(file)));
	const statements = [...restoreSql(lines)];
	await env.RESTORE_DB.batch(statements.map((sql) => env.RESTORE_DB.prepare(sql)));
}

const PEOPLE_QUERY =
	"SELECT id, email, note, quote(big) AS big, hex(avatar) AS avatar FROM person ORDER BY id";

async function runs() {
	return (await env.CATALOG.prepare("SELECT * FROM run ORDER BY started_at, id").all()).results;
}

describe("a backup run", () => {
	it("makes a snapshot that restores to the same rows", async () => {
		const result = await backUp("first", { sources: ["app"] });
		expect(result).toEqual({
			ended: "complete",
			output: [{ source: "app", status: "ok", snapshot: expect.stringMatching(/^\d{8}T/) }],
		});

		const repo = await repository();
		const [name] = await repo.snapshots();
		if (!name) throw new Error("No snapshot was made.");
		const manifest = await repo.manifest(name);
		expect(manifest.source).toEqual({ kind: "d1", name: "app" });
		expect(manifest.meta).toEqual({ tables: 1, rows: 3, empty: [] });

		await restore(repo, name);
		const original = await env.SOURCE_DB.prepare(PEOPLE_QUERY).all();
		const restored = await env.RESTORE_DB.prepare(PEOPLE_QUERY).all();
		expect(restored.results).toEqual(original.results);
		expect(restored.results[0]).toMatchObject({
			big: "9007199254740993",
			note: "first line\nsecond",
		});

		expect(await runs()).toEqual([
			expect.objectContaining({
				id: "first/app",
				status: "ok",
				snapshot: name,
				table_count: 1,
				row_count: 3,
				forgotten: 0,
				error: null,
			}),
		]);
		const snapshots = await env.CATALOG.prepare("SELECT * FROM snapshot").all();
		expect(snapshots.results).toEqual([
			expect.objectContaining({ source: "app", name, row_count: 3, forgotten_at: null }),
		]);
		expect((await env.CATALOG.prepare("SELECT * FROM lock").all()).results).toEqual([]);
	});

	it("leaves nothing readable in the bucket", async () => {
		await backUp("sealed", { sources: ["app"] });
		const listed = await env.VAULT.list({ prefix: "app/" });
		expect(listed.objects.length).toBeGreaterThan(2);
		for (const { key } of listed.objects) {
			const text = await (await env.VAULT.get(key))?.text();
			expect(text, key).not.toContain("example.com");
		}
	});

	it("keeps the day's newest snapshot, and lets go of what only an older one used", async () => {
		await backUp("one", { sources: ["app"] });
		const [first] = await (await repository()).snapshots();
		await env.SOURCE_DB.prepare("UPDATE person SET note = 'changed' WHERE id = 2").run();
		await backUp("two", { sources: ["app"] });

		const repo = await repository();
		const names = await repo.snapshots();
		expect(names).toHaveLength(1);
		expect(names[0]).not.toBe(first);
		await restore(repo, names[0] ?? "");
		const note = await env.RESTORE_DB.prepare("SELECT note FROM person WHERE id = 2").first("note");
		expect(note).toBe("changed");

		// The database fits in one chunk, so the first snapshot's chunk was its own.
		const [, second] = await runs();
		expect(second).toMatchObject({
			status: "ok",
			forgotten: 1,
			held_snapshots: 0,
			deleted_chunks: 1,
			held_chunks: 0,
		});
		const forgotten = await env.CATALOG.prepare("SELECT forgotten_at FROM snapshot WHERE name = ?1")
			.bind(first ?? "")
			.first("forgotten_at");
		expect(forgotten).toEqual(expect.any(Number));
	});

	it("backs up every source when none are named, and fails at the end if one did", async () => {
		const result = await backUp("all");
		expect(result.ended).toBe("errored");
		expect(result.error?.message).toContain("The backup of broken failed.");
		const [app, broken] = await runs().then((rows) =>
			[...rows].sort((a, b) => String(a.source).localeCompare(String(b.source))),
		);
		expect(app).toMatchObject({ source: "app", status: "ok" });
		expect(broken).toMatchObject({
			source: "broken",
			status: "failed",
			snapshot: null,
			error: "Source broken's binding VAULT isn't a D1 database.",
		});
		expect(await (await repository()).snapshots()).toHaveLength(1);
	});

	it("fails a repository the key doesn't open, and leaves it as it was", async () => {
		const store = new R2Store(env.VAULT, "app/");
		await Repository.init(store, generateMasterKey());
		const before = await env.VAULT.list({ prefix: "app/" });

		const result = await backUp("wrong-key", { sources: ["app"] });
		expect(result.ended).toBe("errored");
		expect(await runs()).toEqual([
			expect.objectContaining({
				status: "failed",
				error: "app: That key doesn't open this repository.",
			}),
		]);
		const after = await env.VAULT.list({ prefix: "app/" });
		expect(after.objects.map((o) => o.key)).toEqual(before.objects.map((o) => o.key));
		expect((await env.CATALOG.prepare("SELECT * FROM lock").all()).results).toEqual([]);
	});

	it("leaves alone a source another run is backing up", async () => {
		const until = Date.now() + 3_600_000;
		await env.CATALOG.prepare(
			"INSERT INTO lock (source, holder, until) VALUES ('app', 'other', ?1)",
		)
			.bind(until)
			.run();
		const result = await backUp("second-in-line", { sources: ["app"] });
		expect(result.ended).toBe("errored");
		expect(await runs()).toEqual([
			expect.objectContaining({ status: "failed", error: "Another run is backing up app." }),
		]);
		expect(await env.CATALOG.prepare("SELECT holder, until FROM lock").first()).toEqual({
			holder: "other",
			until,
		});
		expect((await env.VAULT.list({ prefix: "app/" })).objects).toEqual([]);
	});

	it("takes over a lock whose run died", async () => {
		await env.CATALOG.prepare(
			"INSERT INTO lock (source, holder, until) VALUES ('app', 'gone', 1)",
		).run();
		expect((await backUp("after-a-crash", { sources: ["app"] })).ended).toBe("complete");
	});

	it("refuses a source it doesn't have", async () => {
		const result = await backUp("unknown", { sources: ["nope"] });
		expect(result.ended).toBe("errored");
		expect(result.error?.message).toContain("There is no source named nope.");
		expect(await runs()).toEqual([]);
	});
});

describe("the Worker", () => {
	it("answers no requests", async () => {
		const response = await exports.default.fetch("https://backup.example/");
		expect(response.status).toBe(404);
	});
});
