// The settings a deployment may leave out, which `wrangler types` can't see: secrets it doesn't
// require, and the EMAIL binding, which only a deployment that sends email alerts has.
interface AlertEnv {
	/** Where email alerts go: one address or several, separated by commas. A secret. */
	ALERT_TO?: string;
	/** An https address that alerts are posted to, signed as Standard Webhooks signs them. */
	ALERT_WEBHOOK_URL?: string;
	/** The webhook's signing secret: at least 24 random bytes in base64, `whsec_` or not. */
	ALERT_WEBHOOK_SECRET?: string;
	/** Email Service's binding, for email alerts. */
	EMAIL?: SendEmail;
}

interface Env extends AlertEnv {}

declare namespace Cloudflare {
	interface Env extends AlertEnv {}
}
