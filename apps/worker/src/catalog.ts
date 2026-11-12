/**
 * The catalog in D1 (migrations/). Every write here is safe to repeat, since a
 * Workflow step that wrote and then failed runs again.
 */

import type { Alert } from "./alerts";
import type { RestoreTestResult } from "./restore-test";

/** Long enough for any run; a run that died holding the lock frees it when this runs out. */
export const LEASE_MS = 12 * 60 * 60 * 1000;

const ERROR_LENGTH = 1000;

export async function startRun(
	db: D1Database,
	run: { id: string; instance: string; source: string; at: number },
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO run (id, instance, source, started_at, status) VALUES (?1, ?2, ?3, ?4, 'running')
			ON CONFLICT (id) DO NOTHING`,
		)
		.bind(run.id, run.instance, run.source, run.at)
		.run();
}

/** Takes the source's lock for `holder`, if nobody else holds it. Says whether it did. */
export async function takeLock(
	db: D1Database,
	source: string,
	holder: string,
	now: number,
): Promise<boolean> {
	const result = await db
		.prepare(
			`INSERT INTO lock (source, holder, until) VALUES (?1, ?2, ?3)
			ON CONFLICT (source) DO UPDATE SET holder = excluded.holder, until = excluded.until
			WHERE lock.holder = excluded.holder OR lock.until < ?4`,
		)
		.bind(source, holder, now + LEASE_MS, now)
		.run();
	return result.meta.changes > 0;
}

export async function releaseLock(db: D1Database, source: string, holder: string): Promise<void> {
	await db.prepare("DELETE FROM lock WHERE source = ?1 AND holder = ?2").bind(source, holder).run();
}

export interface SnapshotRecord {
	source: string;
	name: string;
	created: string;
	tables: number;
	rows: number;
	size: number;
	newBytes: number;
	empty: string[];
}

export async function recordSnapshot(
	db: D1Database,
	runId: string,
	snapshot: SnapshotRecord,
): Promise<void> {
	await db.batch([
		db
			.prepare(
				`INSERT INTO snapshot (source, name, created_at, table_count, row_count, size, empty)
				VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (source, name) DO NOTHING`,
			)
			.bind(
				snapshot.source,
				snapshot.name,
				Date.parse(snapshot.created),
				snapshot.tables,
				snapshot.rows,
				snapshot.size,
				JSON.stringify(snapshot.empty),
			),
		db
			.prepare(
				`UPDATE run SET snapshot = ?2, table_count = ?3, row_count = ?4, size = ?5, new_bytes = ?6
				WHERE id = ?1`,
			)
			.bind(runId, snapshot.name, snapshot.tables, snapshot.rows, snapshot.size, snapshot.newBytes),
	]);
}

export async function finishRun(
	db: D1Database,
	run: {
		id: string;
		source: string;
		at: number;
		forgotten: string[];
		heldSnapshots: number;
		deleted: number;
		held: number;
	},
): Promise<void> {
	await db.batch([
		...run.forgotten.map((name) =>
			db
				.prepare(
					"UPDATE snapshot SET forgotten_at = ?3 WHERE source = ?1 AND name = ?2 AND forgotten_at IS NULL",
				)
				.bind(run.source, name, run.at),
		),
		db
			.prepare(
				`UPDATE run SET status = 'ok', finished_at = ?2, forgotten = ?3, held_snapshots = ?4,
				deleted_chunks = ?5, held_chunks = ?6 WHERE id = ?1`,
			)
			.bind(run.id, run.at, run.forgotten.length, run.heldSnapshots, run.deleted, run.held),
	]);
}

export async function failRun(
	db: D1Database,
	run: { id: string; at: number; error: string },
): Promise<void> {
	await db
		.prepare("UPDATE run SET status = 'failed', finished_at = ?2, error = ?3 WHERE id = ?1")
		.bind(run.id, run.at, run.error.slice(0, ERROR_LENGTH))
		.run();
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Nightly runs reach a source's test a little earlier or later each night, so a test is due half a
 * day early rather than a night late.
 */
const DUE_EARLY_MS = 12 * 60 * 60 * 1000;

/** Whether the source's restore test is due: it has never passed, or not for `days` days. */
export async function testDue(
	db: D1Database,
	source: string,
	now: number,
	days: number,
): Promise<boolean> {
	const last = await db
		.prepare(
			"SELECT max(tested_at) AS at FROM restore_test WHERE source = ?1 AND status = 'passed'",
		)
		.bind(source)
		.first<number | null>("at");
	return last === null || last <= now - days * DAY_MS + DUE_EARLY_MS;
}

export async function recordTest(
	db: D1Database,
	runId: string,
	test: RestoreTestResult,
	at: number,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO restore_test (run, source, snapshot, tested_at, status, table_count, row_count,
				size, error) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT (run) DO NOTHING`,
		)
		.bind(
			runId,
			test.source,
			test.snapshot,
			at,
			test.passed ? "passed" : "failed",
			test.tables,
			test.rows,
			test.size,
			test.error?.slice(0, ERROR_LENGTH) ?? null,
		)
		.run();
}

/** Keeps an alert, once: a second one under the same key is the first sent again. */
export async function recordAlert(db: D1Database, alert: Alert, at: number): Promise<void> {
	await db
		.prepare(
			`INSERT INTO alert (key, made_at, subject, text, html) VALUES (?1, ?2, ?3, ?4, ?5)
			ON CONFLICT (key) DO NOTHING`,
		)
		.bind(alert.key, at, alert.subject, alert.text, alert.html ?? null)
		.run();
}

export async function alertSent(db: D1Database, key: string): Promise<boolean> {
	const at = await db
		.prepare("SELECT sent_at FROM alert WHERE key = ?1")
		.bind(key)
		.first<number | null>("sent_at");
	return at !== null;
}

/** Notes where an alert went: `went` is empty when no destination is set up. */
export async function markAlertSent(
	db: D1Database,
	key: string,
	went: string[],
	at: number,
): Promise<void> {
	await db
		.prepare("UPDATE alert SET sent_to = ?2, sent_at = ?3, error = NULL WHERE key = ?1")
		.bind(key, went.join(","), at)
		.run();
}

export async function markAlertFailed(db: D1Database, key: string, error: string): Promise<void> {
	await db
		.prepare("UPDATE alert SET error = ?2 WHERE key = ?1 AND sent_at IS NULL")
		.bind(key, error.slice(0, ERROR_LENGTH))
		.run();
}

/** The alerts made since `since` that haven't gone, oldest first. */
export async function unsentAlerts(db: D1Database, since: number): Promise<Alert[]> {
	const { results } = await db
		.prepare(
			"SELECT key, subject, text, html FROM alert WHERE sent_at IS NULL AND made_at >= ?1 ORDER BY made_at, key",
		)
		.bind(since)
		.all<Alert & { html: string | null }>();
	return results.map(({ html, ...alert }) => (html ? { ...alert, html } : alert));
}

/** The source's newest run: when it started and how it stands. Null if it has none. */
export async function newestRun(
	db: D1Database,
	source: string,
): Promise<{ startedAt: number; status: "running" | "ok" | "failed" } | null> {
	return db
		.prepare(
			"SELECT started_at AS startedAt, status FROM run WHERE source = ?1 ORDER BY started_at DESC, id DESC LIMIT 1",
		)
		.bind(source)
		.first();
}
