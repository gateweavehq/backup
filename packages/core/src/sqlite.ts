/**
 * SQLite dumps, for D1 and Durable Object databases: docs/format.md, "SQLite dumps".
 *
 * A dump reads in two rounds. The first learns the schema; the second reads every row, together
 * with the schema again, as one consistent read (a D1 batch, or synchronous calls inside a Durable
 * Object). If the schema changed between the rounds, the dump starts over.
 */

/** The file a SQLite source's snapshot holds its dump in. */
export const DUMP_FILE = "database.jsonl";

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
 * The unique indexes in a dump, by name. A foreign key may point at columns that only such an index
 * makes unique, and SQLite refuses a row for it until that index exists ("foreign key mismatch"),
 * even with checks deferred. D1 always checks foreign keys, so these are made before the rows.
 */
function uniqueIndexes(lines: readonly string[]): Map<string, string> {
	const found = new Map<string, string>();
	for (const text of lines) {
		// Rows are nearly all of a dump, and never an index.
		if (text.startsWith('{"k":"row"') || text.trim() === "") continue;
		try {
			const line = JSON.parse(text) as Line;
			if (line.k === "index" && /^\s*CREATE\s+UNIQUE\s+INDEX\b/i.test(line.sql)) {
				found.set(line.name, line.sql);
			}
		} catch {
			// The second pass reports it, with its line number.
		}
	}
	return found;
}

/**
 * The longest statement a restore makes, in UTF-8 bytes. D1 and Durable Objects refuse one over
 * 100,000 bytes, and a D1 row may be 2 MB, so a longer row goes in through PARTS.
 */
const STATEMENT_BYTES = 90_000;

/** The most a piece of a long value holds, in UTF-8 bytes, so its own INSERT stays short. */
const PIECE_BYTES = 80_000;

/**
 * Where a restore puts a long value together: its pieces go into this table, then the row's INSERT
 * reads them back joined. The table goes once the rows are in. A dump's table of the same name
 * makes it take a number.
 */
const PARTS = "_gateweave_restore_parts";

/** Whether a statement is longer than STATEMENT_BYTES, counting UTF-8 only when it could be. */
function tooLong(statement: string): boolean {
	return statement.length > STATEMENT_BYTES / 3 && utf8Length(statement) > STATEMENT_BYTES;
}

function utf8Length(text: string): number {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code < 0xdc00 && i + 1 < text.length) {
			bytes += 4;
			i++;
		} else bytes += 3;
	}
	return bytes;
}

/** A row's values: the literals `quote()` wrote, joined by commas. */
function literals(values: string, table: string): string[] {
	const out: string[] = [];
	const broken = () => new DumpError(`A row of ${table} has values that don't parse.`);
	let at = 0;
	for (;;) {
		let end: number;
		const text = values[at] === "'";
		if (text || values.startsWith("X'", at)) {
			let from = at + (text ? 1 : 2);
			for (;;) {
				const quote = values.indexOf("'", from);
				if (quote < 0) throw broken();
				// Inside text a quote is doubled; a blob's hex has none.
				if (text && values[quote + 1] === "'") {
					from = quote + 2;
					continue;
				}
				end = quote + 1;
				break;
			}
		} else {
			const comma = values.indexOf(",", at);
			end = comma < 0 ? values.length : comma;
		}
		out.push(values.slice(at, end));
		if (end === values.length) return out;
		if (values[end] !== ",") throw broken();
		at = end + 1;
	}
}

/**
 * The inside of a text or blob literal, cut into pieces of at most PIECE_BYTES. Never inside a
 * doubled quote, which would end the piece's literal early, or inside a character.
 */
function cut(inside: string): string[] {
	const pieces: string[] = [];
	let start = 0;
	let bytes = 0;
	let i = 0;
	while (i < inside.length) {
		const code = inside.charCodeAt(i);
		let width = 1;
		let size = 3;
		if (code === 0x27) {
			width = 2;
			size = 2;
		} else if (code < 0x80) size = 1;
		else if (code < 0x800) size = 2;
		else if (code >= 0xd800 && code < 0xdc00 && i + 1 < inside.length) {
			width = 2;
			size = 4;
		}
		if (bytes + size > PIECE_BYTES && i > start) {
			pieces.push(inside.slice(start, i));
			start = i;
			bytes = 0;
		}
		bytes += size;
		i += width;
	}
	pieces.push(inside.slice(start));
	return pieces;
}

/**
 * A row too long for one statement: its longest values go into the parts table a piece at a time,
 * and its INSERT reads each one back joined, then the parts are cleared for the next row.
 */
function* longRow(table: string, cols: string, values: string, parts: string): Generator<string> {
	const shown = literals(values, table);
	const insert = () => `INSERT INTO ${ident(table)} ${cols} VALUES (${shown.join(",")});`;
	const longest = shown
		.map((_, index) => index)
		.sort((a, b) => (shown[b]?.length ?? 0) - (shown[a]?.length ?? 0));
	for (const index of longest) {
		if (!tooLong(insert())) break;
		const literal = shown[index] ?? "";
		const blob = literal.startsWith("X'");
		// Only text and blobs grow long; a number or NULL is a few characters.
		if (!blob && !literal.startsWith("'")) break;
		let n = 0;
		for (const piece of cut(literal.slice(blob ? 2 : 1, -1))) {
			yield `INSERT INTO ${ident(parts)} (v, n, part) VALUES (${index}, ${n++}, '${piece}');`;
		}
		const joined = `group_concat(part, '' ORDER BY n)`;
		shown[index] =
			`(SELECT ${blob ? `unhex(${joined})` : joined} FROM ${ident(parts)} WHERE v = ${index})`;
	}
	if (tooLong(insert())) {
		throw new DumpError(`A row of ${table} has too many values to restore in one statement.`);
	}
	yield insert();
	yield `DELETE FROM ${ident(parts)};`;
}

