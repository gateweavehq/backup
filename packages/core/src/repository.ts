import { fromBase64Url, fromHex, fromUtf8, sha256Hex, toBase64Url, toHex, utf8 } from "./bytes";
import { Chunker, type ChunkerParams, checkChunkerParams, DEFAULT_CHUNKER } from "./cdc";
import { deriveKeys, parseMasterKey, type RepositoryKeys } from "./keys";
import { chunkIdOf, open, SealError, seal } from "./seal";
import type { ObjectStore } from "./store";

/** docs/format.md, "Objects". */
const CONFIG_KEY = "config.json";
const CHECK_TEXT = "gateweave-backup";
const FORMAT_VERSION = 1;

export interface RepositoryConfig {
	format: "gateweave-backup";
	version: 1;
	id: string;
	created: string;
	chunker: ChunkerParams;
	check: string;
}

export interface SourceInfo {
	kind: string;
	name: string;
}

export interface FileEntry {
	path: string;
	size: number;
	sha256: string;
	chunks: string[];
}

/** docs/format.md, "Manifests". */
export interface Manifest {
	version: 1;
	name: string;
	created: string;
	source: SourceInfo;
	files: FileEntry[];
	meta: Record<string, unknown>;
}

/** What writing a file cost: how many chunks it has, and how many of them were new. */
export interface WriteStats {
	chunks: number;
	newChunks: number;
	newBytes: number;
}

export class RepositoryError extends Error {
	override name = "RepositoryError";
}

function chunkKey(id: string): string {
	return `data/${id.slice(0, 2)}/${id}`;
}

function snapshotKey(name: string): string {
	return `snapshots/${name}`;
}

const SNAPSHOT_NAME = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;

/** A snapshot's name: when it was made, to the second, and a random part. They sort by time. */
export function snapshotName(at: Date): string {
	const stamp = at
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}/, "");
	return `${stamp}-${toHex(crypto.getRandomValues(new Uint8Array(4)))}`;
}

function parseConfig(bytes: Uint8Array): RepositoryConfig {
	let config: unknown;
	try {
		config = JSON.parse(fromUtf8(bytes));
	} catch {
		throw new RepositoryError("config.json is not JSON.");
	}
	const c = config as Partial<RepositoryConfig>;
	if (c.format !== "gateweave-backup")
		throw new RepositoryError("This is not a backup repository.");
	if (c.version !== FORMAT_VERSION) {
		throw new RepositoryError(`This repository is format ${c.version}; this code reads 1.`);
	}
	if (typeof c.id !== "string" || !/^[0-9a-f]{32}$/.test(c.id) || typeof c.check !== "string") {
		throw new RepositoryError("config.json is damaged.");
	}
	if (!c.chunker) throw new RepositoryError("config.json is damaged.");
	checkChunkerParams(c.chunker);
	return c as RepositoryConfig;
}

/**
 * A backup repository: its config, chunks and snapshots in an object store, sealed with keys from
 * the owner's master key. docs/format.md is the format it reads and writes.
 */
export class Repository {
	readonly #store: ObjectStore;
	readonly #keys: RepositoryKeys;
	readonly config: RepositoryConfig;
	/** Chunks known to be stored, so a run asks the store about each only once. */
	readonly #known = new Set<string>();

	private constructor(store: ObjectStore, keys: RepositoryKeys, config: RepositoryConfig) {
		this.#store = store;
		this.#keys = keys;
		this.config = config;
	}

	/** Makes a repository in an empty store. Refuses a store that already has one. */
	static async init(
		store: ObjectStore,
		masterKey: string,
		{ chunker = DEFAULT_CHUNKER, now = new Date() }: { chunker?: ChunkerParams; now?: Date } = {},
	): Promise<Repository> {
		checkChunkerParams(chunker);
		if (await store.has(CONFIG_KEY)) {
			throw new RepositoryError("A repository is already here. Open it instead.");
		}
		const idBytes = crypto.getRandomValues(new Uint8Array(16));
		const id = toHex(idBytes);
		const keys = await deriveKeys(parseMasterKey(masterKey), idBytes);
		const check = toBase64Url(await seal(keys, `config:${id}`, utf8(CHECK_TEXT)));
		const config: RepositoryConfig = {
			format: "gateweave-backup",
			version: FORMAT_VERSION,
			id,
			created: now.toISOString(),
			chunker,
			check,
		};
		await store.put(CONFIG_KEY, utf8(`${JSON.stringify(config, null, "\t")}\n`));
		return new Repository(store, keys, config);
	}

	/** Opens the repository in `store`, checking the key before anything else. */
	static async open(store: ObjectStore, masterKey: string): Promise<Repository> {
		const bytes = await store.get(CONFIG_KEY);
		if (!bytes) throw new RepositoryError("No repository is here.");
		const config = parseConfig(bytes);
		const keys = await deriveKeys(parseMasterKey(masterKey), fromHex(config.id));
		try {
			const check = await open(keys, `config:${config.id}`, fromBase64Url(config.check));
			if (fromUtf8(check) !== CHECK_TEXT) throw new SealError("config");
		} catch (error) {
			if (error instanceof SealError) {
				throw new RepositoryError("That key doesn't open this repository.");
			}
			throw error;
		}
		return new Repository(store, keys, config);
	}

