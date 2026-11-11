import { concat, utf8 } from "./bytes";
import { deflateRaw, inflateRaw } from "./compress";
import type { RepositoryKeys } from "./keys";

/** docs/format.md, "Sealed blobs". */
const VERSION = 1;
const COMPRESSED = 0b1;
const NONCE_BYTES = 12;
const HEADER_BYTES = 2 + NONCE_BYTES;
const TAG_BYTES = 16;

export class SealError extends Error {
	constructor(label: string) {
		// The label says which object, never anything about its contents.
		super(`${label} could not be opened: the key is wrong, or the object was changed.`);
		this.name = "SealError";
	}
}

/**
 * Encrypts `plaintext` for the object named by `label`, compressing it first when that makes it
 * smaller. The label is authenticated, so the blob opens only under the same name.
 */
export async function seal(
	keys: RepositoryKeys,
	label: string,
	plaintext: Uint8Array<ArrayBuffer>,
	{ compress = true }: { compress?: boolean } = {},
): Promise<Uint8Array<ArrayBuffer>> {
	let body = plaintext;
	let flags = 0;
	if (compress && plaintext.length > 0) {
		const smaller = await deflateRaw(plaintext);
		if (smaller.length < plaintext.length) {
			body = smaller;
			flags |= COMPRESSED;
		}
	}
	const header = new Uint8Array(HEADER_BYTES);
	header[0] = VERSION;
	header[1] = flags;
	header.set(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)), 2);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: header.slice(2), additionalData: concat(utf8(label), header) },
		keys.seal,
		body,
	);
	return concat(header, new Uint8Array(ciphertext));
}

/** The plaintext of a blob `seal` made for `label`. Throws `SealError` for anything else. */
export async function open(
	keys: RepositoryKeys,
	label: string,
	blob: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
	if (blob.length < HEADER_BYTES + TAG_BYTES || blob[0] !== VERSION) throw new SealError(label);
	const flags = blob[1] ?? 0;
	if ((flags & ~COMPRESSED) !== 0) throw new SealError(label);
	const header = blob.slice(0, HEADER_BYTES);
	let body: Uint8Array<ArrayBuffer>;
	try {
		body = new Uint8Array(
			await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv: header.slice(2), additionalData: concat(utf8(label), header) },
				keys.seal,
				blob.slice(HEADER_BYTES),
			),
		);
	} catch {
		throw new SealError(label);
	}
	return flags & COMPRESSED ? inflateRaw(body) : body;
}

/** A chunk's id: the hex HMAC-SHA256 of its plaintext under the chunk-id key. */
export async function chunkIdOf(
	keys: RepositoryKeys,
	plaintext: Uint8Array<ArrayBuffer>,
): Promise<string> {
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", keys.chunkId, plaintext));
	let hex = "";
	for (const byte of mac) hex += byte.toString(16).padStart(2, "0");
	return hex;
}
