import {
	createScheduledController,
	introspectWorkflowInstance,
	runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
	type BucketObject,
	type ChunkerParams,
	concat,
	deriveKeys,
	dumpSqlite,
	fromHex,
	fromUtf8,
	generateMasterKey,
	joinLines,
	type ObjectStore,
	parseMasterKey,
	Repository,
	readBucketIndex,
	restoreSql,
	seal,
	splitLines,
	toBase64Url,
	utf8,
	writeBucketIndex,
} from "@gateweave/backup-core";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src";
import { when } from "../src/alert-message";
import {
	type Alert,
	checkBackups,
	deliver,
	destinationsOf,
	lateAlert,
	runAlert,
} from "../src/alerts";
import {
	type BackupService,
	d1Reader,
	describeObject,
	objectReader,
	R2Store,
} from "../src/bindings";
import { CopyConfigError, copyNew, copyTarget } from "../src/copy";
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
		env.CATALOG.prepare("DELETE FROM alert"),
		env.CATALOG.prepare("DELETE FROM copy"),
	]);
	await offsite("/__reset", "");
	for (const bucket of [env.VAULT, env.FILES]) {
		let listed = await bucket.list();
		while (listed.objects.length > 0) {
			await bucket.delete(listed.objects.map((o) => o.key));
			listed = await bucket.list();
		}
	}
	await env.APP_SEED.clear();
	await env.SOURCE_DB.batch([
		env.SOURCE_DB.prepare(
			"CREATE TABLE person (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, note TEXT, big INTEGER, avatar BLOB)",
		),
		...PEOPLE.map((sql) => env.SOURCE_DB.prepare(sql)),
	]);
});

/**
 * Drives the stand-in for the bucket at another provider (test/s3-worker.js), which every fetch
 * reaches: a GET says what it holds and how many PUTs it took, a POST changes how it answers.
 */
async function offsite(path: string, body?: string): Promise<{ keys: string[]; puts: number }> {
	if (body === undefined) return (await fetch(`https://copy.test${path}`)).json();
	await fetch(`https://copy.test${path}`, { method: "POST", body });
	return { keys: [], puts: 0 };
}

/** A source's repository in the copy outside Cloudflare, as the Worker reaches it. */
function copyOf(source = "app"): ObjectStore {
	const target = copyTarget(env);
	if (!target) throw new Error("COPY_TO names no bucket.");
	return target.storeFor(source);
}

async function keysOf(store: ObjectStore): Promise<string[]> {
	const keys: string[] = [];
	for await (const key of store.list("")) keys.push(key);
	return keys.sort();
}

async function copies() {
	return (await env.CATALOG.prepare("SELECT * FROM copy ORDER BY copied_at, run").all()).results;
}

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

/**
 * Restores the snapshot's dump, or the one at `path`, into RESTORE_DB, as one batch, which rolls
 * back if any of it fails.
 */
async function restore(repo: Repository, name: string, path?: string) {
	const { files } = await repo.manifest(name);
	const file = path === undefined ? files[0] : files.find((entry) => entry.path === path);
	if (!file) throw new Error("The snapshot has no such file.");
	const lines = splitLines(fromUtf8(await repo.readWholeFile(file)));
	const statements = [...restoreSql(lines)];
	await env.RESTORE_DB.batch(statements.map((sql) => env.RESTORE_DB.prepare(sql)));
}

const PEOPLE_QUERY =
	"SELECT id, email, note, quote(big) AS big, hex(avatar) AS avatar FROM person ORDER BY id";

async function runs() {
	return (await env.CATALOG.prepare("SELECT * FROM run ORDER BY started_at, id").all()).results;
}

async function alerts() {
	return (await env.CATALOG.prepare("SELECT * FROM alert ORDER BY made_at, key").all()).results;
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
					copy: "ok",
				},
			],
		});

		expect(await alerts()).toEqual([]);

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

		// With nowhere to send it set up, the alert is kept, and noted as gone nowhere.
		const [alert] = await alerts();
		expect(alert).toEqual({
			key: "run:all",
			made_at: expect.any(Number),
			subject: "Gateweave Backup: the backup of broken failed",
			text: expect.any(String),
			html: expect.stringMatching(/^<!doctype html>/),
			sent_to: "",
			sent_at: expect.any(Number),
			error: null,
		});
		expect(String(alert?.text).split("\n")).toEqual([
			"The backup of broken failed.",
			expect.stringMatching(/^Backup run · \d{1,2} [A-Z][a-z]{2} \d{4}, \d\d:\d\d UTC$/),
			"",
			"app       Backed up",
			expect.stringMatching(
				/^ {10}Snapshot \d{8}T\S+, restored and counted by a restore test, and copied outside Cloudflare\.$/,
			),
			"broken    Failed",
			"          The backup failed. The snapshots made before it stay.",
			"          Source broken's binding VAULT isn't a D1 database.",
			"objects   Backed up",
			expect.stringMatching(
				/^ {10}Snapshot \d{8}T\S+, restored and counted by a restore test, and copied outside Cloudflare\.$/,
			),
			"files     Backed up",
			expect.stringMatching(
				/^ {10}Snapshot \d{8}T\S+, restored and counted by a restore test, and copied outside Cloudflare\.$/,
			),
			"",
			"The catalog's run, restore_test and copy tables have the details, under this run's id:",
			"  all",
			"",
			"--",
			expect.stringContaining("runs in your own Cloudflare account"),
			"",
		]);
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
const NOTES = [
	"CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT NOT NULL)",
	"CREATE TABLE tag (note INTEGER NOT NULL REFERENCES note (id), name TEXT NOT NULL)",
];
const NOTES_QUERY = "SELECT id, body FROM note ORDER BY id";

/** Three objects in the stand-in app: more than a page of its list. */
async function addObjects() {
	await env.APP_SEED.add("alpha", [
		...NOTES,
		"INSERT INTO note VALUES (1, 'first'), (2, 'it''s second')",
		"INSERT INTO tag VALUES (1, 'a')",
	]);
	await env.APP_SEED.add("beta", [...NOTES, "INSERT INTO note VALUES (1, 'only')"]);
	await env.APP_SEED.add("gamma.v2", NOTES);
}

