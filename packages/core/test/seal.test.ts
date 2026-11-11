import { describe, expect, it } from "vitest";
import { fromHex, utf8 } from "../src/bytes";
import { deriveKeys, generateMasterKey, parseMasterKey } from "../src/keys";
import { chunkIdOf, open, SealError, seal } from "../src/seal";

const repoId = fromHex("00112233445566778899aabbccddeeff");

async function keys(master = generateMasterKey()) {
	return deriveKeys(parseMasterKey(master), repoId);
}

describe("master keys", () => {
	it("are 32 bytes in base64url", () => {
		const key = generateMasterKey();
		expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(parseMasterKey(key)).toHaveLength(32);
	});

	it("refuse anything else without repeating it", () => {
		for (const bad of ["", "short", `${generateMasterKey()}AA`, "not base64url!!"]) {
			expect(() => parseMasterKey(bad)).toThrow(/32 bytes in base64url/);
			try {
				parseMasterKey(bad);
			} catch (error) {
				if (bad) expect(String(error)).not.toContain(bad);
			}
		}
	});

	it("give different keys in different repositories", async () => {
		const master = generateMasterKey();
		const a = await deriveKeys(parseMasterKey(master), repoId);
		const b = await deriveKeys(parseMasterKey(master), fromHex("ffeeddccbbaa99887766554433221100"));
		const data = utf8("the same plaintext");
		expect(await chunkIdOf(a, data)).not.toBe(await chunkIdOf(b, data));
		expect(a.gear).not.toEqual(b.gear);
	});
});

describe("sealed blobs", () => {
	it("open with the same key and label", async () => {
		const k = await keys();
		const text = utf8("hello ".repeat(1000));
		const blob = await seal(k, "chunk:abc", text);
		expect(await open(k, "chunk:abc", blob)).toEqual(text);
	});

	it("compress what gets smaller, and leave the rest", async () => {
		const k = await keys();
		const repetitive = await seal(k, "x", utf8("a".repeat(10_000)));
		expect(repetitive[1]).toBe(1);
		expect(repetitive.length).toBeLessThan(1000);
		const random = crypto.getRandomValues(new Uint8Array(4096));
		const sealed = await seal(k, "x", random);
		expect(sealed[1]).toBe(0);
		expect(await open(k, "x", sealed)).toEqual(random);
	});

	it("hold an empty plaintext", async () => {
		const k = await keys();
		expect(await open(k, "x", await seal(k, "x", new Uint8Array(0)))).toHaveLength(0);
	});

	it("don't open under another label, so a blob can't be moved", async () => {
		const k = await keys();
		const blob = await seal(k, "chunk:aaa", utf8("data"));
		await expect(open(k, "chunk:bbb", blob)).rejects.toBeInstanceOf(SealError);
	});

	it("don't open with another key", async () => {
		const blob = await seal(await keys(), "x", utf8("data"));
		await expect(open(await keys(), "x", blob)).rejects.toBeInstanceOf(SealError);
	});

	it("notice any changed byte, the header included", async () => {
		const k = await keys();
		const blob = await seal(k, "x", utf8("some data to protect"));
		for (const at of [0, 1, 5, blob.length - 1]) {
			const changed = blob.slice();
			changed[at] = (changed[at] ?? 0) ^ 0x01;
			await expect(open(k, "x", changed)).rejects.toBeInstanceOf(SealError);
		}
		await expect(open(k, "x", blob.slice(0, 20))).rejects.toBeInstanceOf(SealError);
	});

	it("use a fresh nonce each time", async () => {
		const k = await keys();
		const a = await seal(k, "x", utf8("same"));
		const b = await seal(k, "x", utf8("same"));
		expect(a).not.toEqual(b);
	});
});
