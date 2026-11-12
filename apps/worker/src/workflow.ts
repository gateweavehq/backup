import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
	type WorkflowStepConfig,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
	DUMP_FILE,
	dumpSqlite,
	parseMasterKey,
	parseRetention,
	Repository,
	RepositoryError,
	retain,
	utf8,
} from "@gateweave/backup-core";
import { d1Reader, isD1, R2Store } from "./bindings";
import {
	failRun,
	finishRun,
	recordSnapshot,
	recordTest,
	releaseLock,
	type SnapshotRecord,
	startRun,
	takeLock,
	testDue,
} from "./catalog";
import { type RestoreTestResult, testerFor, testInterval } from "./restore-test";
import { parseSources, pickSources, type Source } from "./sources";

/** A manual run may name its sources; a scheduled one backs up all of them. */
export interface BackupParams {
	sources?: string[];
	/** Restore-test each new snapshot, whether or not a test is due. */
	test?: boolean;
}

export interface SourceResult {
	source: string;
	status: "ok" | "failed";
	snapshot?: string;
	/** How the restore test of the new snapshot went, when there was one. */
	test?: "passed" | "failed";
	error?: string;
}

/** Catalog writes are small, and D1 hiccups pass. */
const QUICK: WorkflowStepConfig = {
	retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
	timeout: "1 minute",
};

/** A dump reads the whole database and writes what changed; a retry starts it over. */
const HEAVY: WorkflowStepConfig = {
	retries: { limit: 3, delay: "2 minutes", backoff: "exponential" },
	timeout: "30 minutes",
};

/**
 * One backup run: for each source, a snapshot, then retention. Each source is on its own, so one
 * that fails doesn't stop the rest; the run fails at the end if any did, so it shows as failed.
 */
export class BackupWorkflow extends WorkflowEntrypoint<Env, BackupParams | undefined> {
	override async run(event: Readonly<WorkflowEvent<BackupParams | undefined>>, step: WorkflowStep) {
		const sources = pickSources(parseSources(this.env.SOURCES), event.payload?.sources);
		const results: SourceResult[] = [];
		const force = event.payload?.test === true;
		for (const source of sources) {
			results.push(await this.#backUp(event.instanceId, source, step, force));
		}
		const failed = results.filter((r) => r.status === "failed").map((r) => r.source);
		const untested = results.filter((r) => r.test === "failed").map((r) => r.source);
		const problems = [
			...(failed.length > 0 ? [`The backup of ${failed.join(", ")} failed.`] : []),
			...(untested.length > 0 ? [`The restore test of ${untested.join(", ")} failed.`] : []),
		];
		// A run that made every snapshot but couldn't restore one shows as failed too.
		if (problems.length > 0) throw new Error(`${problems.join(" ")} The catalog says why.`);
		return results;
	}

	async #backUp(
		instance: string,
		source: Source,
		step: WorkflowStep,
		force: boolean,
	): Promise<SourceResult> {
		const db = this.env.CATALOG;
		const id = `${instance}/${source.name}`;
		const name = source.name;
		await step.do(`${name}: start`, QUICK, () =>
			startRun(db, { id, instance, source: name, at: Date.now() }),
		);
		let snapshot: string | undefined;
		try {
			await step.do(`${name}: lock`, QUICK, async () => {
				if (!(await takeLock(db, name, instance, Date.now()))) {
					throw new NonRetryableError(`Another run is backing up ${name}.`);
				}
			});
			const record = await step.do(`${name}: back up`, HEAVY, () => this.#snapshot(source));
			snapshot = record.name;
			await step.do(`${name}: record`, QUICK, () => recordSnapshot(db, id, record));
			const made = record.name;
			const pruned = await step.do(`${name}: prune`, HEAVY, () => this.#prune(source, made));
			// After the prune and under the lock, so the test also proves the prune left what it needs.
			const test = await this.#testIfDue(id, name, made, step, force);
			await step.do(`${name}: finish`, QUICK, async () => {
				await finishRun(db, { id, source: name, at: Date.now(), ...pruned });
				await releaseLock(db, name, instance);
			});
			return { source: name, status: "ok", snapshot, ...(test ? { test } : {}) };
		} catch (error) {
			const reason = describe(error);
			const message = snapshot ? `Snapshot ${snapshot} was made, but then: ${reason}` : reason;
			await step.do(`${name}: failed`, QUICK, async () => {
				await failRun(db, { id, at: Date.now(), error: message });
				await releaseLock(db, name, instance);
			});
			return { source: name, status: "failed", snapshot, error: message };
		}
	}

	/**
	 * Restores the snapshot just made, when the source's last passed test is RESTORE_TEST_DAYS old
	 * or it has none. Its outcome goes to the catalog, and a failure doesn't undo the backup.
	 */
	async #testIfDue(
		runId: string,
		name: string,
		snapshot: string,
		step: WorkflowStep,
		force: boolean,
	): Promise<"passed" | "failed" | undefined> {
		const db = this.env.CATALOG;
		let result: RestoreTestResult;
		try {
			const due = await step.do(`${name}: test due`, QUICK, async () => {
				const days = setting(() => testInterval(this.env.RESTORE_TEST_DAYS));
				return force || (await testDue(db, name, Date.now(), days));
			});
			if (!due) return undefined;
			result = await step.do(`${name}: restore test`, HEAVY, async () => {
				const tester = setting(() => testerFor(this.env, name));
				return (await tester.restore(name, snapshot)) as RestoreTestResult;
			});
		} catch (error) {
			const reason = describe(error);
			result = {
				source: name,
				snapshot,
				passed: false,
				tables: 0,
				rows: 0,
				size: 0,
				error: reason,
			};
		}
		await step.do(`${name}: test recorded`, QUICK, () => recordTest(db, runId, result, Date.now()));
		return result.passed ? "passed" : "failed";
	}

	/** Dumps the source and commits the dump as a snapshot. */
	async #snapshot(source: Source): Promise<SnapshotRecord> {
		const binding = (this.env as unknown as Record<string, unknown>)[source.binding];
		if (!isD1(binding)) {
			throw new NonRetryableError(
				`Source ${source.name}'s binding ${source.binding} isn't a D1 database.`,
			);
		}
		const repo = await this.#repository(source);
		const dump = await dumpSqlite(d1Reader(binding));
		const { entry, stats } = await repo.writeFile(DUMP_FILE, encodeLines(dump.lines));
		const meta = { tables: dump.stats.tables, rows: dump.stats.rows, empty: dump.stats.empty };
		const manifest = await repo.commit({ kind: "d1", name: source.name }, [entry], meta);
		return {
			source: source.name,
			name: manifest.name,
			created: manifest.created,
			tables: dump.stats.tables,
			rows: dump.stats.rows,
			size: entry.size,
			newBytes: stats.newBytes,
			empty: dump.stats.empty,
		};
	}

