import { unlinkSync } from "node:fs";
import { run } from "./cli";
import { unfinished } from "./commands";
import { askHidden, readStdin } from "./key";

// Node 22 calls `node:sqlite` experimental and says so whenever it loads. Restores use it on
// purpose, so that one warning is left out of what the CLI prints; others still show.
const printers = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
	if (warning.name === "ExperimentalWarning" && /sqlite/i.test(warning.message)) return;
	for (const print of printers) print(warning);
});

// Stopped half way, a restore removes the files it was writing, so none looks finished.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		for (const path of unfinished) {
			try {
				unlinkSync(path);
			} catch {
				// Gone already, or never made.
			}
		}
		process.exit(signal === "SIGINT" ? 130 : 143);
	});
}

const interactive = process.stdin.isTTY === true;

process.exitCode = await run(process.argv.slice(2), {
	out: (text) => process.stdout.write(text),
	err: (text) => process.stderr.write(text),
	env: process.env,
	...(interactive
		? { ask: () => askHidden("Master key (it isn't shown): ") }
		: { piped: readStdin }),
});
