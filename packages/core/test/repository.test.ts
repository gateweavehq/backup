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

	it("sorts snapshots made in the same second in the order they were made", async () => {
		const { repo } = await fresh();
		const { entry } = await repo.writeFile("f", utf8("x"));
		const at = new Date("2026-11-11T20:05:00.100Z");
		const names: string[] = [];
		for (let i = 0; i < 5; i++) {
			names.push((await repo.commit({ kind: "d1", name: "db" }, [entry], {}, at)).name);
		}
		expect(await repo.snapshots()).toEqual(names);
		expect(names.map((n) => n.slice(0, 16))).toEqual([
			"20261111T200500Z",
			"20261111T200501Z",
			"20261111T200502Z",
			"20261111T200503Z",
			"20261111T200504Z",
		]);
	});

	it("keeps config.json readable, with nothing secret in it", async () => {
		const { store, key } = await fresh();
		const config = JSON.parse(fromUtf8(store.objects.get("config.json") ?? new Uint8Array()));
		expect(config).toMatchObject({ format: "gateweave-backup", version: 1, chunker });
		expect(JSON.stringify(config)).not.toContain(key);
	});
});

describe("pruning", () => {
	it("forgets a snapshot, then lets go of the chunks only it used", async () => {
		const { store, key, repo } = await fresh();
		const first = text(60_000, 1);
		const second = new Uint8Array([...first.subarray(0, 30_000), ...text(30_000, 2)]);
		const one = await repo.writeFile("database.jsonl", first);
		const old = await repo.commit({ kind: "d1", name: "db" }, [one.entry]);
		const two = await repo.writeFile("database.jsonl", second);
		const kept = await repo.commit({ kind: "d1", name: "db" }, [two.entry]);

		await repo.forget(old.name);
		expect(await repo.snapshots()).toEqual([kept.name]);
		const onlyOld = one.entry.chunks.filter((id) => !two.entry.chunks.includes(id));
		expect(onlyOld.length).toBeGreaterThan(0);

		const stats = await repo.prune();
		expect(stats).toEqual({
			snapshots: 1,
			chunks: new Set([...one.entry.chunks, ...two.entry.chunks]).size,
			deleted: new Set(onlyOld).size,
			held: 0,
		});
		for (const id of onlyOld) expect(await store.has(`data/${id.slice(0, 2)}/${id}`)).toBe(false);

		const again = await Repository.open(store, key);
		expect(await again.readWholeFile(two.entry)).toEqual(second);
		expect(await again.prune()).toMatchObject({ deleted: 0 });
	});

	it("deletes nothing when a manifest doesn't open", async () => {
		const { store, repo } = await fresh();
		const { entry } = await repo.writeFile("database.jsonl", text(20_000));
		const manifest = await repo.commit(
			{ kind: "d1", name: "db" },
			[entry],
			{},
			new Date("2026-11-10T03:00:00Z"),
		);
		const loose = await repo.writeFile("loose.jsonl", text(20_000, 9));
		const newer = await repo.commit(
			{ kind: "d1", name: "db" },
			[loose.entry],
			{},
			new Date("2026-11-11T03:00:00Z"),
		);
		const blob = store.objects.get(`snapshots/${manifest.name}`);
		if (!blob) throw new Error("no manifest");
		blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 1;
		await repo.forget(newer.name);

		const before = store.objects.size;
		await expect(repo.prune()).rejects.toThrow(/could not be opened/);
		expect(store.objects.size).toBe(before);
	});

	it("leaves what isn't a chunk, and counts what the store won't delete", async () => {
		const { store, repo } = await fresh();
		const { entry } = await repo.writeFile("database.jsonl", text(20_000));
		const manifest = await repo.commit({ kind: "d1", name: "db" }, [entry]);
		store.objects.set("data/notes.txt", utf8("not ours"));
		await repo.forget(manifest.name);

		// A locked bucket refuses deletes inside its retention period.
		store.delete = async () => {
			throw new Error("This object is locked.");
		};
		const held = await repo.prune();
		expect(held).toEqual({
			snapshots: 0,
			chunks: entry.chunks.length,
			deleted: 0,
			held: entry.chunks.length,
		});
		expect(store.objects.has("data/notes.txt")).toBe(true);
	});

	it("only forgets what is named as a snapshot", async () => {
		const { repo } = await fresh();
		await expect(repo.forget("../config.json")).rejects.toBeInstanceOf(RepositoryError);
	});
});
