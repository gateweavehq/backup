import { DurableObject } from "cloudflare:workers";
import {
	DUMP_FILE,
	DumpError,
	type DumpSummary,
	describeStatement,
	fromUtf8,
	ident,
	Repository,
	RepositoryError,
	restoreSql,
	SealError,
	splitLines,
	summarizeDump,
} from "@gateweave/backup-core";
import { R2Store } from "./bindings";

/** How a restore test of one snapshot went. */
export interface RestoreTestResult {
	source: string;
	snapshot: string;
	passed: boolean;
	/** What came back: tables and rows. */
	tables: number;
	rows: number;
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
 * the data stays here, not even in the 30 days of point-in-time recovery that a Durable Object's
 * storage keeps: only empty tables reach it, and they are deleted at the end. (Making the tables
 * in the rolled-back transaction too would be simpler, but rolling back writes to an FTS5 table
 * made in the same transaction crashed workerd when we tried it.)
 *
 * There is one object per source, named after it, so two tests of a source never overlap.
 */
export class RestoreTest extends DurableObject<Env> {
	async restore(source: string, snapshot: string): Promise<RestoreTestResult> {
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
			result.error = error.message;
		} finally {
			await this.ctx.storage.deleteAll();
		}
		return result;
	}

	/** Reads the snapshot back, checks every file, and restores its dump. */
	async #test(source: string, snapshot: string, result: RestoreTestResult): Promise<void> {
		const store = new R2Store(this.env.VAULT, `${source}/`);
		const repo = await Repository.open(store, this.env.BACKUP_KEY);
		const manifest = await repo.manifest(snapshot);
		for (const entry of manifest.files) {
			// Every file is read whole and checked against its size and hash; the dump is also restored.
			const bytes = await repo.readWholeFile(entry);
			result.size += entry.size;
			if (entry.path !== DUMP_FILE) continue;
			const lines = splitLines(fromUtf8(bytes));
			const summary = summarizeDump(lines);
			const meant = manifest.meta.rows;
			if (typeof meant === "number" && meant !== summary.rows) {
				throw new RestoreFailure(
					`The manifest says ${meant} rows; the dump holds ${summary.rows}.`,
				);
			}
			this.#load(lines, summary);
			result.tables = summary.tables.length;
			result.rows = summary.rows;
		}
		result.passed = true;
	}

	/** Restores the dump, checks what came back, and rolls the rows back. */
	#load(lines: string[], summary: DumpSummary): void {
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
	}
}

/** Whether an error says the snapshot doesn't restore, rather than that reading it failed for now. */
function isFailure(error: unknown): error is Error {
	return (
		error instanceof RestoreFailure ||
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
