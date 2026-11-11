/**
 * SQLite dumps, for D1 and Durable Object databases: docs/format.md, "SQLite dumps".
 *
 * A dump reads in two rounds. The first learns the schema; the second reads every row, together
 * with the schema again, as one consistent read (a D1 batch, or synchronous calls inside a Durable
 * Object). If the schema changed between the rounds, the dump starts over.
 */

export type Row = Record<string, unknown>;

/** Runs read-only statements together, as one consistent read, and returns each one's rows. */
export interface SqlReader {
	readTogether(statements: string[]): Promise<Row[][]>;
}

export interface DumpStats {
	tables: number;
	rows: number;
	/** Contentless FTS5 tables, which come back empty. */
	empty: string[];
}

export interface Dump {
	lines: string[];
	stats: DumpStats;
}

export class DumpError extends Error {
	override name = "DumpError";
}

/** Double-quoted, so any name is safe in SQL. */
export function ident(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

const SCHEMA = "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY rowid";
const TABLES = "PRAGMA table_list";
const ATTEMPTS = 3;

interface SchemaObject {
	type: string;
	name: string;
	tbl_name: string;
	sql: string | null;
}

interface TableInfo {
	name: string;
	type: string;
	wr: number;
}

type FtsContent = "own" | "external" | "none";

interface Plan {
	tables: { name: string; sql: string; cols: string[]; withoutRowid: boolean }[];
	virtuals: { name: string; sql: string; cols: string[]; content: FtsContent; fts5: boolean }[];
	after: SchemaObject[];
	hasSequence: boolean;
}

/** Ours to skip: SQLite's own tables and Cloudflare's, which can't be read and aren't the app's. */
function internal(name: string): boolean {
	const lower = name.toLowerCase();
	return lower.startsWith("sqlite_") || lower.startsWith("_cf_");
}

/** Whether an FTS5 table keeps its own text, reads it from another table, or keeps none. */
export function ftsContent(sql: string): FtsContent {
	const match = /\bcontent\s*=\s*('(?:[^']|'')*'|"(?:[^"]|"")*"|[^\s,)]+)/i.exec(sql);
	if (!match?.[1]) return "own";
	const value = match[1];
	if (value === "''" || value === '""') return "none";
	return "external";
}

function asSchema(rows: Row[]): SchemaObject[] {
	return rows.map((row) => ({
		type: String(row.type),
		name: String(row.name),
		tbl_name: String(row.tbl_name),
		sql: row.sql === null || row.sql === undefined ? null : String(row.sql),
	}));
}

function columns(rows: Row[]): string[] {
	return rows.map((row) => String(row.name));
}

async function plan(reader: SqlReader): Promise<{ plan: Plan; schema: string }> {
	const [schemaRows = [], tableRows = []] = await reader.readTogether([SCHEMA, TABLES]);
	const schema = asSchema(schemaRows);
	const listed = new Map<string, TableInfo>();
	for (const row of tableRows) {
		if (row.schema !== undefined && row.schema !== "main") continue;
		listed.set(String(row.name), {
			name: String(row.name),
			type: String(row.type),
			wr: Number(row.wr),
		});
	}
	const tables: Plan["tables"] = [];
	const virtuals: Plan["virtuals"] = [];
	const after: SchemaObject[] = [];
	for (const object of schema) {
		if (internal(object.name) || object.sql === null) continue;
		if (object.type === "table") {
			const info = listed.get(object.name);
			if (info?.type === "shadow") continue;
			if (/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(object.sql)) {
				const fts5 = /\bUSING\s+fts5\b/i.test(object.sql);
				virtuals.push({
					name: object.name,
					sql: object.sql,
					cols: [],
					content: fts5 ? ftsContent(object.sql) : "own",
					fts5,
				});
			} else {
				tables.push({ name: object.name, sql: object.sql, cols: [], withoutRowid: info?.wr === 1 });
			}
		} else if (object.type === "index" || object.type === "trigger" || object.type === "view") {
			if (!internal(object.tbl_name)) after.push(object);
		}
	}
	const named = [...tables, ...virtuals];
	const infos = await reader.readTogether(named.map((t) => `PRAGMA table_info(${ident(t.name)})`));
	named.forEach((table, i) => {
		table.cols = columns(infos[i] ?? []);
		if (table.cols.length === 0) throw new DumpError(`${table.name} lists no columns.`);
	});
	const hasSequence = schema.some((o) => o.type === "table" && o.name === "sqlite_sequence");
	return {
		plan: { tables, virtuals, after, hasSequence },
		schema: JSON.stringify(schema),
	};
}

/** One statement that reads a table's rows as SQL literals, joined by commas. */
function rowsQuery(
	name: string,
	cols: string[],
	{ rowid, order }: { rowid: boolean; order: boolean },
) {
	const values = [...(rowid ? ["rowid"] : []), ...cols].map((c) =>
		c === "rowid" ? "quote(rowid)" : `quote(${ident(c)})`,
	);
	return `SELECT ${values.join(" || ',' || ")} AS v FROM ${ident(name)}${order ? " ORDER BY rowid" : ""}`;
}

/**
 * Dumps a database through `reader`. The lines are docs/format.md's `database.jsonl`. `consistent`
 * says whether the reader reads all its statements at one moment, which D1's batches and Durable
 * Objects' synchronous storage do.
 */
