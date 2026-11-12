// The bindings only the tests have (test/wrangler.jsonc and vitest.config.ts).
declare namespace Cloudflare {
	interface Env {
		SOURCE_DB: D1Database;
		RESTORE_DB: D1Database;
		FILES: R2Bucket;
		TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
		APP_SEED: {
			add(name: string, statements: string[]): Promise<void>;
			clear(): Promise<void>;
		};
	}
}
