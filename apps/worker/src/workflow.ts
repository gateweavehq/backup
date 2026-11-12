import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
	type WorkflowStepConfig,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
	BUCKET_INDEX,
	BucketIndexError,
	type BucketObject,
	bucketFile,
	DUMP_FILE,
	dumpSqliteTo,
	type FileEntry,
	type ObjectStore,
	objectFile,
	parseMasterKey,
	parseRetention,
	Repository,
	RepositoryError,
	readBucketIndex,
	retain,
	S3Error,
	SealError,
	type SqlReader,
	utf8,
	writeBucketIndex,
} from "@gateweave/backup-core";
import { type Alert, AlertConfigError, runAlert, sendAlert } from "./alerts";
import {
	type BackupService,
	d1Reader,
	describeObject,
	isD1,
	isR2,
	isService,
	listObjects,
	ObjectGone,
	objectReader,
	R2Store,
} from "./bindings";
import {
	failRun,
	finishRun,
	markAlertFailed,
	recordAlert,
	recordCopy,
	recordSnapshot,
	recordTest,
	releaseLock,
	type SnapshotRecord,
	startRun,
	takeLock,
	testDue,
} from "./catalog";
import { CopyError, type CopyResult, copyNew, copyTarget, pruneCopy } from "./copy";
import { type RestoreTestResult, testerFor, testInterval } from "./restore-test";
import {
	type D1Source,
	type ObjectsSource,
	parseSources,
	pickSources,
	type R2Source,
	type Source,
} from "./sources";

/** A manual run may name its sources; a scheduled one backs up all of them. */
export interface BackupParams {
	sources?: string[];
	/** Restore-test each new snapshot, whether or not a test is due. */
	test?: boolean;
	/** Send the run's alert even if nothing failed, to see that alerts arrive. */
	alert?: boolean;
}

export interface SourceResult {
	source: string;
	status: "ok" | "failed";
	snapshot?: string;
	/** How the restore test of the new snapshot went, when there was one. */
	test?: "passed" | "failed";
	error?: string;
	/** Why the restore test failed. */
	testError?: string;
	/** How the copy outside Cloudflare went, when COPY_TO names one. */
	copy?: "ok" | "failed";
	copyError?: string;
}

/** Catalog writes are small, and D1 hiccups pass. */
const QUICK: WorkflowStepConfig = {
	retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
	timeout: "1 minute",
};

/** An alert waits out a mail or webhook hiccup of a few minutes, then gives up until the morning. */
const ALERT: WorkflowStepConfig = {
	retries: { limit: 4, delay: "30 seconds", backoff: "exponential" },
	timeout: "1 minute",
};

/** How many of an app's objects one step backs up. A step that fails backs them up again. */
const OBJECTS_PER_STEP = 20;

/** One object's dump, written to the repository and waiting for the snapshot that names it. */
interface ObjectPart {
	name: string;
	entry: FileEntry;
	newBytes: number;
	tables: number;
	rows: number;
	empty: string[];
	/** Whether its rows were read at one moment; see dumpSqliteTo. */
	consistent: boolean;
}

/**
 * How many of a bucket's objects one step lists, and about how much its answer may hold: a step's
 * answer is kept, and has a limit of its own.
 */
const LIST_OBJECTS = 1000;
const LIST_BYTES = 512 * 1024;

/** How much of a bucket one step reads: this many objects, or bytes, whichever comes first. */
const READ_OBJECTS = 100;
const READ_BYTES = 256 * 1024 * 1024;

/** An object a listing found, with its file when the last snapshot holds these very bytes. */
interface ListedObject {
	object: BucketObject;
	entry?: FileEntry;
}

/** Where a bucket's listing goes on: after a key, or from R2's cursor. */
interface ListFrom {
	after?: string;
	cursor?: string;
}

