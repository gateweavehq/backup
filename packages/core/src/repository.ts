import {
	fromBase64Url,
	fromHex,
	fromUtf8,
	Sha256,
	sha256Hex,
	toBase64Url,
	toHex,
	utf8,
} from "./bytes";
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

/** What a prune found and did. */
export interface PruneStats {
	snapshots: number;
	chunks: number;
	deleted: number;
	held: number;
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
/** The part of a snapshot's name that tells its second: `20261111T200500Z`. */
const SECOND_LENGTH = 16;
/** Only objects named as chunks are pruned; anything else under `data/` isn't ours to delete. */
const CHUNK_KEY = /^data\/([0-9a-f]{2})\/(\1[0-9a-f]{62})$/;

/** How far ahead of now the newest snapshot may be and still have been pushed there, not dated. */
const AHEAD_MS = 60_000;

/** The time a snapshot's name tells, to the second. */
function secondOf(name: string | undefined): number | undefined {
	const parts = name === undefined ? null : /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z/.exec(name);
	if (!parts) return undefined;
	const [, y, mo, d, h, mi, s] = parts;
	return Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
}

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
		const hash = new Sha256();
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
			// The chunker copies the bytes first, whatever the digest does with them.
			const pieces = chunker.push(part);
			await hash.update(part);
			await store(pieces);
		}
		await store(chunker.finish());
		return { entry: { path, size, sha256: await hash.digest(), chunks }, stats };
	}

	/**
	 * Seals and stores a snapshot's manifest. The snapshot exists once this returns.
	 *
	 * Names tell the time to the second, and retention takes the newest by name. So a snapshot made
	 * in a second that already has one takes the next free second, and the newer sorts last. The
	 * newest snapshot may be a few seconds ahead, pushed there by others made in the same second:
	 * then the next goes after it, even when the second it was made in is free again because a
	 * snapshot there was forgotten.
	 */
	async commit(
		source: SourceInfo,
		files: FileEntry[],
		meta: Record<string, unknown> = {},
		now = new Date(),
	): Promise<Manifest> {
		const names = await this.snapshots();
		const taken = new Set(names.map((n) => n.slice(0, SECOND_LENGTH)));
		let at = now.getTime();
		const newest = secondOf(names.at(-1));
		if (newest !== undefined && newest >= at - 1000 && newest <= at + AHEAD_MS) at = newest + 1000;
		while (taken.has(snapshotName(new Date(at)).slice(0, SECOND_LENGTH))) at += 1000;
		const name = snapshotName(new Date(at));
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

	/**
	 * Deletes a snapshot's manifest. Its chunks stay until `prune()`, so a snapshot forgotten by
	 * mistake can still be found in a copy of the store until then.
	 */
	async forget(name: string): Promise<void> {
		if (!SNAPSHOT_NAME.test(name)) throw new RepositoryError("That is not a snapshot's name.");
		await this.#store.delete(snapshotKey(name));
	}

	/**
	 * Deletes the chunks no snapshot points to. It opens every manifest first, and stops without
	 * deleting anything if one doesn't open: a chunk is only let go when it is known to be unused.
	 * Nothing else may write to the repository meanwhile, or a chunk a run has just found stored
	 * could go before its manifest is written; the caller holds the lock.
	 *
	 * An object the store refuses to delete, as a locked bucket does inside its retention period,
	 * is counted as held and left for a later prune.
	 */
	async prune(): Promise<PruneStats> {
		const used = new Set<string>();
		const snapshots = await this.snapshots();
		for (const name of snapshots) {
			for (const file of (await this.manifest(name)).files) {
				for (const id of file.chunks) used.add(id);
			}
		}
		const stats: PruneStats = { snapshots: snapshots.length, chunks: 0, deleted: 0, held: 0 };
		const unused: string[] = [];
		for await (const key of this.#store.list("data/")) {
			const id = CHUNK_KEY.exec(key)?.[2];
			if (!id) continue;
			stats.chunks++;
			if (!used.has(id)) unused.push(id);
		}
		for (const id of unused) {
			this.#known.delete(id);
			try {
				await this.#store.delete(chunkKey(id));
				stats.deleted++;
			} catch {
				stats.held++;
			}
		}
		return stats;
	}

	/**
	 * The objects a copy of this repository needs, in the order a copy must take them: every chunk
	 * a snapshot uses, then `config.json`, then the manifests. So a copy made in pieces never holds
	 * a manifest without its chunks. Chunks no snapshot uses are left out, as a prune would let them
	 * go. Like `prune()`, it stops if a manifest doesn't open.
	 */
	async neededKeys(): Promise<string[]> {
		const names = await this.snapshots();
		const chunks = new Set<string>();
		for (const name of names) {
			for (const file of (await this.manifest(name)).files) {
				for (const id of file.chunks) chunks.add(chunkKey(id));
			}
		}
		return [...[...chunks].sort(), CONFIG_KEY, ...names.map(snapshotKey)];
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

	/**
	 * A whole file as the chunks it was stored in, checked against its size and SHA-256: for a file
	 * too large to hold twice, which putting it in one piece of memory would.
	 */
	async readFileChunks(entry: FileEntry): Promise<Uint8Array<ArrayBuffer>[]> {
		const chunks: Uint8Array<ArrayBuffer>[] = [];
		for await (const chunk of this.#checked(entry)) chunks.push(chunk);
		return chunks;
	}

	/**
	 * Reads a file through and checks it against its size and SHA-256, holding one chunk at a time:
	 * for a file that only has to be proved whole, however large.
	 */
	async checkFile(entry: FileEntry): Promise<void> {
		for await (const _chunk of this.#checked(entry)) {
			// Each chunk is checked against its id as it is read, and the whole at the end.
		}
	}

	/** A file's chunks as they come, then a check of the whole against its size and SHA-256. */
	async *#checked(entry: FileEntry): AsyncGenerator<Uint8Array<ArrayBuffer>> {
		const hash = new Sha256();
		let size = 0;
		for await (const chunk of this.readFile(entry)) {
			size += chunk.length;
			if (size > entry.size) {
				throw new RepositoryError(`${entry.path} is longer than its manifest says.`);
			}
			yield chunk;
			await hash.update(chunk);
		}
		if (size !== entry.size || (await hash.digest()) !== entry.sha256) {
			throw new RepositoryError(`${entry.path} doesn't match its manifest.`);
		}
	}
}
