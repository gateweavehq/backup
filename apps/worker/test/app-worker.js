// Stands in for an app that offers Gateweave Backup its Durable Objects through a Backup
// entrypoint, as Track does: a directory of objects, and a Store with SQLite for each one.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

/** How many names a page of `objects` holds: few, so the tests page. */
const PAGE = 2;

class RollBack extends Error {}

/** Which objects there are, kept in an object of its own. */
export class Directory extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS object (name TEXT PRIMARY KEY)");
	}

	add(name) {
		this.ctx.storage.sql.exec("INSERT OR IGNORE INTO object VALUES (?)", name);
	}

	clear() {
		this.ctx.storage.sql.exec("DELETE FROM object");
	}

	has(name) {
		return (
			this.ctx.storage.sql.exec("SELECT 1 FROM object WHERE name = ?", name).toArray().length > 0
		);
	}

	page(after, limit) {
		return this.ctx.storage.sql
			.exec("SELECT name FROM object WHERE name > ? ORDER BY name LIMIT ?", after, limit)
			.toArray()
			.map((row) => row.name);
	}
}

export class Store extends DurableObject {
	/** Starts the object over with these statements. */
	async write(statements) {
		await this.ctx.storage.deleteAll();
		for (const sql of statements) this.ctx.storage.sql.exec(sql);
	}

	/** As Track's workspaces do: the statements together, then rolled back. */
	backupRead(statements) {
		let rows = [];
		try {
			this.ctx.storage.transactionSync(() => {
				rows = statements.map((sql) => this.ctx.storage.sql.exec(sql).toArray());
				throw new RollBack();
			});
		} catch (error) {
			if (!(error instanceof RollBack)) throw error;
		}
		return rows;
	}
}

function directory(env) {
	return env.DIRECTORY.getByName("all");
}

export class Backup extends WorkerEntrypoint {
	async objects(cursor) {
		const names = await directory(this.env).page(cursor ?? "", PAGE + 1);
		return names.length > PAGE
			? { names: names.slice(0, PAGE), cursor: names[PAGE - 1] }
			: { names };
	}

	async read(name, statements) {
		if (!(await directory(this.env).has(name))) return null;
		return this.env.STORE.getByName(name).backupRead(statements);
	}
}

/** For the tests: makes an object with these statements, or forgets them all. */
export class Seed extends WorkerEntrypoint {
	async add(name, statements) {
		await this.env.STORE.getByName(name).write(statements);
		await directory(this.env).add(name);
	}

	async clear() {
		await directory(this.env).clear();
	}
}

export default {
	async fetch() {
		return new Response("Not found", { status: 404 });
	},
};
