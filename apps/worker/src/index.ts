import { checkBackups } from "./alerts";

export { RestoreTest } from "./restore-test";
export { BackupWorkflow } from "./workflow";

/**
 * Backups run on the Workflow's schedule, or by hand with `wrangler workflows trigger`. The Worker
 * answers no requests: it has no page, and nothing to offer without sign-in. Its own cron is the daily
 * check that the backups happened, and that their alerts went out.
 */
export default {
	async fetch() {
		return new Response("Not found", { status: 404 });
	},
	async scheduled(controller, env) {
		await checkBackups(env, controller.scheduledTime);
	},
} satisfies ExportedHandler<Env>;