	/** Cuts `source` into chunks, stores the ones the repository lacks, and describes the file. */
	async writeFile(
		path: string,
		source: Uint8Array<ArrayBuffer> | AsyncIterable<Uint8Array>,
	): Promise<{ entry: FileEntry; stats: WriteStats }> {
		const chunker = new Chunker(this.config.chunker, this.#keys.gear);
		const chunks: string[] = [];
		const stats: WriteStats = { chunks: 0, newChunks: 0, newBytes: 0 };
		let size = 0;
		const hash = new IncrementalSha256();
		const store = async (pieces: Uint8Array<ArrayBuffer>[]) => {
			for (const piece of pieces) {
				const id = await chunkIdOf(this.#keys, piece);
				chunks.push(id);
				stats.chunks++;
				if (this.#known.has(id)) continue;
				const key = chunkKey(id);
				if (!(await this.#store.has(key))) {
					const blob = await seal(this.#keys, `chunk:${id}`, piece);
					await this.#store.put(key, blob);
					stats.newChunks++;
					stats.newBytes += blob.length;
				}
				this.#known.add(id);
			}
		};
		const parts = source instanceof Uint8Array ? [source] : source;
		for await (const part of parts) {
			size += part.length;
			hash.update(part);
			await store(chunker.push(part));
		}
		await store(chunker.finish());
		return { entry: { path, size, sha256: await hash.digest(), chunks }, stats };
	}

	/** Seals and stores a snapshot's manifest. The snapshot exists once this returns. */
	async commit(
		source: SourceInfo,
		files: FileEntry[],
		meta: Record<string, unknown> = {},
		now = new Date(),
	): Promise<Manifest> {
		const name = snapshotName(now);
		const manifest: Manifest = {
			version: FORMAT_VERSION,
			name,
			created: now.toISOString(),
			source,
			files,
			meta,
		};
		const blob = await seal(this.#keys, `snapshot:${name}`, utf8(JSON.stringify(manifest)));
		await this.#store.put(snapshotKey(name), blob);
		return manifest;
	}

	/** Snapshot names, oldest first. */
	async snapshots(): Promise<string[]> {
		const names: string[] = [];
		for await (const key of this.#store.list("snapshots/")) {
			const name = key.slice("snapshots/".length);
			if (SNAPSHOT_NAME.test(name)) names.push(name);
		}
		return names.sort();
	}

	async manifest(name: string): Promise<Manifest> {
		if (!SNAPSHOT_NAME.test(name)) throw new RepositoryError("That is not a snapshot's name.");
		const blob = await this.#store.get(snapshotKey(name));
		if (!blob) throw new RepositoryError(`Snapshot ${name} is not here.`);
		const manifest = JSON.parse(fromUtf8(await open(this.#keys, `snapshot:${name}`, blob)));
		if (manifest?.version !== FORMAT_VERSION || manifest.name !== name) {
			throw new RepositoryError(`Snapshot ${name} is damaged.`);
		}
		return manifest as Manifest;
	}

	/** A file's bytes, chunk by chunk, each one checked against its id. */
	async *readFile(entry: FileEntry): AsyncGenerator<Uint8Array<ArrayBuffer>> {
		for (const id of entry.chunks) {
			const blob = await this.#store.get(chunkKey(id));
			if (!blob) throw new RepositoryError(`Chunk ${id} of ${entry.path} is missing.`);
			const plain = await open(this.#keys, `chunk:${id}`, blob);
			if ((await chunkIdOf(this.#keys, plain)) !== id) {
				throw new RepositoryError(`Chunk ${id} of ${entry.path} doesn't match its id.`);
			}
			yield plain;
		}
	}

	/** A whole file, checked against its size and SHA-256. */
	async readWholeFile(entry: FileEntry): Promise<Uint8Array<ArrayBuffer>> {
		const out = new Uint8Array(entry.size);
		let at = 0;
		for await (const chunk of this.readFile(entry)) {
			if (at + chunk.length > entry.size) {
				throw new RepositoryError(`${entry.path} is longer than its manifest says.`);
			}
			out.set(chunk, at);
			at += chunk.length;
		}
		if (at !== entry.size || (await sha256Hex(out)) !== entry.sha256) {
			throw new RepositoryError(`${entry.path} doesn't match its manifest.`);
		}
		return out;
	}
}

/**
 * SHA-256 over a file that arrives in pieces. Web Crypto has no streaming digest, so pieces are
 * kept until the end; a file is at most what one run holds in memory anyway.
 */
class IncrementalSha256 {
	#parts: Uint8Array[] = [];
	#length = 0;

	update(part: Uint8Array) {
		this.#parts.push(part);
		this.#length += part.length;
	}

	async digest(): Promise<string> {
		const all = new Uint8Array(this.#length);
		let at = 0;
		for (const part of this.#parts) {
			all.set(part, at);
			at += part.length;
		}
		return sha256Hex(all);
	}
}