	/**
	 * Lets go of the snapshots the policy no longer keeps, then of the chunks only they used. The
	 * snapshot this run made always stays, whatever a clock that went back says about its age.
	 */
	async #prune(source: Source, made: string) {
		const policy = setting(() => parseRetention(this.env.RETENTION));
		const repo = await this.#repository(source);
		const forget = retain(await repo.snapshots(), policy).forget.filter((name) => name !== made);
		const forgotten: string[] = [];
		let heldSnapshots = 0;
		for (const name of forget) {
			// A locked bucket keeps a manifest until its retention period ends; the next run tries again.
			try {
				await repo.forget(name);
				forgotten.push(name);
			} catch {
				heldSnapshots++;
			}
		}
		const { deleted, held } = await repo.prune();
		return { forgotten, heldSnapshots, deleted, held };
	}

	/** The source's repository, made on its first run. A wrong key fails at once. */
	async #repository(source: Source): Promise<Repository> {
		const key = this.env.BACKUP_KEY;
		try {
			parseMasterKey(key ?? "");
		} catch {
			throw new NonRetryableError("BACKUP_KEY isn't a backup key. Make one with `pnpm keygen`.");
		}
		const store = new R2Store(this.env.VAULT, `${source.name}/`);
		try {
			return (await store.has("config.json"))
				? await Repository.open(store, key)
				: await Repository.init(store, key);
		} catch (error) {
			if (error instanceof RepositoryError) {
				throw new NonRetryableError(`${source.name}: ${error.message}`);
			}
			throw error;
		}
	}
}

/** The dump as `joinLines` writes it, in pieces of about a megabyte instead of one string. */
async function* encodeLines(lines: string[]): AsyncGenerator<Uint8Array<ArrayBuffer>> {
	let batch: string[] = [];
	let length = 0;
	for (const line of lines) {
		batch.push(line);
		length += line.length + 1;
		if (length >= 1 << 20) {
			yield utf8(`${batch.join("\n")}\n`);
			batch = [];
			length = 0;
		}
	}
	if (batch.length > 0) yield utf8(`${batch.join("\n")}\n`);
}

/** Reads a setting, so that one the Worker can't use fails at once rather than after retries. */
function setting<T>(read: () => T): T {
	try {
		return read();
	} catch (error) {
		throw new NonRetryableError(error instanceof Error ? error.message : String(error));
	}
}

/**
 * What went wrong, without the error's class: a step's error comes back from Workflows with its
 * name in front of its message.
 */
function describe(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/^(?:[A-Za-z]*Error: )+/, "");
}
