import { parseArgs } from "node:util";
import { Repository } from "@gateweave/backup-core";
import {
	checkSnapshot,
	type DamagedSnapshot,
	listSnapshots,
	messageOf,
	pickSnapshot,
	type RestoreAs,
	restoreSnapshot,
	type SnapshotInfo,
	showSnapshot,
} from "./commands";
import { readMasterKey, UsageError } from "./key";
import { openStore } from "./stores";

export const HELP = `gateweave-backup: read and restore Gateweave Backup repositories, with nothing but the key.

Usage:
  gateweave-backup snapshots <repository>
      List the snapshots, oldest first.
  gateweave-backup show <repository> [snapshot]
      What a snapshot holds: its files and, for a database, its tables and rows.
  gateweave-backup check <repository> [snapshot] [--all]
      Read a snapshot as a restore would, and restore its database into memory to count it.
      --all checks every snapshot.
  gateweave-backup restore <repository> [snapshot] --to <folder> [--as sql|sqlite|files]
      Write a snapshot out to a folder. It writes only new files, never over anything.
      sql (the default for a database): database.sql, to load into a new D1 database with
        npx wrangler d1 execute <new database> --remote --file database.sql
      sqlite: database.sqlite, a SQLite database file.
      files: the files the snapshot holds, as they were backed up.

<repository> is a folder holding a copy of one (config.json, snapshots/, data/), or
s3://<bucket>/<folder> for one in R2 or another S3-compatible bucket, such as
s3://gateweave-backup/track.
[snapshot] is a name from \`snapshots\`, or latest (the default).

The key:
  GATEWEAVE_BACKUP_KEY, or --key-file <file>; otherwise it is asked for, or read from stdin.
  It is never an argument, since those are kept in shell history.

An s3:// repository:
  --endpoint <url> or AWS_ENDPOINT_URL: https://<account id>.r2.cloudflarestorage.com for R2.
  AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN): for R2, an API token
  that can read the bucket. This tool only reads, whatever the token allows.
  --region or AWS_REGION: auto unless the provider wants one.

Other options:
  --json   Print snapshots, show and check as JSON.
  --help   This text.
`;

export interface Io {
	out(text: string): void;
	err(text: string): void;
	env: Record<string, string | undefined>;
	/** Asks for the key without echoing it; only when stdin is a terminal. */
	ask?: () => Promise<string>;
	/** Reads the key from stdin; only when stdin isn't a terminal. */
	piped?: () => Promise<string>;
	fetch?: typeof fetch;
}

const COMMANDS = new Set(["snapshots", "show", "check", "restore"]);

