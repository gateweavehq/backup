import { describe, expect, it } from "vitest";
import { concat, fromHex } from "../src/bytes";
import { Chunker, type ChunkerParams } from "../src/cdc";
import { deriveKeys, generateMasterKey, parseMasterKey } from "../src/keys";

const small: ChunkerParams = { min: 2048, avg: 8192, max: 32768 };
const EDIT_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

async function gear(master = generateMasterKey()) {
	return (await deriveKeys(parseMasterKey(master), fromHex("00112233445566778899aabbccddeeff")))
		.gear;
}

/** Bytes that look like a database dump: varied, but not random. */
function sample(length: number, seed = 1): Uint8Array {
	const out = new Uint8Array(length);
	let x = seed;
	for (let i = 0; i < length; i++) {
		x = (Math.imul(x, 1103515245) + 12345) >>> 0;
		out[i] = 32 + ((x >>> 16) % 90);
	}
	return out;
}

function chunkAll(chunker: Chunker, data: Uint8Array, pieces: number[]): Uint8Array[] {
	const out: Uint8Array[] = [];
	let at = 0;
	let i = 0;
	while (at < data.length) {
		const size = pieces[i++ % pieces.length] ?? 1;
		out.push(...chunker.push(data.subarray(at, at + size)));
		at += size;
	}
	out.push(...chunker.finish());
	return out;
}

describe("the chunker", () => {
	it("gives back every byte, in order", async () => {
		const g = await gear();
		const data = sample(300_000);
		expect(concat(...chunkAll(new Chunker(small, g), data, [data.length]))).toEqual(data);
	});

	it("cuts the same way however the bytes arrive", async () => {
		const g = await gear();
		const data = sample(300_000);
		const whole = chunkAll(new Chunker(small, g), data, [data.length]).map((c) => c.length);
		for (const pieces of [[1], [7, 4096, 13], [65_536], [32_768, 1]]) {
			const split = chunkAll(new Chunker(small, g), data, pieces).map((c) => c.length);
			expect(split).toEqual(whole);
		}
	});

	it("keeps chunks between the smallest and largest size", async () => {
		const g = await gear();
		const chunks = chunkAll(new Chunker(small, g), sample(1_000_000), [10_000]);
		for (const chunk of chunks.slice(0, -1)) {
			expect(chunk.length).toBeGreaterThanOrEqual(small.min);
			expect(chunk.length).toBeLessThanOrEqual(small.max);
		}
		const average = 1_000_000 / chunks.length;
		expect(average).toBeGreaterThan(small.avg / 2);
		expect(average).toBeLessThan(small.avg * 2);
	});

	it("changes only the chunks around an edit", async () => {
		// The cuts depend on the key. With a random one, an edit now and then lands in a stretch with
		// no cut of its own, and the cuts forced at the largest size shift until the next natural one:
		// more than three new chunks for about one key in three hundred. A fixed key keeps this exact,
		// and a chunker that never found its cuts again would still change dozens here.
		const g = await gear(EDIT_KEY);
		const data = sample(500_000);
		const edited = concat(
			data.subarray(0, 250_000),
			new Uint8Array([1, 2, 3]),
			data.subarray(250_000),
		);
		const key = (c: Uint8Array) => Buffer.from(c).toString("base64");
		const before = new Set(chunkAll(new Chunker(small, g), data, [8192]).map(key));
		const after = chunkAll(new Chunker(small, g), edited, [8192]).map(key);
		const changed = after.filter((c) => !before.has(c)).length;
		expect(changed).toBeLessThanOrEqual(3);
		expect(after.length).toBeGreaterThan(20);
	});

	it("cuts differently under a different key", async () => {
		const data = sample(300_000);
		const a = chunkAll(new Chunker(small, await gear()), data, [data.length]).map((c) => c.length);
		const b = chunkAll(new Chunker(small, await gear()), data, [data.length]).map((c) => c.length);
		expect(a).not.toEqual(b);
	});

	it("passes data shorter than the smallest chunk through whole", async () => {
		const chunker = new Chunker(small, await gear());
		expect(chunker.push(sample(100))).toEqual([]);
		expect(chunker.finish().map((c) => c.length)).toEqual([100]);
		expect(new Chunker(small, await gear()).finish()).toEqual([]);
	});

	it("refuses sizes out of order", async () => {
		const g = await gear();
		expect(() => new Chunker({ min: 10, avg: 5, max: 20 }, g)).toThrow();
		expect(() => new Chunker({ min: 1, avg: 2.5, max: 20 }, g)).toThrow();
	});
});
