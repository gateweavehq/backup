import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
	BUCKET_INDEX,
	type BucketObject,
	bucketFile,
	dumpSqlite,
	type FileEntry,
	generateMasterKey,
	joinLines,
	type Manifest,
	MemoryStore,
	objectFile,
	Repository,
	type Row,
	utf8,
	writeBucketIndex,
} from "@gateweave/backup-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HELP, type Io, run } from "../src/cli";
import { authorization, EMPTY_SHA256 } from "../src/sigv4";
import { FolderStore, parseListing, StoreError } from "../src/stores";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = join(HERE, "..");
/** packages/core's repository from the format's first version, and its public test key. */
const FIXTURE = join(HERE, "..", "..", "core", "test", "fixtures", "v1");
const FIXTURE_KEY = "Z2F0ZXdlYXZlLWJhY2t1cCB0ZXN0IGZpeHR1cmUgMSE";

const KEY = generateMasterKey();
let temp: string;
let repoDir: string;
let store: MemoryStore;
let first: string;
let second: string;

function sample(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		PRAGMA foreign_keys = on;
		CREATE TABLE team (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
		CREATE TABLE person (
			id TEXT PRIMARY KEY,
			team_id INTEGER REFERENCES team(id),
			email TEXT NOT NULL,
			avatar BLOB
		);
		CREATE UNIQUE INDEX person_email ON person (email);
		CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT);
		CREATE VIRTUAL TABLE note_search USING fts5(body, content='note', content_rowid='id');
		INSERT INTO team (name) VALUES ('Core'), ('Sync');
		INSERT INTO person VALUES ('p1', 1, 'ada@example.com', X'00ff10'), ('p2', 2, 'grace@example.com', NULL);
		INSERT INTO note (body) VALUES ('first line
second line'), ('it''s quoted');
		INSERT INTO note_search (note_search) VALUES ('rebuild');
	`);
	return db;
}

async function snapshotOf(repo: Repository, db: DatabaseSync, at: string): Promise<string> {
	const dump = await dumpSqlite({
		async readTogether(statements) {
			return statements.map((sql) => db.prepare(sql).all() as Row[]);
		},
	});
	const { entry } = await repo.writeFile("database.jsonl", utf8(joinLines(dump.lines)));
	const manifest = await repo.commit(
		{ kind: "d1", name: "track" },
		[entry],
		{ tables: dump.stats.tables, rows: dump.stats.rows, empty: dump.stats.empty },
		new Date(at),
	);
	return manifest.name;
}

function writeOut(objects: MemoryStore, dir: string) {
	for (const [key, value] of objects.objects) {
		const path = join(dir, ...key.split("/"));
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, value);
	}
}

/** A repository with small chunks, so a dump of a few hundred rows takes many of them. */
async function bigRepository() {
	const big = new MemoryStore();
	const repo = await Repository.init(big, KEY, { chunker: { min: 256, avg: 1024, max: 4096 } });
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT)");
	const insert = db.prepare("INSERT INTO note (body) VALUES (?)");
	for (let n = 0; n < 400; n++) insert.run(`${n}`.padEnd(300, String.fromCharCode(97 + (n % 26))));
	await snapshotOf(repo, db, "2026-11-12T03:17:00Z");
	const dir = join(temp, `big-${crypto.randomUUID()}`);
	writeOut(big, dir);
	return { store: big, dir };
}

interface Ran {
	code: number;
	out: string;
	err: string;
}

async function cli(argv: string[], extra: Partial<Io> = {}): Promise<Ran> {
	let out = "";
	let err = "";
	const code = await run(argv, {
		out: (text) => {
			out += text;
		},
		err: (text) => {
			err += text;
		},
		env: { GATEWEAVE_BACKUP_KEY: KEY },
		...extra,
	});
	return { code, out, err };
}

beforeAll(async () => {
	temp = mkdtempSync(join(tmpdir(), "gateweave-backup-cli-"));
	repoDir = join(temp, "repo");
	store = new MemoryStore();
	const repo = await Repository.init(store, KEY, { now: new Date("2026-11-10T03:17:00Z") });
	const db = sample();
	first = await snapshotOf(repo, db, "2026-11-10T03:17:00Z");
	db.exec("INSERT INTO team (name) VALUES ('Mail')");
	second = await snapshotOf(repo, db, "2026-11-11T03:17:00Z");
	writeOut(store, repoDir);
});

afterAll(() => {
	rmSync(temp, { recursive: true, force: true });
});

describe("snapshots and show", () => {
	it("lists the snapshots oldest first, by name, source and size", async () => {
		const ran = await cli(["snapshots", repoDir]);
		expect(ran.code).toBe(0);
		const lines = ran.out.trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain(first);
		expect(lines[1]).toContain(second);
		expect(lines[1]).toContain("d1 track");

		const json = JSON.parse((await cli(["snapshots", repoDir, "--json"])).out);
		expect(json.map((s: { name: string }) => s.name)).toEqual([first, second]);
	});

	it("lists a snapshot that doesn't open as damaged, and the others all the same", async () => {
		const damaged = join(temp, "damaged-manifest");
		writeOut(store, damaged);
		const path = join(damaged, "snapshots", first);
		const bytes = readFileSync(path);
		bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
		writeFileSync(path, bytes);
		const ran = await cli(["snapshots", damaged]);
		expect(ran.code).toBe(1);
		expect(ran.out).toContain(`${first}  DAMAGED: `);
		expect(ran.out).toContain(second);
	});

	it("previews the newest snapshot's tables and rows, never their values", async () => {
		const ran = await cli(["show", repoDir]);
		expect(ran.code).toBe(0);
		expect(ran.out).toContain(second);
		expect(ran.out).toMatch(/team\s+3/);
		expect(ran.out).toMatch(/person\s+2/);
		expect(ran.out).toContain("read at one moment");
		expect(ran.out).not.toContain("ada@example.com");

		const older = JSON.parse((await cli(["show", repoDir, first, "--json"])).out);
		expect(older.database.tables.find((t: { name: string }) => t.name === "team").rows).toBe(2);
	});
});

describe("check", () => {
	it("reads every snapshot and restores each into memory", async () => {
		const ran = await cli(["check", repoDir, "--all"]);
		expect(ran.code).toBe(0);
		expect(ran.out.match(/^ok /gm)).toHaveLength(2);
		expect(ran.out).toContain("restored 4 tables");
	});

	it("fails on a chunk that was changed, naming the chunk and nothing in it", async () => {
		const broken = join(temp, "broken");
		writeOut(store, broken);
		const chunk = [...store.objects.keys()].find((key) => key.startsWith("data/"));
		if (!chunk) throw new Error("No chunk.");
		const path = join(broken, ...chunk.split("/"));
		const bytes = readFileSync(path);
		bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
		writeFileSync(path, bytes);

		const ran = await cli(["check", broken, "--all"]);
		expect(ran.code).toBe(1);
		expect(ran.out).toMatch(/FAILED/);
		expect(ran.out).toContain("could not be opened");
		expect(ran.out).not.toContain("example.com");
	});

	it("refuses a wrong key before reading anything", async () => {
		const ran = await cli(["check", repoDir], {
			env: { GATEWEAVE_BACKUP_KEY: generateMasterKey() },
		});
		expect(ran.code).toBe(1);
		expect(ran.err).toContain("That key doesn't open this repository.");
	});
});

describe("restore", () => {
	const rows = (db: DatabaseSync) => ({
		team: db.prepare("SELECT id, name FROM team ORDER BY id").all(),
		person: db
			.prepare("SELECT id, team_id, email, hex(avatar) AS avatar FROM person ORDER BY id")
			.all(),
		note: db.prepare("SELECT id, body FROM note ORDER BY id").all(),
		found: db.prepare("SELECT rowid FROM note_search WHERE note_search MATCH 'quoted'").all(),
		seq: db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'team'").get(),
	});

	it("writes a SQLite file with every row, index and counter", async () => {
		const to = join(temp, "as-sqlite");
		const ran = await cli(["restore", repoDir, "--to", to, "--as", "sqlite"]);
		expect(ran.code).toBe(0);
		const db = new DatabaseSync(join(to, "database.sqlite"));
		const want = sample();
		want.exec("INSERT INTO team (name) VALUES ('Mail')");
		expect(rows(db)).toEqual(rows(want));
		expect(() =>
			db.prepare("INSERT INTO person (id, email) VALUES ('p3', 'ada@example.com')").run(),
		).toThrow(/UNIQUE/);
		db.close();
	});

	it("writes SQL that loads into an empty database as one file", async () => {
		const to = join(temp, "as-sql");
		const ran = await cli(["restore", repoDir, first, "--to", to]);
		expect(ran.code).toBe(0);
		expect(ran.out).toContain("wrangler d1 execute");
		const sql = readFileSync(join(to, "database.sql"), "utf8");
		// D1 runs a file without BEGIN or COMMIT, which it refuses.
		expect(sql).not.toMatch(/^(BEGIN|COMMIT)/m);
		const db = new DatabaseSync(":memory:");
		db.exec(sql);
		expect(rows(db)).toEqual(rows(sample()));
		expect(readdirSync(to)).toEqual(["database.sql"]);
	});

	it("writes the files as they were backed up", async () => {
		const to = join(temp, "as-files");
		expect((await cli(["restore", repoDir, "latest", "--to", to, "--as", "files"])).code).toBe(0);
		const repo = await Repository.open(new FolderStore(repoDir), KEY);
		const [file] = (await repo.manifest(second)).files;
		if (!file) throw new Error("No file.");
		expect(new Uint8Array(readFileSync(join(to, "database.jsonl")))).toEqual(
			await repo.readWholeFile(file),
		);
	});

	it("never writes over a file that is there", async () => {
		const to = join(temp, "taken");
		mkdirSync(to, { recursive: true });
		writeFileSync(join(to, "database.sql"), "keep me");
		const ran = await cli(["restore", repoDir, "--to", to]);
		expect(ran.code).toBe(1);
		expect(ran.err).toContain("is there already");
		expect(readFileSync(join(to, "database.sql"), "utf8")).toBe("keep me");
	});

	it("never writes over a file that is there, restoring the files either", async () => {
		const to = join(temp, "taken-files");
		mkdirSync(to, { recursive: true });
		writeFileSync(join(to, "database.jsonl"), "keep me");
		const ran = await cli(["restore", repoDir, "--to", to, "--as", "files"]);
		expect(ran.code).toBe(1);
		expect(readFileSync(join(to, "database.jsonl"), "utf8")).toBe("keep me");
		expect(readdirSync(to)).toEqual(["database.jsonl"]);
	});

	it("leaves nothing behind when a chunk turns out damaged half way", async () => {
		const big = await bigRepository();
		const chunk = [...big.store.objects.keys()].filter((key) => key.startsWith("data/")).sort()[1];
		if (!chunk) throw new Error("Expected several chunks.");
		const path = join(big.dir, ...chunk.split("/"));
		const bytes = readFileSync(path);
		bytes[20] = (bytes[20] ?? 0) ^ 1;
		writeFileSync(path, bytes);
		for (const as of ["files", "sql", "sqlite"]) {
			const to = join(temp, `damaged-${as}`);
			const ran = await cli(["restore", big.dir, "--to", to, "--as", as]);
			expect(ran.code).toBe(1);
			expect(ran.err).toContain("could not be opened");
			expect(readdirSync(to)).toEqual([]);
		}
	});

	it("restores a database cut into many chunks", async () => {
		const big = await bigRepository();
		const chunks = [...big.store.objects.keys()].filter((key) => key.startsWith("data/"));
		expect(chunks.length).toBeGreaterThan(3);
		const to = join(temp, "many-chunks");
		expect((await cli(["restore", big.dir, "--to", to, "--as", "sqlite"])).code).toBe(0);
		const db = new DatabaseSync(join(to, "database.sqlite"));
		expect(db.prepare("SELECT count(*) AS n, sum(length(body)) AS bytes FROM note").get()).toEqual({
			n: 400,
			bytes: 400 * 300,
		});
		db.close();
	});

	it("refuses a file the snapshot names outside the folder", async () => {
		const odd = new MemoryStore();
		const repo = await Repository.init(odd, KEY);
		const { entry } = await repo.writeFile("x", utf8("outside"));
		await repo.commit({ kind: "files", name: "odd" }, [{ ...entry, path: "../escaped.txt" }]);
		const dir = join(temp, "odd-repo");
		writeOut(odd, dir);
		const to = join(temp, "odd-out");
		const ran = await cli(["restore", dir, "--to", to]);
		expect(ran.code).toBe(1);
		expect(ran.err).toContain("can't write");
		expect(existsSync(join(temp, "escaped.txt"))).toBe(false);
	});

	it("restores the repository the format's first version wrote", async () => {
		const to = join(temp, "fixture");
		const ran = await cli(["restore", FIXTURE, "--to", to, "--as", "sqlite"], {
			env: { GATEWEAVE_BACKUP_KEY: FIXTURE_KEY },
		});
		expect(ran.code).toBe(0);
		const db = new DatabaseSync(join(to, "database.sqlite"));
		expect(db.prepare("SELECT id, email FROM person ORDER BY id").all()).toEqual([
			{ id: 1, email: "ada@example.com" },
			{ id: 2, email: "grace@example.com" },
		]);
		db.close();
	});
});

/** A small database, as one of an app's Durable Objects might hold. */
function small(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE issue (id TEXT PRIMARY KEY, title TEXT NOT NULL);
		INSERT INTO issue VALUES ('i1', 'Kept'), ('i2', 'Also kept');
	`);
	return db;
}

