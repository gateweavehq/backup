import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
	DumpError,
	dumpSqlite,
	ftsContent,
	ident,
	joinLines,
	type Row,
	restoreSql,
	type SqlReader,
	splitLines,
} from "../src/sqlite";

/** Reads synchronously, one statement after another, as a Durable Object does: one moment. */
function reader(db: DatabaseSync): SqlReader {
	return {
		async readTogether(statements) {
			return statements.map((sql) => db.prepare(sql).all() as Row[]);
		},
	};
}

function restore(lines: string[]): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec("BEGIN");
	for (const statement of restoreSql(lines)) db.exec(statement);
	db.exec("COMMIT");
	return db;
}

/** Every table's rows as quoted literals, rowid order, so two databases can be compared. */
function contents(db: DatabaseSync, tables: string[]): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const table of tables) {
		const cols = (db.prepare(`PRAGMA table_info(${ident(table)})`).all() as { name: string }[]).map(
			(c) => `quote(${ident(c.name)})`,
		);
		out[table] = (
			db
				.prepare(`SELECT ${cols.join(" || ',' || ")} AS v FROM ${ident(table)} ORDER BY 1`)
				.all() as {
				v: string;
			}[]
		).map((r) => r.v);
	}
	return out;
}

function sample(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		PRAGMA foreign_keys = on;
		CREATE TABLE team (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
		CREATE TABLE "user" (
			id TEXT PRIMARY KEY,
			team_id INTEGER REFERENCES team(id),
			email TEXT NOT NULL,
			score REAL,
			big INTEGER,
			avatar BLOB,
			lower_email TEXT GENERATED ALWAYS AS (lower(email)) VIRTUAL
		);
		CREATE TABLE "odd ""name""" (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
		CREATE TABLE event (id INTEGER PRIMARY KEY AUTOINCREMENT, what TEXT);
		CREATE INDEX user_email ON "user"(email);
		CREATE VIEW team_size AS SELECT team_id, count(*) AS n FROM "user" GROUP BY team_id;
		CREATE TABLE issue (id INTEGER PRIMARY KEY, title TEXT, body TEXT);
		CREATE VIRTUAL TABLE issue_search USING fts5(title, body, content='issue', content_rowid='id');
		CREATE TRIGGER issue_ai AFTER INSERT ON issue BEGIN
			INSERT INTO issue_search(rowid, title, body) VALUES (new.id, new.title, new.body);
		END;
		CREATE VIRTUAL TABLE notes USING fts5(text);
		CREATE VIRTUAL TABLE hashes USING fts5(text, content='');
		CREATE TRIGGER user_event AFTER INSERT ON "user" BEGIN
			INSERT INTO event (what) VALUES ('user ' || new.id);
		END;
	`);
	const team = db.prepare("INSERT INTO team (name) VALUES (?)");
	team.run("Core");
	team.run('Edge\'s "team"');
	const user = db.prepare(
		'INSERT INTO "user" (id, team_id, email, score, big, avatar) VALUES (?, ?, ?, ?, ?, ?)',
	);
	user.run("u1", 1, "Ada@Example.com", 0.1 + 0.2, 9007199254740993n, new Uint8Array([0, 255, 10]));
	user.run("u2", 2, "line\nbreak'quote\"", null, -1n, null);
	user.run("u3", null, "émoji 🎉", 1e-300, 0n, new Uint8Array(0));
	db.prepare(`INSERT INTO "odd ""name""" VALUES (?, ?)`).run("b", "2");
	db.prepare(`INSERT INTO "odd ""name""" VALUES (?, ?)`).run("a", "1");
	db.exec("DELETE FROM event WHERE id = 3");
	const issue = db.prepare("INSERT INTO issue (title, body) VALUES (?, ?)");
	issue.run("Sync breaks offline", "The replica stops after a reconnect");
	issue.run("Search is slow", "FTS should be fast");
	db.prepare("INSERT INTO notes (rowid, text) VALUES (?, ?)").run(42, "remember the milk");
	db.prepare("INSERT INTO hashes (text) VALUES (?)").run("gone after restore");
	return db;
}

const TABLES = ["team", "user", 'odd "name"', "event", "issue"];

describe("SQLite dumps", () => {
	it("restore every row, value for value", async () => {
		const db = sample();
		const dump = await dumpSqlite(reader(db));
		const copy = restore(dump.lines);
		expect(contents(copy, TABLES)).toEqual(contents(db, TABLES));
	});

	it("keep exact numbers, text and blobs", async () => {
		const copy = restore((await dumpSqlite(reader(sample()))).lines);
		const u1 = copy
			.prepare(`SELECT score, quote(big) AS big, hex(avatar) AS avatar FROM "user" WHERE id = 'u1'`)
			.get();
		expect(u1).toEqual({ score: 0.30000000000000004, big: "9007199254740993", avatar: "00FF0A" });
		const u2 = copy.prepare(`SELECT email FROM "user" WHERE id = 'u2'`).get();
		expect(u2).toEqual({ email: "line\nbreak'quote\"" });
		const u3 = copy
			.prepare(`SELECT email, lower_email, length(avatar) AS n FROM "user" WHERE id = 'u3'`)
			.get();
		expect(u3).toEqual({ email: "émoji 🎉", lower_email: "émoji 🎉", n: 0 });
	});

	it("bring back indexes, views, triggers and AUTOINCREMENT counters", async () => {
		const copy = restore((await dumpSqlite(reader(sample()))).lines);
		const names = copy
			.prepare(
				"SELECT type, name FROM sqlite_master WHERE type IN ('index', 'view', 'trigger') AND sql IS NOT NULL ORDER BY name",
			)
			.all();
		expect(names).toEqual([
			{ type: "trigger", name: "issue_ai" },
			{ type: "view", name: "team_size" },
			{ type: "index", name: "user_email" },
			{ type: "trigger", name: "user_event" },
		]);
		// The trigger runs after the restore, not during it, and the counter carries on.
		copy.prepare(`INSERT INTO "user" (id, email) VALUES ('u4', 'new@example.com')`).run();
		expect(copy.prepare("SELECT max(id) AS id FROM event").get()).toEqual({ id: 4 });
	});

	it("rebuild search indexes, keep FTS text with its rowids, and say what can't come back", async () => {
		const db = sample();
		const dump = await dumpSqlite(reader(db));
		expect(dump.stats.empty).toEqual(["hashes"]);
		const copy = restore(dump.lines);
		const found = copy
			.prepare("SELECT rowid FROM issue_search WHERE issue_search MATCH 'replica'")
			.all();
		expect(found).toEqual([{ rowid: 1 }]);
		expect(copy.prepare("SELECT rowid, text FROM notes").all()).toEqual([
			{ rowid: 42, text: "remember the milk" },
		]);
		expect(copy.prepare("SELECT count(*) AS n FROM hashes").get()).toEqual({ n: 0 });
	});

	it("leave out shadow tables and SQLite's own", async () => {
		const dump = await dumpSqlite(reader(sample()));
		const names = dump.lines
			.map((l) => JSON.parse(l))
			.filter((l) => l.k === "table")
			.map((l) => l.name);
		expect(names).toEqual(["team", "user", 'odd "name"', "event", "issue"]);
		expect(dump.lines.join("\n")).not.toContain("issue_search_data");
	});

	it("leave generated columns to the database", async () => {
		const dump = await dumpSqlite(reader(sample()));
		const user = dump.lines
			.map((l) => JSON.parse(l))
			.find((l) => l.k === "table" && l.name === "user");
		expect(user.cols).not.toContain("lower_email");
	});

	it("come out the same for the same data, so unchanged data dedupes", async () => {
		const db = sample();
		expect(joinLines((await dumpSqlite(reader(db))).lines)).toBe(
			joinLines((await dumpSqlite(reader(db))).lines),
		);
	});

	it("start over when the schema changes between rounds", async () => {
		const db = sample();
		let rounds = 0;
		const changing: SqlReader = {
			async readTogether(statements) {
				rounds++;
				if (rounds === 3) db.exec("CREATE TABLE late (x)");
				return statements.map((sql) => db.prepare(sql).all() as Row[]);
			},
		};
		const dump = await dumpSqlite(changing);
		expect(dump.lines.some((l) => l.includes('"name":"late"'))).toBe(true);
		expect(rounds).toBe(6);
	});

	it("give up when the schema never settles", async () => {
		const db = sample();
		let n = 0;
		const restless: SqlReader = {
			async readTogether(statements) {
				const rows = statements.map((sql) => db.prepare(sql).all() as Row[]);
				db.exec(`CREATE TABLE t${n++} (x)`);
				return rows;
			},
		};
		await expect(dumpSqlite(restless)).rejects.toBeInstanceOf(DumpError);
	});

	it("dump an empty database", async () => {
		const copy = restore((await dumpSqlite(reader(new DatabaseSync(":memory:")))).lines);
		expect(copy.prepare("SELECT count(*) AS n FROM sqlite_master").get()).toEqual({ n: 0 });
	});
});

describe("restoring a dump", () => {
	it("refuses one that stops early", async () => {
		const lines = (await dumpSqlite(reader(sample()))).lines;
		expect(() => [...restoreSql(lines.slice(0, -1))]).toThrow(/incomplete/);
	});

	it("refuses one whose row count is off", async () => {
		const lines = (await dumpSqlite(reader(sample()))).lines;
		const firstRow = lines.findIndex((x) => x.includes('"k":"row"'));
		const missingRow = lines.filter((_, at) => at !== firstRow);
		expect(() => [...restoreSql(missingRow)]).toThrow(/rows but holds/);
	});

	it("refuses what isn't a dump", () => {
		expect(() => [...restoreSql(["not json"])]).toThrow(DumpError);
		expect(() => [...restoreSql([])]).toThrow(/empty/);
		expect(() => [...restoreSql(['{"k":"head","format":"other","version":1}'])]).toThrow(
			/version 1/,
		);
	});

	it("refuses rows for a table it never made", () => {
		const lines = [
			'{"k":"head","format":"sqlite-jsonl","version":1,"consistent":true}',
			'{"k":"row","t":"user","v":"1"}',
		];
		expect(() => [...restoreSql(lines)]).toThrow(/hasn't made/);
	});

	it("survives a round trip through one file", async () => {
		const lines = (await dumpSqlite(reader(sample()))).lines;
		expect(splitLines(joinLines(lines))).toEqual(lines);
	});
});

describe("FTS5 content", () => {
	it("tells own, external and contentless tables apart", () => {
		expect(ftsContent("CREATE VIRTUAL TABLE a USING fts5(x)")).toBe("own");
		expect(ftsContent("CREATE VIRTUAL TABLE a USING fts5(x, content='issue')")).toBe("external");
		expect(ftsContent("CREATE VIRTUAL TABLE a USING fts5(x, content = issue)")).toBe("external");
		expect(ftsContent("CREATE VIRTUAL TABLE a USING fts5(x, content='')")).toBe("none");
		expect(ftsContent('CREATE VIRTUAL TABLE a USING fts5(x, content="")')).toBe("none");
	});
});
