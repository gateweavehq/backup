/**
 * SQLite dumps, for D1 and Durable Object databases: docs/format.md, "SQLite dumps".
 *
 * A dump reads in two rounds. The first learns the schema and how large the tables are; the second
 * reads every row, together with the schema again, as one consistent read (a D1 batch, or
 * synchronous calls inside a Durable Object), or a page at a time when the rows are too many for
 * one. If the schema changed between the rounds, the dump starts over.
 */

import { concat, fromUtf8 } from "./bytes";

/** The file a SQLite source's snapshot holds its dump in. */
export const DUMP_FILE = "database.jsonl";

/**
 * Where a snapshot of many databases, one per Durable Object, keeps each one's dump:
 * `objects/<name>.jsonl`.
 */
export const OBJECT_DIR = "objects/";

/** An object's name as a file's: no slashes, and not starting with a dot. */
const OBJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

/** The file an object's dump goes in. */
export function objectFile(name: string): string {
	if (!OBJECT_NAME.test(name)) {
		throw new DumpError(
			"An object's name must be up to 200 letters, digits, dots, dashes and underscores, starting with a letter or digit.",
		);
	}
	return `${OBJECT_DIR}${name}.jsonl`;
}

/** The object whose dump a file holds, or undefined for any other file. */
export function objectOf(path: string): string | undefined {
	if (!path.startsWith(OBJECT_DIR) || !path.endsWith(".jsonl")) return undefined;
	const name = path.slice(OBJECT_DIR.length, -".jsonl".length);
	return OBJECT_NAME.test(name) ? name : undefined;
}

/** Whether a snapshot's file is a database's dump: a D1 source's one, or one of an object's. */
export function isDumpFile(path: string): boolean {
	return path === DUMP_FILE || objectOf(path) !== undefined;
}

export type Row = Record<string, unknown>;

export class DumpError extends Error {
	override name = "DumpError";
}

/** Runs read-only statements together, as one consistent read, and returns each one's rows. */
export interface SqlReader {
	readTogether(statements: string[]): Promise<Row[][]>;
}

export interface DumpStats {
	tables: number;
	rows: number;
	/** Contentless FTS5 tables, which come back empty. */
	empty: string[];
	/** Whether every row was read at the same moment, as the dump's head says. */
	consistent: boolean;
}

