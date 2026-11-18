// The example of docs/app-entrypoint.md, word for word: a test holds the guide to this file. It is
// type-checked with the Worker's tests, and its guard is tested against the statements a real
// dump sends (test/example-app.test.ts). test/app-worker.js is the app the backup tests run.

// #region example
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

/** What this app's Worker binds: its directory of notebooks, and the notebooks themselves. */
interface AppEnv {
	DB: D1Database;
	NOTEBOOK: DurableObjectNamespace<Notebook>;
}

type Row = Record<string, SqlStorageValue>;

/** A statement that only reads: a SELECT, or one of the three PRAGMAs that describe tables. */
const READ = /^\s*(?:SELECT\b|PRAGMA\s+table_(?:list|info|xinfo)\b)/i;

/** Why a backup's statements are refused, or undefined when they may run. */
export function refusal(statements: unknown): string | undefined {
	if (!Array.isArray(statements)) return "Not a list of statements.";
	if (statements.length > 1000) return "Too many statements at once.";
	for (const sql of statements) {
		if (typeof sql !== "string") return "Not a list of statements.";
		if (sql.length > 100_000) return "A statement is too long.";
		if (!READ.test(sql)) return "A backup only reads: SELECT, or PRAGMA table_list or table_info.";
		if (sql.includes(";")) return "One statement at a time.";
	}
	return undefined;
}

class RollBack extends Error {}

/** One of the app's Durable Objects. Yours has its own tables and methods; it gains `backupRead`. */
export class Notebook extends DurableObject<AppEnv> {
	constructor(ctx: DurableObjectState, env: AppEnv) {
		super(ctx, env);
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS note (id INTEGER PRIMARY KEY, body TEXT)");
	}

	/**
	 * Runs a backup's statements together and rolls back whatever they did. Synchronous from start
	 * to end, so they all see one moment of the object. A refusal says why and never what was
	 * sent: its message is kept in the backup's catalog and sent in its alert.
	 */
	backupRead(statements: string[]): Row[][] {
		const reason = refusal(statements);
		if (reason !== undefined) throw new Error(`The notebook refused the backup's read. ${reason}`);
		let rows: Row[][] = [];
		try {
			this.ctx.storage.transactionSync(() => {
				rows = statements.map((sql) => this.ctx.storage.sql.exec<Row>(sql).toArray());
				throw new RollBack();
			});
		} catch (error) {
			if (!(error instanceof RollBack)) throw error;
		}
		return rows;
	}
}

/** A notebook's id, which is also its dump's file name in the backup. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** How many names a page of `objects` holds. */
const PAGE = 100;

/**
 * Gateweave Backup's way in. It has no route: a service binding from a Worker in the same account
 * is its access, so nothing here checks who is calling.
 */
export class Backup extends WorkerEntrypoint<AppEnv> {
	/** The notebooks' ids, in order, a page at a time: `cursor` is the last id of the page before. */
	async objects(cursor?: string): Promise<{ names: string[]; cursor?: string }> {
		if (cursor !== undefined && !NAME.test(cursor)) throw new Error("That is not a cursor.");
		const { results } = await this.env.DB.prepare(
			"SELECT id FROM notebook WHERE id > ?1 ORDER BY id LIMIT ?2",
		)
			.bind(cursor ?? "", PAGE + 1)
			.all<{ id: string }>();
		const names = results.slice(0, PAGE).map((row) => row.id);
		const last = names.at(-1);
		return results.length > PAGE && last !== undefined ? { names, cursor: last } : { names };
	}

	/** Runs a backup's reads in one notebook, or answers null when there is no such notebook. */
	async read(name: string, statements: string[]): Promise<Row[][] | null> {
		if (typeof name !== "string" || !NAME.test(name)) return null;
		// Asked of the directory first: naming an object makes it, and a deleted one must stay gone.
		const found = await this.env.DB.prepare("SELECT 1 FROM notebook WHERE id = ?1")
			.bind(name)
			.first();
		if (found === null) return null;
		return this.env.NOTEBOOK.getByName(name).backupRead(statements);
	}
}
// #endregion example