/** A repository with one snapshot of an app's objects: ws-a holds sample(), ws-b small(). */
async function objectsRepository() {
	const objects = new MemoryStore();
	const repo = await Repository.init(objects, KEY);
	const entries = [];
	let tables = 0;
	let rowCount = 0;
	for (const [name, db] of [
		["ws-a", sample()],
		["ws-b", small()],
	] as const) {
		const dump = await dumpSqlite({
			async readTogether(statements) {
				return statements.map((sql) => db.prepare(sql).all() as Row[]);
			},
		});
		const { entry } = await repo.writeFile(objectFile(name), utf8(joinLines(dump.lines)));
		entries.push(entry);
		tables += dump.stats.tables;
		rowCount += dump.stats.rows;
	}
	const meta = { objects: 2, tables, rows: rowCount, empty: [] };
	const manifest = await repo.commit({ kind: "do", name: "track-workspaces" }, entries, meta);
	const dir = join(temp, `objects-${crypto.randomUUID()}`);
	writeOut(objects, dir);
	return { store: objects, dir, name: manifest.name, rows: rowCount };
}

describe("a snapshot of an app's Durable Objects", () => {
	it("lists its objects, and shows one's tables", async () => {
		const { dir } = await objectsRepository();
		const ran = await cli(["show", dir]);
		expect(ran.code).toBe(0);
		expect(ran.out).toContain("Source    do track-workspaces");
		expect(ran.out).toContain("File      objects/ws-a.jsonl");
		expect(ran.out).toContain("Objects   2, a database each; --object <name> shows one");
		expect(ran.out).not.toContain("Database");

		const one = await cli(["show", dir, "--object", "ws-b"]);
		expect(one.code).toBe(0);
		expect(one.out).toContain("Object    ws-b");
		expect(one.out).toMatch(/Database {2}1 tables, 2 rows/);
		expect(one.out).toMatch(/issue\s+2/);
		expect(one.out).not.toContain("Kept");

		const json = JSON.parse((await cli(["show", dir, "--json"])).out);
		expect(json.objects).toEqual(["ws-a", "ws-b"]);

		const missing = await cli(["show", dir, "--object", "ws-c"]);
		expect(missing.code).toBe(1);
		expect(missing.err).toContain("holds no object ws-c.");
	});

	it("checks every object's database by restoring it into memory", async () => {
		const { dir, rows: rowCount } = await objectsRepository();
		const ran = await cli(["check", dir]);
		expect(ran.code).toBe(0);
		expect(ran.out).toMatch(
			new RegExp(`^ok {6}\\S+: read .+, restored 2 objects: 5 tables and ${rowCount} rows$`, "m"),
		);
	});

	it("names the object whose database doesn't come back", async () => {
		const { store: objects, dir } = await objectsRepository();
		const repo = await Repository.open(new FolderStore(dir), KEY);
		const [name] = await repo.snapshots();
		const manifest = await repo.manifest(name ?? "");
		const chunk = manifest.files.find((entry) => entry.path === "objects/ws-b.jsonl")?.chunks[0];
		if (!chunk) throw new Error("No chunk.");
		const key = `data/${chunk.slice(0, 2)}/${chunk}`;
		expect(objects.objects.has(key)).toBe(true);
		const path = join(dir, ...key.split("/"));
		const bytes = readFileSync(path);
		bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
		writeFileSync(path, bytes);

		const ran = await cli(["check", dir]);
		expect(ran.code).toBe(1);
		expect(ran.out).toMatch(/^FAILED {2}\S+: ws-b: /m);
	});

	it("restores each object as its own SQL file, or one as SQLite", async () => {
		const { dir } = await objectsRepository();
		const to = join(temp, `objects-sql-${crypto.randomUUID()}`);
		const ran = await cli(["restore", dir, "--to", to]);
		expect(ran.code).toBe(0);
		expect(ran.out).toContain("2 objects, 5 tables");
		expect(ran.out).not.toContain("wrangler d1 execute");
		expect(readdirSync(to).sort()).toEqual(["ws-a.sql", "ws-b.sql"]);
		const db = new DatabaseSync(":memory:");
		db.exec(readFileSync(join(to, "ws-b.sql"), "utf8"));
		expect(db.prepare("SELECT id, title FROM issue ORDER BY id").all()).toEqual(
			small().prepare("SELECT id, title FROM issue ORDER BY id").all(),
		);

		const one = join(temp, `objects-sqlite-${crypto.randomUUID()}`);
		const single = await cli(["restore", dir, "--to", one, "--as", "sqlite", "--object", "ws-a"]);
		expect(single.code).toBe(0);
		expect(single.out).toContain("1 object, 4 tables");
		expect(readdirSync(one)).toEqual(["ws-a.sqlite"]);
		const restored = new DatabaseSync(join(one, "ws-a.sqlite"));
		expect(restored.prepare("SELECT name FROM team ORDER BY id").all()).toEqual(
			sample().prepare("SELECT name FROM team ORDER BY id").all(),
		);
		restored.close();

		const files = join(temp, `objects-files-${crypto.randomUUID()}`);
		expect((await cli(["restore", dir, "--to", files, "--as", "files"])).code).toBe(0);
		expect(readdirSync(join(files, "objects")).sort()).toEqual(["ws-a.jsonl", "ws-b.jsonl"]);
	});

	it("takes --object only for a snapshot of objects, and only to show or restore", async () => {
		const wrong = await cli(["show", repoDir, "--object", "ws-a"]);
		expect(wrong.code).toBe(1);
		expect(wrong.err).toContain("is of one database, not of objects: leave out --object.");

		const check = await cli(["check", repoDir, "--object", "ws-a"]);
		expect(check.code).toBe(2);
		expect(check.err).toContain("--object is for show and restore.");
	});
});

