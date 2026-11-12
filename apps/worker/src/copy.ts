import {
	fromUtf8,
	type ObjectStore,
	parseS3Url,
	Repository,
	type RetentionPolicy,
	retain,
	S3Bucket,
} from "@gateweave/backup-core";

/**
 * The copy outside Cloudflare (docs/architecture.md, principle 3): after each run, every source's
 * repository goes to an S3-compatible bucket at another provider, a sealed object at a time, as it
 * is in the vault. Only what the copy lacks is sent. The copy keeps its own retention: it lets a
 * snapshot go when the policy says so, never because the vault lost it.
 */

/** The settings of a copy, which a deployment may leave out. The keys are secrets. */
export interface CopyEnv {
	/** `s3://<bucket>[/<folder>]`, or empty for no copy. */
	COPY_TO?: string;
	/** The bucket's S3 endpoint, an https URL. */
	COPY_ENDPOINT?: string;
	/** The region requests are signed for: `auto` at R2, the bucket's own elsewhere. */
	COPY_REGION?: string;
	COPY_ACCESS_KEY_ID?: string;
	COPY_SECRET_ACCESS_KEY?: string;
}

/** A setting no retry mends. */
export class CopyConfigError extends Error {
	override name = "CopyConfigError";
}

/** The vault's repository is missing an object a snapshot needs. */
export class CopyError extends Error {
	override name = "CopyError";
}

export interface CopyTarget {
	/** `s3://<bucket>[/<folder>]`, as COPY_TO names it. */
	location: string;
	/** One source's repository in the copy: a folder of the same name, as in the vault. */
	storeFor(source: string): ObjectStore;
}

/** The copy COPY_TO names, or undefined when it names none. */
export function copyTarget(env: CopyEnv, fetcher?: typeof fetch): CopyTarget | undefined {
	const to = env.COPY_TO?.trim() ?? "";
	if (to === "") return undefined;
	let where: { bucket: string; prefix: string };
	try {
		where = parseS3Url(to);
	} catch (error) {
		throw new CopyConfigError(`COPY_TO: ${error instanceof Error ? error.message : error}`);
	}
	let endpoint: URL;
	try {
		endpoint = new URL(env.COPY_ENDPOINT?.trim() ?? "");
	} catch {
		throw new CopyConfigError(
			"COPY_TO needs COPY_ENDPOINT, the bucket's S3 endpoint, such as https://s3.eu-central-003.backblazeb2.com.",
		);
	}
	if (endpoint.protocol !== "https:") throw new CopyConfigError("COPY_ENDPOINT is an https URL.");
	const accessKeyId = env.COPY_ACCESS_KEY_ID;
	const secretAccessKey = env.COPY_SECRET_ACCESS_KEY;
	if (!accessKeyId || !secretAccessKey) {
		throw new CopyConfigError(
			"COPY_TO needs the secrets COPY_ACCESS_KEY_ID and COPY_SECRET_ACCESS_KEY: a key that may read, write and delete in that bucket.",
		);
	}
	const region = env.COPY_REGION?.trim() || "auto";
	return {
		location: to,
		storeFor: (source) =>
			new S3Bucket({
				endpoint,
				bucket: where.bucket,
				prefix: `${where.prefix}${source}/`,
				region,
				credentials: { accessKeyId, secretAccessKey },
				...(fetcher ? { fetch: fetcher } : {}),
			}),
	};
}

/** How much one step copies: this many objects, or bytes, whichever comes first. */
export const COPY_OBJECTS = 200;
export const COPY_BYTES = 256 * 1024 * 1024;

export interface CopyProgress {
	copied: number;
	bytes: number;
	/** Whether the copy now has every object the repository's snapshots need. */
	done: boolean;
}

/**
 * Copies what the repository's snapshots need and the copy lacks, chunks first and manifests
 * last, so a copy cut short holds no manifest without its chunks. It stops after a budget, and
 * the next step goes on from what the copy has by then.
 *
 * A copy that holds another repository, as it does after the vault's was lost and made anew, is
 * left as it is: the new one's manifests wouldn't open with its config.json, and its retention
 * would let the old snapshots go for them.
 */
export async function copyNew(
	repo: Repository,
	from: ObjectStore,
	to: ObjectStore,
	budget = { objects: COPY_OBJECTS, bytes: COPY_BYTES },
): Promise<CopyProgress> {
	const there = new Set<string>();
	for await (const key of to.list("")) there.add(key);
	if (there.has("config.json")) {
		const [ours, theirs] = await Promise.all([from.get("config.json"), to.get("config.json")]);
		if (!ours || !theirs || fromUtf8(ours) !== fromUtf8(theirs)) {
			throw new CopyError(
				"The copy holds another repository than the vault: their config.json differ. Nothing was sent, and the copy is as it was. Move its folder aside to start a new copy.",
			);
		}
	}
	let copied = 0;
	let bytes = 0;
	for (const key of await repo.neededKeys()) {
		if (there.has(key)) continue;
		if (copied >= budget.objects || bytes >= budget.bytes) return { copied, bytes, done: false };
		const data = await from.get(key);
		if (!data) throw new CopyError(`${key} is missing from the vault, and a snapshot needs it.`);
		await to.put(key, data);
		copied++;
		bytes += data.length;
	}
	return { copied, bytes, done: true };
}

export interface CopyPrune {
	/** The snapshots the copy holds after the prune. */
	snapshots: number;
	forgotten: number;
	/** Snapshots the policy let go, which a lock on the copy keeps until a later run. */
	heldSnapshots: number;
	deleted: number;
	held: number;
}

/**
 * The copy's own retention: the same policy, on the snapshots the copy holds. A snapshot that went
 * missing from the vault stays in the copy until the policy lets it go, which is what a copy is
 * for. Chunks no manifest in the copy uses are deleted; a lock on the copy's bucket keeps some,
 * counted as held, for a later run.
 */
export async function pruneCopy(
	to: ObjectStore,
	masterKey: string,
	policy: RetentionPolicy,
): Promise<CopyPrune> {
	const copy = await Repository.open(to, masterKey);
	const { forget } = retain(await copy.snapshots(), policy);
	let forgotten = 0;
	let heldSnapshots = 0;
	for (const name of forget) {
		try {
			await copy.forget(name);
			forgotten++;
		} catch {
			heldSnapshots++;
		}
	}
	const stats = await copy.prune();
	return {
		snapshots: stats.snapshots,
		forgotten,
		heldSnapshots,
		deleted: stats.deleted,
		held: stats.held,
	};
}

/** How a source's copy went in one run, as the catalog keeps it. */
export interface CopyResult {
	source: string;
	ok: boolean;
	objects: number;
	bytes: number;
	prune?: CopyPrune;
	error?: string;
}
