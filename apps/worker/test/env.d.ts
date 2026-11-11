// The bindings only the tests have (test/wrangler.jsonc and vitest.config.ts).
declare namespace Cloudflare {
	interface Env {
		SOURCE_DB: D1Database;
		RESTORE_DB: D1Database;
		TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
	}
}