describe("a database too large for one read", () => {
	it("is read a page at a time, through D1 and an app's entrypoint, to the same dump", async () => {
		await env.SOURCE_DB.batch(
			Array.from({ length: 50 }, (_, i) =>
				env.SOURCE_DB.prepare("INSERT INTO person (id, email, note) VALUES (?1, ?2, ?3)").bind(
					100 + i,
					`p${i}@example.com`,
					"ğüş 🙂 ".repeat(i),
				),
			),
		);
		const whole = await dumpSqlite(d1Reader(env.SOURCE_DB));
		const paged = await dumpSqlite(d1Reader(env.SOURCE_DB), { pageChars: 500 });
		expect(paged.lines).toEqual(whole.lines);
		expect(paged.stats).toEqual(whole.stats);

		const notes = Array.from({ length: 40 }, (_, i) => `(${i + 1}, 'note ${"x".repeat(i)}')`);
		await env.APP_SEED.add("big", [...NOTES, `INSERT INTO note VALUES ${notes.join(", ")}`]);
		const app = (env as unknown as { APP: BackupService }).APP;
		const object = await dumpSqlite(objectReader(app, "big"));
		const pages = await dumpSqlite(objectReader(app, "big"), { pageChars: 300 });
		expect(pages.lines).toEqual(object.lines);
		expect(pages.stats).toEqual({ ...object.stats, consistent: true });
		expect(object.stats.rows).toBe(40);
	});
});

describe("an app's Durable Objects", () => {
	it("go into one snapshot, a dump each, and each restores to the same rows", async () => {
		await addObjects();
		const result = await backUp("dos", { sources: ["objects"] });
		expect(result).toEqual({
			ended: "complete",
			output: [
				{
					source: "objects",
					status: "ok",
					snapshot: expect.stringMatching(/^\d{8}T/),
					test: "passed",
					copy: "ok",
				},
			],
		});

		const repo = await repository("objects");
		const [name] = await repo.snapshots();
		if (!name) throw new Error("No snapshot was made.");
		const manifest = await repo.manifest(name);
		expect(manifest.source).toEqual({ kind: "do", name: "objects" });
		expect(manifest.files.map((entry) => entry.path)).toEqual([
			"objects/alpha.jsonl",
			"objects/beta.jsonl",
			"objects/gamma.v2.jsonl",
		]);
		expect(manifest.meta).toEqual({
			objects: 3,
			tables: 6,
			rows: 4,
			empty: [],
		});

		await restore(repo, name, "objects/alpha.jsonl");
		expect((await env.RESTORE_DB.prepare(NOTES_QUERY).all()).results).toEqual([
			{ id: 1, body: "first" },
			{ id: 2, body: "it's second" },
		]);
		await clear(env.RESTORE_DB);
		await restore(repo, name, "objects/beta.jsonl");
		expect((await env.RESTORE_DB.prepare(NOTES_QUERY).all()).results).toEqual([
			{ id: 1, body: "only" },
		]);

		expect(await runs()).toEqual([
			expect.objectContaining({
				id: "dos/objects",
				status: "ok",
				snapshot: name,
				table_count: 6,
				row_count: 4,
				error: null,
			}),
		]);
		expect(await tests()).toEqual([
			expect.objectContaining({
				run: "dos/objects",
				status: "passed",
				table_count: 6,
				row_count: 4,
				error: null,
			}),
		]);
		expect(await testerTables("objects")).toEqual([]);
	});

	it("write only what changed since the last snapshot", async () => {
		await addObjects();
		await backUp("before", { sources: ["objects"] });
		await env.APP_SEED.add("beta", [...NOTES, "INSERT INTO note VALUES (1, 'changed')"]);
		await backUp("after", { sources: ["objects"] });

		const [before, after] = await runs();
		expect(Number(before?.new_bytes)).toBeGreaterThan(0);
		// Only beta's dump is new, and it is smaller than all three.
		expect(Number(after?.new_bytes)).toBeGreaterThan(0);
		expect(Number(after?.new_bytes)).toBeLessThan(Number(before?.new_bytes));
		const repo = await repository("objects");
		const [name] = await repo.snapshots();
		await restore(repo, name ?? "", "objects/beta.jsonl");
		expect((await env.RESTORE_DB.prepare(NOTES_QUERY).all()).results).toEqual([
			{ id: 1, body: "changed" },
		]);
	});

	it("leave out one deleted after the list was made, however many steps they take", async () => {
		await addObjects();
		// 21 names take two steps; all but the first and the last are gone by the time they're read.
		const listed = ["alpha", ...Array.from({ length: 19 }, (_, i) => `gone-${i}`), "beta"];
		const result = await backUp("deleted", { sources: ["objects"] }, (m) =>
			m.mockStepResult({ name: "objects: list" }, listed),
		);
		expect(result).toMatchObject({ ended: "complete", output: [{ status: "ok", test: "passed" }] });

		const repo = await repository("objects");
		const [name] = await repo.snapshots();
		const manifest = await repo.manifest(name ?? "");
		expect(manifest.files.map((entry) => entry.path)).toEqual([
			"objects/alpha.jsonl",
			"objects/beta.jsonl",
		]);
		expect(manifest.meta).toMatchObject({ objects: 2, rows: 4 });
	});

	it("fail at once when the app lists a name no file can have", async () => {
		const result = await backUp("bad-name", { sources: ["objects"] }, (m) =>
			m.mockStepResult({ name: "objects: list" }, ["../up"]),
		);
		expect(result.ended).toBe("errored");
		expect(await runs()).toEqual([
			expect.objectContaining({
				status: "failed",
				error: "objects listed an object whose name can't be a file.",
			}),
		]);
		expect(await (await repository("objects")).snapshots()).toEqual([]);
	});

	it("of several kinds go into one snapshot, as Mail's do, a search index coming back empty", async () => {
		// What Mail's entrypoint lists: a workspace's webhooks and audience, then its mailboxes. A
		// mailbox has what Track's and Agents' objects don't: tables without a rowid, and a search
		// index that keeps no text of its own, which a trigger on another table deletes from.
		await env.APP_SEED.add("webhooks.w1", [
			"CREATE TABLE webhook (id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL) STRICT, WITHOUT ROWID",
			"INSERT INTO webhook VALUES ('h1', 'https://hooks.example/in', 'v2.key.sealed')",
		]);
		await env.APP_SEED.add("audience.w1", [
			"CREATE TABLE template (id TEXT PRIMARY KEY, name TEXT NOT NULL, removed_at INTEGER) STRICT, WITHOUT ROWID",
			"INSERT INTO template VALUES ('t1', 'Welcome', NULL)",
		]);
		await env.APP_SEED.add("mailbox.m1", [
			"CREATE TABLE message (id TEXT PRIMARY KEY, object TEXT NOT NULL, size INTEGER NOT NULL, subject TEXT, seal TEXT, search_id INTEGER) STRICT",
			"CREATE UNIQUE INDEX message_search_id ON message (search_id)",
			"CREATE TABLE held (one INTEGER PRIMARY KEY CHECK (one = 1), bytes INTEGER NOT NULL) STRICT",
			"INSERT INTO held (one, bytes) VALUES (1, 0)",
			"CREATE TRIGGER message_added AFTER INSERT ON message BEGIN UPDATE held SET bytes = bytes + new.size WHERE one = 1; END",
			"CREATE TABLE message_reference (message TEXT NOT NULL, ref TEXT NOT NULL, PRIMARY KEY (message, ref)) STRICT, WITHOUT ROWID",
			"CREATE VIRTUAL TABLE message_search USING fts5(subject, body, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2')",
			"CREATE TRIGGER message_search_gone AFTER DELETE ON message WHEN old.search_id IS NOT NULL BEGIN DELETE FROM message_search WHERE rowid = old.search_id; END",
			"INSERT INTO message_search (rowid, subject, body) VALUES (1, 'Hello', 'a first letter')",
			"INSERT INTO message VALUES ('a', 'w1/m1/a.eml', 120, 'Hello', 'v2.key.salt', 1), ('b', 'w1/m1/b.eml', 80, 'Re: Hello', NULL, NULL)",
			"INSERT INTO message_reference VALUES ('b', '<a@example.com>'), ('b', '<z@example.com>')",
		]);

		const result = await backUp("mail", { sources: ["objects"] });
		expect(result).toMatchObject({ ended: "complete", output: [{ status: "ok", test: "passed" }] });

		const repo = await repository("objects");
		const [name] = await repo.snapshots();
		if (!name) throw new Error("No snapshot was made.");
		const manifest = await repo.manifest(name);
		expect(manifest.files.map((entry) => entry.path)).toEqual([
			"objects/audience.w1.jsonl",
			"objects/mailbox.m1.jsonl",
			"objects/webhooks.w1.jsonl",
		]);
		expect(manifest.meta).toEqual({
			objects: 3,
			tables: 6,
			rows: 7,
			empty: ["mailbox.m1/message_search"],
		});
		expect(await testerTables("objects")).toEqual([]);

		// The mailbox comes back with its rows as they were, the sealed ones still sealed, and its
		// triggers made after them, so nothing is counted twice. Its search index is there and empty.
		await restore(repo, name, "objects/mailbox.m1.jsonl");
		const all = async (sql: string) => (await env.RESTORE_DB.prepare(sql).all()).results;
		expect(await all("SELECT id, seal, search_id FROM message ORDER BY id")).toEqual([
			{ id: "a", seal: "v2.key.salt", search_id: 1 },
			{ id: "b", seal: null, search_id: null },
		]);
		expect(await all("SELECT bytes FROM held")).toEqual([{ bytes: 200 }]);
		expect(await all("SELECT ref FROM message_reference ORDER BY ref")).toEqual([
			{ ref: "<a@example.com>" },
			{ ref: "<z@example.com>" },
		]);
		expect(
			await all("SELECT rowid FROM message_search WHERE message_search MATCH 'hello'"),
		).toEqual([]);
		// The restored database still works as a mailbox's does: deleting a message whose search entry
		// didn't come back is no error.
		await env.RESTORE_DB.prepare("DELETE FROM message WHERE id = 'a'").run();
		expect(await all("SELECT id FROM message")).toEqual([{ id: "b" }]);
	});
});

