import { createHash } from "node:crypto";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	DumpError,
	type FileEntry,
	fromUtf8,
	ident,
	type Manifest,
	type Repository,
	RepositoryError,
	restoreSql,
	splitLines,
} from "@gateweave/backup-core";

/** The file a SQLite source's snapshot holds: docs/format.md, "SQLite dumps". */
export const DUMP_FILE = "database.jsonl";

/** Something a restore refuses to do, such as write over a file that is there. */
export class RestoreError extends Error {
	override name = "RestoreError";
}

/** A snapshot's name: the one asked for, or the newest for `latest` or nothing. */
export async function pickSnapshot(repo: Repository, wanted?: string): Promise<string> {
	const names = await repo.snapshots();
	const newest = names.at(-1);
	if (newest === undefined) throw new RepositoryError("The repository has no snapshots yet.");
	if (wanted === undefined || wanted === "latest") return newest;
	if (!names.includes(wanted)) throw new RepositoryError(`Snapshot ${wanted} is not here.`);
	return wanted;
}

export interface TableSummary {
	name: string;
	rows: number;
	/** A virtual table, such as an FTS5 index, whose rows may be rebuilt rather than listed. */
	virtual: boolean;
}

export interface DumpSummary {
	/** Whether every row was read at the same moment. */
	consistent: boolean;
	tables: TableSummary[];
	rows: number;
}

/** What a dump holds: its tables and how many rows each has. Names and counts, never values. */
export function summarize(lines: string[]): DumpSummary {
	const summary: DumpSummary = { consistent: false, tables: [], rows: 0 };
	const byName = new Map<string, TableSummary>();
	let ended = false;
	lines.forEach((text, index) => {
		if (text.trim() === "") return;
		let line: { k?: unknown; name?: unknown; t?: unknown; consistent?: unknown };
		try {
			line = JSON.parse(text);
		} catch {
			throw new DumpError(`Line ${index + 1} of the dump is not a dump line.`);
		}
		if (line.k === "head") summary.consistent = line.consistent === true;
		else if ((line.k === "table" || line.k === "virtual") && typeof line.name === "string") {
			const table = { name: line.name, rows: 0, virtual: line.k === "virtual" };
			byName.set(line.name, table);
			summary.tables.push(table);
		} else if (line.k === "row" && typeof line.t === "string") {
			const table = byName.get(line.t);
			if (!table)
				throw new DumpError(`Line ${index + 1} has a row for a table the dump hasn't made.`);
			table.rows++;
			summary.rows++;
		} else if (line.k === "end") ended = true;
	});
	if (!ended) throw new DumpError("The dump stops before its end: it is incomplete.");
	return summary;
}

/** A file's bytes as they come, checked against the manifest's size and SHA-256 at the end. */
async function* verified(repo: Repository, entry: FileEntry): AsyncGenerator<Uint8Array> {
	const hash = createHash("sha256");
	let size = 0;
	for await (const chunk of repo.readFile(entry)) {
		size += chunk.length;
		if (size > entry.size) {
			throw new RepositoryError(`${entry.path} is longer than its manifest says.`);
		}
		hash.update(chunk);
		yield chunk;
	}
	if (size !== entry.size || hash.digest("hex") !== entry.sha256) {
		throw new RepositoryError(`${entry.path} doesn't match its manifest.`);
	}
}

async function readDump(repo: Repository, manifest: Manifest): Promise<string[]> {
	const entry = manifest.files.find((file) => file.path === DUMP_FILE);
	if (!entry) throw new RestoreError(`Snapshot ${manifest.name} holds no database.`);
	return splitLines(fromUtf8(await repo.readWholeFile(entry)));
}

/**
 * Loads a dump into an open, empty SQLite database in one transaction, which is rolled back when
 * anything fails, including a dump that turns out to be incomplete at its end.
 */
function load(db: DatabaseSync, lines: string[]): void {
	db.exec("BEGIN");
	try {
		for (const statement of restoreSql(lines)) {
			try {
				db.exec(statement);
			} catch (error) {
				throw new RestoreError(`${describe(statement)} failed: ${sqliteReason(error)}`);
			}
		}
		db.exec("COMMIT");
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// A failed COMMIT may have ended the transaction already.
		}
		if (error instanceof RestoreError || error instanceof DumpError) throw error;
		throw new RestoreError(`The database didn't load: ${sqliteReason(error)}`);
	}
}

