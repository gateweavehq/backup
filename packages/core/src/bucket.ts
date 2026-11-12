import { fromUtf8, utf8 } from "./bytes";

/**
 * A snapshot of an R2 bucket (`"kind": "r2"`) keeps each object's bytes at `files/<key>`, and
 * lists every object in `bucket.json`, with what R2 keeps beside the bytes: docs/format.md.
 */
export const BUCKET_INDEX = "bucket.json";
export const BUCKET_DIR = "files/";

/** R2's HTTP metadata, as an object's `httpMetadata` has it, with its expiry as an ISO time. */
export interface BucketHttpMetadata {
	contentType?: string;
	contentLanguage?: string;
	contentDisposition?: string;
	contentEncoding?: string;
	cacheControl?: string;
	cacheExpiry?: string;
}

/** One object of a bucket: its key and size, and what R2 keeps with it. */
export interface BucketObject {
	key: string;
	size: number;
	etag: string;
	/** When it was uploaded, as an ISO time. */
	uploaded: string;
	http: BucketHttpMetadata;
	custom: Record<string, string>;
}

export class BucketIndexError extends Error {
	override name = "BucketIndexError";
}

const HTTP_FIELDS = [
	"contentType",
	"contentLanguage",
	"contentDisposition",
	"contentEncoding",
	"cacheControl",
	"cacheExpiry",
] as const;

/** The file an object's bytes go in. */
export function bucketFile(key: string): string {
	return BUCKET_DIR + key;
}

/** The key of the object whose bytes a file holds, or undefined for any other file. */
export function keyOf(path: string): string | undefined {
	return path.startsWith(BUCKET_DIR) && path.length > BUCKET_DIR.length
		? path.slice(BUCKET_DIR.length)
		: undefined;
}

/**
 * `bucket.json`: a head line, then one object a line, in key order. Lines, so a bucket of many
 * objects can be read one at a time.
 */
export function writeBucketIndex(objects: BucketObject[]): Uint8Array<ArrayBuffer> {
	const sorted = [...objects].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	const lines = [
		JSON.stringify({ format: "r2-bucket", version: 1, objects: sorted.length }),
		...sorted.map((object) => JSON.stringify(object)),
	];
	return utf8(`${lines.join("\n")}\n`);
}

/** Reads `bucket.json`, checking its head, every object and their count. */
export function readBucketIndex(bytes: Uint8Array): BucketObject[] {
	const lines = fromUtf8(bytes).split("\n");
	if (lines.at(-1) === "") lines.pop();
	const head = parseLine(lines[0]);
	if (head?.format !== "r2-bucket" || head.version !== 1 || typeof head.objects !== "number") {
		throw new BucketIndexError("bucket.json doesn't start as one does.");
	}
	const objects = lines.slice(1).map((line, i) => checkObject(parseLine(line), i + 2));
	if (objects.length !== head.objects) {
		throw new BucketIndexError(
			`bucket.json says it lists ${head.objects} objects, and lists ${objects.length}.`,
		);
	}
	for (let i = 1; i < objects.length; i++) {
		if ((objects[i - 1]?.key ?? "") >= (objects[i]?.key ?? "")) {
			throw new BucketIndexError(`bucket.json's line ${i + 2} is out of order, or twice.`);
		}
	}
	return objects;
}

function parseLine(line: string | undefined): Record<string, unknown> | undefined {
	if (line === undefined) return undefined;
	try {
		const value: unknown = JSON.parse(line);
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** An object as bucket.json lists it, or an error naming the line, never the key. */
function checkObject(value: Record<string, unknown> | undefined, line: number): BucketObject {
	const wrong = () => new BucketIndexError(`bucket.json's line ${line} isn't an object's.`);
	if (!value) throw wrong();
	const { key, size, etag, uploaded, http, custom } = value;
	if (typeof key !== "string" || key === "") throw wrong();
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) throw wrong();
	if (typeof etag !== "string" || typeof uploaded !== "string") throw wrong();
	if (!isStrings(http) || !Object.keys(http).every((name) => isHttpField(name))) throw wrong();
	if (!isStrings(custom)) throw wrong();
	return { key, size, etag, uploaded, http, custom };
}

function isHttpField(name: string): name is (typeof HTTP_FIELDS)[number] {
	return (HTTP_FIELDS as readonly string[]).includes(name);
}

function isStrings(value: unknown): value is Record<string, string> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every((item) => typeof item === "string")
	);
}
