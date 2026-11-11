import type { ObjectStore, Row, SqlReader } from "@gateweave/backup-core";

/**
 * Reads a D1 database. A batch runs as one transaction, so the statements see the same moment:
 * the consistent read `dumpSqlite` asks for.
 */
export function d1Reader(db: D1Database): SqlReader {
	return {
		async readTogether(statements) {
			const results = await db.batch<Row>(statements.map((sql) => db.prepare(sql)));
			return results.map((result) => result.results);
		},
	};
}

/** Whether a binding is a D1 database, as far as a backup needs one. */
export function isD1(value: unknown): value is D1Database {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as D1Database).batch === "function" &&
		typeof (value as D1Database).prepare === "function"
	);
}

/** A repository's objects in an R2 bucket, under a folder of their own. */
export class R2Store implements ObjectStore {
	readonly #bucket: R2Bucket;
	readonly #prefix: string;

	constructor(bucket: R2Bucket, prefix: string) {
		if (prefix !== "" && !prefix.endsWith("/")) throw new Error("A prefix ends with a slash.");
		this.#bucket = bucket;
		this.#prefix = prefix;
	}

	async get(key: string) {
		const object = await this.#bucket.get(this.#prefix + key);
		return object ? new Uint8Array(await object.arrayBuffer()) : null;
	}

	async put(key: string, data: Uint8Array<ArrayBuffer>) {
		await this.#bucket.put(this.#prefix + key, data);
	}

	async has(key: string) {
		return (await this.#bucket.head(this.#prefix + key)) !== null;
	}

	async *list(prefix: string) {
		let cursor: string | undefined;
		do {
			const page = await this.#bucket.list({ prefix: this.#prefix + prefix, cursor });
			for (const object of page.objects) yield object.key.slice(this.#prefix.length);
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
	}

	async delete(key: string) {
		await this.#bucket.delete(this.#prefix + key);
	}
}
