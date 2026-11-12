import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, type FileHandle, link, mkdir, open, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
	DUMP_FILE,
	DumpError,
	type DumpSummary,
	describeStatement,
	type FileEntry,
	fromUtf8,
	ident,
	type Manifest,
	type Repository,
	RepositoryError,
	restoreSql,
	splitLines,
	summarizeDump,
} from "@gateweave/backup-core";

/**
 * SQLite, loaded when a command needs it. Node 22 calls `node:sqlite` experimental and says so when
 * it loads, so main.ts first quiets that one warning.
 */
async function openSqlite(path: string): Promise<DatabaseSync> {
	const { DatabaseSync } = await import("node:sqlite");
	return new DatabaseSync(path);
}

/** Files being written, which main.ts removes should the CLI be stopped before it finishes. */
export const unfinished = new Set<string>();

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
				throw new RestoreError(`${describeStatement(statement)} failed: ${sqliteReason(error)}`);
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

/** A snapshot whose manifest doesn't open, listed as such so the others still are. */
export interface DamagedSnapshot {
	name: string;
	error: string;
}

/** Every snapshot, oldest first. One that doesn't open is listed with why, not left out. */
export async function listSnapshots(repo: Repository): Promise<(SnapshotInfo | DamagedSnapshot)[]> {
	const out: (SnapshotInfo | DamagedSnapshot)[] = [];
	for (const name of await repo.snapshots()) {
		try {
			out.push(infoOf(await repo.manifest(name)));
		} catch (error) {
			out.push({ name, error: messageOf(error) });
		}
	}
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
		database: hasDump ? summarizeDump(await readDump(repo, manifest)) : null,
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
			const summary = summarizeDump(lines);
			const db = await openSqlite(":memory:");
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
	for (const target of targets) if (await exists(target)) throw taken(target);
	await mkdir(folder, { recursive: true });
	const written: string[] = [];
	try {
		if (way === "files") {
			for (const [index, entry] of manifest.files.entries()) {
				const target = targets[index] ?? "";
				await mkdir(dirname(target), { recursive: true });
				await writeNew(target, async (file) => {
					for await (const chunk of verified(repo, entry)) await writeAll(file, chunk);
					return entry.size;
				});
				written.push(target);
			}
			return { name, as: way, written, database: null };
		}
		const lines = await readDump(repo, manifest);
		const summary = summarizeDump(lines);
		const target = targets[0] ?? "";
		if (way === "sql") {
			await writeNew(target, async (file) => {
				let size = 0;
				let batch = "";
				for (const statement of restoreSql(lines)) {
					batch += `${statement}\n`;
					if (batch.length >= 1 << 20) {
						size += await writeAll(file, batch);
						batch = "";
					}
				}
				return size + (await writeAll(file, batch));
			});
		} else {
			await writeNew(target, null, async (path) => {
				const db = await openSqlite(path);
				try {
					load(db, lines);
				} finally {
					db.close();
				}
			});
		}
		written.push(target);
		return { name, as: way, written, database: summary };
	} catch (error) {
		for (const path of written) await unlink(path).catch(() => {});
		throw error;
	}
}

/**
 * Writes a file under a name of its own beside `target`, then gives it its name with a hard link,
 * which refuses a name that is taken, where a rename would replace it. So a restore stopped half
 * way leaves nothing that looks finished, and never anything in a name that was there before.
 *
 * `write` writes through the open file and says how many bytes it wrote, which the file must then
 * have; or, with `build`, the file is made empty and `build` fills it by its path.
 */
async function writeNew(
	target: string,
	write: ((file: FileHandle) => Promise<number>) | null,
	build?: (path: string) => Promise<void>,
): Promise<void> {
	const partial = `${target}.partial-${randomBytes(4).toString("hex")}`;
	unfinished.add(partial);
	try {
		const file = await open(partial, "wx");
		let size: number | null = null;
		try {
			if (write) size = await write(file);
			await file.sync();
		} finally {
			await file.close();
		}
		if (build) await build(partial);
		if (size !== null && (await stat(partial)).size !== size) {
			throw new RestoreError(`${target} wasn't written whole: is the disk full?`);
		}
		await name(partial, target);
	} finally {
		await unlink(partial).catch(() => {});
		unfinished.delete(partial);
	}
}

/** Gives a written file its name, never over one that is there. */
async function name(partial: string, target: string): Promise<void> {
	try {
		await link(partial, target);
	} catch (error) {
		const code = (error as { code?: unknown })?.code;
		if (code === "EEXIST") throw taken(target);
		// A file system without hard links, such as FAT on a USB stick: a copy that refuses the name.
		if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV" && code !== "ENOSYS")
			throw error;
		try {
			await copyFile(partial, target, constants.COPYFILE_EXCL);
		} catch (copying) {
			if ((copying as { code?: unknown })?.code === "EEXIST") throw taken(target);
			throw copying;
		}
	}
}

function taken(target: string): RestoreError {
	return new RestoreError(
		`${target} is there already. A restore writes only new files, so it never replaces anything.`,
	);
}

/** Writes all of `data`, as one call to `write` may write less. Answers how many bytes. */
async function writeAll(file: FileHandle, data: Uint8Array | string): Promise<number> {
	const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
	let at = 0;
	while (at < bytes.length) {
		const { bytesWritten } = await file.write(bytes, at, bytes.length - at);
		if (bytesWritten === 0) throw new RestoreError("The disk took nothing more: is it full?");
		at += bytesWritten;
	}
	return bytes.length;
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