/** An object read into the repository, and what it cost. */
interface ReadObject {
	object: BucketObject;
	entry: FileEntry;
	newBytes: number;
}

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
		const uncopied = results.filter((r) => r.copy === "failed").map((r) => r.source);
		const problems = [
			...(failed.length > 0 ? [`The backup of ${failed.join(", ")} failed.`] : []),
			...(untested.length > 0 ? [`The restore test of ${untested.join(", ")} failed.`] : []),
			...(uncopied.length > 0
				? [`The copy of ${uncopied.join(", ")} outside Cloudflare failed.`]
				: []),
		];
		const asked = event.payload?.alert === true;
		if (problems.length > 0 || asked) {
			await this.#alert(() => runAlert(event.instanceId, results, asked, new Date()), step);
		}
		// A run that made every snapshot but couldn't restore one shows as failed too.
		if (problems.length > 0) throw new Error(`${problems.join(" ")} The catalog says why.`);
		return results;
	}

	/**
	 * Keeps the alert in the catalog, then sends it. One that can't be sent stays there with why,
	 * and the next morning's check (alerts.ts) tries it again; the run goes on to end as it would.
	 */
	async #alert(make: () => Alert, step: WorkflowStep) {
		const db = this.env.CATALOG;
		// Made inside the step, so its time is the one kept, however often the run is replayed.
		const alert = await step.do("alert", QUICK, async () => {
			const made = make();
			await recordAlert(db, made, Date.now());
			return made;
		});
		try {
			await step.do("alert: send", ALERT, () =>
				sendAlert(this.env, alert).catch((error: unknown) => {
					// A setting no retry fixes fails the step at once.
					if (error instanceof AlertConfigError) throw new NonRetryableError(error.message);
					throw error;
				}),
			);
		} catch (error) {
			await step.do("alert: not sent", QUICK, () =>
				markAlertFailed(db, alert.key, describe(error)),
			);
		}
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
			const record =
				source.kind === "d1"
					? await step.do(`${name}: back up`, HEAVY, () => this.#snapshot(source))
					: source.kind === "do"
						? await this.#snapshotObjects(source, step)
						: await this.#snapshotBucket(source, step);
			snapshot = record.name;
			await step.do(`${name}: record`, QUICK, () => recordSnapshot(db, id, record));
			const made = record.name;
			const pruned = await step.do(`${name}: prune`, HEAVY, () => this.#prune(source, made));
			// After the prune and under the lock, so the test also proves the prune left what it needs.
			const test = await this.#testIfDue(id, name, made, step, force);
			// Still under the lock, so the vault doesn't change while it is copied.
			const copy = await this.#copyIfSet(id, source, step);
			await step.do(`${name}: finish`, QUICK, async () => {
				await finishRun(db, { id, source: name, at: Date.now(), ...pruned });
				await releaseLock(db, name, instance);
			});
			const result: SourceResult = { source: name, status: "ok", snapshot };
			if (test) result.test = test.passed ? "passed" : "failed";
			if (test?.error) result.testError = test.error;
			if (copy) result.copy = copy.ok ? "ok" : "failed";
			if (copy?.error) result.copyError = copy.error;
			return result;
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
	): Promise<RestoreTestResult | undefined> {
		const db = this.env.CATALOG;
		const failed = (error: string): RestoreTestResult => ({
			source: name,
			snapshot,
			passed: false,
			tables: 0,
			rows: 0,
			size: 0,
			error,
		});
		let result: RestoreTestResult | undefined;
		try {
			const due = await step.do(`${name}: test due`, QUICK, async () => {
				const days = setting(() => testInterval(this.env.RESTORE_TEST_DAYS));
				return force || (await testDue(db, name, Date.now(), days));
			});
			if (!due) return undefined;
		} catch (error) {
			// Recorded as a failed test, so a setting that stops every test shows in the catalog.
			result = failed(`The test didn't start: ${describe(error)}`);
		}
		try {
			result ??= await step.do(`${name}: restore test`, HEAVY, async () => {
				const tester = setting(() => testerFor(this.env, name));
				return (await tester.restore(name, snapshot)) as RestoreTestResult;
			});
		} catch (error) {
			result = failed(describe(error));
		}
		await step.do(`${name}: test recorded`, QUICK, () => recordTest(db, runId, result, Date.now()));
		return result;
	}

	/**
	 * Copies the source's repository outside Cloudflare when COPY_TO names a bucket, some objects a
	 * step, then prunes the copy by its own retention. How it went goes to the catalog; a failure
	 * is alerted and leaves the backup as it is, in the vault.
	 */
	async #copyIfSet(
		runId: string,
		source: Source,
		step: WorkflowStep,
	): Promise<CopyResult | undefined> {
		const name = source.name;
		const result: CopyResult = { source: name, ok: true, objects: 0, bytes: 0 };
		let set = false;
		try {
			set = copyTarget(this.env) !== undefined;
		} catch (error) {
			// Recorded as a failed copy, so a wrong setting shows in the catalog and the alert.
			Object.assign(result, { ok: false, error: `The copy didn't start: ${describe(error)}` });
		}
		if (!set && result.ok) return undefined;
		if (set) {
			try {
				for (let i = 1; ; i++) {
					const progress = await step.do(`${name}: copy ${i}`, HEAVY, () =>
						copying(async () => {
							const repo = await this.#repository(source);
							const vault = new R2Store(this.env.VAULT, `${name}/`);
							return copyNew(repo, vault, this.#copyOf(name));
						}),
					);
					result.objects += progress.copied;
					result.bytes += progress.bytes;
					if (progress.done) break;
					if (progress.copied === 0) throw new Error("A copy step copied nothing.");
				}
				result.prune = await step.do(`${name}: copy prune`, HEAVY, () =>
					copying(() => {
						const policy = setting(() => parseRetention(this.env.RETENTION));
						return pruneCopy(this.#copyOf(name), this.env.BACKUP_KEY, policy);
					}),
				);
			} catch (error) {
				Object.assign(result, { ok: false, error: describe(error) });
			}
		}
		await step.do(`${name}: copy recorded`, QUICK, () =>
			recordCopy(this.env.CATALOG, runId, result, Date.now()),
		);
		return result;
	}

	/** One source's repository in the copy. */
	#copyOf(name: string): ObjectStore {
		const target = setting(() => copyTarget(this.env));
		if (!target) throw new NonRetryableError("COPY_TO names no bucket.");
		return target.storeFor(name);
	}

	/**
	 * Backs up an app's Durable Objects: lists them, dumps them some at a time, one step each, then
	 * commits one snapshot that holds every dump. An object deleted since it was listed is left out.
	 */
	async #snapshotObjects(source: ObjectsSource, step: WorkflowStep): Promise<SnapshotRecord> {
		const name = source.name;
		const names = await step.do(`${name}: list`, QUICK, () => listObjects(this.#service(source)));
		const batches: string[][] = [];
		for (let i = 0; i < names.length; i += OBJECTS_PER_STEP) {
			batches.push(names.slice(i, i + OBJECTS_PER_STEP));
		}
		const parts: ObjectPart[] = [];
		for (const [i, batch] of batches.entries()) {
			const label = `${name}: back up ${i + 1} of ${batches.length}`;
			parts.push(...(await step.do(label, HEAVY, () => this.#dumpObjects(source, batch))));
		}
		return step.do(`${name}: commit`, QUICK, async () => {
			const repo = await this.#repository(source);
			const tables = parts.reduce((sum, part) => sum + part.tables, 0);
			const rows = parts.reduce((sum, part) => sum + part.rows, 0);
			const empty = parts.flatMap((part) => part.empty.map((table) => `${part.name}/${table}`));
			const inconsistent = parts.filter((part) => !part.consistent).map((part) => part.name);
			const meta = {
				objects: parts.length,
				tables,
				rows,
				empty,
				// Objects that kept changing while they were read a page at a time.
				...(inconsistent.length > 0 ? { inconsistent } : {}),
			};
			const entries = parts.map((part) => part.entry);
			const manifest = await repo.commit({ kind: "do", name }, entries, meta);
			return {
				source: name,
				name: manifest.name,
				created: manifest.created,
				tables,
				rows,
				objects: parts.length,
				size: entries.reduce((sum, entry) => sum + entry.size, 0),
				newBytes: parts.reduce((sum, part) => sum + part.newBytes, 0),
				empty,
			};
		});
	}

	/** Dumps some of the app's objects into the repository, each in its own file. */
	async #dumpObjects(source: ObjectsSource, names: string[]): Promise<ObjectPart[]> {
		const service = this.#service(source);
		const repo = await this.#repository(source);
		const parts: ObjectPart[] = [];
		for (const name of names) {
			let path: string;
			try {
				path = objectFile(name);
			} catch {
				throw new NonRetryableError(`${source.name} listed an object whose name can't be a file.`);
			}
			let dump: Awaited<ReturnType<typeof writeDump>>;
			try {
				dump = await writeDump(repo, path, objectReader(service, name));
			} catch (error) {
				if (error instanceof ObjectGone) continue;
				throw error;
			}
			const { entry, stats } = dump.written;
			parts.push({
				name,
				entry,
				newBytes: stats.newBytes,
				tables: dump.stats.tables,
				rows: dump.stats.rows,
				empty: dump.stats.empty,
				consistent: dump.stats.consistent,
			});
		}
		return parts;
	}

	/**
	 * Backs up an R2 bucket: lists it, reads the objects the last snapshot doesn't hold already, some
	 * at a time, a step each, then commits one snapshot that holds them all and lists them, with
	 * their metadata, in bucket.json. An object deleted after it was listed is left out.
	 */
	async #snapshotBucket(source: R2Source, step: WorkflowStep): Promise<SnapshotRecord> {
		const name = source.name;
		const listed: ListedObject[] = [];
		let from: ListFrom | undefined = {};
		for (let page = 1; from; page++) {
			const start: ListFrom = from;
			const found = await step.do(`${name}: list ${page}`, HEAVY, () =>
				this.#listBucket(source, start),
			);
			listed.push(...found.objects);
			from = found.next;
		}
		const batches: string[][] = [];
		let batch: string[] = [];
		let bytes = 0;
		for (const { object, entry } of listed) {
			if (entry) continue;
			if (batch.length >= READ_OBJECTS || (batch.length > 0 && bytes + object.size > READ_BYTES)) {
				batches.push(batch);
				batch = [];
				bytes = 0;
			}
			batch.push(object.key);
			bytes += object.size;
		}
		if (batch.length > 0) batches.push(batch);
		const read: ReadObject[] = [];
		for (const [i, keys] of batches.entries()) {
			const label = `${name}: back up ${i + 1} of ${batches.length}`;
			read.push(...(await step.do(label, HEAVY, () => this.#readObjects(source, keys))));
		}
		return step.do(`${name}: commit`, HEAVY, async () => {
			const repo = await this.#repository(source);
			const kept = listed.flatMap(({ object, entry }) => (entry ? [{ object, entry }] : []));
			const objects = [...kept, ...read].sort((a, b) => (a.object.key < b.object.key ? -1 : 1));
			const index = await repo.writeFile(
				BUCKET_INDEX,
				writeBucketIndex(objects.map(({ object }) => object)),
			);
			const files = [index.entry, ...objects.map(({ entry }) => entry)];
			const meta = {
				objects: objects.length,
				bytes: objects.reduce((sum, { object }) => sum + object.size, 0),
				read: read.length,
				reused: kept.length,
			};
			const manifest = await repo.commit({ kind: "r2", name }, files, meta);
			return {
				source: name,
				name: manifest.name,
				created: manifest.created,
				tables: 0,
				rows: 0,
				objects: objects.length,
				size: files.reduce((sum, file) => sum + file.size, 0),
				newBytes: read.reduce((sum, item) => sum + item.newBytes, index.stats.newBytes),
				empty: [],
			};
		});
	}

	/**
	 * Lists the bucket from where the last page ended. An object the last snapshot holds with the
	 * same etag, size and upload time gets that snapshot's file, and isn't read again: R2 never
	 * changes an object, only replaces it.
	 */
	async #listBucket(
		source: R2Source,
		from: ListFrom,
	): Promise<{ objects: ListedObject[]; next?: ListFrom }> {
		const bucket = this.#bucket(source);
		const known = await this.#lastObjects(source);
		const page = await bucket.list({
			limit: LIST_OBJECTS,
			include: ["httpMetadata", "customMetadata"],
			...(from.cursor !== undefined ? { cursor: from.cursor } : {}),
			...(from.after !== undefined ? { startAfter: from.after } : {}),
		});
		const objects: ListedObject[] = [];
		let bytes = 0;
		for (const found of page.objects) {
			const object = describeObject(found);
			const last = known.get(object.key);
			const same =
				last !== undefined &&
				last.object.etag === object.etag &&
				last.object.size === object.size &&
				last.object.uploaded === object.uploaded;
			const item: ListedObject = same ? { object, entry: last.entry } : { object };
			const cost = JSON.stringify(item).length;
			const previous = objects.at(-1);
			if (previous && bytes + cost > LIST_BYTES) {
				return { objects, next: { after: previous.object.key } };
			}
			objects.push(item);
			bytes += cost;
		}
		return page.truncated ? { objects, next: { cursor: page.cursor } } : { objects };
	}

	/**
	 * What the newest snapshot holds, by key. Empty when there is none, and when it doesn't open:
	 * then every object is read again, and the snapshot this run makes doesn't lean on it.
	 */
	async #lastObjects(
		source: R2Source,
	): Promise<Map<string, { object: BucketObject; entry: FileEntry }>> {
		const known = new Map<string, { object: BucketObject; entry: FileEntry }>();
		const repo = await this.#repository(source);
		const newest = (await repo.snapshots()).at(-1);
		if (newest === undefined) return known;
		try {
			const manifest = await repo.manifest(newest);
			const index = manifest.files.find((file) => file.path === BUCKET_INDEX);
			if (manifest.source.kind !== "r2" || !index) return known;
			const files = new Map(manifest.files.map((file) => [file.path, file]));
			for (const object of readBucketIndex(await repo.readWholeFile(index))) {
				const entry = files.get(bucketFile(object.key));
				if (entry && entry.size === object.size) known.set(object.key, { object, entry });
			}
		} catch (error) {
			const unreadable =
				error instanceof RepositoryError ||
				error instanceof SealError ||
				error instanceof BucketIndexError ||
				error instanceof SyntaxError;
			if (!unreadable) throw error;
			known.clear();
		}
		return known;
	}

	/** Reads some of the bucket's objects into the repository, each in its own file. */
	async #readObjects(source: R2Source, keys: string[]): Promise<ReadObject[]> {
		const bucket = this.#bucket(source);
		const repo = await this.#repository(source);
		const read: ReadObject[] = [];
		for (const key of keys) {
			const found = await bucket.get(key);
			if (found === null) continue;
			const { entry, stats } = await repo.writeFile(bucketFile(key), found.body);
			if (entry.size !== found.size) {
				throw new Error(`An object of ${found.size} bytes came back with ${entry.size}.`);
			}
			read.push({ object: describeObject(found), entry, newBytes: stats.newBytes });
		}
		return read;
	}

	/** The source's bucket, from its binding, which must not be the one backups go to. */
	#bucket(source: R2Source): R2Bucket {
		const binding = (this.env as unknown as Record<string, unknown>)[source.binding];
		if (!isR2(binding)) {
			throw new NonRetryableError(
				`Source ${source.name}'s binding ${source.binding} isn't an R2 bucket.`,
			);
		}
		if (source.binding === "VAULT") {
			throw new NonRetryableError(`Source ${source.name} is the bucket backups go to.`);
		}
		return binding;
	}

	/** The app's Backup entrypoint, from the source's service binding. */
	#service(source: ObjectsSource): BackupService {
		const binding = (this.env as unknown as Record<string, unknown>)[source.binding];
		if (!isService(binding)) {
			throw new NonRetryableError(
				`Source ${source.name}'s binding ${source.binding} isn't a service binding.`,
			);
		}
		return binding;
	}

	/** Dumps the source and commits the dump as a snapshot. */
	async #snapshot(source: D1Source): Promise<SnapshotRecord> {
		const binding = (this.env as unknown as Record<string, unknown>)[source.binding];
		if (!isD1(binding)) {
			throw new NonRetryableError(
				`Source ${source.name}'s binding ${source.binding} isn't a D1 database.`,
			);
		}
		const repo = await this.#repository(source);
		const dump = await writeDump(repo, DUMP_FILE, d1Reader(binding));
		const { entry, stats } = dump.written;
		const meta = {
			tables: dump.stats.tables,
			rows: dump.stats.rows,
			empty: dump.stats.empty,
			...(dump.stats.consistent ? {} : { consistent: false }),
		};
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

/**
 * Dumps a database into the repository as it is read, so only a page of it is held at a time. A
 * dump that starts over writes its file again; the chunks of the first try that nothing uses are
 * pruned.
 */
function writeDump(repo: Repository, path: string, reader: SqlReader) {
	return dumpSqliteTo(reader, (lines) => repo.writeFile(path, encodeLines(lines)));
}

/** The dump as `joinLines` writes it, in pieces of about a megabyte instead of one string. */
async function* encodeLines(lines: AsyncIterable<string>): AsyncGenerator<Uint8Array<ArrayBuffer>> {
	let batch: string[] = [];
	let length = 0;
	for await (const line of lines) {
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

/**
 * Runs a copy step. A refusal no retry mends, such as a wrong key (403) or a missing bucket (404),
 * or an object the vault lacks, fails it at once rather than after every retry's wait.
 */
async function copying<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		const refused = error instanceof S3Error && error.status !== undefined && error.status < 500;
		if (refused || error instanceof CopyError) throw new NonRetryableError(describe(error));
		throw error;
	}
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
