import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, type FileHandle, link, mkdir, open, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
	BUCKET_INDEX,
	type BucketHttpMetadata,
	type BucketObject,
	bucketFile,
	DUMP_FILE,
	DumpError,
	type DumpSummary,
	describeStatement,
	type FileEntry,
	fromUtf8,
	ident,
	isDumpFile,
	type Manifest,
	objectOf,
	type Repository,
	RepositoryError,
	readBucketIndex,
	restoreSql,
	sendable,
	splitLines,
	summarizeDump,
} from "@gateweave/backup-core";
import { type Placed, PUT_LIMIT, type S3Target } from "./stores";

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

/** One database a snapshot holds: a D1 source's, or one of an app's Durable Objects. */
interface Dump {
	/** The object's name, or null for a D1 source's one database. */
	object: string | null;
	entry: FileEntry;
}

/** Whether a snapshot is of an app's Durable Objects, a database each (docs/format.md). */
function ofObjects(manifest: Manifest): boolean {
	return manifest.source.kind === "do";
}

/** The databases a snapshot holds, in its order, or only the object `object` names. */
function dumpsOf(manifest: Manifest, object?: string): Dump[] {
	const dumps: Dump[] = [];
	for (const entry of manifest.files) {
		if (entry.path === DUMP_FILE) dumps.push({ object: null, entry });
		const name = objectOf(entry.path);
		if (name !== undefined) dumps.push({ object: name, entry });
	}
	if (object === undefined) return dumps;
	if (!ofObjects(manifest)) {
		throw new RestoreError(
			`Snapshot ${manifest.name} is of one database, not of objects: leave out --object.`,
		);
	}
	const found = dumps.filter((dump) => dump.object === object);
	if (found.length === 0) {
		throw new RestoreError(`Snapshot ${manifest.name} holds no object ${object}.`);
	}
	return found;
}

async function readDump(repo: Repository, entry: FileEntry): Promise<string[]> {
	return splitLines(fromUtf8(await repo.readWholeFile(entry)));
}

/** Runs `work` on one of a snapshot's databases; a failure in an object's says which object. */
async function onDump<T>(dump: Dump, work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (dump.object === null) throw error;
		throw new RestoreError(`${dump.object}: ${messageOf(error)}`);
	}
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

export interface ShownSnapshot extends SnapshotInfo {
	/** For a snapshot of an app's Durable Objects: their names. */
	objects: string[] | null;
	/** The object whose database is shown, when one was asked for. */
	object: string | null;
	database: DumpSummary | null;
}

/**
 * A preview of a snapshot before restoring it: its files and, for a database, its tables. A
 * snapshot of objects lists them, and shows the tables of the one `object` names.
 */
export async function showSnapshot(
	repo: Repository,
	name: string,
	object?: string,
): Promise<ShownSnapshot> {
	const manifest = await repo.manifest(name);
	const dumps = dumpsOf(manifest, object);
	const many = ofObjects(manifest);
	const shown = many && object === undefined ? undefined : dumps[0];
	return {
		...infoOf(manifest),
		objects: many ? dumpsOf(manifest).map((dump) => dump.object ?? "") : null,
		object: shown?.object ?? null,
		database: shown ? summarizeDump(await readDump(repo, shown.entry)) : null,
	};
}

export interface CheckResult {
	name: string;
	ok: boolean;
	bytes: number;
	/** For a snapshot of an app's Durable Objects: how many it holds. */
	objects?: number;
	/** For a database, or all of them: the tables and rows that loaded into scratch SQLite. */
	tables?: number;
	rows?: number;
	error?: string;
}

/**
 * Reads a snapshot as a restore would, and restores each database in it into memory: every chunk
 * opened and checked against its id, every file against its size and SHA-256, and every table's
 * rows counted against the dump. Nothing is written to disk.
 */
export async function checkSnapshot(repo: Repository, name: string): Promise<CheckResult> {
	let bytes = 0;
	try {
		const manifest = await repo.manifest(name);
		const result: CheckResult = { name, ok: true, bytes: 0 };
		for (const entry of manifest.files) {
			if (isDumpFile(entry.path)) continue;
			for await (const chunk of verified(repo, entry)) bytes += chunk.length;
		}
		const dumps = dumpsOf(manifest);
		if (ofObjects(manifest)) result.objects = dumps.length;
		if (dumps.length > 0 || ofObjects(manifest)) Object.assign(result, { tables: 0, rows: 0 });
		for (const dump of dumps) {
			const summary = await onDump(dump, async () => {
				const lines = await readDump(repo, dump.entry);
				bytes += dump.entry.size;
				return countLoaded(lines);
			});
			result.tables = (result.tables ?? 0) + summary.tables.length;
			result.rows = (result.rows ?? 0) + summary.rows;
		}
		result.bytes = bytes;
		return result;
	} catch (error) {
		return { name, ok: false, bytes, error: messageOf(error) };
	}
}

/** Loads a dump into a database in memory and counts every table's rows against it. */
async function countLoaded(lines: string[]): Promise<DumpSummary> {
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
	return summary;
}

