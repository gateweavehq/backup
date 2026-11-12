import { DurableObject } from "cloudflare:workers";
import {
	BUCKET_INDEX,
	BucketIndexError,
	bucketFile,
	DumpError,
	DumpLines,
	type DumpSummary,
	describeStatement,
	ident,
	isDumpFile,
	type Manifest,
	objectOf,
	Repository,
	RepositoryError,
	readBucketIndex,
	restoreSql,
	SealError,
	summarizeDump,
} from "@gateweave/backup-core";
import { R2Store } from "./bindings";

/** How a restore test of one snapshot went. */
export interface RestoreTestResult {
	source: string;
	snapshot: string;
	passed: boolean;
	/** What came back: tables and rows, and how many objects, for a source of many. */
	tables: number;
	rows: number;
	objects?: number;
	/** The bytes read back and checked. */
	size: number;
	/** Why it failed. It names objects and statements, never values. */
	error?: string;
}

/** A restore that went wrong in a way that trying again won't change. */
class RestoreFailure extends Error {
	override name = "RestoreFailure";
}

/** Thrown once everything is counted, to roll back what the restore wrote. */
class RollBack extends Error {}

/** The statements that make a table, which a restore runs before anything else. */
const MAKES_TABLE = /^\s*CREATE\s+(?:VIRTUAL\s+)?TABLE\b/i;

/**
 * Restore tests: docs/architecture.md, "Restore tests". A test reads a snapshot back from the
 * bucket, restores it into this object's own SQLite, and counts every table against the dump.
 *
 * The rows are never committed. The tables are made and committed first, then the rows go in, are
 * counted and checked inside one transaction, and that transaction is rolled back. So no copy of
 * the data stays here. The 30 days of point-in-time recovery a Durable Object's storage keeps go
 * back only to committed states, and the only ones a test makes hold empty tables, which it deletes
 * at the end. (Making the tables in the rolled-back transaction too would be simpler, but rolling
 * back writes to an FTS5 table made in the same transaction crashed workerd when we tried it.)
 *
 * There is one object per source, named after it, and it runs one test at a time: a Workflow step
 * that timed out may be tried again while its first try is still running here.
 */
export class RestoreTest extends DurableObject<Env> {
	#queue: Promise<unknown> = Promise.resolve();

	async restore(source: string, snapshot: string): Promise<RestoreTestResult> {
		const turn = this.#queue.then(() => this.#restoreNow(source, snapshot));
		this.#queue = turn.catch(() => {});
		return turn;
	}

	async #restoreNow(source: string, snapshot: string): Promise<RestoreTestResult> {
		const result: RestoreTestResult = {
			source,
			snapshot,
			passed: false,
			tables: 0,
			rows: 0,
			size: 0,
		};
		// What a test that stopped half way may have left: tables, never rows.
		await this.ctx.storage.deleteAll();
		try {
			await this.#test(source, snapshot, result);
		} catch (error) {
			if (!isFailure(error)) throw error;
			// A failed test counts nothing, though some of a snapshot's dumps came back before it.
			Object.assign(result, { tables: 0, rows: 0, error: error.message });
		} finally {
			await this.ctx.storage.deleteAll();
		}
		return result;
	}

	/**
	 * Reads the snapshot back, checks every file, and restores each dump: a D1 source's one, or each
	 * of an app's objects, one after another, each into an empty database. A bucket's snapshot has no
	 * dump: every object's file is read through and checked, and so is bucket.json's list of them.
	 */
	async #test(source: string, snapshot: string, result: RestoreTestResult): Promise<void> {
		const store = new R2Store(this.env.VAULT, `${source}/`);
		const repo = await Repository.open(store, this.env.BACKUP_KEY);
		const manifest = await repo.manifest(snapshot);
		const many = manifest.files.filter((entry) => isDumpFile(entry.path)).length > 1;
		let loaded = 0;
		for (const entry of manifest.files) {
			// Every file is read whole and checked against its size and hash; a dump is also restored.
			if (!isDumpFile(entry.path)) {
				await repo.checkFile(entry);
				result.size += entry.size;
				continue;
			}
			try {
				// The dump is held once, as the chunks it was stored in, and read a line at a time: the
				// rows must go in inside one synchronous transaction, so they can't wait for the bucket.
				const lines = new DumpLines(await repo.readFileChunks(entry));
				result.size += entry.size;
				const summary = summarizeDump(lines);
				if (loaded > 0) await this.ctx.storage.deleteAll();
				this.#load(lines, summary);
				loaded++;
				result.tables += summary.tables.length;
				result.rows += summary.rows;
			} catch (error) {
				// In a snapshot of many objects, a failure says which one.
				if (!many || !isFailure(error)) throw error;
				throw new RestoreFailure(`${objectOf(entry.path) ?? entry.path}: ${error.message}`);
			}
		}
		const objects =
			manifest.source.kind === "r2"
				? await checkBucket(repo, manifest)
				: manifest.source.kind === "do"
					? loaded
					: undefined;
		const meant = manifest.meta.rows;
		if (typeof meant === "number" && meant !== result.rows) {
			const held = many ? "the dumps hold" : "the dump holds";
			throw new RestoreFailure(`The manifest says ${meant} rows; ${held} ${result.rows}.`);
		}
		if (objects !== undefined) result.objects = objects;
		result.passed = true;
	}

	/** Restores the dump, checks what came back, and rolls the rows back. */
	#load(lines: DumpLines, summary: DumpSummary): void {
		const sql = this.ctx.storage.sql;
		const run = (statement: string) => {
			try {
				sql.exec(statement);
			} catch (error) {
				throw new RestoreFailure(`${describeStatement(statement)} failed: ${reasonOf(error)}`);
			}
		};
		const statements = restoreSql(lines);
		// The first statement sets up the transaction the rows go in; the tables come next.
		const setUp = statements.next();
		let next = statements.next();
		this.ctx.storage.transactionSync(() => {
			while (!next.done && MAKES_TABLE.test(next.value)) {
				run(next.value);
				next = statements.next();
			}
		});
		try {
			this.ctx.storage.transactionSync(() => {
				if (!setUp.done) run(setUp.value);
				while (!next.done) {
					run(next.value);
					next = statements.next();
				}
				// Foreign keys are checked at the end of the restore, which never commits: check them here.
				const dangling = sql.exec<{ table: string }>("PRAGMA foreign_key_check").toArray();
				const first = dangling[0];
				if (first) {
					throw new RestoreFailure(
						`${dangling.length} rows point to rows that aren't there, the first in ${first.table}.`,
					);
				}
				for (const table of summary.tables) {
					if (table.virtual) continue;
					const found = sql
						.exec<{ n: number }>(`SELECT count(*) AS n FROM ${ident(table.name)}`)
						.one().n;
					if (found !== table.rows) {
						throw new RestoreFailure(
							`${table.name} came back with ${found} rows; the dump has ${table.rows}.`,
						);
					}
				}
				throw new RollBack();
			});
		} catch (error) {
			if (!(error instanceof RollBack)) throw error;
		}
		// The rows must be gone. If a rollback ever kept them, the test says so rather than pass.
		for (const table of summary.tables) {
			if (table.virtual) continue;
			const kept = sql
				.exec<{ n: number }>(`SELECT count(*) AS n FROM ${ident(table.name)}`)
				.one().n;
			if (kept > 0) throw new RestoreFailure(`${table.name} kept ${kept} rows after the rollback.`);
		}
	}
}

