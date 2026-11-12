export { RestoreTest } from "./restore-test";
export { BackupWorkflow } from "./workflow";

/**
 * Backups run on the Workflow's schedule, or by hand with `wrangler workflows trigger`. The Worker
 * answers no requests until it has a page with sign-in in front of it.
 */
export default {
	async fetch() {
		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
