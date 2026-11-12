import { describe, expect, it } from "vitest";
import {
	BUCKET_INDEX,
	type BucketObject,
	bucketFile,
	fromUtf8,
	keyOf,
	readBucketIndex,
	utf8,
	writeBucketIndex,
} from "../src";

const object = (key: string, extra: Partial<BucketObject> = {}): BucketObject => ({
	key,
	size: 3,
	etag: `etag-${key}`,
	uploaded: "2026-11-12T10:00:00.000Z",
	http: {},
	custom: {},
	...extra,
});

describe("a bucket's snapshot", () => {
	it("keeps each object under files/, and only there", () => {
		expect(BUCKET_INDEX).toBe("bucket.json");
		expect(bucketFile("w1/a b/Grüße.txt")).toBe("files/w1/a b/Grüße.txt");
		expect(keyOf("files/w1/a b/Grüße.txt")).toBe("w1/a b/Grüße.txt");
		expect(keyOf("files/")).toBeUndefined();
		expect(keyOf("bucket.json")).toBeUndefined();
		expect(keyOf("objects/a.jsonl")).toBeUndefined();
	});

	it("lists its objects in bucket.json, in key order, a line each", () => {
		const objects = [
			object("b", { http: { contentType: "text/plain", cacheExpiry: "2027-01-01T00:00:00.000Z" } }),
			object("a\nnewline", { custom: { uploadedBy: "u1" } }),
			object("ä"),
		];
		const bytes = writeBucketIndex(objects);
		const lines = fromUtf8(bytes).split("\n");
		expect(lines[0]).toBe('{"format":"r2-bucket","version":1,"objects":3}');
		expect(lines).toHaveLength(5);
		expect(readBucketIndex(bytes)).toEqual([objects[1], objects[0], objects[2]]);
		expect(readBucketIndex(writeBucketIndex([]))).toEqual([]);
	});

	it("refuses a bucket.json that isn't whole and right", () => {
		const good = fromUtf8(writeBucketIndex([object("a"), object("b")]));
		const lines = good.split("\n");
		const broken = (text: string) => () => readBucketIndex(utf8(text));
		expect(broken("")).toThrow("bucket.json doesn't start as one does.");
		expect(broken(lines.slice(0, 2).join("\n"))).toThrow(
			"bucket.json says it lists 2 objects, and lists 1.",
		);
		expect(broken([lines[0], lines[2], lines[1]].join("\n"))).toThrow(
			"bucket.json's line 3 is out of order, or twice.",
		);
		expect(broken([lines[0], lines[1], lines[1]].join("\n"))).toThrow(
			"bucket.json's line 3 is out of order, or twice.",
		);
		const wrong = [
			{ ...object("a"), size: -1 },
			{ ...object("a"), key: "" },
			{ ...object("a"), http: { contentType: 1 } },
			{ ...object("a"), http: { color: "red" } },
			{ ...object("a"), custom: [] },
			"not an object",
		];
		for (const value of wrong) {
			const text = ['{"format":"r2-bucket","version":1,"objects":1}', JSON.stringify(value)].join(
				"\n",
			);
			// It names the line, never what is on it, which may be a person's file name.
			expect(broken(text)).toThrow("bucket.json's line 2 isn't an object's.");
		}
	});
});
