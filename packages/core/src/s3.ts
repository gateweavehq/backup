import { sha256Hex, toHex, utf8 } from "./bytes";
import type { ObjectStore } from "./store";

/**
 * An S3-compatible bucket: AWS Signature Version 4, and a store over it. R2, AWS S3, Backblaze B2,
 * Hetzner Object Storage and MinIO all take path-style requests signed this way. Signing uses Web
 * Crypto, so it runs in Workers and in Node alike.
 */

export interface Credentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

/** The SHA-256 of nothing: what a request without a body signs as its payload. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** RFC 3986 with every character but the unreserved ones escaped, as SigV4 wants. */
export function uriEncode(text: string, { keepSlash = false } = {}): string {
	const encoded = encodeURIComponent(text).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return keepSlash ? encoded.replaceAll("%2F", "/") : encoded;
}

export interface CanonicalRequest {
	method: string;
	/** The path, already encoded. */
	path: string;
	query: [string, string][];
	/** Every header to sign, `host` and the `x-amz-*` ones included. */
	headers: [string, string][];
	payloadHash: string;
}

export function canonicalQuery(query: [string, string][]): string {
	return query
		.map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
		.sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
		.map(([name, value]) => `${name}=${value}`)
		.join("&");
}

async function hmac(key: Uint8Array<ArrayBuffer>, text: string): Promise<Uint8Array<ArrayBuffer>> {
	const imported = await crypto.subtle.importKey(
		"raw",
		key,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return new Uint8Array(await crypto.subtle.sign("HMAC", imported, utf8(text)));
}

/** The `Authorization` header for a request made at `amzDate` (`20130524T000000Z`). */
export async function authorization(
	request: CanonicalRequest,
	credentials: Credentials,
	region: string,
	amzDate: string,
	service = "s3",
): Promise<string> {
	const headers = request.headers
		.map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const signed = headers.map(([name]) => name).join(";");
	const canonical = [
		request.method,
		request.path,
		canonicalQuery(request.query),
		headers.map(([name, value]) => `${name}:${value}\n`).join(""),
		signed,
		request.payloadHash,
	].join("\n");
	const day = amzDate.slice(0, 8);
	const scope = `${day}/${region}/${service}/aws4_request`;
	const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(utf8(canonical))].join("\n");
	let key = await hmac(utf8(`AWS4${credentials.secretAccessKey}`), day);
	for (const part of [region, service, "aws4_request"]) key = await hmac(key, part);
	const signature = toHex(await hmac(key, toSign));
	return `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
}

/** `20130524T000000Z`, the time SigV4 signs. */
export function amzDateOf(at: Date): string {
	return at
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}/, "");
}

/** What went wrong reaching a bucket. It names objects, never their contents. */
export class S3Error extends Error {
	override name = "S3Error";

	/** The status the bucket refused with, when it answered. */
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
	}
}

export interface S3Options {
	/** `https://<account id>.r2.cloudflarestorage.com` for R2. */
	endpoint: URL;
	bucket: string;
	/** A folder in the bucket, ending with a slash, or empty. Keys are relative to it. */
	prefix: string;
	region: string;
	credentials: Credentials;
	fetch?: typeof fetch;
	now?: () => Date;
}

const ATTEMPTS = 4;
/** How long one request may take, its body included, before it is tried again. */
const TIMEOUT_MS = 120_000;

/**
 * A store in an S3-compatible bucket, with path-style requests signed with SigV4. A busy bucket
 * (429 or 5xx) or a failed connection is tried again, the answer's body included.
 */
export class S3Bucket implements ObjectStore {
	readonly #options: S3Options;
	readonly #fetch: typeof fetch;
	readonly #base: string;

	constructor(options: S3Options) {
		if (options.prefix !== "" && !options.prefix.endsWith("/")) {
			throw new S3Error("A prefix ends with a slash.");
		}
		this.#options = options;
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#base = `${options.endpoint.pathname.replace(/\/+$/, "")}/${uriEncode(options.bucket)}`;
	}

