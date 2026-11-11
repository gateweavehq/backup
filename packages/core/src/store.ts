/**
 * Where a repository's objects live: an R2 bucket through its binding, an S3-compatible bucket, or
 * memory in tests. Keys are relative to the repository's prefix.
 */
export interface ObjectStore {
	get(key: string): Promise<Uint8Array<ArrayBuffer> | null>;
	put(key: string, data: Uint8Array<ArrayBuffer>): Promise<void>;
	has(key: string): Promise<boolean>;
	/** Every key under `prefix`, in no promised order. */
	list(prefix: string): AsyncIterable<string>;
	delete(key: string): Promise<void>;
}

/** An object store in memory, for tests and for checking a restore before it is written. */
export class MemoryStore implements ObjectStore {
	readonly objects = new Map<string, Uint8Array<ArrayBuffer>>();
	puts = 0;

	async get(key: string) {
		const value = this.objects.get(key);
		return value ? value.slice() : null;
	}

	async put(key: string, data: Uint8Array<ArrayBuffer>) {
		this.puts++;
		this.objects.set(key, data.slice());
	}

	async has(key: string) {
		return this.objects.has(key);
	}

	async *list(prefix: string) {
		for (const key of [...this.objects.keys()]) if (key.startsWith(prefix)) yield key;
	}

	async delete(key: string) {
		this.objects.delete(key);
	}
}
