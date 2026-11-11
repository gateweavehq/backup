import { describe, expect, it } from "vitest";
import { fromUtf8, utf8 } from "../src/bytes";
import type { ChunkerParams } from "../src/cdc";
import { generateMasterKey } from "../src/keys";
import { Repository, RepositoryError, snapshotName } from "../src/repository";
import { MemoryStore } from "../src/store";

const chunker: ChunkerParams = { min: 1024, avg: 4096, max: 16384 };

function text(length: number, seed = 7): Uint8Array<ArrayBuffer> {
	let out = "";
	let x = seed;
	while (out.length < length) {
		x = (Math.imul(x, 1103515245) + 12345) >>> 0;
		out += `{"k":"row","t":"user","v":"'u${x % 100000}','person${x % 977}@example.com',${x}"}\n`;
	}
	return utf8(out.slice(0, length));
}

async function fresh() {
	const store = new MemoryStore();
	const key = generateMasterKey();
	const repo = await Repository.init(store, key, { chunker });
	return { store, key, repo };
}

describe("a repository", () => {
	it("opens with its key, and only with it", async () => {
		const { store, key } = await fresh();
		expect((await Repository.open(store, key)).config.chunker).toEqual(chunker);
		await expect(Repository.open(store, generateMasterKey())).rejects.toThrow(
			"That key doesn't open this repository.",
		);
	});

	it("is made only once in a store", async () => {
		const { store, key } = await fresh();
		await expect(Repository.init(store, key)).rejects.toBeInstanceOf(RepositoryError);
	});

	it("keeps nothing readable without the key", async () => {
		const { store, repo } = await fresh();
		const data = utf8("ada@example.com is a secret address ".repeat(200));
		const { entry } = await repo.writeFile("database.jsonl", data);
		await repo.commit({ kind: "d1", name: "db" }, [entry]);
		for (const [key, value] of store.objects) {
			if (key === "config.json") continue;
			expect(Buffer.from(value).toString("latin1")).not.toContain("ada@example.com");
		}
	});

	it("gives back a file as it was written", async () => {
		const { store, key, repo } = await fresh();
		const data = text(100_000);
		const { entry } = await repo.writeFile("database.jsonl", data);
		const manifest = await repo.commit({ kind: "d1", name: "db" }, [entry], { rows: 3 });

		const again = await Repository.open(store, key);
		expect(await again.snapshots()).toEqual([manifest.name]);
		const read = await again.manifest(manifest.name);
		expect(read.meta).toEqual({ rows: 3 });
		const file = read.files[0];
		if (!file) throw new Error("no file");
		expect(await again.readWholeFile(file)).toEqual(data);
	});

	it("stores only what changed since the last snapshot", async () => {
		const { store, repo } = await fresh();
		const first = text(200_000);
		const one = await repo.writeFile("database.jsonl", first);
		await repo.commit({ kind: "d1", name: "db" }, [one.entry]);
		expect(one.stats.newChunks).toBe(one.stats.chunks);

		const second = new Uint8Array([
			...first.subarray(0, 100_000),
			...utf8("one new row\n"),
			...first.subarray(100_000),
		]);
		const putsBefore = store.puts;
		const two = await repo.writeFile("database.jsonl", second);
		expect(two.stats.newChunks).toBeLessThanOrEqual(3);
		expect(store.puts - putsBefore).toBe(two.stats.newChunks);
	});

	it("accepts a file in pieces", async () => {
		const { repo } = await fresh();
		const data = text(50_000);
		async function* pieces() {
			for (let at = 0; at < data.length; at += 777) yield data.subarray(at, at + 777);
		}
		const { entry } = await repo.writeFile("database.jsonl", pieces());
		expect(await repo.readWholeFile(entry)).toEqual(data);
		const whole = await repo.writeFile("again.jsonl", data);
		expect(whole.entry.chunks).toEqual(entry.chunks);
	});

	it("notices a missing or damaged chunk", async () => {
		const { store, repo } = await fresh();
		const { entry } = await repo.writeFile("database.jsonl", text(30_000));
		const [firstChunk, secondChunk] = entry.chunks;
		if (!firstChunk || !secondChunk) throw new Error("expected two chunks");

		const damaged = `data/${secondChunk.slice(0, 2)}/${secondChunk}`;
		const blob = store.objects.get(damaged);
		if (!blob) throw new Error("no blob");
		blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 1;
		await expect(repo.readWholeFile(entry)).rejects.toThrow(/could not be opened/);

		store.objects.delete(`data/${firstChunk.slice(0, 2)}/${firstChunk}`);
		await expect(repo.readWholeFile(entry)).rejects.toThrow(/is missing/);
	});

	it("refuses a chunk swapped for another of its own", async () => {
		const { store, repo } = await fresh();
		const { entry } = await repo.writeFile("database.jsonl", text(30_000));
		const [a, b] = entry.chunks;
		if (!a || !b) throw new Error("expected two chunks");
		const keyA = `data/${a.slice(0, 2)}/${a}`;
		const keyB = `data/${b.slice(0, 2)}/${b}`;
		const blobB = store.objects.get(keyB);
		if (!blobB) throw new Error("no blob");
		store.objects.set(keyA, blobB);
		await expect(repo.readWholeFile(entry)).rejects.toThrow(/could not be opened/);
	});

	it("lists snapshots oldest first, by name", async () => {
		const { repo } = await fresh();
		const { entry } = await repo.writeFile("f", utf8("x"));
		const later = await repo.commit(
			{ kind: "d1", name: "db" },
			[entry],
			{},
			new Date("2026-11-12T00:00:00Z"),
		);
		const earlier = await repo.commit(
			{ kind: "d1", name: "db" },
			[entry],
			{},
			new Date("2026-11-11T00:00:00Z"),
		);
		expect(await repo.snapshots()).toEqual([earlier.name, later.name]);
		expect(snapshotName(new Date("2026-11-11T20:05:00.123Z"))).toMatch(
			/^20261111T200500Z-[0-9a-f]{8}$/,
		);
	});

	it("keeps config.json readable, with nothing secret in it", async () => {
		const { store, key } = await fresh();
		const config = JSON.parse(fromUtf8(store.objects.get("config.json") ?? new Uint8Array()));
		expect(config).toMatchObject({ format: "gateweave-backup", version: 1, chunker });
		expect(JSON.stringify(config)).not.toContain(key);
	});
});