describe("the key", () => {
	it("comes from a file, and never shows up in what the CLI prints", async () => {
		const file = join(temp, "key.txt");
		writeFileSync(file, `${KEY}\n`);
		const ran = await cli(["snapshots", repoDir, "--key-file", file], { env: {} });
		expect(ran.code).toBe(0);
		expect(ran.out + ran.err).not.toContain(KEY);
	});

	it("comes from a file PowerShell wrote, in UTF-16", async () => {
		const file = join(temp, "key-utf16.txt");
		const text = Buffer.from(`${KEY}\r\n`, "utf16le");
		writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), text]));
		const ran = await cli(["snapshots", repoDir, "--key-file", file], { env: {} });
		expect(ran.err).toBe("");
		expect(ran.code).toBe(0);
	});

	it("is asked for when nothing gives it", async () => {
		const ran = await cli(["snapshots", repoDir], { env: {}, ask: async () => KEY });
		expect(ran.code).toBe(0);
	});

	it("is never taken as an argument", async () => {
		const ran = await cli(["snapshots", repoDir, "--key", KEY]);
		expect(ran.code).toBe(2);
		expect(ran.err).not.toContain(KEY);
	});
});

describe("an S3-compatible bucket", () => {
	let server: Server;
	let endpoint: string;
	const methods = new Set<string>();
	const authorizations: string[] = [];
	const ODD = "odd folder+~é";
	let busyOnce = false;

	beforeAll(async () => {
		// The repository sits in a folder of the bucket, as the Worker keeps one per source.
		const objects = new Map<string, Uint8Array>(
			[...store.objects].map(([key, value]) => [`track/${key}`, value] as const),
		);
		objects.set("other/config.json", utf8("{}"));
		// A folder whose name needs escaping, and one that is busy once.
		for (const folder of [ODD, "flaky"]) {
			for (const [key, value] of store.objects) objects.set(`${folder}/${key}`, value);
		}
		server = createServer((request, response) => {
			methods.add(request.method ?? "");
			authorizations.push(request.headers.authorization ?? "");
			// Signed again here from what arrived, so a path or query sent unlike it was signed fails,
			// as R2 would refuse it.
			const [rawPath = "/", rawQuery = ""] = (request.url ?? "/").split("?");
			const amzDate = String(request.headers["x-amz-date"] ?? "");
			const expected = authorization(
				{
					method: request.method ?? "",
					path: rawPath,
					query: [...new URLSearchParams(rawQuery)],
					headers: [
						["host", String(request.headers.host)],
						["x-amz-content-sha256", String(request.headers["x-amz-content-sha256"])],
						["x-amz-date", amzDate],
					],
					payloadHash: EMPTY_SHA256,
				},
				{ accessKeyId: "test-access-key", secretAccessKey: "test-secret" },
				"auto",
				amzDate,
			);
			if (request.headers.authorization !== expected) {
				response.statusCode = 403;
				response.end("<Error><Code>SignatureDoesNotMatch</Code></Error>");
				return;
			}
			const url = new URL(request.url ?? "/", "http://bucket");
			if (url.pathname === "/vault/" && url.searchParams.get("list-type") === "2") {
				// Two keys a page, so the CLI has to follow continuation tokens.
				const prefix = url.searchParams.get("prefix") ?? "";
				const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
				const start = Number(url.searchParams.get("continuation-token") ?? "0");
				const page = keys.slice(start, start + 2);
				const more = start + 2 < keys.length;
				response.setHeader("content-type", "application/xml");
				response.end(
					`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>${more}</IsTruncated>${page
						.map((key) => `<Contents><Key>${key}</Key><Size>1</Size></Contents>`)
						.join(
							"",
						)}${more ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ""}</ListBucketResult>`,
				);
				return;
			}
			const key = decodeURIComponent(rawPath.replace(/^\/vault\//, ""));
			if (key === "flaky/config.json" && !busyOnce) {
				busyOnce = true;
				response.statusCode = 503;
				response.end("<Error><Code>SlowDown</Code></Error>");
				return;
			}
			const value = objects.get(key);
			if (!value) {
				response.statusCode = 404;
				response.end("<Error><Code>NoSuchKey</Code></Error>");
				return;
			}
			response.end(request.method === "HEAD" ? undefined : Buffer.from(value));
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(() => {
		server.close();
	});

	const env = () => ({
		GATEWEAVE_BACKUP_KEY: KEY,
		AWS_ENDPOINT_URL: endpoint,
		AWS_ACCESS_KEY_ID: "test-access-key",
		AWS_SECRET_ACCESS_KEY: "test-secret",
	});

	it("restores from a folder of the bucket, with signed reads only", async () => {
		const to = join(temp, "from-s3");
		const ran = await cli(["restore", "s3://vault/track", "--to", to, "--as", "sqlite"], {
			env: env(),
		});
		expect(ran.err).toBe("");
		expect(ran.code).toBe(0);
		const db = new DatabaseSync(join(to, "database.sqlite"));
		expect(db.prepare("SELECT count(*) AS n FROM team").get()).toEqual({ n: 3 });
		db.close();
		expect([...methods].every((method) => method === "GET" || method === "HEAD")).toBe(true);
		expect(
			authorizations.every((value) =>
				/^AWS4-HMAC-SHA256 Credential=test-access-key\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/.test(
					value,
				),
			),
		).toBe(true);
	});

	it("signs a folder whose name needs escaping as it sends it", async () => {
		const ran = await cli(["show", `s3://vault/${ODD}`], { env: env() });
		expect(ran.err).toBe("");
		expect(ran.out).toContain(second);
	});

	it("tries again when the bucket is busy", async () => {
		const ran = await cli(["snapshots", "s3://vault/flaky"], { env: env() });
		expect(ran.code).toBe(0);
		expect(busyOnce).toBe(true);
	});

	it("refuses a folder with a part a URL would tidy away", async () => {
		const ran = await cli(["snapshots", "s3://vault/track/../other"], { env: env() });
		expect(ran.code).toBe(1);
		expect(ran.err).toContain(".. part");
	});

	it("lists every snapshot across pages", async () => {
		const ran = await cli(["snapshots", "s3://vault/track", "--json"], { env: env() });
		expect(JSON.parse(ran.out).map((s: { name: string }) => s.name)).toEqual([first, second]);
	});

	it("says what is missing to reach a bucket", async () => {
		const ran = await cli(["snapshots", "s3://vault/track"], {
			env: { GATEWEAVE_BACKUP_KEY: KEY },
		});
		expect(ran.code).toBe(1);
		expect(ran.err).toContain("--endpoint or AWS_ENDPOINT_URL");
	});
});

interface Sample {
	object: Omit<BucketObject, "size">;
	bytes: Uint8Array<ArrayBuffer>;
}

function noise(size: number): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(size);
	for (let at = 0; at < size; at += 65_536) {
		crypto.getRandomValues(bytes.subarray(at, Math.min(size, at + 65_536)));
	}
	return bytes;
}

const UPLOADED = "2026-11-01T10:00:00.000Z";
const BUCKET: Sample[] = [
	{
		object: {
			key: "ws-1/f-1/report.pdf",
			etag: "e1",
			uploaded: UPLOADED,
			http: {
				contentType: "application/pdf",
				contentDisposition: 'attachment; filename="report.pdf"',
				cacheControl: "max-age=60",
				cacheExpiry: "2026-12-01T00:00:00.000Z",
			},
			custom: { uploadedBy: "user-1" },
		},
		// Many chunks, so the body goes out in many writes.
		bytes: noise(50_000),
	},
	{
		object: {
			key: "ws-1/f-2/naïve notes.txt",
			etag: "e2",
			uploaded: UPLOADED,
			http: { contentType: "text/plain; charset=utf-8", contentLanguage: "tr" },
			custom: { note: "çok güzel", plain: "=?not encoded?=" },
		},
		bytes: utf8("merhaba dünya\n"),
	},
	{
		object: { key: "ws-2/f-3/empty", etag: "e3", uploaded: UPLOADED, http: {}, custom: {} },
		bytes: new Uint8Array(0),
	},
];

/** A repository holding one snapshot of a bucket, copied to a folder of its own. */
async function bucketRepository(samples: Sample[]) {
	const objects = new MemoryStore();
	const repo = await Repository.init(objects, KEY, { chunker: { min: 256, avg: 1024, max: 4096 } });
	const entries: FileEntry[] = [];
	const listed: BucketObject[] = [];
	for (const { object, bytes } of samples) {
		entries.push((await repo.writeFile(bucketFile(object.key), bytes)).entry);
		listed.push({ ...object, size: bytes.length });
	}
	entries.push((await repo.writeFile(BUCKET_INDEX, writeBucketIndex(listed))).entry);
	const manifest = await repo.commit({ kind: "r2", name: "track-files" }, entries, {
		objects: listed.length,
	});
	const dir = join(temp, `bucket-${crypto.randomUUID()}`);
	writeOut(objects, dir);
	return { dir, manifest };
}

/** Flips a byte in the chunk of a snapshot's file, in the repository copied to `dir`. */
function damage(dir: string, entry: FileEntry | undefined, index: number) {
	const id = entry?.chunks[index];
	if (!id) throw new Error("No such chunk.");
	const path = join(dir, "data", id.slice(0, 2), id);
	const bytes = readFileSync(path);
	bytes[20] = (bytes[20] ?? 0) ^ 1;
	writeFileSync(path, bytes);
}

describe("restoring a snapshot of a bucket", () => {
	let server: Server;
	let endpoint: string;
	let repo: { dir: string; manifest: Manifest };
	/** What the bucket `live` holds: each object's bytes and the headers it came with. */
	const live = new Map<string, { bytes: Buffer; headers: [string, string][] }>();
	const puts: { key: string; status: number; headers: [string, string][] }[] = [];
	const busy = new Set<string>();
	const SECRETS: Record<string, string> = { "write-key": "write-secret" };

	beforeAll(async () => {
		repo = await bucketRepository(BUCKET);
		server = createServer(async (request, response) => {
			const answer = (status: number, code?: string) => {
				response.statusCode = status;
				response.end(code ? `<Error><Code>${code}</Code></Error>` : undefined);
			};
			const parts: Buffer[] = [];
			try {
				for await (const part of request) parts.push(part as Buffer);
			} catch {
				// The client gave up half way: nothing is stored.
			}
			if (!request.complete) return;
			const body = Buffer.concat(parts);
			const headers: [string, string][] = [];
			for (let i = 0; i < request.rawHeaders.length; i += 2) {
				headers.push([request.rawHeaders[i] ?? "", request.rawHeaders[i + 1] ?? ""]);
			}
			// Signed again here from what arrived, over the headers it says it signed, which must be
			// every x-amz-* one and the body's SHA-256, as R2 checks them.
			const auth =
				/^AWS4-HMAC-SHA256 Credential=([^/]+)\/[^,]+, SignedHeaders=([^,]+), Signature=/.exec(
					request.headers.authorization ?? "",
				);
			const secret = SECRETS[auth?.[1] ?? ""];
			const signed = (auth?.[2] ?? "").split(";");
			const [rawPath = "/", rawQuery = ""] = (request.url ?? "/").split("?");
			const amzDate = String(request.headers["x-amz-date"] ?? "");
			const payload = String(request.headers["x-amz-content-sha256"] ?? "");
			const unsigned = headers.some(
				([name]) =>
					/^(x-amz-|content-|cache-control$|expires$|if-)/i.test(name) &&
					!signed.includes(name.toLowerCase()),
			);
			if (!auth || !secret || unsigned) return answer(403, "AccessDenied");
			const expected = authorization(
				{
					method: request.method ?? "",
					path: rawPath,
					query: [...new URLSearchParams(rawQuery)],
					headers: signed.map((name) => [name, String(request.headers[name] ?? "")]),
					payloadHash: payload,
				},
				{ accessKeyId: auth[1] ?? "", secretAccessKey: secret },
				"auto",
				amzDate,
			);
			if (request.headers.authorization !== expected) return answer(403, "SignatureDoesNotMatch");
			if (createHash("sha256").update(body).digest("hex") !== payload) {
				return answer(400, "XAmzContentSHA256Mismatch");
			}
			if (request.method !== "PUT" || !rawPath.startsWith("/live/")) {
				return answer(405, "MethodNotAllowed");
			}
			const key = decodeURIComponent(rawPath.slice("/live/".length));
			if (busy.delete(key)) return answer(503, "SlowDown");
			const taken = request.headers["if-none-match"] === "*" && live.has(key);
			puts.push({ key, status: taken ? 412 : 200, headers });
			if (taken) return answer(412, "PreconditionFailed");
			live.set(key, { bytes: body, headers });
			answer(200);
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(() => {
		server.close();
	});

	const env = () => ({
		GATEWEAVE_BACKUP_KEY: KEY,
		// The repository's token, which may only read: not the one that writes.
		AWS_ACCESS_KEY_ID: "read-key",
		AWS_SECRET_ACCESS_KEY: "read-secret",
		GATEWEAVE_RESTORE_ENDPOINT_URL: endpoint,
		GATEWEAVE_RESTORE_ACCESS_KEY_ID: "write-key",
		GATEWEAVE_RESTORE_SECRET_ACCESS_KEY: "write-secret",
	});
	const header = (headers: [string, string][], name: string) =>
		headers.find(([sent]) => sent === name)?.[1];
	const word = (text: string) => `=?UTF-8?B?${Buffer.from(text).toString("base64")}?=`;

	it("puts every object back with its bytes and metadata, through PUTs that never replace", async () => {
		const ran = await cli(["restore", repo.dir, "--to", "s3://live"], { env: env() });
		expect(ran.err).toBe("");
		expect(ran.code).toBe(0);
		for (const { object } of BUCKET) expect(ran.out).toContain(`Put back ${object.key}\n`);
		expect(ran.out).toMatch(/Snapshot \S+: put back 3 objects, 50 kB, into s3:\/\/live\.\n/);
		for (const { object, bytes } of BUCKET) {
			expect(new Uint8Array(live.get(object.key)?.bytes ?? [])).toEqual(bytes);
		}
		expect(puts.every((put) => header(put.headers, "if-none-match") === "*")).toBe(true);

		const report = live.get("ws-1/f-1/report.pdf")?.headers ?? [];
		expect(header(report, "Content-Type")).toBe("application/pdf");
		expect(header(report, "Content-Disposition")).toBe('attachment; filename="report.pdf"');
		expect(header(report, "Cache-Control")).toBe("max-age=60");
		expect(header(report, "Expires")).toBe("Tue, 01 Dec 2026 00:00:00 GMT");
		// Sent as Track named it, though R2 keeps names in lower case, which the CLI says.
		expect(header(report, "x-amz-meta-uploadedBy")).toBe("user-1");
		expect(ran.out).toContain(
			"The S3 API keeps custom metadata names in lower case, so the bucket has uploadedBy as uploadedby.\n",
		);

		const notes = live.get("ws-1/f-2/naïve notes.txt")?.headers ?? [];
		expect(header(notes, "Content-Language")).toBe("tr");
		expect(header(notes, "x-amz-meta-note")).toBe(word("çok güzel"));
		// A value that would read as encoded is encoded, so it comes back as it was.
		expect(header(notes, "x-amz-meta-plain")).toBe(word("=?not encoded?="));

		// Nothing the object didn't have: fetch would add Cache-Control and Pragma to a PUT with
		// If-None-Match, and R2 would keep them.
		const empty = live.get("ws-2/f-3/empty")?.headers ?? [];
		const names = empty.map(([name]) => name.toLowerCase());
		for (const name of ["cache-control", "pragma", "content-type", "expires"]) {
			expect(names).not.toContain(name);
		}
		expect(names.filter((name) => name.startsWith("x-amz-meta-"))).toEqual([]);
	});

	it("puts back only what is missing, and leaves every object there as it is", async () => {
		live.delete("ws-2/f-3/empty");
		const kept = Buffer.from("someone else's bytes");
		live.set("ws-1/f-1/report.pdf", { bytes: kept, headers: [] });
		const ran = await cli(["restore", repo.dir, repo.manifest.name, "--to", "s3://live"], {
			env: env(),
		});
		expect(ran.code).toBe(0);
		expect(ran.out).toContain("Left ws-1/f-1/report.pdf: there already\n");
		expect(ran.out).toContain("Put back ws-2/f-3/empty\n");
		expect(ran.out).toContain(
			"put back 1 object, 0 B, into s3://live. 2 were there already and left as they are.",
		);
		expect(live.get("ws-1/f-1/report.pdf")?.bytes).toEqual(kept);
	});

	it("picks objects by --prefix, into a folder of the bucket, and tries again when it is busy", async () => {
		busy.add("restored/ws-1/f-2/naïve notes.txt");
		const ran = await cli(
			["restore", repo.dir, "--to", "s3://live/restored", "--prefix", "ws-1/"],
			{ env: env() },
		);
		expect(ran.err).toBe("");
		expect(ran.code).toBe(0);
		expect(busy.size).toBe(0);
		expect([...live.keys()].filter((key) => key.startsWith("restored/")).sort()).toEqual([
			"restored/ws-1/f-1/report.pdf",
			"restored/ws-1/f-2/naïve notes.txt",
		]);
		expect(ran.out).toContain("into s3://live/restored.");
	});

	it("writes the objects --prefix picks to a folder, with bucket.json", async () => {
		const to = join(temp, "bucket-folder");
		const ran = await cli(["restore", repo.dir, "--to", to, "--prefix", "ws-2/"]);
		expect(ran.code).toBe(0);
		expect(readdirSync(to, { recursive: true }).map(String).sort()).toEqual(
			[
				"bucket.json",
				"files",
				join("files", "ws-2"),
				join("files", "ws-2", "f-3"),
				join("files", "ws-2", "f-3", "empty"),
			].sort(),
		);
		const none = await cli(["restore", repo.dir, "--to", join(temp, "none"), "--prefix", "ws-9/"]);
		expect(none.code).toBe(1);
		expect(none.err).toContain('holds no object whose key starts with "ws-9/"');
	});

	it("stops at an object whose chunk was damaged, and the bucket never gets it", async () => {
		const files = new Map(repo.manifest.files.map((entry) => [entry.path, entry]));
		const broken = join(temp, `bucket-broken-${crypto.randomUUID()}`);
		cpSync(repo.dir, broken, { recursive: true });
		// Half way through the first object's body.
		damage(broken, files.get("files/ws-1/f-1/report.pdf"), 10);
		const ran = await cli(["restore", broken, "--to", "s3://live/broken"], { env: env() });
		expect(ran.code).toBe(1);
		expect(ran.err).toContain("could not be opened");
		expect([...live.keys()].filter((key) => key.startsWith("broken/"))).toEqual([]);

		// One put, then the next object fails: the restore says what is there, and run again
		// once the repository is whole, it puts back the rest.
		const half = join(temp, `bucket-half-${crypto.randomUUID()}`);
		cpSync(repo.dir, half, { recursive: true });
		damage(half, files.get("files/ws-1/f-2/naïve notes.txt"), 0);
		const stopped = await cli(["restore", half, "--to", "s3://live/half"], { env: env() });
		expect(stopped.code).toBe(1);
		expect(stopped.out).toBe("Put back ws-1/f-1/report.pdf\n");
		expect(stopped.err).toContain(
			"1 object was put back before that; the same restore again puts back the rest.",
		);
		const again = await cli(["restore", repo.dir, "--to", "s3://live/half"], { env: env() });
		expect(again.out).toContain("put back 2 objects");
		expect(again.out).toContain("1 was there already and left as it is.");
	});

	it("refuses metadata the S3 API can't carry, before putting anything", async () => {
		const odd: Record<string, string>[] = [{ ünï: "x" }, { tag: "a", TAG: "b" }];
		for (const custom of odd) {
			const made = await bucketRepository([
				{ object: { key: "a", etag: "e", uploaded: UPLOADED, http: {}, custom }, bytes: utf8("a") },
				{
					object: { key: "b", etag: "e", uploaded: UPLOADED, http: {}, custom: {} },
					bytes: utf8("b"),
				},
			]);
			const before = puts.length;
			const ran = await cli(["restore", made.dir, "--to", "s3://live/odd"], { env: env() });
			expect(ran.code).toBe(1);
			expect(ran.err).toContain("which the S3 API can't carry");
			expect(puts.length).toBe(before);
		}
	});

	it("uses the AWS_ variables for the bucket when there are no GATEWEAVE_RESTORE_ ones", async () => {
		const ran = await cli(["restore", repo.dir, "--to", "s3://live/aws", "--prefix", "ws-2/"], {
			env: {
				GATEWEAVE_BACKUP_KEY: KEY,
				AWS_ENDPOINT_URL: endpoint,
				AWS_ACCESS_KEY_ID: "write-key",
				AWS_SECRET_ACCESS_KEY: "write-secret",
			},
		});
		expect(ran.err).toBe("");
		expect(live.has("aws/ws-2/f-3/empty")).toBe(true);
	});

	it("puts only a bucket's snapshot into a bucket, and says what it needs to reach one", async () => {
		const database = await cli(["restore", repoDir, "--to", "s3://live/db"], { env: env() });
		expect(database.code).toBe(1);
		expect(database.err).toContain("not of a bucket");

		const unreached = await cli(["restore", repo.dir, "--to", "s3://live"], {
			env: { GATEWEAVE_BACKUP_KEY: KEY },
		});
		expect(unreached.code).toBe(1);
		expect(unreached.err).toContain("--to-endpoint, GATEWEAVE_RESTORE_ENDPOINT_URL");

		const as = await cli(["restore", repo.dir, "--to", "s3://live", "--as", "files"], {
			env: env(),
		});
		expect(as.code).toBe(2);
		const where = await cli(["restore", repo.dir, "--to", join(temp, "x"), "--to-region", "eu"]);
		expect(where.code).toBe(2);
		const prefix = await cli(["show", repo.dir, "--prefix", "ws-1/"]);
		expect(prefix.code).toBe(2);
	});
});

describe("the store", () => {
	it("never writes to a repository", async () => {
		const folder = new FolderStore(repoDir);
		await expect(folder.put()).rejects.toThrow(StoreError);
		await expect(folder.delete()).rejects.toThrow(StoreError);
	});

	it("reads only the names the format makes", async () => {
		const folder = new FolderStore(repoDir);
		await expect(folder.get("../outside")).rejects.toThrow(StoreError);
		await expect(folder.get("data/../config.json")).rejects.toThrow(StoreError);
	});

	it("reads a listing's escaped keys", () => {
		expect(
			parseListing(
				"<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>a&amp;b&#x2F;c</Key></Contents></ListBucketResult>",
			),
		).toEqual({ keys: ["a&b/c"], next: null });
	});
});

describe("the bundle", () => {
	it("runs on its own with Node, the way an owner restores", () => {
		execFileSync(process.execPath, ["build.mjs"], { cwd: PACKAGE });
		const bundle = join(PACKAGE, "dist", "gateweave-backup.mjs");
		const ran = spawnSync(process.execPath, [bundle, "snapshots", repoDir], {
			env: { ...process.env, GATEWEAVE_BACKUP_KEY: KEY },
			encoding: "utf8",
		});
		expect(ran.stderr).toBe("");
		expect(ran.status).toBe(0);
		expect(ran.stdout).toContain(second);

		const help = spawnSync(process.execPath, [bundle, "--help"], { encoding: "utf8" });
		expect(help.stdout).toBe(HELP);
	});

	it("reads a key piped in from a password manager", () => {
		const bundle = join(PACKAGE, "dist", "gateweave-backup.mjs");
		const env = { ...process.env };
		delete env.GATEWEAVE_BACKUP_KEY;
		const ran = spawnSync(process.execPath, [bundle, "snapshots", repoDir], {
			env,
			input: `${KEY}\n`,
			encoding: "utf8",
		});
		expect(ran.status).toBe(0);
		expect(ran.stdout).toContain(first);
	});
});
