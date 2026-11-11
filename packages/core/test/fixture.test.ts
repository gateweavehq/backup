import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fromUtf8, utf8 } from "../src/bytes";
import { Repository } from "../src/repository";
import { dumpSqlite, joinLines, type Row, restoreSql, splitLines } from "../src/sqlite";
import { MemoryStore } from "../src/store";

/**
 * AGENTS.md, invariant 2: old backups always restore. `fixtures/v1` is a repository written by the
 * first version of this code, kept as it was. Its key is public, for this test only.
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "v1");
const KEY = "Z2F0ZXdlYXZlLWJhY2t1cCB0ZXN0IGZpeHR1cmUgMSE";

function load(dir: string): MemoryStore {
	const store = new MemoryStore();
	const walk = (path: string) => {
		for (const name of readdirSync(path)) {
			const full = join(path, name);
			if (statSync(full).isDirectory()) walk(full);
			else
				store.objects.set(
					relative(dir, full).replaceAll("\\", "/"),
					new Uint8Array(readFileSync(full)),
				);
		}
	};
	walk(dir);
	return store;
}

describe("a version 1 repository", () => {
	it.runIf(process.env.WRITE_FIXTURE === "1")("is written once, to keep", async () => {
		const db = new DatabaseSync(":memory:");
		db.exec(`
			CREATE TABLE person (id INTEGER PRIMARY KEY, email TEXT, joined INTEGER);
			INSERT INTO person (email, joined) VALUES ('ada@example.com', 1762891500000), ('grace@example.com', NULL);
		`);
		const dump = await dumpSqlite({
			async readTogether(statements) {
				return statements.map((sql) => db.prepare(sql).all() as Row[]);
			},
		});
		const store = new MemoryStore();
		const repo = await Repository.init(store, KEY, { now: new Date("2026-11-11T20:00:00Z") });
		const { entry } = await repo.writeFile("database.jsonl", utf8(joinLines(dump.lines)));
		await repo.commit(
			{ kind: "d1", name: "fixture" },
			[entry],
			{ rows: dump.stats.rows },
			new Date("2026-11-11T20:05:00Z"),
		);
		for (const [key, value] of store.objects) {
			const path = join(FIXTURE, key);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, value);
		}
	});

	it("still opens and restores", async () => {
		const repo = await Repository.open(load(FIXTURE), KEY);
		const [name] = await repo.snapshots();
		if (!name) throw new Error("The fixture has no snapshot.");
		const manifest = await repo.manifest(name);
		expect(manifest.source).toEqual({ kind: "d1", name: "fixture" });
		expect(manifest.meta).toEqual({ rows: 2 });
		const [file] = manifest.files;
		if (!file) throw new Error("The fixture's snapshot has no file.");
		const lines = splitLines(fromUtf8(await repo.readWholeFile(file)));
		const db = new DatabaseSync(":memory:");
		for (const statement of restoreSql(lines)) db.exec(statement);
		expect(db.prepare("SELECT id, email, joined FROM person ORDER BY id").all()).toEqual([
			{ id: 1, email: "ada@example.com", joined: 1762891500000 },
			{ id: 2, email: "grace@example.com", joined: null },
		]);
	});
});