	/**
	 * Makes a signed request and reads its answer with `read`, which throws an `S3Error` to refuse.
	 * `key` is the whole key, the prefix included, or null for the bucket itself.
	 */
	async #request<T>(
		method: "GET" | "HEAD" | "PUT" | "DELETE",
		key: string | null,
		query: [string, string][],
		read: (response: Response) => Promise<T>,
		body?: Uint8Array<ArrayBuffer>,
	): Promise<T> {
		const { endpoint, region, credentials } = this.#options;
		const path =
			key === null ? `${this.#base}/` : `${this.#base}/${uriEncode(key, { keepSlash: true })}`;
		const search = query.map(([name, value]) => `${uriEncode(name)}=${uriEncode(value)}`).join("&");
		const url = `${endpoint.origin}${path}${search ? `?${search}` : ""}`;
		const what = key ?? "a listing";
		const payloadHash = body ? await sha256Hex(body) : EMPTY_SHA256;
		let last: unknown;
		for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
			const amzDate = amzDateOf(this.#options.now?.() ?? new Date());
			const headers: [string, string][] = [
				["host", endpoint.host],
				["x-amz-content-sha256", payloadHash],
				["x-amz-date", amzDate],
			];
			if (credentials.sessionToken) {
				headers.push(["x-amz-security-token", credentials.sessionToken]);
			}
			const signature = await authorization(
				{ method, path, query, headers, payloadHash },
				credentials,
				region,
				amzDate,
			);
			try {
				const response = await this.#fetch(url, {
					method,
					// `host` is the fetch's own; it is signed, not sent by hand.
					headers: [...headers.filter(([name]) => name !== "host"), ["authorization", signature]],
					...(body ? { body } : {}),
					signal: AbortSignal.timeout(TIMEOUT_MS),
				});
				if (response.status < 500 && response.status !== 429) return await read(response);
				last = new S3Error(`The bucket answered ${response.status} for ${what}.`);
				await response.body?.cancel();
			} catch (error) {
				if (error instanceof S3Error) throw error;
				last = error;
			}
			if (attempt < ATTEMPTS) await new Promise((done) => setTimeout(done, 250 * 2 ** attempt));
		}
		throw last instanceof S3Error
			? last
			: new S3Error(`The bucket couldn't be reached for ${what}.`);
	}

	async #refused(response: Response, key: string | null): Promise<never> {
		// S3's error body says why in its `Code`, which names no data.
		const code = /<Code>([^<]{1,64})<\/Code>/.exec(await response.text().catch(() => ""))?.[1];
		throw new S3Error(
			`The bucket answered ${response.status}${code ? ` (${code})` : ""} for ${key ?? "a listing"}.`,
			response.status,
		);
	}

	async get(key: string) {
		return this.#request("GET", this.#options.prefix + key, [], async (response) => {
			if (response.status === 404) {
				await response.body?.cancel();
				return null;
			}
			if (!response.ok) return this.#refused(response, key);
			return new Uint8Array(await response.arrayBuffer());
		});
	}

	async has(key: string) {
		return this.#request("HEAD", this.#options.prefix + key, [], async (response) => {
			await response.body?.cancel();
			if (response.status === 404) return false;
			if (!response.ok) return this.#refused(response, key);
			return true;
		});
	}

	async put(key: string, data: Uint8Array<ArrayBuffer>) {
		await this.#request(
			"PUT",
			this.#options.prefix + key,
			[],
			async (response) => {
				if (!response.ok) return this.#refused(response, key);
				await response.body?.cancel();
			},
			data,
		);
	}

	/** Deletes an object. One that is gone already is no error; one a lock keeps is. */
	async delete(key: string) {
		await this.#request("DELETE", this.#options.prefix + key, [], async (response) => {
			if (!response.ok && response.status !== 404) return this.#refused(response, key);
			await response.body?.cancel();
		});
	}

	async *list(prefix: string) {
		const full = this.#options.prefix + prefix;
		let token: string | null = null;
		do {
			const query: [string, string][] = [
				["list-type", "2"],
				["prefix", full],
			];
			if (token !== null) query.push(["continuation-token", token]);
			const page = await this.#request("GET", null, query, async (response) => {
				if (!response.ok) return this.#refused(response, null);
				return parseListing(await response.text());
			});
			for (const key of page.keys) {
				if (key.startsWith(this.#options.prefix)) yield key.slice(this.#options.prefix.length);
			}
			token = page.next;
		} while (token !== null);
	}
}

/** The keys in a ListObjectsV2 answer, and the token for the next page if there is one. */
export function parseListing(xml: string): { keys: string[]; next: string | null } {
	const keys: string[] = [];
	for (const contents of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
		const key = /<Key>([\s\S]*?)<\/Key>/.exec(contents[1] ?? "")?.[1];
		if (key !== undefined) keys.push(xmlText(key));
	}
	const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml);
	const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
	if (truncated && next === undefined) {
		throw new S3Error("The bucket's listing goes on but gives no way to the next page.");
	}
	return { keys, next: truncated && next !== undefined ? xmlText(next) : null };
}

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};

function xmlText(text: string): string {
	return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, name: string) => {
		if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
		if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
		return ENTITIES[name] ?? whole;
	});
}

/** An `s3://<bucket>[/<folder>]` location: its bucket, and its folder ending with a slash or empty. */
export function parseS3Url(location: string): { bucket: string; prefix: string } {
	if (!location.startsWith("s3://")) throw new S3Error(`${location} isn't an s3:// location.`);
	const rest = location.slice("s3://".length);
	const slash = rest.indexOf("/");
	const bucket = slash < 0 ? rest : rest.slice(0, slash);
	let prefix = slash < 0 ? "" : rest.slice(slash + 1);
	if (prefix !== "" && !prefix.endsWith("/")) prefix += "/";
	if (bucket === "") throw new S3Error("s3:// needs a bucket: s3://<bucket>/<folder>.");
	// A URL would tidy these away, and the request would no longer be the one signed.
	if (prefix !== "" && !sendable(prefix.slice(0, -1))) {
		throw new S3Error(`The folder in ${location} has an empty, . or .. part.`);
	}
	return { bucket, prefix };
}

/** A key that goes into a request path as it is: a URL would tidy away an empty, . or .. part. */
export function sendable(key: string): boolean {
	return key.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