export type RestoreAs = "sql" | "sqlite" | "files";

export interface RestoreReport {
	name: string;
	as: RestoreAs;
	written: string[];
	/** Whether the snapshot is of an app's Durable Objects, a database each. */
	objects: boolean;
	/** What each database written holds: one, or one per object. */
	databases: { object: string | null; summary: DumpSummary }[];
}

/**
 * Writes a snapshot out to a folder: as SQL to load into a new D1 database, as a SQLite file, or
 * as the files it holds. A snapshot of an app's Durable Objects writes `<object>.sql` or
 * `<object>.sqlite` for each, or for the one `object` names. It writes only files that aren't
 * there yet, and removes what it wrote when anything fails, so nothing is ever restored over
 * something else.
 */
export async function restoreSnapshot(
	repo: Repository,
	name: string,
	{ to, as, object, prefix }: { to: string; as?: RestoreAs; object?: string; prefix?: string },
): Promise<RestoreReport> {
	const manifest = await repo.manifest(name);
	const dumps = dumpsOf(manifest, object);
	const objects = ofObjects(manifest);
	const way: RestoreAs = as ?? (dumps.length > 0 ? "sql" : "files");
	if (way !== "files" && dumps.length === 0) {
		throw new RestoreError(`Snapshot ${name} holds no database; restore it --as files.`);
	}
	const folder = resolve(to);
	let files = object === undefined ? manifest.files : dumps.map((dump) => dump.entry);
	if (prefix !== undefined) {
		// bucket.json goes too, as it lists every object with what R2 kept beside its bytes.
		const chosen = new Set(
			(await bucketObjects(repo, manifest, prefix)).map((item) => bucketFile(item.key)),
		);
		files = files.filter((entry) => entry.path === BUCKET_INDEX || chosen.has(entry.path));
	}
	const targets =
		way === "files"
			? files.map((file) => join(folder, ...safePath(file.path).split("/")))
			: dumps.map((dump) => join(folder, `${dump.object ?? "database"}.${way}`));
	for (const target of targets) if (await exists(target)) throw taken(target);
	await mkdir(folder, { recursive: true });
	const written: string[] = [];
	try {
		if (way === "files") {
			for (const [index, entry] of files.entries()) {
				const target = targets[index] ?? "";
				await mkdir(dirname(target), { recursive: true });
				await writeNew(target, async (file) => {
					for await (const chunk of verified(repo, entry)) await writeAll(file, chunk);
					return entry.size;
				});
				written.push(target);
			}
			return { name, as: way, written, objects, databases: [] };
		}
		const databases: RestoreReport["databases"] = [];
		for (const [index, dump] of dumps.entries()) {
			const target = targets[index] ?? "";
			const summary = await onDump(dump, async () => {
				const lines = await readDump(repo, dump.entry);
				await writeDatabase(target, way, lines);
				return summarizeDump(lines);
			});
			written.push(target);
			databases.push({ object: dump.object, summary });
		}
		return { name, as: way, written, objects, databases };
	} catch (error) {
		for (const path of written) await unlink(path).catch(() => {});
		throw error;
	}
}

/** The objects a snapshot of a bucket lists in bucket.json, or those whose keys start with `prefix`. */
async function bucketObjects(
	repo: Repository,
	manifest: Manifest,
	prefix?: string,
): Promise<BucketObject[]> {
	const { kind, name } = manifest.source;
	if (kind !== "r2") {
		throw new RestoreError(
			`Snapshot ${manifest.name} is of ${kind} ${name}, not of a bucket: only a bucket's objects are picked with --prefix, or go back into a bucket.`,
		);
	}
	const index = manifest.files.find((entry) => entry.path === BUCKET_INDEX);
	if (!index) throw new RestoreError(`Snapshot ${manifest.name} has no ${BUCKET_INDEX}.`);
	const objects = readBucketIndex(await repo.readWholeFile(index));
	if (prefix === undefined) return objects;
	const chosen = objects.filter((item) => item.key.startsWith(prefix));
	if (chosen.length === 0) {
		throw new RestoreError(
			`Snapshot ${manifest.name} holds no object whose key starts with ${JSON.stringify(prefix)}.`,
		);
	}
	return chosen;
}

/** How bucket.json's HTTP metadata goes back into a PutObject's headers. */
const HTTP_HEADERS: Record<keyof BucketHttpMetadata, string> = {
	contentType: "Content-Type",
	contentLanguage: "Content-Language",
	contentDisposition: "Content-Disposition",
	contentEncoding: "Content-Encoding",
	cacheControl: "Cache-Control",
	cacheExpiry: "Expires",
};

/** A name HTTP takes for a header: RFC 9110's token. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * The headers that give an object back its metadata. Custom metadata goes in `x-amz-meta-*`, and
 * a value that a header wouldn't carry as it is goes RFC 2047-encoded, which R2 decodes before it
 * stores the value. Metadata no header can carry stops the restore, naming the object.
 */
