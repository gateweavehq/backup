import { readFile } from "node:fs/promises";

export class UsageError extends Error {
	override name = "UsageError";
}

export interface KeySources {
	env: Record<string, string | undefined>;
	keyFile?: string;
	/** Asks a person for the key without showing it, when stdin is a terminal. */
	ask?: () => Promise<string>;
	/** Reads the key piped into stdin, when it isn't a terminal. */
	piped?: () => Promise<string>;
}

/**
 * The master key, from a file, the environment, or a person. Never from an argument: those end
 * up in shell history and in the list of running processes.
 */
export async function readMasterKey(sources: KeySources): Promise<string> {
	if (sources.keyFile !== undefined) {
		try {
			return firstLine(await readFile(sources.keyFile, "utf8"));
		} catch {
			throw new UsageError(`The key file ${sources.keyFile} can't be read.`);
		}
	}
	const fromEnv = sources.env.GATEWEAVE_BACKUP_KEY;
	if (fromEnv) return firstLine(fromEnv);
	if (sources.ask) return firstLine(await sources.ask());
	if (sources.piped) return firstLine(await sources.piped());
	throw new UsageError("No key: set GATEWEAVE_BACKUP_KEY, or pass --key-file <file>.");
}

function firstLine(text: string): string {
	return (text.split(/\r?\n/)[0] ?? "").trim();
}

/** Reads a line from a terminal with nothing echoed, on stderr so stdout stays the output. */
export function askHidden(question: string): Promise<string> {
	const stdin = process.stdin;
	return new Promise((resolve, reject) => {
		let value = "";
		const finish = () => {
			stdin.off("data", onData);
			stdin.setRawMode(false);
			stdin.pause();
			process.stderr.write("\n");
		};
		const onData = (chunk: string) => {
			for (const ch of chunk) {
				if (ch === "\r" || ch === "\n") {
					finish();
					resolve(value);
					return;
				}
				if (ch === "\u0003" || ch === "\u0004") {
					finish();
					reject(new UsageError("Stopped."));
					return;
				}
				if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
				else value += ch;
			}
		};
		process.stderr.write(question);
		stdin.setEncoding("utf8");
		stdin.setRawMode(true);
		stdin.resume();
		stdin.on("data", onData);
	});
}

/** All of stdin, for a key piped in from a password manager. */
export async function readStdin(): Promise<string> {
	let text = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) text += chunk;
	return text;
}