/** Objects with what R2 keeps beside their bytes: a type, custom metadata, a cache setting. */
async function addFiles() {
	const big = new Uint8Array(300_000);
	for (let i = 0; i < big.length; i += 65_536) {
		crypto.getRandomValues(big.subarray(i, Math.min(i + 65_536, big.length)));
	}
	await env.FILES.put("w1/i1/one.txt", "hello", {
		httpMetadata: { contentType: "text/plain; charset=utf-8" },
		customMetadata: { uploadedBy: "user-1" },
	});
	await env.FILES.put("w1/i2/big.bin", big, {
		httpMetadata: { contentType: "application/octet-stream", cacheControl: "private, max-age=60" },
	});
	await env.FILES.put("w2/Grüße 🙂.txt", "Grüße", {
		httpMetadata: { contentDisposition: 'attachment; filename="gruesse.txt"' },
	});
	await env.FILES.put("w2/empty", new Uint8Array(0));
	return big;
}

/** The objects in FILES, as a snapshot lists them. */
async function filesNow(): Promise<BucketObject[]> {
	const listed = await env.FILES.list({ include: ["httpMetadata", "customMetadata"] });
	return listed.objects.map(describeObject);
}

async function fileBytes(repo: Repository, name: string, key: string) {
	const entry = (await repo.manifest(name)).files.find((file) => file.path === `files/${key}`);
	if (!entry) throw new Error(`The snapshot has no file for ${key}.`);
	return repo.readWholeFile(entry);
}

