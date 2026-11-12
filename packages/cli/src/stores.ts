import { readdir, readFile, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join, resolve, sep } from "node:path";
import type { ObjectStore } from "@gateweave/backup-core";
import { amzDateOf, authorization, type Credentials, EMPTY_SHA256, uriEncode } from "./sigv4";

/** What went wrong reaching a repository's objects. It names objects, never their contents. */
export class StoreError extends Error {
	override name = "StoreError";
}

/**
 * The CLI only reads a repository. Restoring writes somewhere else, so nothing it does can change
 * or lose a backup, whatever its credentials would allow.
 */
function readOnly(): never {
	throw new StoreError("This tool only reads a repository; it never writes to one.");
}

/** Keys the format makes are plain relative paths. Anything else isn't read. */
function checkKey(key: string): void {
	if (
		key === "" ||
		key.startsWith("/") ||
		key.includes("\\") ||
		key.includes("\0") ||
		key.split("/").some((part) => part === "" || part === "." || part === "..")
	) {
		throw new StoreError(`${JSON.stringify(key)} is not a repository object's name.`);
	}
}

/**
 * A repository copied to a folder, as `rclone copy` or `aws s3 sync` leaves it: the folder holds
 * `config.json`, `snapshots/` and `data/`.
 */
export class FolderStore implements ObjectStore {
	readonly #root: string;

	constructor(root: string) {
		this.#root = resolve(root);
	}

	#path(key: string): string {
		checkKey(key);
		return join(this.#root, ...key.split("/"));
	}

	async get(key: string) {
		try {
			const bytes = await readFile(this.#path(key));
			return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
		} catch (error) {
			if (isMissing(error)) return null;
			throw error;
		}
	}

	async has(key: string) {
		try {
			return (await stat(this.#path(key))).isFile();
		} catch (error) {
			if (isMissing(error)) return false;
			throw error;
		}
	}

	async *list(prefix: string) {
		// Start at the folder the prefix names, so listing `snapshots/` doesn't walk `data/`.
		const at = prefix.lastIndexOf("/");
		const base = at < 0 ? "" : prefix.slice(0, at);
		const start = base === "" ? this.#root : join(this.#root, ...base.split("/"));
		for await (const key of walk(start, base)) if (key.startsWith(prefix)) yield key;
	}

	async put(): Promise<void> {
		readOnly();
	}

	async delete(): Promise<void> {
		readOnly();
	}
}

async function* walk(dir: string, key: string): AsyncGenerator<string> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) return;
		throw error;
	}
	for (const entry of entries) {
		const name = key === "" ? entry.name : `${key}/${entry.name}`;
		if (entry.isDirectory()) yield* walk(`${dir}${sep}${entry.name}`, name);
		else if (entry.isFile()) yield name;
	}
}

