import { describe, expect, it } from "vitest";
import { authorization, EMPTY_SHA256 } from "../src";

/** The worked examples in AWS's "Signature Calculations for the Authorization Header" for S3. */
const credentials = {
	accessKeyId: "AKIAIOSFODNN7EXAMPLE",
	secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const AT = "20130524T000000Z";

describe("SigV4", () => {
	it("signs AWS's GET Object example", async () => {
		expect(
			await authorization(
				{
					method: "GET",
					path: "/test.txt",
					query: [],
					headers: [
						["Host", "examplebucket.s3.amazonaws.com"],
						["Range", "bytes=0-9"],
						["x-amz-content-sha256", EMPTY_SHA256],
						["x-amz-date", AT],
					],
					payloadHash: EMPTY_SHA256,
				},
				credentials,
				"us-east-1",
				AT,
			),
		).toBe(
			"AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
		);
	});

	it("signs AWS's list objects example, with its query in canonical order", async () => {
		expect(
			await authorization(
				{
					method: "GET",
					path: "/",
					query: [
						["prefix", "J"],
						["max-keys", "2"],
					],
					headers: [
						["host", "examplebucket.s3.amazonaws.com"],
						["x-amz-content-sha256", EMPTY_SHA256],
						["x-amz-date", AT],
					],
					payloadHash: EMPTY_SHA256,
				},
				credentials,
				"us-east-1",
				AT,
			),
		).toMatch(/Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/);
	});
});
