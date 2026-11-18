// The app of docs/app-entrypoint.md (test/example-app.ts), run as a Worker of its own beside the
// stand-in app, with what the tests need and a reader's app has already: a way to make notebooks.
import { WorkerEntrypoint } from "cloudflare:workers";
import { Notebook as ExampleNotebook } from "./example-app.js";

export { Backup } from "./example-app.js";

/** The example's notebook, with a way to write in it. */
export class Notebook extends ExampleNotebook {
	write(bodies) {
		for (const body of bodies)
			this.ctx.storage.sql.exec("INSERT INTO note (body) VALUES (?)", body);
	}
}

/** For the tests: lists notebooks in the directory, writes in one, and takes one off the list. */
export class Seed extends WorkerEntrypoint {
	async list(ids) {
		const db = this.env.DB;
		await db.batch([
			db.prepare("CREATE TABLE IF NOT EXISTS notebook (id TEXT PRIMARY KEY)"),
			...ids.map((id) => db.prepare("INSERT OR IGNORE INTO notebook (id) VALUES (?1)").bind(id)),
		]);
	}

	async write(id, bodies) {
		await this.list([id]);
		await this.env.NOTEBOOK.getByName(id).write(bodies);
	}

	async clear() {
		await this.env.DB.prepare("DROP TABLE IF EXISTS notebook").run();
		await this.list([]);
	}

	async remove(id) {
		await this.env.DB.prepare("DELETE FROM notebook WHERE id = ?1").bind(id).run();
	}
}

export default {
	async fetch() {
		return new Response("Not found", { status: 404 });
	},
};
