import { fromBase64Url, toBase64Url, utf8 } from "./bytes";

/** docs/format.md, "Keys". */
export interface RepositoryKeys {
	/** AES-256-GCM, sealing every blob. */
	readonly seal: CryptoKey;
	/** HMAC-SHA256, naming chunks by their content. */
	readonly chunkId: CryptoKey;
	/** The chunker's gear table, 256 values. It comes from the key so cut points reveal nothing. */
	readonly gear: Uint32Array;
}

const MASTER_KEY_BYTES = 32;

/** A new master key, as the owner keeps it: 32 random bytes in base64url. */
export function generateMasterKey(): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(MASTER_KEY_BYTES)));
}

/** The master key's bytes. The same error for anything that isn't one, so it never echoes input. */
export function parseMasterKey(text: string): Uint8Array<ArrayBuffer> {
	let bytes: Uint8Array<ArrayBuffer>;
	try {
		bytes = fromBase64Url(text.trim());
	} catch {
		throw new Error("The backup key must be 32 bytes in base64url (43 characters).");
	}
	if (bytes.length !== MASTER_KEY_BYTES) {
		throw new Error("The backup key must be 32 bytes in base64url (43 characters).");
	}
	return bytes;
}

/** The repository's keys, from the master key and the repository's id (its salt). */
export async function deriveKeys(
	master: Uint8Array<ArrayBuffer>,
	repositoryId: Uint8Array<ArrayBuffer>,
): Promise<RepositoryKeys> {
	const base = await crypto.subtle.importKey("raw", master, "HKDF", false, ["deriveBits"]);
	const bits = (info: string, length: number) =>
		crypto.subtle.deriveBits(
			{ name: "HKDF", hash: "SHA-256", salt: repositoryId, info: utf8(info) },
			base,
			length * 8,
		);
	const [sealBits, idBits, gearBits] = await Promise.all([
		bits("gateweave-backup v1 seal", 32),
		bits("gateweave-backup v1 chunk-id", 32),
		bits("gateweave-backup v1 chunker", 1024),
	]);
	const [seal, chunkId] = await Promise.all([
		crypto.subtle.importKey("raw", sealBits, "AES-GCM", false, ["encrypt", "decrypt"]),
		crypto.subtle.importKey("raw", idBits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
	]);
	// Little-endian, so the table is the same on every machine.
	const view = new DataView(gearBits);
	const gear = new Uint32Array(256);
	for (let i = 0; i < 256; i++) gear[i] = view.getUint32(i * 4, true);
	return { seal, chunkId, gear };
}
