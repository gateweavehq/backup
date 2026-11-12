const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export function utf8(text: string): Uint8Array<ArrayBuffer> {
	// Workers' types don't say what the DOM's do: the encoder always makes a fresh ArrayBuffer.
	return encoder.encode(text) as Uint8Array<ArrayBuffer>;
}

export function fromUtf8(bytes: Uint8Array): string {
	return decoder.decode(bytes);
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	let length = 0;
	for (const part of parts) length += part.length;
	const out = new Uint8Array(length);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

export function toHex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
}

export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
	if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) throw new Error("Not lowercase hex.");
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

export function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("Not base64url.");
	const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

interface DigestStreamLike extends WritableStream<Uint8Array> {
	readonly digest: Promise<ArrayBuffer>;
}

/**
 * SHA-256 over bytes that arrive in pieces. Workers have a streaming digest, `crypto.DigestStream`,
 * so a file is hashed as it goes by and never held whole for it. Elsewhere, as in Node, Web Crypto
 * has none, so the pieces are kept and hashed at the end.
 */
export class Sha256 {
	readonly #stream: DigestStreamLike | undefined;
	readonly #writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
	readonly #parts: Uint8Array[] = [];

	constructor() {
		const DigestStream = (
			crypto as unknown as { DigestStream?: new (algorithm: string) => DigestStreamLike }
		).DigestStream;
		if (DigestStream) {
			this.#stream = new DigestStream("SHA-256");
			this.#writer = this.#stream.getWriter();
		}
	}

	async update(part: Uint8Array): Promise<void> {
		if (this.#writer) await this.#writer.write(part);
		else this.#parts.push(part);
	}

	async digest(): Promise<string> {
		if (this.#writer && this.#stream) {
			await this.#writer.close();
			return toHex(new Uint8Array(await this.#stream.digest));
		}
		return sha256Hex(concat(...this.#parts));
	}
}
