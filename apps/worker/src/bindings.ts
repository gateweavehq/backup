import type { BucketObject, ObjectStore, Row, SqlReader } from "@gateweave/backup-core";

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

/**
 * An app's `Backup` entrypoint, through a service binding: it lists the Durable Objects to back
 * up, a page at a time, and runs a dump's reads in one of them, rolled back. `read` answers null
 * for an object that is gone, such as a workspace deleted since it was listed.
 */
export interface BackupService {
	objects(cursor?: string): Promise<{ names: string[]; cursor?: string }>;
	read(name: string, statements: string[]): Promise<Row[][] | null>;
}

/**
 * Whether a binding is a service binding, as far as a backup can tell before calling it: it has
 * `fetch`, which D1 and R2 bindings don't. Its stub answers any method name, so nothing more shows.
 */
export function isService(value: unknown): value is BackupService {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { fetch?: unknown }).fetch === "function"
	);
}

/** Every object the app lists, in its order. */
export async function listObjects(service: BackupService): Promise<string[]> {
	const names: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await service.objects(cursor);
		names.push(...page.names);
		if (page.cursor !== undefined && page.cursor === cursor) {
			throw new Error("The app's list of objects went round in a circle.");
		}
		cursor = page.cursor;
	} while (cursor !== undefined);
	return names;
}

/** An object that the app no longer has: it was deleted after it was listed. */
export class ObjectGone extends Error {
	override name = "ObjectGone";
}

/** Reads one of the app's objects, as `dumpSqlite` reads a database. */
export function objectReader(service: BackupService, name: string): SqlReader {
	return {
		async readTogether(statements) {
			const rows = await service.read(name, statements);
			if (rows === null) throw new ObjectGone(`${name} is gone.`);
			return rows;
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

/**
 * Whether a binding is an R2 bucket. A service binding's stub answers any method name, so it is
 * told apart by `fetch`, which a bucket hasn't.
 */
export function isR2(value: unknown): value is R2Bucket {
	if (typeof value !== "object" || value === null) return false;
	const bucket = value as Partial<Record<"list" | "get" | "head" | "fetch", unknown>>;
	return (
		typeof bucket.list === "function" &&
		typeof bucket.get === "function" &&
		typeof bucket.head === "function" &&
		typeof bucket.fetch !== "function"
	);
}

/** An object as a snapshot lists it: its key, size, version and the metadata R2 keeps with it. */
export function describeObject(object: R2Object): BucketObject {
	const { cacheExpiry, ...http } = object.httpMetadata ?? {};
	return {
		key: object.key,
		size: object.size,
		etag: object.etag,
		uploaded: object.uploaded.toISOString(),
		http: {
			...Object.fromEntries(Object.entries(http).filter(([, value]) => typeof value === "string")),
			...(cacheExpiry ? { cacheExpiry: cacheExpiry.toISOString() } : {}),
		},
		custom: { ...object.customMetadata },
	};
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
