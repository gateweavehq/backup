// A stand-in for an S3-compatible bucket at another provider, which every fetch the tests' Worker
// makes reaches (vitest.config.ts). It keeps one bucket, `offsite`, in memory. It takes only
// requests signed with the test key, checks a body against its signed SHA-256, and pages listings
// three keys at a time, so continuation tokens are followed.
//
// Tests drive it with paths of its own: /__objects lists what it holds, /__reset empties it,
// /__lock refuses deletes of the keys posted to it, /__fail refuses the next PUTs with 403.

const objects = new Map();
const locked = new Set();
let failing = 0;
let puts = 0;

const xml = (status, code) =>
	new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code></Error>`, {
		status,
		headers: { "content-type": "application/xml" },
	});

const escapeXml = (text) =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

async function sha256(bytes) {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default {
	async fetch(request) {
		const url = new URL(request.url);
		switch (url.pathname) {
			case "/__objects":
				return Response.json({ keys: [...objects.keys()].sort(), puts });
			case "/__reset":
				objects.clear();
				locked.clear();
				failing = 0;
				puts = 0;
				return new Response("ok");
			case "/__lock":
				for (const key of await request.json()) locked.add(key);
				return new Response("ok");
			case "/__fail":
				failing = Number(await request.text());
				return new Response("ok");
		}
		const auth = request.headers.get("authorization") ?? "";
		if (!auth.startsWith("AWS4-HMAC-SHA256 Credential=copy-key/")) return xml(403, "AccessDenied");
		if (!/SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/.test(auth)) {
			return xml(403, "SignatureDoesNotMatch");
		}
		const [, bucket = "", ...rest] = url.pathname.split("/");
		if (bucket !== "offsite") return xml(404, "NoSuchBucket");
		const key = decodeURIComponent(rest.join("/"));
		if (request.method === "GET" && key === "" && url.searchParams.get("list-type") === "2") {
			const prefix = url.searchParams.get("prefix") ?? "";
			const keys = [...objects.keys()].filter((name) => name.startsWith(prefix)).sort();
			const start = Number(url.searchParams.get("continuation-token") ?? "0");
			const page = keys.slice(start, start + 3);
			const more = start + 3 < keys.length;
			return new Response(
				`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>${more}</IsTruncated>${page
					.map((name) => `<Contents><Key>${escapeXml(name)}</Key></Contents>`)
					.join(
						"",
					)}${more ? `<NextContinuationToken>${start + 3}</NextContinuationToken>` : ""}</ListBucketResult>`,
				{ headers: { "content-type": "application/xml" } },
			);
		}
		switch (request.method) {
			case "PUT": {
				if (failing > 0) {
					failing--;
					return xml(403, "AccessDenied");
				}
				const body = new Uint8Array(await request.arrayBuffer());
				if ((await sha256(body)) !== request.headers.get("x-amz-content-sha256")) {
					return xml(400, "XAmzContentSHA256Mismatch");
				}
				objects.set(key, body);
				puts++;
				return new Response(null, { status: 200 });
			}
			case "GET":
			case "HEAD": {
				const body = objects.get(key);
				if (!body) return xml(404, "NoSuchKey");
				return new Response(request.method === "HEAD" ? null : body);
			}
			case "DELETE":
				if (locked.has(key)) return xml(403, "AccessDenied");
				objects.delete(key);
				return new Response(null, { status: 204 });
		}
		return xml(405, "MethodNotAllowed");
	},
};