export interface Dump {
	lines: string[];
	stats: DumpStats;
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

/**
 * The most a dump reads in one call, in characters of its rows' SQL literals. A Durable Object's
 * answer over RPC may be 32 MiB at most and a D1 batch's 50 MB, and a character past Latin-1 can
 * take two bytes on the way. A database with more is read a page at a time.
 */
export const PAGE_CHARS = 12_000_000;

/** How many rows the database's connection has changed: the same before and after a quiet read. */
const CHANGES = "SELECT total_changes() AS t";
const SEQUENCES = "SELECT name, seq FROM sqlite_sequence ORDER BY name";

/** The most statements one call sends. The apps' Backup entrypoints take up to 1,000. */
const STATEMENTS = 500;

export interface DumpOptions {
	/**
	 * Whether the reader reads all the statements of one call at one moment, as D1's batches and
	 * Durable Objects do. The default.
	 */
	consistent?: boolean;
	/** The most one call reads, in characters: PAGE_CHARS unless a test wants pages sooner. */
	pageChars?: number;
}

/** A table whose rows a dump reads, as `rowsQuery` and `pageQuery` read it. */
interface Readable {
	name: string;
	cols: string[];
	/** Whether its rowid is one of the values, as an FTS5 table that keeps its own text needs. */
	rowid: boolean;
	/** Whether a whole read orders it by rowid. */
	order: boolean;
	/** Whether it has a rowid to read it by a page at a time. */
	pageable: boolean;
}

/** The tables whose rows a dump holds, in its order: the plain tables, then the own-text FTS. */
function readables(p: Plan): Readable[] {
	return [
		...p.tables.map((t) => ({
			name: t.name,
			cols: t.cols,
			rowid: false,
			order: !t.withoutRowid,
			pageable: !t.withoutRowid,
		})),
		// An FTS5 table that keeps its own text is restored by inserting it, rowid included, so
		// that the rowids other tables may hold still match.
		...p.virtuals
			.filter((v) => v.content === "own")
			.map((v) => ({ name: v.name, cols: v.cols, rowid: v.fts5, order: false, pageable: v.fts5 })),
	];
}

/** A table's row as SQL literals, joined by commas. */
function valuesOf(t: Readable): string {
	return [...(t.rowid ? ["rowid"] : []), ...t.cols]
		.map((c) => (c === "rowid" ? "quote(rowid)" : `quote(${ident(c)})`))
		.join(" || ',' || ");
}

/** One statement that reads all of a table's rows. */
function rowsQuery(t: Readable): string {
	return `SELECT ${valuesOf(t)} AS v FROM ${ident(t.name)}${t.order ? " ORDER BY rowid" : ""}`;
}

/** How many rows a table has, and how many characters they come to. */
function sizeQuery(t: Readable): string {
	return `SELECT count(*) AS n, coalesce(sum(length(${valuesOf(t)})), 0) AS c FROM ${ident(t.name)}`;
}

/** Up to `limit` of a table's rows after the rowid `after`, each with its rowid. */
function pageQuery(t: Readable, after: string | undefined, limit: number): string {
	const where = after === undefined ? "" : ` WHERE rowid > ${after}`;
	return `SELECT quote(rowid) AS r, ${valuesOf(t)} AS v FROM ${ident(t.name)}${where} ORDER BY rowid LIMIT ${limit}`;
}

function rowidOf(value: unknown): string {
	const text = String(value);
	if (!/^-?\d{1,20}$/.test(text))
		throw new DumpError("A page came back with a rowid that isn't one.");
	return text;
}

function changesOf(rows: Row[] | undefined): number {
	return Number(rows?.[0]?.t);
}

/** The database changed while it was read a page at a time, so the dump starts over. */
class Changed extends Error {}

const line = (value: Record<string, unknown>) => JSON.stringify(value);

function* headLines(p: Plan, consistent: boolean): Generator<string> {
	yield line({ k: "head", format: "sqlite-jsonl", version: 1, consistent });
	for (const t of p.tables) yield line({ k: "table", name: t.name, sql: t.sql, cols: t.cols });
	for (const v of p.virtuals) {
		const cols = v.content === "own" && v.fts5 ? ["rowid", ...v.cols] : v.cols;
		yield line({ k: "virtual", name: v.name, sql: v.sql, cols, content: v.content });
	}
}

function* tailLines(p: Plan, sequences: Row[], rows: number): Generator<string> {
	for (const row of sequences)
		yield line({ k: "seq", name: String(row.name), seq: Number(row.seq) });
	for (const object of p.after) yield line({ k: object.type, name: object.name, sql: object.sql });
	for (const v of p.virtuals) {
		if (v.fts5 && v.content === "external") yield line({ k: "rebuild", t: v.name });
	}
	yield line({ k: "end", tables: p.tables.length + p.virtuals.length, rows });
}

/**
 * Dumps a database through `reader`. The lines are docs/format.md's `database.jsonl`.
 */
export async function dumpSqlite(reader: SqlReader, options: DumpOptions = {}): Promise<Dump> {
	const lines: string[] = [];
	const { stats } = await dumpSqliteTo(
		reader,
		async (all) => {
			lines.length = 0;
			for await (const text of all) lines.push(text);
		},
		options,
	);
	return { lines, stats };
}

/**
 * Dumps a database through `reader`, giving its lines to `write` as they are read, so a large
 * database is never held whole: docs/format.md, "SQLite dumps". `write` may be called again, with
 * the dump from the start, when the database changed while it was read a page at a time.
 *
 * A database whose rows come to PAGE_CHARS or less is read in one call, at one moment. A larger one
 * is read in calls of about PAGE_CHARS: its small tables together, a large one a page at a time by
 * rowid. Every call also reads `total_changes()`, which any write moves, so a dump whose calls
 * don't all agree starts over. The last of its tries goes on regardless, and says it wasn't read
 * at one moment.
 */
export async function dumpSqliteTo<T>(
	reader: SqlReader,
	write: (lines: AsyncIterable<string>) => Promise<T>,
	{ consistent = true, pageChars = PAGE_CHARS }: DumpOptions = {},
): Promise<{ written: T; stats: DumpStats }> {
	for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
		const { plan: p, schema } = await plan(reader);
		const readable = readables(p);
		const sized = await reader.readTogether([SCHEMA, CHANGES, ...readable.map(sizeQuery)]);
		if (JSON.stringify(asSchema(sized[0] ?? [])) !== schema) continue;
		const sizes = readable.map((_, i) => ({
			rows: Number(sized[i + 2]?.[0]?.n ?? 0),
			chars: Number(sized[i + 2]?.[0]?.c ?? 0),
		}));
		const stats: DumpStats = {
			tables: p.tables.length + p.virtuals.length,
			rows: 0,
			empty: p.virtuals.filter((v) => v.content === "none").map((v) => v.name),
			consistent,
		};
		let lines: AsyncGenerator<string>;
		if (sizes.reduce((sum, size) => sum + size.chars, 0) <= pageChars) {
			const results = await reader.readTogether([
				SCHEMA,
				...readable.map(rowsQuery),
				...(p.hasSequence ? [SEQUENCES] : []),
			]);
			if (JSON.stringify(asSchema(results[0] ?? [])) !== schema) continue;
			lines = wholeLines(p, readable, results, stats);
		} else {
			stats.consistent = consistent && attempt < ATTEMPTS;
			const read = { reader, schema, changes: changesOf(sized[1]), pageChars };
			lines = pagedLines(p, readable, sizes, read, stats);
		}
		try {
			return { written: await write(lines), stats };
		} catch (error) {
			if (error instanceof Changed) continue;
			throw error;
		}
	}
	throw new DumpError(`The database kept changing during the dump, ${ATTEMPTS} times.`);
}