/** A statement by what it does and to which object: `INSERT INTO "person"`, never its values. */
function describe(statement: string): string {
	return (statement.split(/\s*\(|\s+VALUES\b/i)[0] ?? "").slice(0, 120);
}

/** SQLite's reason, when it names only tables and columns; its error class otherwise. */
function sqliteReason(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	if (/^(UNIQUE|NOT NULL|CHECK|FOREIGN KEY|PRIMARY KEY) constraint failed\b/.test(message)) {
		return message.slice(0, 200);
	}
	return (error as { errstr?: string })?.errstr ?? "SQLite refused it";
}

export interface SnapshotInfo {
	name: string;
	created: string;
	source: Manifest["source"];
	files: { path: string; size: number }[];
	size: number;
	meta: Record<string, unknown>;
}

function infoOf(manifest: Manifest): SnapshotInfo {
	const files = manifest.files.map(({ path, size }) => ({ path, size }));
	return {
		name: manifest.name,
		created: manifest.created,
		source: manifest.source,
		files,
		size: files.reduce((sum, file) => sum + file.size, 0),
		meta: manifest.meta,
	};
}

export async function listSnapshots(repo: Repository): Promise<SnapshotInfo[]> {
	const out: SnapshotInfo[] = [];
	for (const name of await repo.snapshots()) out.push(infoOf(await repo.manifest(name)));
	return out;
}

/** A preview of a snapshot before restoring it: its files and, for a database, its tables. */
export async function showSnapshot(
	repo: Repository,
	name: string,
): Promise<SnapshotInfo & { database: DumpSummary | null }> {
	const manifest = await repo.manifest(name);
	const hasDump = manifest.files.some((file) => file.path === DUMP_FILE);
	return {
		...infoOf(manifest),
		database: hasDump ? summarize(await readDump(repo, manifest)) : null,
	};
}

export interface CheckResult {
	name: string;
	ok: boolean;
	bytes: number;
	/** For a database: the tables and rows that loaded into a scratch SQLite database. */
	tables?: number;
	rows?: number;
	error?: string;
}

/**
 * Reads a snapshot as a restore would, and restores it into a database in memory: every chunk
 * opened and checked against its id, every file against its size and SHA-256, and every table's
 * rows counted against the dump. Nothing is written to disk.
 */
export async function checkSnapshot(repo: Repository, name: string): Promise<CheckResult> {
	let bytes = 0;
	try {
		const manifest = await repo.manifest(name);
		const result: CheckResult = { name, ok: true, bytes: 0 };
		for (const entry of manifest.files) {
			if (entry.path === DUMP_FILE) continue;
			for await (const chunk of verified(repo, entry)) bytes += chunk.length;
		}
		if (manifest.files.some((file) => file.path === DUMP_FILE)) {
			const lines = await readDump(repo, manifest);
			bytes += manifest.files.find((file) => file.path === DUMP_FILE)?.size ?? 0;
			const summary = summarize(lines);
			const db = new DatabaseSync(":memory:");
			try {
				load(db, lines);
				for (const table of summary.tables) {
					if (table.virtual) continue;
					const found = db.prepare(`SELECT count(*) AS n FROM ${ident(table.name)}`).get() as {
						n: number;
					};
					if (found.n !== table.rows) {
						throw new RestoreError(
							`${table.name} came back with ${found.n} rows; the dump has ${table.rows}.`,
						);
					}
				}
			} finally {
				db.close();
			}
			result.tables = summary.tables.length;
			result.rows = summary.rows;
		}
		result.bytes = bytes;
		return result;
	} catch (error) {
		return { name, ok: false, bytes, error: messageOf(error) };
	}
}

export type RestoreAs = "sql" | "sqlite" | "files";

export interface RestoreReport {
	name: string;
	as: RestoreAs;
	written: string[];
	database: DumpSummary | null;
}

/**
 * Writes a snapshot out to a folder: as SQL to load into a new D1 database, as a SQLite file, or
 * as the files it holds. It writes only files that aren't there yet, and removes what it wrote
 * when anything fails, so nothing is ever restored over something else.
 */
export async function restoreSnapshot(
	repo: Repository,
	name: string,
	{ to, as }: { to: string; as?: RestoreAs },
): Promise<RestoreReport> {
	const manifest = await repo.manifest(name);
	const hasDump = manifest.files.some((file) => file.path === DUMP_FILE);
	const way: RestoreAs = as ?? (hasDump ? "sql" : "files");
	if (way !== "files" && !hasDump) {
		throw new RestoreError(`Snapshot ${name} holds no database; restore it --as files.`);
	}
	const folder = resolve(to);
	const targets =
		way === "files"
			? manifest.files.map((file) => join(folder, ...safePath(file.path).split("/")))
			: [join(folder, way === "sql" ? "database.sql" : "database.sqlite")];
	for (const target of targets) {
		if (await exists(target)) {
			throw new RestoreError(
				`${target} is there already. A restore writes only new files, so it never replaces anything.`,
			);
		}
	}
	await mkdir(folder, { recursive: true });
	const written: string[] = [];
	try {
		if (way === "files") {
			for (const [index, entry] of manifest.files.entries()) {
				const target = targets[index] ?? "";
				await mkdir(resolve(target, ".."), { recursive: true });
				const file = await open(target, "wx");
				written.push(target);
				try {
					for await (const chunk of verified(repo, entry)) await file.write(chunk);
				} finally {
					await file.close();
				}
			}
			return { name, as: way, written, database: null };
		}
		const lines = await readDump(repo, manifest);
		const summary = summarize(lines);
		const target = targets[0] ?? "";
		const file = await open(target, "wx");
		written.push(target);
		if (way === "sql") {
			try {
				let batch = "";
				for (const statement of restoreSql(lines)) {
					batch += `${statement}\n`;
					if (batch.length >= 1 << 20) {
						await file.write(batch);
						batch = "";
					}
				}
				await file.write(batch);
			} finally {
				await file.close();
			}
		} else {
			// Made empty with `wx` above, so SQLite opens a file nobody else has.
			await file.close();
			const db = new DatabaseSync(target);
			try {
				load(db, lines);
			} finally {
				db.close();
			}
		}
		return { name, as: way, written, database: summary };
	} catch (error) {
		for (const path of written) await unlink(path).catch(() => {});
		throw error;
	}
}

/** A manifest's file path, which must stay inside the folder a restore writes to. */
function safePath(path: string): string {
	if (
		path === "" ||
		isAbsolute(path) ||
		path.includes("\\") ||
		path.includes("\0") ||
		path.split("/").some((part) => part === "" || part === "." || part === "..")
	) {
		throw new RestoreError(`The snapshot names a file ${JSON.stringify(path)} it can't write.`);
	}
	return path;
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if ((error as { code?: unknown })?.code === "ENOENT") return false;
		throw error;
	}
}

export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
