// Bundles the CLI and the format's code into one file, so a restore needs only Node and that file:
// docs/architecture.md, principle 1.
import { build } from "esbuild";

await build({
	entryPoints: ["src/main.ts"],
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	outfile: "dist/gateweave-backup.mjs",
	banner: { js: "#!/usr/bin/env node" },
	legalComments: "none",
	logLevel: "warning",
});