describe("an R2 bucket", () => {
	it("goes into one snapshot with every object's bytes and metadata, and passes a restore test", async () => {
		const big = await addFiles();
		const result = await backUp("bucket", { sources: ["files"] });
		expect(result).toEqual({
			ended: "complete",
			output: [
				{
					source: "files",
					status: "ok",
					snapshot: expect.stringMatching(/^\d{8}T/),
					test: "passed",
					copy: "ok",
				},
			],
		});

		const repo = await repository("files");
		const [name] = await repo.snapshots();
		if (!name) throw new Error("No snapshot was made.");
		const manifest = await repo.manifest(name);
		expect(manifest.source).toEqual({ kind: "r2", name: "files" });
		expect(manifest.files.map((entry) => entry.path)).toEqual([
			"bucket.json",
			"files/w1/i1/one.txt",
			"files/w1/i2/big.bin",
			"files/w2/Grüße 🙂.txt",
			"files/w2/empty",
		]);
		const bytes = 5 + big.length + utf8("Grüße").length;
		expect(manifest.meta).toEqual({ objects: 4, bytes, read: 4, reused: 0 });

		const index = manifest.files[0];
		if (!index) throw new Error("The snapshot has no bucket.json.");
		const listed = readBucketIndex(await repo.readWholeFile(index));
		expect(listed).toEqual(await filesNow());
		expect(listed[0]).toMatchObject({
			key: "w1/i1/one.txt",
			http: { contentType: "text/plain; charset=utf-8" },
			custom: { uploadedBy: "user-1" },
		});
		expect(listed[1]?.http).toEqual({
			contentType: "application/octet-stream",
			cacheControl: "private, max-age=60",
		});
		expect(fromUtf8(await fileBytes(repo, name, "w1/i1/one.txt"))).toBe("hello");
		expect(await fileBytes(repo, name, "w1/i2/big.bin")).toEqual(big);
		expect(fromUtf8(await fileBytes(repo, name, "w2/Grüße 🙂.txt"))).toBe("Grüße");
		expect((await fileBytes(repo, name, "w2/empty")).length).toBe(0);

		expect(await runs()).toEqual([
			expect.objectContaining({
				id: "bucket/files",
				status: "ok",
				snapshot: name,
				table_count: 0,
				row_count: 0,
				object_count: 4,
				size: bytes + index.size,
				error: null,
			}),
		]);
		expect(await tests()).toEqual([
			expect.objectContaining({
				run: "bucket/files",
				status: "passed",
				object_count: 4,
				size: bytes + index.size,
				error: null,
			}),
		]);
		expect(await testerTables("files")).toEqual([]);
	});

	it("reads only the objects that changed since the last snapshot", async () => {
		await addFiles();
		await backUp("first", { sources: ["files"] });
		await env.FILES.put("w1/i1/one.txt", "hello again", {
			httpMetadata: { contentType: "text/plain; charset=utf-8" },
		});
		await env.FILES.delete("w2/empty");
		await env.FILES.put("w3/new.txt", "new");
		await backUp("second", { sources: ["files"] });

		// Retention keeps a day's newest snapshot, so each run's is the one there.
		const repo = await repository("files");
		const newest = async () => (await repo.snapshots()).at(-1) ?? "";
		const second = await newest();
		const changed = await repo.manifest(second);
		expect(changed.files.map((entry) => entry.path)).toEqual([
			"bucket.json",
			"files/w1/i1/one.txt",
			"files/w1/i2/big.bin",
			"files/w2/Grüße 🙂.txt",
			"files/w3/new.txt",
		]);
		expect(changed.meta).toMatchObject({ objects: 4, read: 2, reused: 2 });
		expect(fromUtf8(await fileBytes(repo, second, "w1/i1/one.txt"))).toBe("hello again");
		const index = changed.files[0];
		if (!index) throw new Error("The snapshot has no bucket.json.");
		expect(readBucketIndex(await repo.readWholeFile(index))).toEqual(await filesNow());
		expect(await backUp("third", { sources: ["files"] })).toMatchObject({ ended: "complete" });
		const third = await newest();
		expect(third).not.toBe(second);
		expect((await repo.manifest(third)).meta).toMatchObject({ objects: 4, read: 0, reused: 4 });

		const [first, after, same] = await runs();
		expect(Number(after?.new_bytes)).toBeGreaterThan(0);
		expect(Number(after?.new_bytes)).toBeLessThan(Number(first?.new_bytes) / 10);
		// Nothing changed: no object was read, and bucket.json came out the same.
		expect(same?.new_bytes).toBe(0);
	});

	it("leaves out an object deleted after the listing", async () => {
		await addFiles();
		const gone: BucketObject = {
			key: "w0/gone.txt",
			size: 4,
			etag: "0123",
			uploaded: new Date().toISOString(),
			http: {},
			custom: {},
		};
		const listed = [{ object: gone }, ...(await filesNow()).map((object) => ({ object }))];
		const result = await backUp("deleted", { sources: ["files"] }, (m) =>
			m.mockStepResult({ name: "files: list 1" }, { objects: listed }),
		);
		expect(result).toMatchObject({ ended: "complete", output: [{ status: "ok", test: "passed" }] });
		const repo = await repository("files");
		const [name] = await repo.snapshots();
		const manifest = await repo.manifest(name ?? "");
		expect(manifest.meta).toMatchObject({ objects: 4, read: 4 });
		expect(manifest.files.some((entry) => entry.path === "files/w0/gone.txt")).toBe(false);
	});

	it("is listed a part at a time when its listing is large", async () => {
		// About 2 KB of metadata each, so the listing passes what one step's answer may hold.
		const custom = { note: "x".repeat(1900) };
		const keys = Array.from({ length: 300 }, (_, i) => `many/${String(i).padStart(3, "0")}`);
		for (let i = 0; i < keys.length; i += 50) {
			await Promise.all(
				keys.slice(i, i + 50).map((key) => env.FILES.put(key, key, { customMetadata: custom })),
			);
		}
		const result = await backUp("many", { sources: ["files"] });
		expect(result).toMatchObject({ ended: "complete", output: [{ status: "ok", test: "passed" }] });
		const repo = await repository("files");
		const [name] = await repo.snapshots();
		const manifest = await repo.manifest(name ?? "");
		expect(manifest.files.slice(1).map((entry) => entry.path)).toEqual(
			keys.map((key) => `files/${key}`),
		);
		expect(manifest.meta).toMatchObject({ objects: 300, read: 300 });
	});

	it("fails a restore test when bucket.json lists an object the snapshot doesn't hold", async () => {
		const repo = await Repository.init(new R2Store(env.VAULT, "crafted/"), env.BACKUP_KEY);
		const object = (key: string, size: number): BucketObject => ({
			key,
			size,
			etag: key,
			uploaded: "2026-11-12T00:00:00.000Z",
			http: {},
			custom: {},
		});
		const kept = await repo.writeFile("files/a", utf8("kept"));
		const index = await repo.writeFile(
			"bucket.json",
			writeBucketIndex([object("a", 4), object("b", 7)]),
		);
		const snapshot = (
			await repo.commit({ kind: "r2", name: "crafted" }, [index.entry, kept.entry], { objects: 2 })
		).name;

		const test = await testerFor(env, "crafted").restore("crafted", snapshot);
		expect(test).toEqual({
			source: "crafted",
			snapshot,
			passed: false,
			tables: 0,
			rows: 0,
			size: expect.any(Number),
			error: "bucket.json lists an object of 7 bytes that the snapshot doesn't hold.",
		});
	});
});

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
/**
 * A repository with the id given, where `Repository.init` would draw one: its `config.json`
 * written as docs/format.md describes it, then opened as any other. The chunker's table comes from
 * the key and the id, so the same bytes are cut at the same places in every run.
 */