function isMissing(error: unknown): boolean {
	const code = (error as { code?: unknown })?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

export interface S3Options {
	/** `https://<account id>.r2.cloudflarestorage.com` for R2. */
	endpoint: URL;
	bucket: string;
	/** The repository's folder in the bucket, ending with a slash, or empty. */
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
 * A repository in an S3-compatible bucket, read with path-style requests signed with SigV4. R2
 * takes them at its S3 endpoint with an R2 API token's access key; so do AWS S3, B2 and MinIO.
 */
export class S3Store implements ObjectStore {
	readonly #options: S3Options;
	readonly #fetch: typeof fetch;
	readonly #base: string;

	constructor(options: S3Options) {
		if (options.prefix !== "" && !options.prefix.endsWith("/")) {
			throw new StoreError("A prefix ends with a slash.");
		}
		this.#options = options;
		this.#fetch = options.fetch ?? fetch;
		this.#base = `${options.endpoint.pathname.replace(/\/+$/, "")}/${uriEncode(options.bucket)}`;
	}

	/**
	 * Makes a signed request and reads its answer with `read`, trying again when the bucket is busy
	 * or the connection fails, the answer's body included. `read` throws a `StoreError` to refuse.
	 */
	async #request<T>(
		method: "GET" | "HEAD",
		key: string | null,
		query: [string, string][],
		read: (response: Response) => Promise<T>,
	): Promise<T> {
		const { endpoint, region, credentials } = this.#options;
		const path =
			key === null ? `${this.#base}/` : `${this.#base}/${uriEncode(key, { keepSlash: true })}`;
		const search = query.map(([name, value]) => `${uriEncode(name)}=${uriEncode(value)}`).join("&");
		const url = `${endpoint.origin}${path}${search ? `?${search}` : ""}`;
		const what = key ?? "a listing";
		let last: unknown;
		for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
			const amzDate = amzDateOf(this.#options.now?.() ?? new Date());
			const headers: [string, string][] = [
				["host", endpoint.host],
				["x-amz-content-sha256", EMPTY_SHA256],
				["x-amz-date", amzDate],
			];
			if (credentials.sessionToken)
				headers.push(["x-amz-security-token", credentials.sessionToken]);
			const signature = authorization(
				{ method, path, query, headers, payloadHash: EMPTY_SHA256 },
				credentials,
				region,
				amzDate,
			);
			try {
				const response = await this.#fetch(url, {
					method,
					// `host` is the fetch's own; it is signed, not sent by hand.
					headers: [...headers.filter(([name]) => name !== "host"), ["authorization", signature]],
					signal: AbortSignal.timeout(TIMEOUT_MS),
				});
				if (response.status < 500 && response.status !== 429) return await read(response);
				last = new StoreError(`The bucket answered ${response.status} for ${what}.`);
				await response.body?.cancel();
			} catch (error) {
				if (error instanceof StoreError) throw error;
				last = error;
			}
			if (attempt < ATTEMPTS) await new Promise((done) => setTimeout(done, 250 * 2 ** attempt));
		}
		throw last instanceof StoreError
			? last
			: new StoreError(`The bucket couldn't be reached for ${what}.`);
	}

	async #refused(response: Response, key: string | null): Promise<never> {
		// S3's error body says why in its `Code`, which names no data.
		const code = /<Code>([^<]{1,64})<\/Code>/.exec(await response.text().catch(() => ""))?.[1];
		throw new StoreError(
			`The bucket answered ${response.status}${code ? ` (${code})` : ""} for ${key ?? "a listing"}.`,
		);
	}

	async get(key: string) {
		checkKey(key);
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
		checkKey(key);
		return this.#request("HEAD", this.#options.prefix + key, [], async (response) => {
			await response.body?.cancel();
			if (response.status === 404) return false;
			if (!response.ok) return this.#refused(response, key);
			return true;
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

	async put(): Promise<void> {
		readOnly();
	}

	async delete(): Promise<void> {
		readOnly();
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
		throw new StoreError("The bucket's listing goes on but gives no way to the next page.");
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

/** A key that goes into a request path as it is: a URL would tidy away an empty, . or .. part. */
export function sendable(key: string): boolean {
	return key.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** The largest object one PutObject takes at R2: 5 MiB less than 5 GiB, which AWS S3 takes. */
export const PUT_LIMIT = 5 * 1024 ** 3 - 5 * 1024 ** 2;

/** What restoring one object into a bucket came to. */
export type Placed = "created" | "there";

export interface NewObject {
	key: string;
	size: number;
	/** The bytes' SHA-256, hex. It is signed, so the bucket refuses bytes that don't match it. */
	sha256: string;
	/** Content-Type, x-amz-meta-* and the like, as they are to be sent. */
	headers: [string, string][];
	/** The bytes, read again for each try. */
	body: () => AsyncIterable<Uint8Array>;
}

/** The bytes to send couldn't be read: trying again wouldn't mend that. */
class BodyError extends Error {
	constructor(readonly reason: unknown) {
		super("The bytes to send couldn't be read.");
	}
}

interface Answer {
	status: number;
	code: string | undefined;
}

/**
 * A bucket that a snapshot of a bucket is restored into. It only creates objects: each PutObject
 * carries `If-None-Match: *`, so the bucket refuses a key that is taken, and nothing there is ever
 * replaced.
 *
 * It writes with node:http rather than fetch, which adds `Cache-Control: no-cache` to a request
 * with `If-None-Match`, and the bucket would keep that as the object's own.
 */
export class S3Target {
	readonly #options: S3Options;
	readonly #base: string;

	constructor(options: S3Options) {
		if (options.prefix !== "" && !options.prefix.endsWith("/")) {
			throw new StoreError("A prefix ends with a slash.");
		}
		this.#options = options;
		this.#base = `${options.endpoint.pathname.replace(/\/+$/, "")}/${uriEncode(options.bucket)}`;
	}

	/** The bucket and folder, as `--to` named them. */
	get location(): string {
		const { bucket, prefix } = this.#options;
		return `s3://${bucket}${prefix === "" ? "" : `/${prefix.slice(0, -1)}`}`;
	}

	/**
	 * Puts an object under its key, unless the key is taken. A try that fails on the way is made
	 * again; should the first one have been stored without its answer arriving, the next finds the
	 * key taken, and the object counts as there already, which it is.
	 */
	async create(object: NewObject): Promise<Placed> {
		const { endpoint, region, credentials, prefix } = this.#options;
		const key = prefix + object.key;
		if (!sendable(key)) {
			throw new StoreError(`${JSON.stringify(object.key)} can't be sent as a key as it is.`);
		}
		const path = `${this.#base}/${uriEncode(key, { keepSlash: true })}`;
		let last: unknown;
		for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
			const amzDate = amzDateOf(this.#options.now?.() ?? new Date());
			const headers: [string, string][] = [
				["host", endpoint.host],
				["content-length", String(object.size)],
				["if-none-match", "*"],
				["x-amz-content-sha256", object.sha256],
				["x-amz-date", amzDate],
				...object.headers,
			];
			if (credentials.sessionToken) {
				headers.push(["x-amz-security-token", credentials.sessionToken]);
			}
			const signature = authorization(
				{ method: "PUT", path, query: [], headers, payloadHash: object.sha256 },
				credentials,
				region,
				amzDate,
			);
			headers.push(["authorization", signature]);
			try {
				const answer = await put(endpoint, path, headers, object.body);
				if (answer.status >= 200 && answer.status < 300) return "created";
				// 409: a bucket lock keeps the object at that key, which is there all the same.
				if (
					answer.status === 412 ||
					(answer.status === 409 && answer.code === "ObjectLockedByBucketPolicy")
				) {
					return "there";
				}
				const refused = new StoreError(
					`The bucket answered ${answer.status}${answer.code ? ` (${answer.code})` : ""} for ${object.key}.`,
				);
				if (answer.status < 500 && answer.status !== 429) throw refused;
				last = refused;
			} catch (error) {
				if (error instanceof BodyError) throw error.reason;
				if (error instanceof StoreError) throw error;
				last = error;
			}
			if (attempt < ATTEMPTS) await new Promise((done) => setTimeout(done, 250 * 2 ** attempt));
		}
		throw last instanceof StoreError
			? last
			: new StoreError(`The bucket couldn't be reached for ${object.key}.`);
	}
}

/**
 * Sends one PUT, streaming its body, and reads the answer's status and S3 error code. A failure to
 * read the body rejects with a `BodyError`. An answer that comes before the body is all sent, as
 * a 412 can, ends the request there.
 */
function put(
	endpoint: URL,
	path: string,
	headers: [string, string][],
	body: () => AsyncIterable<Uint8Array>,
): Promise<Answer> {
	const send = endpoint.protocol === "https:" ? httpsRequest : httpRequest;
	return new Promise<Answer>((resolve, reject) => {
		let answered = false;
		const request = send({
			protocol: endpoint.protocol,
			hostname: endpoint.hostname.replace(/^\[(.*)\]$/, "$1"),
			port: endpoint.port || undefined,
			method: "PUT",
			path,
			headers: Object.fromEntries(headers),
		});
		request.setTimeout(TIMEOUT_MS, () =>
			request.destroy(new Error("The bucket stopped answering.")),
		);
		request.on("error", (error) => {
			if (!answered) reject(error);
		});
		request.on("response", (response) => {
			answered = true;
			let text = "";
			response.setEncoding("utf8");
			response.on("data", (part: string) => {
				if (text.length < 4096) text += part;
			});
			response.on("error", reject);
			response.on("end", () => {
				// S3's error body says why in its `Code`, which names no data.
				resolve({
					status: response.statusCode ?? 0,
					code: /<Code>([^<]{1,64})<\/Code>/.exec(text)?.[1],
				});
				request.destroy();
			});
		});
		const chunks = body()[Symbol.asyncIterator]();
		// Stops reading the repository once the request is over, answered or failed.
		const over = async () => {
			if (!answered && !request.destroyed) return false;
			await chunks.return?.()?.catch(() => {});
			return true;
		};
		void (async () => {
			for (;;) {
				if (await over()) return;
				let next: IteratorResult<Uint8Array>;
				try {
					next = await chunks.next();
				} catch (error) {
					request.destroy(new BodyError(error));
					return;
				}
				if (next.done) break;
				if (await over()) return;
				if (!request.write(next.value)) {
					await new Promise((done) => {
						request.once("drain", done);
						request.once("close", done);
					});
				}
			}
			if (!answered && !request.destroyed) request.end();
		})().catch((error: unknown) => request.destroy(error as Error));
	});
}

export interface Settings {
	env: Record<string, string | undefined>;
	endpoint?: string;
	region?: string;
	fetch?: typeof fetch;
}

/**
 * The store a repository argument names: `s3://<bucket>/<folder>` for a bucket, anything else for
 * a folder on this machine.
 */
export function openStore(location: string, settings: Settings): ObjectStore {
	if (!location.startsWith("s3://")) return new FolderStore(location);
	return new S3Store({
		...s3Options(location, settings, {
			endpoint: "An s3:// repository needs --endpoint or AWS_ENDPOINT_URL",
			credentials:
				"An s3:// repository needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY: for R2, an API token with read access to the bucket.",
		}),
		...(settings.fetch ? { fetch: settings.fetch } : {}),
	});
}

/**
 * The bucket `--to s3://<bucket>[/<folder>]` names, reached with the `GATEWEAVE_RESTORE_*`
 * variables when they are set, so a token that writes needn't be the one that reads the
 * repository, and with the `AWS_*` ones when they aren't.
 */
export function openTarget(location: string, settings: Settings): S3Target {
	const { env } = settings;
	const own = env.GATEWEAVE_RESTORE_ACCESS_KEY_ID !== undefined;
	return new S3Target(
		s3Options(
			location,
			{
				...settings,
				env: {
					AWS_ENDPOINT_URL: env.GATEWEAVE_RESTORE_ENDPOINT_URL ?? env.AWS_ENDPOINT_URL,
					AWS_REGION: env.GATEWEAVE_RESTORE_REGION ?? env.AWS_REGION,
					AWS_ACCESS_KEY_ID: own ? env.GATEWEAVE_RESTORE_ACCESS_KEY_ID : env.AWS_ACCESS_KEY_ID,
					AWS_SECRET_ACCESS_KEY: own
						? env.GATEWEAVE_RESTORE_SECRET_ACCESS_KEY
						: env.AWS_SECRET_ACCESS_KEY,
					AWS_SESSION_TOKEN: own ? env.GATEWEAVE_RESTORE_SESSION_TOKEN : env.AWS_SESSION_TOKEN,
				},
			},
			{
				endpoint:
					"Restoring into s3:// needs --to-endpoint, GATEWEAVE_RESTORE_ENDPOINT_URL or AWS_ENDPOINT_URL",
				credentials:
					"Restoring into s3:// needs GATEWEAVE_RESTORE_ACCESS_KEY_ID and GATEWEAVE_RESTORE_SECRET_ACCESS_KEY, or the AWS_ ones: for R2, an API token that can write to the bucket.",
			},
		),
	);
}

/** An `s3://<bucket>/<folder>` location and how to reach it, or an error saying what is missing. */
function s3Options(
	location: string,
	settings: Settings,
	say: { endpoint: string; credentials: string },
): S3Options {
	const rest = location.slice("s3://".length);
	const slash = rest.indexOf("/");
	const bucket = slash < 0 ? rest : rest.slice(0, slash);
	let prefix = slash < 0 ? "" : rest.slice(slash + 1);
	if (prefix !== "" && !prefix.endsWith("/")) prefix += "/";
	if (bucket === "") throw new StoreError("s3:// needs a bucket: s3://<bucket>/<folder>.");
	// A URL would tidy these away, and the request would no longer be the one signed.
	if (prefix !== "" && !sendable(prefix.slice(0, -1))) {
		throw new StoreError(`The folder in ${location} has an empty, . or .. part.`);
	}
	const endpoint = settings.endpoint ?? settings.env.AWS_ENDPOINT_URL;
	if (!endpoint) {
		throw new StoreError(
			`${say.endpoint}, such as https://<account id>.r2.cloudflarestorage.com for R2.`,
		);
	}
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new StoreError("The endpoint isn't a URL.");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new StoreError("The endpoint is an https:// URL.");
	}
	const accessKeyId = settings.env.AWS_ACCESS_KEY_ID;
	const secretAccessKey = settings.env.AWS_SECRET_ACCESS_KEY;
	if (!accessKeyId || !secretAccessKey) {
		throw new StoreError(say.credentials);
	}
	const sessionToken = settings.env.AWS_SESSION_TOKEN;
	return {
		endpoint: url,
		bucket,
		prefix,
		region: settings.region ?? settings.env.AWS_REGION ?? "auto",
		credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
	};
}