/**
 * The SQL that restores a dump into an empty database, one statement at a time: the tables, their
 * unique indexes, the rows, then the rest. It checks the dump as it goes, and throws at the end if
 * the dump is incomplete, so a caller that runs statements as they come must run them in a
 * transaction it can roll back.
 */
export function* restoreSql(lines: Iterable<string>): Generator<string> {
	const all = Array.isArray(lines) ? (lines as readonly string[]) : [...lines];
	const unique = uniqueIndexes(all);
	const columnsOf = new Map<string, string>();
	let number = 0;
	let rows = 0;
	let ended = false;
	let tablesMade = false;
	let parts: string | undefined;
	for (const text of all) {
		number++;
		if (text.trim() === "") continue;
		if (ended) throw new DumpError("The dump goes on after its end.");
		const line = parseLine(text, number);
		if (!tablesMade && number > 1 && line.k !== "table" && line.k !== "virtual") {
			tablesMade = true;
			for (const sql of unique.values()) yield `${sql};`;
		}
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
				const statement = `INSERT INTO ${ident(line.t)} ${cols} VALUES (${line.v});`;
				if (!tooLong(statement)) {
					yield statement;
					break;
				}
				if (parts === undefined) {
					const taken = new Set([...columnsOf.keys()].map((name) => name.toLowerCase()));
					parts = PARTS;
					for (let n = 2; taken.has(parts); n++) parts = `${PARTS}_${n}`;
					yield `CREATE TABLE ${ident(parts)} (v INTEGER NOT NULL, n INTEGER NOT NULL, part TEXT NOT NULL, PRIMARY KEY (v, n));`;
				}
				yield* longRow(line.t, cols, line.v, parts);
				break;
			}
			case "seq":
				yield `DELETE FROM sqlite_sequence WHERE name = '${line.name.replaceAll("'", "''")}';`;
				yield `INSERT INTO sqlite_sequence (name, seq) VALUES ('${line.name.replaceAll("'", "''")}', ${Math.trunc(line.seq)});`;
				break;
			case "index":
				if (!unique.has(line.name)) yield `${line.sql};`;
				break;
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
				if (parts !== undefined) yield `DROP TABLE ${ident(parts)};`;
				ended = true;
				break;
			case "head":
				throw new DumpError(`Line ${number} starts another dump.`);
		}
	}
	if (number === 0) throw new DumpError("The dump is empty.");
	if (!ended) throw new DumpError("The dump stops before its end: it is incomplete.");
}

export interface TableSummary {
	name: string;
	rows: number;
	/** A virtual table, such as an FTS5 index, whose rows may be rebuilt rather than listed. */
	virtual: boolean;
}

export interface DumpSummary {
	/** Whether every row was read at the same moment. */
	consistent: boolean;
	tables: TableSummary[];
	rows: number;
}

/** What a dump holds: its tables and how many rows each has. Names and counts, never values. */
export function summarizeDump(lines: readonly string[]): DumpSummary {
	const summary: DumpSummary = { consistent: false, tables: [], rows: 0 };
	const byName = new Map<string, TableSummary>();
	let ended = false;
	lines.forEach((text, index) => {
		if (text.trim() === "") return;
		let line: { k?: unknown; name?: unknown; t?: unknown; consistent?: unknown };
		try {
			line = JSON.parse(text);
		} catch {
			throw new DumpError(`Line ${index + 1} of the dump is not a dump line.`);
		}
		if (line.k === "head") summary.consistent = line.consistent === true;
		else if ((line.k === "table" || line.k === "virtual") && typeof line.name === "string") {
			const table = { name: line.name, rows: 0, virtual: line.k === "virtual" };
			byName.set(line.name, table);
			summary.tables.push(table);
		} else if (line.k === "row" && typeof line.t === "string") {
			const table = byName.get(line.t);
			if (!table)
				throw new DumpError(`Line ${index + 1} has a row for a table the dump hasn't made.`);
			table.rows++;
			summary.rows++;
		} else if (line.k === "end") ended = true;
	});
	if (!ended) throw new DumpError("The dump stops before its end: it is incomplete.");
	return summary;
}

/** A name as SQL writes it: quoted in any of SQLite's ways, or bare. */
const NAME = /"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[^\s(,;]+/.source;

/** The start of each statement a restore makes, up to the object it is about. */
const STATEMENT_START = new RegExp(
	[
		`CREATE\\s+(?:UNIQUE\\s+|VIRTUAL\\s+|TEMP(?:ORARY)?\\s+)*(?:TABLE|INDEX|TRIGGER|VIEW)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:${NAME})`,
		`INSERT\\s+INTO\\s+(?:${NAME})`,
		`DELETE\\s+FROM\\s+(?:${NAME})`,
		`PRAGMA\\s+\\w+`,
	]
		.map((start) => `^\\s*${start}`)
		.join("|"),
	"i",
);

/**
 * A restore statement by what it does and to which object, such as `INSERT INTO "person"`: what an
 * error about a statement may say. Never its values, and never the rest of a view's or a trigger's
 * SQL, which may hold literals.
 */
export function describeStatement(statement: string): string {
	const start = STATEMENT_START.exec(statement)?.[0] ?? statement.trim().split(/\s/)[0] ?? "";
	return start.trim().replace(/\s+/g, " ").slice(0, 120);
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