async function repositoryWithId(store: ObjectStore, id: string, chunker: ChunkerParams) {
	const keys = await deriveKeys(parseMasterKey(env.BACKUP_KEY), fromHex(id));
	const check = toBase64Url(await seal(keys, `config:${id}`, utf8("gateweave-backup")));
	const config = {
		format: "gateweave-backup",
		version: 1,
		id,
		created: "2026-11-18T00:00:00.000Z",
		chunker,
		check,
	};
	await store.put("config.json", utf8(`${JSON.stringify(config, null, "\t")}\n`));
	return Repository.open(store, env.BACKUP_KEY);
}

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
		expect(await alerts()).toEqual([
			expect.objectContaining({
				key: "run:unlucky",
				subject: "Gateweave Backup: the restore test of app failed",
				text: expect.stringContaining(
					"was made, but restoring it failed. The snapshot stays.\n      Chunk abc of database.jsonl is missing.\n",
				),
			}),
		]);

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

	it("restore a dump cut into many chunks, between lines and inside characters", async () => {
		// Irregular text, so the chunks' cuts don't fall in the same place in every row. The letters
		// come from a small generator with a seed of its own: a formula of the row and the column
		// repeats every few letters, and then every cut can fall at the same place in the pattern.
		const letters = [..."ğüşıöç aeß🙂"];
		let seed = 20261118;
		const next = () => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return seed >>> 16;
		};
		const note = (i: number) =>
			Array.from({ length: 300 + i * 11 }, () => letters[next() % letters.length]).join("");
		await env.SOURCE_DB.batch(
			Array.from({ length: 60 }, (_, i) =>
				env.SOURCE_DB.prepare("INSERT INTO person (id, email, note) VALUES (?1, ?2, ?3)").bind(
					100 + i,
					`p${i}@example.com`,
					note(i),
				),
			),
		);
		const { lines } = await dumpSqlite(d1Reader(env.SOURCE_DB));
		// The cuts depend on the repository's id, which is random, so this one's is given: the same
		// text is cut at the same places every time, and what is asked of the cuts below holds or
		// fails for good.
		const repo = await repositoryWithId(
			new R2Store(env.VAULT, "chunked/"),
			"5eed0000c0ffee00000000000000cdc1",
			{ min: 128, avg: 512, max: 2048 },
		);
		const { entry } = await repo.writeFile("database.jsonl", utf8(joinLines(lines)));
		const chunks = await repo.readFileChunks(entry);
		expect(chunks.length).toBeGreaterThan(20);
		expect(fromUtf8(concat(...chunks))).toBe(joinLines(lines));
		// Some chunk starts in the middle of a character: a UTF-8 continuation byte.
		expect(chunks.some((chunk) => ((chunk[0] ?? 0) & 0xc0) === 0x80)).toBe(true);
		const snapshot = (await repo.commit({ kind: "d1", name: "chunked" }, [entry], {})).name;

		const test = await testerFor(env, "chunked").restore("chunked", snapshot);
		expect(test).toMatchObject({ passed: true, tables: 1, rows: 63, size: entry.size });
		expect(await testerTables("chunked")).toEqual([]);
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

describe("the copy outside Cloudflare", () => {
	it("holds what the vault's snapshots need, as sealed, and a later run sends only what is new", async () => {
		await backUp("one", { sources: ["app"] });
		const vault = new R2Store(env.VAULT, "app/");
		const keys = await keysOf(copyOf());
		expect(keys).toEqual(await keysOf(vault));
		let size = 0;
		for (const key of keys) {
			const sealed = await vault.get(key);
			expect(await copyOf().get(key), key).toEqual(sealed);
			size += sealed?.length ?? 0;
		}
		// The backup key opens it on its own, and its snapshot restores to the same rows.
		const copy = await Repository.open(copyOf(), env.BACKUP_KEY);
		const [name] = await copy.snapshots();
		expect([name]).toEqual(await (await repository()).snapshots());
		await restore(copy, name ?? "");
		const original = await env.SOURCE_DB.prepare(PEOPLE_QUERY).all();
		expect((await env.RESTORE_DB.prepare(PEOPLE_QUERY).all()).results).toEqual(original.results);
		expect(await copies()).toEqual([
			{
				run: "one/app",
				source: "app",
				copied_at: expect.any(Number),
				status: "ok",
				object_count: keys.length,
				size,
				snapshot_count: 1,
				forgotten: 0,
				held_snapshots: 0,
				deleted_chunks: 0,
				held_chunks: 0,
				error: null,
			},
		]);

		await env.SOURCE_DB.prepare("UPDATE person SET note = 'changed' WHERE id = 2").run();
		await backUp("two", { sources: ["app"] });
		// The new chunk and manifest went, and the copy let the day's older snapshot go, as the vault did.
		expect(await keysOf(copyOf())).toEqual(await keysOf(vault));
		const [, second] = await copies();
		expect(second).toMatchObject({
			run: "two/app",
			status: "ok",
			object_count: 2,
			snapshot_count: 1,
			forgotten: 1,
			deleted_chunks: 1,
		});
		expect((await offsite("/__objects")).puts).toBe(keys.length + 2);
	});

	it("keeps a snapshot the vault lost, until its own retention lets it go", async () => {
		// A snapshot from two days ago, which the policy keeps.
		const made = await Repository.init(new R2Store(env.VAULT, "app/"), env.BACKUP_KEY);
		const { lines } = await dumpSqlite(d1Reader(env.SOURCE_DB));
		const { entry } = await made.writeFile("database.jsonl", utf8(joinLines(lines)));
		const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
		const old = (await made.commit({ kind: "d1", name: "app" }, [entry], {}, twoDaysAgo)).name;
		await backUp("one", { sources: ["app"] });

		// The vault loses it.
		await (await repository()).forget(old);
		await env.SOURCE_DB.prepare("UPDATE person SET note = 'changed' WHERE id = 2").run();
		await backUp("two", { sources: ["app"] });

		const kept = await (await repository()).snapshots();
		expect(kept).toHaveLength(1);
		const copy = await Repository.open(copyOf(), env.BACKUP_KEY);
		expect(await copy.snapshots()).toEqual([old, ...kept]);
		await restore(copy, old);
		const note = await env.RESTORE_DB.prepare("SELECT note FROM person WHERE id = 2").first("note");
		expect(note).toBe("Grüße, 🙂");
	});

	it("fails and is alerted when the bucket refuses it, and the backup stays in the vault", async () => {
		await offsite("/__fail", "1");
		const result = await backUp("refused", { sources: ["app"] });
		expect(result.ended).toBe("errored");
		expect(result.error?.message).toContain("The copy of app outside Cloudflare failed.");
		expect(await runs()).toEqual([expect.objectContaining({ source: "app", status: "ok" })]);
		expect(await (await repository()).snapshots()).toHaveLength(1);
		expect(await copies()).toEqual([
			expect.objectContaining({
				run: "refused/app",
				status: "failed",
				object_count: 0,
				snapshot_count: null,
				error: expect.stringContaining("403 (AccessDenied)"),
			}),
		]);
		const [alert] = await alerts();
		expect(alert?.subject).toBe("Gateweave Backup: the copy of app outside Cloudflare failed");
		const text = String(alert?.text).split("\n");
		expect(text.slice(3, 6)).toEqual([
			"app   Copy failed",
			expect.stringMatching(
				/^ {6}Snapshot \d{8}T\S+ was made, restored and counted by a restore test, but copying it outside Cloudflare failed\. It is in the vault\.$/,
			),
			expect.stringContaining("403 (AccessDenied)"),
		]);

		// The next run sends what this one didn't.
		await backUp("again", { sources: ["app"] });
		expect(await keysOf(copyOf())).toEqual(await keysOf(new R2Store(env.VAULT, "app/")));
	});

	it("counts what a lock on its bucket keeps, and leaves it for a later run", async () => {
		await backUp("one", { sources: ["app"] });
		await offsite("/__lock", JSON.stringify((await offsite("/__objects")).keys));
		await env.SOURCE_DB.prepare("UPDATE person SET note = 'changed' WHERE id = 2").run();
		const result = await backUp("two", { sources: ["app"] });
		expect(result.ended).toBe("complete");
		const [, second] = await copies();
		expect(second).toMatchObject({
			status: "ok",
			snapshot_count: 2,
			forgotten: 0,
			held_snapshots: 1,
			deleted_chunks: 0,
			held_chunks: 0,
		});
		expect(await (await Repository.open(copyOf(), env.BACKUP_KEY)).snapshots()).toHaveLength(2);
	});

	it("leaves a copy of another repository as it is", async () => {
		await backUp("one", { sources: ["app"] });
		const before = await keysOf(copyOf());
		// The vault's repository is lost, and the next run makes a new one.
		const lost = await env.VAULT.list({ prefix: "app/" });
		await env.VAULT.delete(lost.objects.map((o) => o.key));
		const result = await backUp("two", { sources: ["app"] });
		expect(result.ended).toBe("errored");
		expect(await (await repository()).snapshots()).toHaveLength(1);
		const [, second] = await copies();
		expect(second).toMatchObject({
			status: "failed",
			object_count: 0,
			error: expect.stringContaining("The copy holds another repository than the vault"),
		});
		expect(await keysOf(copyOf())).toEqual(before);
	});

	it("goes in steps, chunks first and manifests last", async () => {
		const vault = new R2Store(env.VAULT, "app/");
		const repo = await Repository.init(vault, env.BACKUP_KEY, {
			chunker: { min: 128, avg: 512, max: 2048 },
		});
		// Rows that differ, so no two chunks are the same.
		const rows = Array.from({ length: 600 }, (_, n) => `row ${n}: ${(n * 7919) % 104729} ünïcode`);
		const { entry } = await repo.writeFile("database.jsonl", utf8(rows.join("\n")));
		await repo.commit({ kind: "d1", name: "app" }, [entry], {});
		const needed = await repo.neededKeys();
		expect(needed.length).toBeGreaterThan(6);

		const steps: { copied: number; done: boolean; keys: string[] }[] = [];
		for (let done = false; !done; ) {
			const progress = await copyNew(repo, vault, copyOf(), { objects: 3, bytes: Infinity });
			done = progress.done;
			steps.push({ copied: progress.copied, done, keys: await keysOf(copyOf()) });
		}
		expect(steps.at(-1)?.keys).toEqual([...needed].sort());
		expect(steps.slice(0, -1).every((step) => step.copied === 3 && !step.done)).toBe(true);
		// Until the last chunk is there, the copy holds no manifest.
		for (const step of steps) {
			const chunks = step.keys.filter((key) => key.startsWith("data/")).length;
			const manifests = step.keys.filter((key) => key.startsWith("snapshots/")).length;
			if (manifests > 0) expect(chunks).toBe(new Set(entry.chunks).size);
		}
		expect(await copyNew(repo, vault, copyOf())).toEqual({ copied: 0, bytes: 0, done: true });
	});

	it("is set by COPY_TO, with an https endpoint and a key", () => {
		const keys = { COPY_ACCESS_KEY_ID: "id", COPY_SECRET_ACCESS_KEY: "secret" };
		const at = { COPY_ENDPOINT: "https://s3.example", ...keys };
		expect(copyTarget({})).toBeUndefined();
		expect(copyTarget({ COPY_TO: " ", ...at })).toBeUndefined();
		expect(copyTarget({ COPY_TO: "s3://bucket/backups", ...at })?.location).toBe(
			"s3://bucket/backups",
		);
		const wrong: [Record<string, string>, string][] = [
			[{ COPY_TO: "bucket", ...at }, "COPY_TO: bucket isn't an s3:// location."],
			[{ COPY_TO: "s3://bucket", ...keys }, "COPY_TO needs COPY_ENDPOINT"],
			[{ COPY_TO: "s3://bucket", ...at, COPY_ENDPOINT: "http://s3.example" }, "https URL"],
			[
				{ COPY_TO: "s3://bucket", COPY_ENDPOINT: "https://s3.example" },
				"COPY_TO needs the secrets",
			],
		];
		for (const [setting, message] of wrong) {
			expect(() => copyTarget(setting), message).toThrow(CopyConfigError);
			expect(() => copyTarget(setting), message).toThrow(message);
		}
	});
});

describe("alerts", () => {
	const HOUR = 60 * 60 * 1000;
	const ALERT: Alert = {
		key: "run:x",
		subject: "Gateweave Backup: a test",
		text: "One\nTwo",
		html: "<p>One</p>",
	};
	/** A webhook secret for these tests only: 32 bytes, "gateweave backup alert tests 01!". */
	const SECRET = "whsec_Z2F0ZXdlYXZlIGJhY2t1cCBhbGVydCB0ZXN0cyAwMSE=";

	/** An EMAIL binding that keeps what it was given, or fails as Email Service does. */
	function mailbox(error?: Error & { code?: string }) {
		const sent: unknown[] = [];
		const binding = {
			async send(message: unknown) {
				if (error) throw error;
				sent.push(message);
				return { messageId: "test" };
			},
		} as unknown as SendEmail;
		return { binding, sent };
	}

	async function startedRun(source: string, ago: number, status: "running" | "ok") {
		const at = Date.now() - ago;
		await env.CATALOG.prepare(
			"INSERT INTO run (id, instance, source, started_at, status) VALUES (?1, ?1, ?2, ?3, ?4)",
		)
			.bind(`${source}-${at}`, source, at, status)
			.run();
	}

	it("go by email and by a webhook signed as Standard Webhooks signs one", async () => {
		const { binding, sent } = mailbox();
		const destinations = destinationsOf({
			ALERT_FROM: "Gateweave Backup <backup@example.com>",
			ALERT_TO: " owner@example.com, second@example.org ",
			ALERT_WEBHOOK_URL: "https://hooks.example/backup",
			ALERT_WEBHOOK_SECRET: SECRET,
			EMAIL: binding,
		});
		const requests: Request[] = [];
		const at = new Date("2026-11-12T09:17:00Z");
		const went = await deliver(ALERT, destinations, at, async (input, init) => {
			requests.push(new Request(input, init));
			return new Response(null, { status: 204 });
		});

		expect(went).toEqual(["email", "webhook"]);
		expect(sent).toEqual([
			{
				from: { name: "Gateweave Backup", email: "backup@example.com" },
				to: ["owner@example.com", "second@example.org"],
				subject: ALERT.subject,
				text: ALERT.text,
				html: ALERT.html,
			},
		]);
		const [request] = requests;
		if (!request) throw new Error("The webhook wasn't called.");
		expect(request.url).toBe("https://hooks.example/backup");
		const body = await request.text();
		expect(JSON.parse(body)).toEqual({
			type: "backup.alert",
			timestamp: "2026-11-12T09:17:00.000Z",
			data: { key: "run:x", subject: ALERT.subject, text: ALERT.text },
		});
		const id = request.headers.get("webhook-id");
		const timestamp = request.headers.get("webhook-timestamp");
		expect(id).toMatch(/^msg_[A-Za-z0-9_-]+$/);
		expect(timestamp).toBe(String(at.getTime() / 1000));
		// Checked as a receiver would, from the secret alone.
		const raw = Uint8Array.from(atob(SECRET.slice("whsec_".length)), (c) => c.charCodeAt(0));
		const key = await crypto.subtle.importKey(
			"raw",
			raw,
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["verify"],
		);
		const signature = request.headers.get("webhook-signature") ?? "";
		expect(signature).toMatch(/^v1,/);
		const mac = Uint8Array.from(atob(signature.slice(3)), (c) => c.charCodeAt(0));
		const signed = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
		expect(await crypto.subtle.verify("HMAC", key, mac, signed)).toBe(true);
	});

	it("go nowhere when nothing is set up, and refuse a setting that is there but wrong", () => {
		expect(destinationsOf({})).toEqual({});
		expect(destinationsOf({ ALERT_FROM: " ", ALERT_TO: "" })).toEqual({});
		const { binding } = mailbox();
		const wrong: [Parameters<typeof destinationsOf>[0], string][] = [
			[{ ALERT_FROM: "backup@example.com", EMAIL: binding }, "need both ALERT_FROM and ALERT_TO"],
			[{ ALERT_TO: "owner@example.com", EMAIL: binding }, "need both ALERT_FROM and ALERT_TO"],
			[
				{ ALERT_FROM: "backup@example.com", ALERT_TO: "owner@example.com" },
				"need the EMAIL binding",
			],
			[
				{ ALERT_FROM: "Backup <nobody>", ALERT_TO: "owner@example.com", EMAIL: binding },
				"ALERT_FROM isn't an email address",
			],
			[
				{ ALERT_FROM: "backup@example.com", ALERT_TO: "owner; boss@example.com", EMAIL: binding },
				"ALERT_TO must be email addresses",
			],
			[{ ALERT_WEBHOOK_URL: "hooks.example" }, "ALERT_WEBHOOK_URL isn't a URL"],
			[
				{ ALERT_WEBHOOK_URL: "http://hooks.example/", ALERT_WEBHOOK_SECRET: SECRET },
				"must be https",
			],
			[{ ALERT_WEBHOOK_URL: "https://hooks.example/" }, "ALERT_WEBHOOK_SECRET must be"],
			[
				{ ALERT_WEBHOOK_URL: "https://hooks.example/", ALERT_WEBHOOK_SECRET: "whsec_c2hvcnQ=" },
				"ALERT_WEBHOOK_SECRET must be",
			],
		];
		for (const [settings, message] of wrong) {
			expect(() => destinationsOf(settings), JSON.stringify(settings)).toThrow(message);
		}
	});

	it("say what Email Service and the webhook answered, and never an address", async () => {
		const refused = Object.assign(new Error("owner@example.com is suppressed"), {
			code: "E_RECIPIENT_SUPPRESSED",
		});
		const settings = { ALERT_FROM: "backup@example.com", ALERT_TO: "owner@example.com" };
		const email = destinationsOf({ ...settings, EMAIL: mailbox(refused).binding });
		await expect(deliver(ALERT, email, new Date())).rejects.toThrow(
			/^The alert email wasn't sent: E_RECIPIENT_SUPPRESSED\.$/,
		);
		const hook = destinationsOf({
			ALERT_WEBHOOK_URL: "https://hooks.example/",
			ALERT_WEBHOOK_SECRET: SECRET,
		});
		const status = (code: number) => async () => new Response(null, { status: code });
		await expect(deliver(ALERT, hook, new Date(), status(500))).rejects.toThrow(
			"The alert webhook answered 500.",
		);
		const offline = async () => Promise.reject(new TypeError("Network connection lost."));
		await expect(deliver(ALERT, hook, new Date(), offline)).rejects.toThrow(
			"The alert webhook answered nothing.",
		);
	});

	it("go out when a run asks for one, though nothing failed", async () => {
		const result = await backUp("asked-for", { sources: ["app"], alert: true });
		expect(result.ended).toBe("complete");
		expect(await alerts()).toEqual([
			expect.objectContaining({
				key: "run:asked-for",
				subject: "Gateweave Backup: every backup was made (a test alert)",
				sent_to: "",
			}),
		]);
	});

	it("that can't be sent stay in the catalog and go the next morning", async () => {
		const result = await backUp("unsent", { sources: ["app"], alert: true }, (m) =>
			m.mockStepError({ name: "alert: send" }, new Error("The alert webhook answered 503.")),
		);
		expect(result.ended).toBe("complete");
		expect(await alerts()).toEqual([
			expect.objectContaining({
				key: "run:unsent",
				sent_at: null,
				error: "The alert webhook answered 503.",
			}),
		]);

		await startedRun("broken", HOUR, "ok");
		await startedRun("objects", HOUR, "ok");
		await startedRun("files", HOUR, "ok");
		expect(await checkBackups(env, Date.now())).toEqual({ late: false, sent: 1 });
		expect(await alerts()).toEqual([
			expect.objectContaining({ key: "run:unsent", sent_to: "", error: null }),
		]);
	});

	it("say when a nightly backup didn't start, or didn't end", async () => {
		await startedRun("app", 30 * HOUR, "ok");
		await startedRun("broken", 6 * HOUR, "running");
		await startedRun("objects", 2 * HOUR, "ok");
		await startedRun("files", 2 * HOUR, "ok");
		const controller = createScheduledController({ scheduledTime: Date.now(), cron: "17 9 * * *" });
		await worker.scheduled(controller, env);

		const [late] = await alerts();
		const day = new Date().toISOString().slice(0, 10);
		expect(late).toMatchObject({
			key: `late:${day}`,
			subject: "Gateweave Backup: the backups of app and broken are late",
			sent_to: "",
		});
		const time = "\\d{1,2} [A-Z][a-z]{2} \\d{4}, \\d\\d:\\d\\d UTC";
		expect(String(late?.text).split("\n")).toEqual([
			"The backups of app and broken are late.",
			expect.stringMatching(new RegExp(`^Daily check · ${time}$`)),
			"",
			"app       Late",
			expect.stringMatching(new RegExp(`^ {10}No backup has started since ${time}\\.$`)),
			"broken    Stuck",
			expect.stringMatching(new RegExp(`^ {10}The backup that started ${time} hasn't ended\\.$`)),
			"objects   On time",
			expect.stringMatching(new RegExp(`^ {10}Last started ${time}\\.$`)),
			"files     On time",
			expect.stringMatching(new RegExp(`^ {10}Last started ${time}\\.$`)),
			"",
			"The nightly run didn't start, or stopped part way. The Workflow's instances say which:",
			"  npx wrangler workflows instances list gateweave-backup",
			"",
			"--",
			expect.any(String),
			"",
		]);

		// Once a day, however often the check runs.
		expect(await checkBackups(env, Date.now())).toEqual({ late: true, sent: 0 });
		expect(await alerts()).toHaveLength(1);
	});

	it("read as a card in HTML, with every value they quote escaped", async () => {
		const at = new Date("2026-11-12T03:07:00Z");
		expect(when(at)).toBe("12 Nov 2026, 03:07 UTC");
		const alert = runAlert(
			"night",
			[
				{ source: "id", status: "ok", snapshot: "20261112T030700Z-a1", test: "passed" },
				{
					source: "track",
					status: "failed",
					error: `INSERT INTO "<script>" failed: 'a' & "b"`,
				},
			],
			false,
			at,
		);
		expect(alert.subject).toBe("Gateweave Backup: the backup of track failed");
		const html = alert.html ?? "";
		expect(html).toMatch(/^<!doctype html>/);
		expect(html).toContain("<title>Gateweave Backup: the backup of track failed</title>");
		expect(html).toContain("The backup of track failed</h1>");
		expect(html).toContain("Backup run · 12 Nov 2026, 03:07 UTC");
		expect(html).toContain(">Backed up</span>");
		expect(html).toContain(">Failed</span>");
		// The strip is red when anything failed.
		expect(html).toContain("background:#f04438");
		expect(html).not.toContain("<script>");
		expect(html).toContain(
			"INSERT INTO &quot;&lt;script&gt;&quot; failed: &#39;a&#39; &amp; &quot;b&quot;",
		);
		expect(alert.text).toContain(`INSERT INTO "<script>" failed: 'a' & "b"`);
		// Nothing for a mail client to load.
		expect(html).not.toMatch(/<img|<link|src=|url\(/);

		const good = runAlert("asked", [{ source: "id", status: "ok", snapshot: "s" }], true, at);
		expect(good.subject).toBe("Gateweave Backup: every backup was made (a test alert)");
		expect(good.html).toContain("background:#17b26a");
		expect(good.html).toContain("Test alert · 12 Nov 2026, 03:07 UTC");

		await startedRun("app", 2 * HOUR, "ok");
		await startedRun("broken", 30 * HOUR, "ok");
		await startedRun("objects", 2 * HOUR, "ok");
		await startedRun("files", 2 * HOUR, "ok");
		const late = await lateAlert(env, Date.now());
		expect(late?.subject).toBe("Gateweave Backup: the backup of broken is late");
		expect(late?.html).toContain("background:#f79009");
		expect(late?.html).toContain(">On time</span>");
		expect(late?.html).toContain(">Late</span>");
	});

	it("stay quiet while every source's backup is on time", async () => {
		await startedRun("app", 6 * HOUR, "ok");
		// A run cut off long ago is past, once a newer one ran.
		await startedRun("broken", 50 * HOUR, "running");
		await startedRun("broken", 2 * HOUR, "running");
		await startedRun("objects", 6 * HOUR, "ok");
		await startedRun("files", 6 * HOUR, "ok");
		expect(await checkBackups(env, Date.now())).toEqual({ late: false, sent: 0 });
		expect(await alerts()).toEqual([]);
	});
});

describe("the Worker", () => {
	it("answers no requests", async () => {
		const response = await exports.default.fetch("https://backup.example/");
		expect(response.status).toBe(404);
	});
});