export function headersOf(object: BucketObject): [string, string][] {
	const cannot = (what: string) =>
		new RestoreError(
			`${JSON.stringify(object.key)} has ${what}, which the S3 API can't carry. Restore it to a folder instead.`,
		);
	const headers: [string, string][] = [];
	for (const [field, header] of Object.entries(HTTP_HEADERS)) {
		const value = object.http[field as keyof BucketHttpMetadata];
		if (value === undefined) continue;
		if (field === "cacheExpiry") {
			const at = new Date(value);
			if (Number.isNaN(at.getTime())) throw cannot("an expiry that isn't a time");
			headers.push([header, at.toUTCString()]);
			continue;
		}
		if (!plain(value)) throw cannot(`a ${header} that isn't plain ASCII`);
		headers.push([header, value]);
	}
	const names = new Set<string>();
	for (const [name, value] of Object.entries(object.custom)) {
		if (!TOKEN.test(name)) throw cannot("a custom metadata name that can't be a header's");
		// Header names have no case, so these two would arrive as one.
		if (names.has(name.toLowerCase())) {
			throw cannot("custom metadata names that differ only in case");
		}
		names.add(name.toLowerCase());
		const sent = plain(value) && !value.includes("=?") ? value : encodedWord(value);
		headers.push([`x-amz-meta-${name}`, sent]);
	}
	return headers;
}

/** Printable ASCII with no space at either end: a header value that arrives as it was sent. */
function plain(value: string): boolean {
	return value === "" || /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value);
}

/** An RFC 2047 encoded word: UTF-8, in base64. */
function encodedWord(value: string): string {
	return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export interface BucketRestoreReport {
	name: string;
	/** Where the objects went, as `s3://<bucket>[/<folder>]`. */
	to: string;
	/** The keys put back. */
	created: string[];
	/** The keys that were taken, whose objects were left as they are. */
	there: string[];
	/** The bytes put back. */
	bytes: number;
	/**
	 * Custom metadata names with capitals, among the objects put back. The S3 API keeps names in
	 * lower case, R2's as well, so `uploadedBy` comes back as `uploadedby`.
	 */
	lowered: string[];
}

/**
 * Puts a snapshot of a bucket back into a bucket: every object, or those whose keys start with
 * `prefix`, each with its metadata. Everything is checked before anything is sent, and an object
 * goes in only where its key is free, so nothing there is replaced. Stopped half way, it leaves
 * the objects it put, each one whole, and the same restore again puts back the rest.
 */
export async function restoreToBucket(
	repo: Repository,
	name: string,
	target: S3Target,
	{ prefix, done }: { prefix?: string; done?: (key: string, placed: Placed) => void } = {},
): Promise<BucketRestoreReport> {
	const manifest = await repo.manifest(name);
	const files = new Map(manifest.files.map((entry) => [entry.path, entry] as const));
	const plans = (await bucketObjects(repo, manifest, prefix)).map((object) => {
		const key = JSON.stringify(object.key);
		const entry = files.get(bucketFile(object.key));
		if (!entry || entry.size !== object.size) {
			throw new RestoreError(`Snapshot ${name} doesn't hold ${key} as bucket.json lists it.`);
		}
		if (entry.size > PUT_LIMIT) {
			throw new RestoreError(
				`${key} is larger than one PutObject takes at R2, 5 MiB less than 5 GiB. Restore it to a folder and upload it with rclone or aws s3 cp.`,
			);
		}
		if (!sendable(object.key)) {
			throw new RestoreError(
				`${key} has an empty, . or .. part, which a request's path would lose, so it can't go back under its key.`,
			);
		}
		return { object, entry, headers: headersOf(object) };
	});
	const report: BucketRestoreReport = {
		name,
		to: target.location,
		created: [],
		there: [],
		bytes: 0,
		lowered: [],
	};
	const lowered = new Set<string>();
	try {
		for (const { object, entry, headers } of plans) {
			const placed = await target.create({
				key: object.key,
				size: entry.size,
				sha256: entry.sha256,
				headers,
				body: () => verified(repo, entry),
			});
			if (placed === "created") {
				report.created.push(object.key);
				report.bytes += entry.size;
				for (const name of Object.keys(object.custom)) {
					if (name !== name.toLowerCase()) lowered.add(name);
				}
			} else report.there.push(object.key);
			done?.(object.key, placed);
		}
	} catch (error) {
		const put = report.created.length;
		if (put === 0) throw error;
		throw new RestoreError(
			`${messageOf(error)} ${put} ${put === 1 ? "object was" : "objects were"} put back before that; the same restore again puts back the rest.`,
		);
	}
	report.lowered = [...lowered].sort();
	return report;
}

/** Writes one dump as SQL, or loads it into a new SQLite file. */
async function writeDatabase(
	target: string,
	way: "sql" | "sqlite",
	lines: string[],
): Promise<void> {
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
		return;
	}
	await writeNew(target, null, async (path) => {
		const db = await openSqlite(path);
		try {
			load(db, lines);
		} finally {
			db.close();
		}
	});
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
