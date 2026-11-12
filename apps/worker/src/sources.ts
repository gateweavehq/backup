/** A D1 database, read through its binding. */
export interface D1Source {
	name: string;
	kind: "d1";
	binding: string;
}

/**
 * An app's Durable Objects, read through a service binding to the app's `Backup` entrypoint, which
 * lists them and reads each one's SQLite (docs/architecture.md, "Sources").
 */
export interface ObjectsSource {
	name: string;
	kind: "do";
	binding: string;
}

/** An R2 bucket's objects, with their metadata, read through its binding. */
export interface R2Source {
	name: string;
	kind: "r2";
	binding: string;
}

export type Source = D1Source | ObjectsSource | R2Source;

const KINDS = ["d1", "do", "r2"] as const;

/** What a source's binding is, said when it is missing. */
const BINDINGS: Record<Source["kind"], string> = {
	d1: "D1 binding",
	do: "service binding to the app's Backup entrypoint",
	r2: "R2 bucket binding",
};

/** A mistake in the Worker's settings. Retrying doesn't fix it. */
export class ConfigError extends Error {
	override name = "ConfigError";
}

/** Short and plain: a source's name is its repository's folder in the bucket. */
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BINDING = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Reads `SOURCES`, a list of what to back up, given as JSON or as text holding JSON. */
export function parseSources(value: unknown): Source[] {
	let list = value;
	if (typeof value === "string") {
		try {
			list = JSON.parse(value);
		} catch {
			throw new ConfigError("SOURCES is not JSON.");
		}
	}
	if (!Array.isArray(list)) throw new ConfigError("SOURCES must be a list.");
	const names = new Set<string>();
	return list.map((item: unknown, i) => {
		const { name, kind, binding } = (typeof item === "object" && item !== null ? item : {}) as {
			[key: string]: unknown;
		};
		if (typeof name !== "string" || !NAME.test(name)) {
			throw new ConfigError(
				`Source ${i + 1} needs a name of lowercase letters, digits and dashes, up to 63.`,
			);
		}
		if (names.has(name)) throw new ConfigError(`Two sources are named ${name}.`);
		names.add(name);
		const known = KINDS.find((k) => k === kind);
		if (!known) {
			throw new ConfigError(`Source ${name} is of a kind this version can't back up yet.`);
		}
		if (typeof binding !== "string" || !BINDING.test(binding)) {
			throw new ConfigError(`Source ${name} needs the name of its ${BINDINGS[known]}.`);
		}
		return { name, kind: known, binding };
	});
}

/** The sources a run asked for, or all of them. */
export function pickSources(sources: Source[], names: string[] | undefined): Source[] {
	if (names === undefined) return sources;
	return names.map((name) => {
		const source = sources.find((s) => s.name === name);
		if (!source) throw new ConfigError(`There is no source named ${name}.`);
		return source;
	});
}
