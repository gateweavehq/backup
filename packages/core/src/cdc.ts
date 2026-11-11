/** docs/format.md, "Chunks". Sizes in bytes, fixed for the life of a repository. */
export interface ChunkerParams {
	readonly min: number;
	readonly avg: number;
	readonly max: number;
}

export const DEFAULT_CHUNKER: ChunkerParams = {
	min: 256 * 1024,
	avg: 1024 * 1024,
	max: 4096 * 1024,
};

export function checkChunkerParams(params: ChunkerParams): void {
	const { min, avg, max } = params;
	const whole = [min, avg, max].every((n) => Number.isSafeInteger(n) && n > 0);
	if (!whole || !(min < avg && avg < max) || avg < 64) {
		throw new Error("The chunker needs whole sizes with min < avg < max.");
	}
}

/** The top `bits` bits of a 32-bit hash. They depend on the most recent bytes, all 32 of them. */
function topBits(bits: number): number {
	const n = Math.min(32, Math.max(1, bits));
	return n === 32 ? 0xffffffff : (0xffffffff << (32 - n)) >>> 0;
}

/**
 * FastCDC with a 32-bit gear hash and normalized chunking: a cut is harder to find before the
 * average size and easier after it, which keeps sizes close to the average.
 *
 * Bytes can arrive in pieces of any size; the chunks are the same as if they came at once. Each
 * cut depends only on the bytes since the last one, so an edit changes only the chunks around it.
 */
export class Chunker {
	readonly #params: ChunkerParams;
	readonly #gear: Uint32Array;
	readonly #strict: number;
	readonly #loose: number;
	/** The current chunk's bytes so far, in a buffer that grows as needed. */
	#buffer = new Uint8Array(0);
	#length = 0;
	/** How far into the current chunk the hash has read, and the hash itself. */
	#scanned = 0;
	#hash = 0;

	constructor(params: ChunkerParams, gear: Uint32Array) {
		checkChunkerParams(params);
		if (gear.length !== 256) throw new Error("The gear table has 256 entries.");
		this.#params = params;
		this.#gear = gear;
		const bits = Math.round(Math.log2(params.avg));
		this.#strict = topBits(bits + 2);
		this.#loose = topBits(bits - 2);
	}

	/** Takes more bytes and returns the chunks they complete. */
	push(bytes: Uint8Array): Uint8Array<ArrayBuffer>[] {
		const chunks: Uint8Array<ArrayBuffer>[] = [];
		let at = 0;
		while (at < bytes.length) {
			// Never hold more than one chunk: take only what the current chunk can still use.
			const take = Math.min(bytes.length - at, this.#params.max - this.#length);
			this.#append(bytes.subarray(at, at + take));
			at += take;
			const cut = this.#scan();
			if (cut !== null) chunks.push(this.#emit(cut));
		}
		return chunks;
	}

	/** Returns the last chunks, once every byte has been pushed. */
	finish(): Uint8Array<ArrayBuffer>[] {
		const chunks: Uint8Array<ArrayBuffer>[] = [];
		while (this.#length > 0) {
			// At the very end, what is left is a chunk even without a cut.
			chunks.push(this.#emit(this.#scan() ?? this.#length));
		}
		return chunks;
	}

	#append(bytes: Uint8Array) {
		const needed = this.#length + bytes.length;
		if (needed > this.#buffer.length) {
			const grown = new Uint8Array(
				Math.min(this.#params.max, Math.max(needed, this.#buffer.length * 2)),
			);
			grown.set(this.#buffer.subarray(0, this.#length));
			this.#buffer = grown;
		}
		this.#buffer.set(bytes, this.#length);
		this.#length = needed;
	}

	/** The current chunk's bytes up to `cut`, keeping the rest as the start of the next one. */
	#emit(cut: number): Uint8Array<ArrayBuffer> {
		const chunk = this.#buffer.slice(0, cut);
		this.#buffer.copyWithin(0, cut, this.#length);
		this.#length -= cut;
		this.#scanned = 0;
		this.#hash = 0;
		// The rest may already hold the next cut.
		return chunk;
	}

	/**
	 * Hashes on from where it stopped, and returns where the current chunk ends if the bytes so far
	 * show it: a cut, or the largest size. The hash starts at `min`, so no chunk is smaller.
	 */
	#scan(): number | null {
		const { min, avg, max } = this.#params;
		const gear = this.#gear;
		const data = this.#buffer;
		const end = Math.min(this.#length, max);
		let i = Math.max(this.#scanned, min);
		let hash = this.#hash;
		for (; i < end; i++) {
			hash = ((hash << 1) + (gear[data[i] ?? 0] ?? 0)) >>> 0;
			if ((hash & (i < avg ? this.#strict : this.#loose)) === 0) {
				this.#scanned = 0;
				this.#hash = 0;
				return i + 1;
			}
		}
		this.#scanned = i;
		this.#hash = hash;
		return end === max ? max : null;
	}
}