export async function dumpSqlite(
	reader: SqlReader,
	{ consistent = true }: { consistent?: boolean } = {},
): Promise<Dump> {
	for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
		const { plan: p, schema } = await plan(reader);
		const ownVirtuals = p.virtuals.filter((v) => v.content === "own");
		const statements = [
			SCHEMA,
			...p.tables.map((t) => rowsQuery(t.name, t.cols, { rowid: false, order: !t.withoutRowid })),
			// An FTS5 table that keeps its own text is restored by inserting it, rowid included, so
			// that the rowids other tables may hold still match.
			...ownVirtuals.map((v) => rowsQuery(v.name, v.cols, { rowid: v.fts5, order: false })),
			...(p.hasSequence ? ["SELECT name, seq FROM sqlite_sequence ORDER BY name"] : []),
		];
		const results = await reader.readTogether(statements);
		if (JSON.stringify(asSchema(results[0] ?? [])) !== schema) continue;

		const lines: string[] = [];
		const line = (value: Record<string, unknown>) => lines.push(JSON.stringify(value));
		let rows = 0;
		line({ k: "head", format: "sqlite-jsonl", version: 1, consistent });
		for (const t of p.tables) line({ k: "table", name: t.name, sql: t.sql, cols: t.cols });
		for (const v of p.virtuals) {
			const cols = v.content === "own" && v.fts5 ? ["rowid", ...v.cols] : v.cols;
			line({ k: "virtual", name: v.name, sql: v.sql, cols, content: v.content });
		}
		let at = 1;
		for (const t of [...p.tables, ...ownVirtuals]) {
			for (const row of results[at] ?? []) {
				line({ k: "row", t: t.name, v: String(row.v) });
				rows++;
			}
			at++;
		}
		if (p.hasSequence) {
			for (const row of results[at] ?? [])
				line({ k: "seq", name: String(row.name), seq: Number(row.seq) });
		}
		for (const object of p.after) line({ k: object.type, name: object.name, sql: object.sql });
		for (const v of p.virtuals) {
			if (v.fts5 && v.content === "external") line({ k: "rebuild", t: v.name });
		}
		line({ k: "end", tables: p.tables.length + p.virtuals.length, rows });
		const empty = p.virtuals.filter((v) => v.content === "none").map((v) => v.name);
		return { lines, stats: { tables: p.tables.length + p.virtuals.length, rows, empty } };
	}
	throw new DumpError(`The schema kept changing during the dump, ${ATTEMPTS} times.`);
}

type Line =
	| { k: "head"; format: string; version: number; consistent: boolean }
	| { k: "table" | "virtual"; name: string; sql: string; cols: string[] }
	| { k: "row"; t: string; v: string }
	| { k: "seq"; name: string; seq: number }
	| { k: "index" | "trigger" | "view"; name: string; sql: string }
	| { k: "rebuild"; t: string }
	| { k: "end"; tables: number; rows: number };

function parseLine(text: string, number: number): Line {
	try {
		const value = JSON.parse(text) as Line;
		if (typeof value === "object" && value !== null && typeof value.k === "string") return value;
	} catch {}
	throw new DumpError(`Line ${number} of the dump is not a dump line.`);
}

/**
 * The SQL that restores a dump into an empty database, one statement at a time. It checks the dump
 * as it goes, and throws at the end if the dump is incomplete, so a caller that runs statements as
 * they come must run them in a transaction it can roll back.
 */
export function* restoreSql(lines: Iterable<string>): Generator<string> {
	const columnsOf = new Map<string, string>();
	let number = 0;
	let rows = 0;
	let ended = false;
	for (const text of lines) {
		number++;
		if (text.trim() === "") continue;
		if (ended) throw new DumpError("The dump goes on after its end.");
		const line = parseLine(text, number);
		if (number === 1) {
			if (line.k !== "head" || line.format !== "sqlite-jsonl" || line.version !== 1) {
				throw new DumpError("This is not a version 1 SQLite dump.");
			}
			yield "PRAGMA defer_foreign_keys = on;";
			continue;
		}
		switch (line.k) {
			case "table":
			case "virtual":
				columnsOf.set(line.name, `(${line.cols.map(ident).join(", ")})`);
				yield `${line.sql};`;
				break;
			case "row": {
				const cols = columnsOf.get(line.t);
				if (!cols)
					throw new DumpError(`Line ${number} has a row for a table the dump hasn't made.`);
				rows++;
				yield `INSERT INTO ${ident(line.t)} ${cols} VALUES (${line.v});`;
				break;
			}
			case "seq":
				yield `DELETE FROM sqlite_sequence WHERE name = '${line.name.replaceAll("'", "''")}';`;
				yield `INSERT INTO sqlite_sequence (name, seq) VALUES ('${line.name.replaceAll("'", "''")}', ${Math.trunc(line.seq)});`;
				break;
			case "index":
			case "trigger":
			case "view":
				yield `${line.sql};`;
				break;
			case "rebuild":
				yield `INSERT INTO ${ident(line.t)} (${ident(line.t)}) VALUES ('rebuild');`;
				break;
			case "end":
				if (line.rows !== rows) {
					throw new DumpError(`The dump says ${line.rows} rows but holds ${rows}.`);
				}
				ended = true;
				break;
			case "head":
				throw new DumpError(`Line ${number} starts another dump.`);
		}
	}
	if (number === 0) throw new DumpError("The dump is empty.");
	if (!ended) throw new DumpError("The dump stops before its end: it is incomplete.");
}

/** A dump's lines as one file, and back. */
export function joinLines(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

export function splitLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}
