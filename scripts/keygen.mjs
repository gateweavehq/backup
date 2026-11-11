// Prints a new master key: 32 random bytes in base64url, as packages/core's generateMasterKey makes.
// It goes to stdout only, so it can be piped straight into `wrangler secret put BACKUP_KEY`.
const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
process.stdout.write(`${key}\n`);
process.stderr.write(
	"Keep this key somewhere safe, such as a password manager. Without it no backup opens, and nobody can recover it.\n",
);
