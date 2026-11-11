const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8(text: string): Uint8Array<ArrayBuffer> {
	return encoder.encode(text);
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
