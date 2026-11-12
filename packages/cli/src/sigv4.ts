import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4, for the requests the CLI makes to an S3-compatible bucket: R2, AWS S3,
 * Backblaze B2, MinIO. A read's payload is empty; a restore into a bucket signs each object's
 * SHA-256, so the bucket refuses bytes that don't match it.
 */

export interface Credentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

export const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

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

/** The `Authorization` header for a request made at `amzDate` (`20130524T000000Z`). */
export function authorization(
	request: CanonicalRequest,
	credentials: Credentials,
	region: string,
	amzDate: string,
	service = "s3",
): string {
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
	const toSign = [
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		createHash("sha256").update(canonical).digest("hex"),
	].join("\n");
	let key: Buffer = createHmac("sha256", `AWS4${credentials.secretAccessKey}`).update(day).digest();
	for (const part of [region, service, "aws4_request"]) {
		key = createHmac("sha256", key).update(part).digest();
	}
	const signature = createHmac("sha256", key).update(toSign).digest("hex");
	return `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
}

/** `20130524T000000Z`, the time SigV4 signs. */
export function amzDateOf(at: Date): string {
	return at
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}/, "");
}