/**
 * Checks that a bucket's snapshot holds a file for every object bucket.json lists, of its size, and
 * nothing else. Answers how many objects it holds.
 */
async function checkBucket(repo: Repository, manifest: Manifest): Promise<number> {
	const index = manifest.files.find((entry) => entry.path === BUCKET_INDEX);
	if (!index) throw new RestoreFailure("The snapshot has no bucket.json.");
	const objects = readBucketIndex(await repo.readWholeFile(index));
	const files = new Map(manifest.files.map((entry) => [entry.path, entry]));
	for (const object of objects) {
		const file = files.get(bucketFile(object.key));
		if (!file || file.size !== object.size) {
			throw new RestoreFailure(
				`bucket.json lists an object of ${object.size} bytes that the snapshot doesn't hold.`,
			);
		}
	}
	if (manifest.files.length !== objects.length + 1) {
		throw new RestoreFailure(
			`The snapshot holds ${manifest.files.length - 1} objects' files; bucket.json lists ${objects.length}.`,
		);
	}
	const meant = manifest.meta.objects;
	if (typeof meant === "number" && meant !== objects.length) {
		throw new RestoreFailure(
			`The manifest says ${meant} objects; bucket.json lists ${objects.length}.`,
		);
	}
	return objects.length;
}

/** Whether an error says the snapshot doesn't restore, rather than that reading it failed for now. */
function isFailure(error: unknown): error is Error {
	return (
		error instanceof RestoreFailure ||
		error instanceof BucketIndexError ||
		error instanceof DumpError ||
		error instanceof RepositoryError ||
		error instanceof SealError
	);
}

/** What SQLite said, when it names only objects; otherwise a word for it. Never values. */
function reasonOf(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	const constraint =
		/\b(?:UNIQUE|NOT NULL|CHECK|FOREIGN KEY|PRIMARY KEY) constraint failed\b[^\n]*/.exec(message);
	if (constraint) return constraint[0].slice(0, 200);
	if (/too big|too long|TOOBIG/i.test(message)) return "it is larger than SQLite takes here";
	if (/not authorized/i.test(message)) return "SQLite doesn't allow it here";
	return "SQLite refused it";
}

const JURISDICTIONS = ["eu", "fedramp"] as const;

/** How many days apart a source's restore tests are: RESTORE_TEST_DAYS, 30 when it isn't set. */
export function testInterval(text: string | undefined): number {
	if (text === undefined || text.trim() === "") return 30;
	const days = Number(text);
	if (!Number.isInteger(days) || days < 1 || days > 366) {
		throw new Error("RESTORE_TEST_DAYS must be a whole number of days from 1 to 366.");
	}
	return days;
}

/** The source's restore test object, in JURISDICTION when one is set: the bucket's, as a rule. */
export function testerFor(env: Env, source: string): DurableObjectStub<RestoreTest> {
	const wanted = env.JURISDICTION?.trim() ?? "";
	let namespace = env.RESTORE_TEST;
	if (wanted !== "") {
		const jurisdiction = JURISDICTIONS.find((j) => j === wanted);
		if (!jurisdiction) throw new Error(`JURISDICTION must be empty, "eu" or "fedramp".`);
		namespace = namespace.jurisdiction(jurisdiction);
	}
	return namespace.get(namespace.idFromName(source));
}