/** The lines of a dump read in one call, each row let go as soon as its line is made. */
async function* wholeLines(
	p: Plan,
	readable: Readable[],
	results: Row[][],
	stats: DumpStats,
): AsyncGenerator<string> {
	yield* headLines(p, stats.consistent);
	for (const [i, t] of readable.entries()) {
		// Taken from the end of a reversed list, so each row can go as soon as its line is made.
		const left = (results[i + 1] ?? []).reverse();
		results[i + 1] = [];
		for (let row = left.pop(); row !== undefined; row = left.pop()) {
			stats.rows++;
			yield line({ k: "row", t: t.name, v: String(row.v) });
		}
	}
	yield* tailLines(p, p.hasSequence ? (results[readable.length + 1] ?? []) : [], stats.rows);
}

/** The lines of a dump read a page at a time, checked as they come when `stats.consistent`. */
async function* pagedLines(
	p: Plan,
	readable: Readable[],
	sizes: { rows: number; chars: number }[],
	read: { reader: SqlReader; schema: string; changes: number; pageChars: number },
	stats: DumpStats,
): AsyncGenerator<string> {
	const { reader, pageChars } = read;
	const check = (rows: Row[] | undefined) => {
		if (stats.consistent && changesOf(rows) !== read.changes) throw new Changed();
	};
	let group: Readable[] = [];
	let groupChars = 0;
	async function* readGroup(): AsyncGenerator<string> {
		if (group.length === 0) return;
		const tables = group;
		group = [];
		groupChars = 0;
		const results = await reader.readTogether([...tables.map(rowsQuery), CHANGES]);
		check(results[tables.length]);
		for (const [i, t] of tables.entries()) {
			for (const row of results[i] ?? []) {
				stats.rows++;
				yield line({ k: "row", t: t.name, v: String(row.v) });
			}
		}
	}

	yield* headLines(p, stats.consistent);
	for (const [i, t] of readable.entries()) {
		const size = sizes[i] ?? { rows: 0, chars: 0 };
		if (size.chars <= pageChars) {
			if (groupChars + size.chars > pageChars || group.length >= STATEMENTS) yield* readGroup();
			group.push(t);
			groupChars += size.chars;
			continue;
		}
		yield* readGroup();
		if (!t.pageable) {
			throw new DumpError(
				`${t.name} is too large to read at once, and has no rowid to read it a page at a time.`,
			);
		}
		// As many rows as come to pageChars on average; a page of longer ones is longer.
		const limit = Math.max(1, Math.floor((pageChars * size.rows) / size.chars));
		let after: string | undefined;
		for (;;) {
			const [page = [], counted] = await reader.readTogether([pageQuery(t, after, limit), CHANGES]);
			check(counted);
			for (const row of page) {
				stats.rows++;
				after = rowidOf(row.r);
				yield line({ k: "row", t: t.name, v: String(row.v) });
			}
			if (page.length < limit) break;
		}
	}
	yield* readGroup();
	const [schemaRows = [], counted, sequences = []] = await reader.readTogether([
		SCHEMA,
		CHANGES,
		...(p.hasSequence ? [SEQUENCES] : []),
	]);
	// The indexes, triggers and views come from the plan, so a schema that changed starts over.
	if (JSON.stringify(asSchema(schemaRows)) !== read.schema) throw new Changed();
	check(counted);
	yield* tailLines(p, sequences, stats.rows);
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
function uniqueIndexes(lines: Iterable<string>): Map<string, string> {
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
	// Read twice, for the unique indexes first. An array or DumpLines starts over; other lines are
	// kept as they are read.
	const all = Array.isArray(lines) || lines instanceof DumpLines ? lines : [...lines];
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
export function summarizeDump(lines: Iterable<string>): DumpSummary {
	const summary: DumpSummary = { consistent: false, tables: [], rows: 0 };
	const byName = new Map<string, TableSummary>();
	let ended = false;
	let index = -1;
	for (const text of lines) {
		index++;
		if (text.trim() === "") continue;
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
	}
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

/**
 * A dump's lines, as `splitLines` reads them, but from the UTF-8 bytes it was stored in, chunk by
 * chunk, and decoded one line at a time. So a large dump is held once, as bytes, rather than as
 * bytes, one string and its lines. It reads from the start each time, as `restoreSql` needs.
 */
export class DumpLines implements Iterable<string> {
	readonly #chunks: readonly Uint8Array[];

	constructor(chunks: readonly Uint8Array[]) {
		this.#chunks = chunks;
	}

	*[Symbol.iterator](): Generator<string> {
		let number = 0;
		const decode = (bytes: Uint8Array) => {
			number++;
			try {
				return fromUtf8(bytes);
			} catch {
				throw new DumpError(`Line ${number} of the dump is not UTF-8.`);
			}
		};
		// The start of a line that goes on in the next chunk.
		let carried: Uint8Array[] = [];
		for (const chunk of this.#chunks) {
			let at = 0;
			for (let end = chunk.indexOf(0x0a); end >= 0; end = chunk.indexOf(0x0a, at)) {
				const part = chunk.subarray(at, end);
				yield decode(carried.length > 0 ? concat(...carried, part) : part);
				carried = [];
				at = end + 1;
			}
			if (at < chunk.length) carried.push(chunk.subarray(at));
		}
		if (carried.length > 0) yield decode(concat(...carried));
	}
}
