import { join } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** A key for these tests only, and public: it is "gateweave-backup worker tests 01". */
const TEST_KEY = "Z2F0ZXdlYXZlLWJhY2t1cCB3b3JrZXIgdGVzdHMgMDE";

export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			wrangler: { configPath: "./test/wrangler.jsonc" },
			miniflare: {
				bindings: {
					BACKUP_KEY: TEST_KEY,
					TEST_MIGRATIONS: await readD1Migrations(join(import.meta.dirname, "migrations")),
				},
				// An app whose Durable Objects are a source, as Track's are.
				workers: [
					{
						name: "app",
						modules: true,
						scriptPath: join(import.meta.dirname, "test", "app-worker.js"),
						compatibilityDate: "2026-11-01",
						durableObjects: {
							DIRECTORY: { className: "Directory", useSQLite: true },
							STORE: { className: "Store", useSQLite: true },
						},
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