/** Runs the CLI and answers its exit code: 0 done, 1 failed, 2 asked wrongly. */
export async function run(argv: string[], io: Io): Promise<number> {
	let args: ReturnType<typeof parse>;
	try {
		args = parse(argv);
	} catch (error) {
		io.err(
			`gateweave-backup: ${messageOf(error)}\nRun gateweave-backup --help for how to use it.\n`,
		);
		return 2;
	}
	const { values, positionals } = args;
	if (values.help || positionals.length === 0) {
		io.out(HELP);
		return values.help ? 0 : 2;
	}
	try {
		const [command = "", location, snapshot, ...extra] = positionals;
		if (!COMMANDS.has(command)) throw new UsageError(`There is no command ${command}.`);
		if (location === undefined) throw new UsageError(`${command} needs a repository.`);
		if (extra.length > 0 || (command === "snapshots" && snapshot !== undefined)) {
			throw new UsageError(`${command} takes no more arguments than that.`);
		}
		if (command === "check" && values.all && snapshot !== undefined) {
			throw new UsageError("check takes a snapshot or --all, not both.");
		}
		if (command === "restore" && values.to === undefined) {
			throw new UsageError("restore needs --to <folder>, a folder to write the snapshot to.");
		}
		const as = values.as;
		if (as !== undefined && as !== "sql" && as !== "sqlite" && as !== "files") {
			throw new UsageError("--as is sql, sqlite or files.");
		}
		const store = openStore(location, {
			env: io.env,
			...(values.endpoint !== undefined ? { endpoint: values.endpoint } : {}),
			...(values.region !== undefined ? { region: values.region } : {}),
			...(io.fetch ? { fetch: io.fetch } : {}),
		});
		const key = await readMasterKey({
			env: io.env,
			...(values["key-file"] !== undefined ? { keyFile: values["key-file"] } : {}),
			...(io.ask ? { ask: io.ask } : {}),
			...(io.piped ? { piped: io.piped } : {}),
		});
		const repo = await Repository.open(store, key);
		switch (command) {
			case "snapshots": {
				const list = await listSnapshots(repo);
				if (values.json) io.out(`${JSON.stringify(list, null, "\t")}\n`);
				else if (list.length === 0) io.out("No snapshots yet.\n");
				else for (const info of list) io.out(`${line(info)}\n`);
				// Listed all the same, but a snapshot that doesn't open is a failure to know of.
				return list.some((info) => "error" in info) ? 1 : 0;
			}
			case "show": {
				const shown = await showSnapshot(repo, await pickSnapshot(repo, snapshot));
				if (values.json) {
					io.out(`${JSON.stringify(shown, null, "\t")}\n`);
					return 0;
				}
				io.out(`Snapshot  ${shown.name}\n`);
				io.out(`Source    ${shown.source.kind} ${shown.source.name}\n`);
				io.out(`Made      ${shown.created}\n`);
				for (const file of shown.files) io.out(`File      ${file.path}, ${bytes(file.size)}\n`);
				const db = shown.database;
				if (db) {
					io.out(
						`Database  ${db.tables.length} tables, ${db.rows} rows, ${db.consistent ? "read at one moment" : "read in parts, not at one moment"}\n`,
					);
					const width = Math.max(...db.tables.map((table) => table.name.length));
					for (const table of db.tables) {
						const note = table.virtual ? " (virtual, rebuilt when restored)" : "";
						io.out(`  ${table.name.padEnd(width)}  ${table.rows}${note}\n`);
					}
				}
				return 0;
			}
			case "check": {
				const names = values.all ? await repo.snapshots() : [await pickSnapshot(repo, snapshot)];
				const results = [];
				for (const name of names) {
					const result = await checkSnapshot(repo, name);
					results.push(result);
					if (values.json) continue;
					if (result.ok) {
						const restored =
							result.tables !== undefined
								? `, restored ${result.tables} tables and ${result.rows} rows`
								: "";
						io.out(`ok      ${name}: read ${bytes(result.bytes)}${restored}\n`);
					} else io.out(`FAILED  ${name}: ${result.error}\n`);
				}
				if (values.json) io.out(`${JSON.stringify(results, null, "\t")}\n`);
				return results.every((result) => result.ok) ? 0 : 1;
			}
			case "restore": {
				const name = await pickSnapshot(repo, snapshot);
				const report = await restoreSnapshot(repo, name, {
					to: values.to ?? "",
					...(as !== undefined ? { as: as as RestoreAs } : {}),
				});
				for (const path of report.written) io.out(`Wrote ${path}\n`);
				if (report.database) {
					io.out(
						`Snapshot ${name}: ${report.database.tables.length} tables, ${report.database.rows} rows.\n`,
					);
				}
				if (report.as === "sql") {
					io.out(
						"Load it into a new D1 database, never the live one:\n  npx wrangler d1 create <new database>\n  npx wrangler d1 execute <new database> --remote --file database.sql\n",
					);
				}
				return 0;
			}
		}
		return 2;
	} catch (error) {
		const usage = error instanceof UsageError;
		io.err(
			`gateweave-backup: ${messageOf(error)}\n${usage ? "Run gateweave-backup --help for how to use it.\n" : ""}`,
		);
		return usage ? 2 : 1;
	}
}

function parse(argv: string[]) {
	return parseArgs({
		args: argv,
		allowPositionals: true,
		strict: true,
		options: {
			to: { type: "string" },
			as: { type: "string" },
			all: { type: "boolean" },
			json: { type: "boolean" },
			"key-file": { type: "string" },
			endpoint: { type: "string" },
			region: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
}

function line(info: SnapshotInfo | DamagedSnapshot): string {
	if ("error" in info) return `${info.name}  DAMAGED: ${info.error}`;
	const rows = typeof info.meta.rows === "number" ? `, ${info.meta.rows} rows` : "";
	return `${info.name}  ${info.created}  ${info.source.kind} ${info.source.name}  ${bytes(info.size)}${rows}`;
}

/** Sizes as people read them, in powers of 1000. */
export function bytes(n: number): string {
	if (n < 1000) return `${n} B`;
	const units = ["kB", "MB", "GB", "TB"];
	let value = n / 1000;
	let unit = 0;
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit++;
	}
	return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
