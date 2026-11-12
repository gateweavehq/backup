import { run } from "./cli";
import { askHidden, readStdin } from "./key";

const interactive = process.stdin.isTTY === true;

process.exitCode = await run(process.argv.slice(2), {
	out: (text) => process.stdout.write(text),
	err: (text) => process.stderr.write(text),
	env: process.env,
	...(interactive
		? { ask: () => askHidden("Master key (it isn't shown): ") }
		: { piped: readStdin }),
});
