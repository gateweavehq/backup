import { introspectWorkflowInstance, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
	dumpSqlite,
	fromUtf8,
	generateMasterKey,
	joinLines,
	Repository,
	restoreSql,
	splitLines,
	utf8,
} from "@gateweave/backup-core";
import { beforeEach, describe, expect, it } from "vitest";
import { d1Reader, R2Store } from "../src/bindings";
import { testerFor, testInterval } from "../src/restore-test";
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
	// In one transaction with foreign keys checked at its end, so the order of the tables is no matter.
	// An FTS5 table's own tables go with it, hence IF EXISTS.
	await db.batch([
		db.prepare("PRAGMA defer_foreign_keys = on"),
		...tables.results.map(({ name }) => db.prepare(`DROP TABLE IF EXISTS "${name}"`)),
	]);
}

beforeEach(async () => {
	await clear(env.SOURCE_DB);
	await clear(env.RESTORE_DB);
	await env.CATALOG.batch([
		env.CATALOG.prepare("DELETE FROM run"),
		env.CATALOG.prepare("DELETE FROM snapshot"),
		env.CATALOG.prepare("DELETE FROM lock"),
		env.CATALOG.prepare("DELETE FROM restore_test"),
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

type Instance = Awaited<ReturnType<typeof introspectWorkflowInstance>>;
type Modifier = Parameters<Parameters<Instance["modify"]>[0]>[0];

/** Runs the Workflow to its end and says how it ended. */
async function backUp(id: string, params?: BackupParams, change?: (m: Modifier) => Promise<void>) {
	await using instance = await introspectWorkflowInstance(env.BACKUP, id);
	await instance.modify(async (m) => {
		await m.disableRetryDelays();
		await change?.(m);
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
			output: [
				{
					source: "app",
					status: "ok",
					snapshot: expect.stringMatching(/^\d{8}T/),
					test: "passed",
				},
			],
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

	it("restores a row longer than D1 takes in one statement", async () => {
		await env.SOURCE_DB.batch([
			env.SOURCE_DB.prepare("CREATE TABLE page (id INTEGER PRIMARY KEY, body TEXT, data BLOB)"),
			env.SOURCE_DB.prepare("INSERT INTO page VALUES (1, ?1, ?2)").bind(
				`'quoted' ${"wiki 📚 ".repeat(25_000)}`,
				Uint8Array.from({ length: 120_000 }, (_, i) => i % 256),
			),
		]);
		const result = await backUp("long", { sources: ["app"] });
		expect(result).toMatchObject({ ended: "complete", output: [{ test: "passed" }] });

		const repo = await repository();
		const [name] = await repo.snapshots();
		await restore(repo, name ?? "");
		const page = "SELECT id, body, hex(data) AS data FROM page";
		expect((await env.RESTORE_DB.prepare(page).all()).results).toEqual(
			(await env.SOURCE_DB.prepare(page).all()).results,
		);
		expect((await env.RESTORE_DB.prepare(PEOPLE_QUERY).all()).results).toHaveLength(3);
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

/** A schema with what a restore must get right: foreign keys, AUTOINCREMENT, FTS5 and a trigger. */
async function addTeams() {
	await env.SOURCE_DB.batch(
		[
			"CREATE TABLE team (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)",
			"CREATE TABLE member (team INTEGER NOT NULL REFERENCES team (id), person INTEGER NOT NULL REFERENCES person (id), PRIMARY KEY (team, person))",
			"CREATE VIRTUAL TABLE person_search USING fts5 (email, note, content = 'person', content_rowid = 'id')",
			"CREATE TRIGGER person_added AFTER INSERT ON person BEGIN INSERT INTO person_search (rowid, email, note) VALUES (new.id, new.email, new.note); END",
			"INSERT INTO team (name) VALUES ('core'), ('docs')",
			"INSERT INTO member (team, person) VALUES (1, 1), (1, 2), (2, 3)",
			"INSERT INTO person_search (person_search) VALUES ('rebuild')",
		].map((sql) => env.SOURCE_DB.prepare(sql)),
	);
}

async function tests() {
	return (await env.CATALOG.prepare("SELECT * FROM restore_test ORDER BY tested_at, run").all())
		.results;
}

/** The tables in a restore test object's own database, which must stay empty. */
async function testerTables(source: string) {
	return runInDurableObject(testerFor(env, source), (_, state) =>
		state.storage.sql
			.exec<{ name: string }>("SELECT name FROM sqlite_master")
			.toArray()
			.map((row) => row.name)
			.filter((name) => !name.startsWith("_cf_") && !name.startsWith("__cf_")),
	);
}

/** A repository for `source` holding one snapshot of `lines`, as a backup would write it. */
async function commitDump(source: string, lines: string[]) {
	const repo = await Repository.init(new R2Store(env.VAULT, `${source}/`), env.BACKUP_KEY);
	const { entry } = await repo.writeFile("database.jsonl", utf8(joinLines(lines)));
	return (await repo.commit({ kind: "d1", name: source }, [entry], {})).name;
}

describe("restore tests", () => {
	it("restore a source's first snapshot, count it, and keep none of it", async () => {
		await addTeams();
		const result = await backUp("tested", { sources: ["app"] });
		expect(result).toMatchObject({ ended: "complete", output: [{ test: "passed" }] });
		const [snapshot] = await (await repository()).snapshots();
		expect(await tests()).toEqual([
			expect.objectContaining({
				run: "tested/app",
				source: "app",
				snapshot,
				status: "passed",
				table_count: 4,
				row_count: 8,
				size: expect.any(Number),
				error: null,
			}),
		]);
		expect(await testerTables("app")).toEqual([]);
	});

	it("clear away what a test that stopped half way left", async () => {
		await runInDurableObject(testerFor(env, "app"), (_, state) => {
			state.storage.sql.exec("CREATE TABLE person (id INTEGER PRIMARY KEY)");
		});
		const result = await backUp("after-a-stop", { sources: ["app"] });
		expect(result).toMatchObject({ ended: "complete", output: [{ test: "passed" }] });
		expect(await testerTables("app")).toEqual([]);
	});

	it("come round again when the last one that passed is RESTORE_TEST_DAYS old", async () => {
		await backUp("first-night", { sources: ["app"] });
		const second = await backUp("second-night", { sources: ["app"] });
		expect(second).toEqual({
			ended: "complete",
			output: [expect.not.objectContaining({ test: expect.anything() })],
		});
		expect(await tests()).toHaveLength(1);

		const days = testInterval(env.RESTORE_TEST_DAYS);
		const hour = 60 * 60 * 1000;
		const passedAgo = (ms: number) =>
			env.CATALOG.prepare("UPDATE restore_test SET tested_at = ?1")
				.bind(Date.now() - ms)
				.run();
		await passedAgo((days * 24 - 13) * hour);
		await backUp("not-yet", { sources: ["app"] });
		expect(await tests()).toHaveLength(1);

		// Half a day early, so a nightly run that reaches the test a little sooner doesn't wait a night.
		await passedAgo((days * 24 - 11) * hour);
		const third = await backUp("a-month-on", { sources: ["app"] });
		expect(third).toMatchObject({ ended: "complete", output: [{ test: "passed" }] });
		expect(await tests()).toHaveLength(2);
	});

	it("run whenever a run asks for one", async () => {
		await backUp("first", { sources: ["app"] });
		await backUp("asked", { sources: ["app"], test: true });
		expect((await tests()).map((t) => t.run)).toEqual(["first/app", "asked/app"]);
	});

	it("fail the run when one fails, and keep the backup, the catalog and the lock right", async () => {
		const result = await backUp("unlucky", { sources: ["app"] }, (m) =>
			m.mockStepError(
				{ name: "app: restore test" },
				new Error("Chunk abc of database.jsonl is missing."),
			),
		);
		expect(result.ended).toBe("errored");
		expect(result.error?.message).toBe("The restore test of app failed. The catalog says why.");
		expect(await runs()).toEqual([expect.objectContaining({ status: "ok", error: null })]);
		expect(await tests()).toEqual([
			expect.objectContaining({
				status: "failed",
				error: "Chunk abc of database.jsonl is missing.",
				row_count: 0,
			}),
		]);
		expect((await env.CATALOG.prepare("SELECT * FROM lock").all()).results).toEqual([]);
		expect(await (await repository()).snapshots()).toHaveLength(1);

		// A failed test is due again the next night.
		expect((await backUp("next-night", { sources: ["app"] })).output).toEqual([
			expect.objectContaining({ test: "passed" }),
		]);
	});

	it("fail a snapshot whose chunk was changed", async () => {
		await backUp("made", { sources: ["app"] });
		const [snapshot] = await (await repository()).snapshots();
		const chunks = await env.VAULT.list({ prefix: "app/data/" });
		const [chunk] = chunks.objects;
		if (!snapshot || !chunk) throw new Error("The backup made nothing.");
		await env.VAULT.put(chunk.key, new Uint8Array(64));

		const test = await testerFor(env, "app").restore("app", snapshot);
		expect(test).toMatchObject({ passed: false, rows: 0 });
		expect(test.error).toMatch(
			/could not be opened: the key is wrong, or the object was changed\.$/,
		);
	});

	it("fail a dump whose rows point to rows that aren't there, naming only the table", async () => {
		await addTeams();
		const { lines } = await dumpSqlite(d1Reader(env.SOURCE_DB));
		// Without its first team, two members point nowhere.
		const team = lines.findIndex((line) => line.startsWith('{"k":"row","t":"team"'));
		expect(team).toBeGreaterThan(0);
		const ended = (line: string) =>
			line.replace(/"rows":(\d+)/, (_, n: string) => `"rows":${Number(n) - 1}`);
		const broken = lines
			.filter((_, index) => index !== team)
			.map((line) => (line.startsWith('{"k":"end"') ? ended(line) : line));
		const snapshot = await commitDump("crafted", broken);

		const test = await testerFor(env, "crafted").restore("crafted", snapshot);
		expect(test).toEqual({
			source: "crafted",
			snapshot,
			passed: false,
			tables: 0,
			rows: 0,
			size: expect.any(Number),
			error: "2 rows point to rows that aren't there, the first in member.",
		});
		expect(await testerTables("crafted")).toEqual([]);
	});

	it("take one at a time, so a second try of a step doesn't trip over the first", async () => {
		await addTeams();
		await backUp("made", { sources: ["app"] });
		const [snapshot] = await (await repository()).snapshots();
		const tester = testerFor(env, "app");
		const both = await Promise.all([
			tester.restore("app", snapshot ?? ""),
			tester.restore("app", snapshot ?? ""),
		]);
		expect(both.map((test) => test.error ?? "passed")).toEqual(["passed", "passed"]);
	});

	it("fail a row SQLite refuses, naming the table and column but no value", async () => {
		const { lines } = await dumpSqlite(d1Reader(env.SOURCE_DB));
		const person = lines.find((line) => line.startsWith('{"k":"row","t":"person"')) ?? "";
		const at = lines.indexOf(person);
		const ended = (line: string) =>
			line.replace(/"rows":(\d+)/, (_, n: string) => `"rows":${Number(n) + 1}`);
		const twice = [...lines.slice(0, at), person, ...lines.slice(at)].map((line) =>
			line.startsWith('{"k":"end"') ? ended(line) : line,
		);
		const snapshot = await commitDump("twice", twice);

		const test = await testerFor(env, "twice").restore("twice", snapshot);
		expect(test.error).toMatch(
			/^INSERT INTO "person" failed: UNIQUE constraint failed: person\.id/,
		);
		expect(test.error).not.toContain("example.com");
		expect(await testerTables("twice")).toEqual([]);
	});

	it("fail a dump that stops before its end", async () => {
		const { lines } = await dumpSqlite(d1Reader(env.SOURCE_DB));
		const snapshot = await commitDump("cut", lines.slice(0, -1));
		const test = await testerFor(env, "cut").restore("cut", snapshot);
		expect(test.error).toBe("The dump stops before its end: it is incomplete.");
		expect(await testerTables("cut")).toEqual([]);
	});

	it("read RESTORE_TEST_DAYS as whole days", () => {
		expect(testInterval(undefined)).toBe(30);
		expect(testInterval("")).toBe(30);
		expect(testInterval("7")).toBe(7);
		for (const bad of ["0", "1.5", "a week", "400"]) {
			expect(() => testInterval(bad), bad).toThrow("RESTORE_TEST_DAYS must be");
		}
	});
});

describe("the Worker", () => {
	it("answers no requests", async () => {
		const response = await exports.default.fetch("https://backup.example/");
		expect(response.status).toBe(404);
	});
});
