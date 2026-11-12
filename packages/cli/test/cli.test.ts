import { execFileSync, spawnSync } from "node:child_process";
import {
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
	dumpSqlite,
	generateMasterKey,
	joinLines,
	MemoryStore,
	Repository,
	type Row,
	utf8,
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
