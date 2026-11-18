import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { transform } from "esbuild";
import { defineConfig } from "vitest/config";

/** A key for these tests only, and public: it is "gateweave-backup worker tests 01". */
const TEST_KEY = "Z2F0ZXdlYXZlLWJhY2t1cCB3b3JrZXIgdGVzdHMgMDE";

const TESTS = join(import.meta.dirname, "test");

// Each app's Durable Objects, named apart from the list of Workers: side by side in it, their
// types would be merged into one that has every app's classes.
const APP_OBJECTS = {
	DIRECTORY: { className: "Directory", useSQLite: true },
	STORE: { className: "Store", useSQLite: true },
};
const EXAMPLE_OBJECTS = {
	NOTEBOOK: { className: "Notebook", useSQLite: true },
};

/**
 * The example of docs/app-entrypoint.md as workerd takes it: its types taken off, nothing else
 * changed. So the code a reader copies is the code the tests run.
 */
async function exampleApp(): Promise<string> {
	const source = await readFile(join(TESTS, "example-app.ts"), "utf8");
	return (await transform(source, { loader: "ts", format: "esm", target: "esnext" })).code;
}

export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			wrangler: { configPath: "./test/wrangler.jsonc" },
			miniflare: {
				bindings: {
					BACKUP_KEY: TEST_KEY,
					TEST_MIGRATIONS: await readD1Migrations(join(import.meta.dirname, "migrations")),
					// The copy's key, which the stand-in bucket takes.
					COPY_ACCESS_KEY_ID: "copy-key",
					COPY_SECRET_ACCESS_KEY: "copy-secret",
				},
				// Every fetch the Worker makes reaches the stand-in for a bucket elsewhere.
				outboundService: "s3",
				// An app whose Durable Objects are a source, as Track's are.
				workers: [
					{
						name: "app",
						modules: true,
						scriptPath: join(import.meta.dirname, "test", "app-worker.js"),
						compatibilityDate: "2026-11-01",
						durableObjects: APP_OBJECTS,
					},
					// The guide's example app, whose notebooks the tests read as a backup does.
					{
						name: "example",
						modules: [
							{
								type: "ESModule",
								path: join(TESTS, "example-worker.js"),
								contents: await readFile(join(TESTS, "example-worker.js"), "utf8"),
							},
							{
								type: "ESModule",
								path: join(TESTS, "example-app.js"),
								contents: await exampleApp(),
							},
						],
						compatibilityDate: "2026-11-01",
						d1Databases: ["DB"],
						durableObjects: EXAMPLE_OBJECTS,
					},
					{
						name: "s3",
						modules: true,
						scriptPath: join(import.meta.dirname, "test", "s3-worker.js"),
						compatibilityDate: "2026-11-01",
					},
				],
			},
		})),
	],
	test: {
		setupFiles: ["./test/apply-migrations.ts"],
		testTimeout: 60_000,
	},
});
