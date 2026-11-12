import { toBase64Url } from "@gateweave/backup-core";
import {
	alertSent,
	markAlertFailed,
	markAlertSent,
	newestRun,
	recordAlert,
	unsentAlerts,
} from "./catalog";
import { parseSources } from "./sources";
import type { SourceResult } from "./workflow";

/**
 * An alert: docs/architecture.md, "Alerts". Each one is written to the catalog under its key
 * first, so it goes out once however often a step is tried, then sent by email and to a webhook,
 * whichever are set up. Its text names sources, snapshots and steps, never data, like the
 * catalog's errors.
 */
export interface Alert {
	/** What makes it once: `run:<instance>` or `late:<day>`. */
	key: string;
	subject: string;
	text: string;
}

/** Where alerts go, from ALERT_FROM and ALERT_TO, and ALERT_WEBHOOK_URL with its secret. */
export interface Destinations {
	email?: { binding: SendEmail; from: string | EmailAddress; to: string[] };
	webhook?: { url: string; secret: Uint8Array<ArrayBuffer> };
}

/** The settings alerts read: all of them may be left out. */
export interface AlertSettings {
	ALERT_FROM?: string;
	ALERT_TO?: string;
	ALERT_WEBHOOK_URL?: string;
	ALERT_WEBHOOK_SECRET?: string;
	EMAIL?: SendEmail;
}

/** A mistake in the alert settings. Retrying doesn't fix it. */
export class AlertConfigError extends Error {
	override name = "AlertConfigError";
}

const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

/** A sender written as `Name <address>` or as a bare address. */
function parseSender(value: string): string | EmailAddress {
	const named = /^(.*?)\s*<([^<>]+)>$/.exec(value);
	const email = (named?.[2] ?? value).trim();
	if (!ADDRESS.test(email)) throw new AlertConfigError("ALERT_FROM isn't an email address.");
	const name = named?.[1]?.trim().replace(/^"(.*)"$/, "$1");
	return name ? { name, email } : email;
}

/** Where alerts go. Nowhere is allowed; a setting that is there but wrong is refused. */
export function destinationsOf(env: AlertSettings): Destinations {
	const destinations: Destinations = {};
	const from = env.ALERT_FROM?.trim() ?? "";
	const to = (env.ALERT_TO ?? "")
		.split(",")
		.map((address) => address.trim())
		.filter((address) => address !== "");
	if (from !== "" || to.length > 0) {
		if (from === "" || to.length === 0) {
			throw new AlertConfigError("Email alerts need both ALERT_FROM and ALERT_TO.");
		}
		if (!to.every((address) => ADDRESS.test(address))) {
			throw new AlertConfigError("ALERT_TO must be email addresses, separated by commas.");
		}
		if (!env.EMAIL) throw new AlertConfigError("Email alerts need the EMAIL binding.");
		destinations.email = { binding: env.EMAIL, from: parseSender(from), to };
	}
	const url = env.ALERT_WEBHOOK_URL?.trim() ?? "";
	if (url !== "") {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new AlertConfigError("ALERT_WEBHOOK_URL isn't a URL.");
		}
		if (parsed.protocol !== "https:") {
			throw new AlertConfigError("ALERT_WEBHOOK_URL must be https.");
		}
		destinations.webhook = { url: parsed.href, secret: webhookSecret(env.ALERT_WEBHOOK_SECRET) };
	}
	return destinations;
}

/** The webhook's signing secret, as Standard Webhooks writes one: base64, `whsec_` or not. */
function webhookSecret(value: string | undefined): Uint8Array<ArrayBuffer> {
	const text = (value ?? "").trim().replace(/^whsec_/, "");
	let bytes = new Uint8Array(0);
	try {
		bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
	} catch {
		// Not base64: refused below with the rest.
	}
	if (bytes.length < 24) {
		throw new AlertConfigError(
			"ALERT_WEBHOOK_SECRET must be at least 24 random bytes in base64, with or without whsec_.",
		);
	}
	return bytes;
}

/**
 * Sends an alert everywhere it is set up to go, and says where it went. A destination that fails
 * throws, naming it and Email Service's error code or the webhook's status, never an address.
 */
export async function deliver(
	alert: Alert,
	destinations: Destinations,
	at: Date,
	send: typeof fetch = fetch,
): Promise<string[]> {
	const went: string[] = [];
	if (destinations.email) {
		const { binding, from, to } = destinations.email;
		try {
			await binding.send({ from, to, subject: alert.subject, text: alert.text });
		} catch (error) {
			throw new Error(`The alert email wasn't sent: ${codeOf(error)}.`);
		}
		went.push("email");
	}
	if (destinations.webhook) {
		const request = await signedRequest(alert, destinations.webhook, at);
		const response = await send(request).catch(() => undefined);
		if (!response?.ok) {
			throw new Error(`The alert webhook answered ${response ? response.status : "nothing"}.`);
		}
		went.push("webhook");
	}
	return went;
}

/**
 * The webhook's request, signed as Standard Webhooks signs one (standardwebhooks.com): an
 * HMAC-SHA256 of `<id>.<timestamp>.<body>` under the secret, in `webhook-signature` as `v1,<base64>`.
 * The id is the same each time an alert is sent, so a receiver can drop a second copy.
 */
export async function signedRequest(
	alert: Alert,
	webhook: { url: string; secret: Uint8Array<ArrayBuffer> },
	at: Date,
): Promise<Request> {
	const timestamp = Math.floor(at.getTime() / 1000);
	const body = JSON.stringify({
		type: "backup.alert",
		timestamp: at.toISOString(),
		data: { key: alert.key, subject: alert.subject, text: alert.text },
	});
	const id = `msg_${toBase64Url(new TextEncoder().encode(alert.key))}`;
	const key = await crypto.subtle.importKey(
		"raw",
		webhook.secret,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signed = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));
	return new Request(webhook.url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"webhook-id": id,
			"webhook-timestamp": String(timestamp),
			"webhook-signature": `v1,${btoa(String.fromCharCode(...mac))}`,
		},
		body,
	});
}

/** Email Service's code for what went wrong, such as `E_RECIPIENT_SUPPRESSED`, never its message. */
function codeOf(error: unknown): string {
	const code = typeof error === "object" && error !== null && "code" in error ? error.code : "";
	return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "no error code";
}

/**
 * Sends an alert the catalog holds, unless it went already, and notes where it went. Safe to
 * repeat, except that an alert sent just before the note was written goes out twice.
 */
export async function sendAlert(
	env: Env,
	alert: Alert,
	now: () => number = Date.now,
	send: typeof fetch = fetch,
): Promise<string[]> {
	if (await alertSent(env.CATALOG, alert.key)) return [];
	const went = await deliver(alert, destinationsOf(env), new Date(now()), send);
	await markAlertSent(env.CATALOG, alert.key, went, now());
	return went;
}

/** The alert for a run that failed somewhere, or that asked for one: how every source fared. */
export function runAlert(instance: string, results: SourceResult[], asked: boolean): Alert {
	const failed = results.filter((r) => r.status === "failed").map((r) => r.source);
	const untested = results.filter((r) => r.test === "failed").map((r) => r.source);
	const problems = [
		...(failed.length > 0 ? [`the backup of ${list(failed)} failed`] : []),
		...(untested.length > 0 ? [`the restore test of ${list(untested)} failed`] : []),
	];
	const subject =
		problems.length > 0
			? `Gateweave Backup: ${problems.join(", and ")}`
			: `Gateweave Backup: every backup was made${asked ? " (a test alert)" : ""}`;
	const lines = results.map((r) => {
		if (r.status === "failed") return `- ${r.source}: the backup failed. ${r.error ?? ""}`.trim();
		const made = `- ${r.source}: snapshot ${r.snapshot ?? ""} made`;
		if (r.test === "failed") {
			return `${made}, but its restore test failed. ${r.testError ?? ""}`.trim();
		}
		return r.test === "passed" ? `${made}, and its restore test passed.` : `${made}.`;
	});
	return {
		key: `run:${instance}`,
		subject,
		text: [
			`Backup run ${instance}:`,
			"",
			...lines,
			"",
			`The catalog has more: its run and restore_test tables, under ${instance}/<source>.`,
		].join("\n"),
	};
}

const HOUR_MS = 60 * 60 * 1000;

/** A nightly backup that hasn't started for this long didn't happen. */
const LATE_MS = 26 * HOUR_MS;

/**
 * A run still going after this long has stopped somewhere without saying so. Only a source's newest
 * run counts: an older one left "running" by a run that was cut off is past, once a newer one ran.
 */
const STUCK_MS = 5 * HOUR_MS;

/**
 * The alert for backups that didn't happen: a source whose newest run started over LATE_MS ago,
 * or that has none, or whose newest run has been going for over STUCK_MS. A run that fails sends its own alert; this
 * catches the runs that never got that far. Undefined when every source is on time.
 */
export async function lateAlert(env: Env, now: number): Promise<Alert | undefined> {
	const lines: string[] = [];
	for (const { name } of parseSources(env.SOURCES)) {
		const run = await newestRun(env.CATALOG, name);
		const started = run ? new Date(run.startedAt).toISOString() : "";
		if (!run) lines.push(`- ${name}: no backup has started yet.`);
		else if (run.status === "running" && run.startedAt < now - STUCK_MS) {
			lines.push(`- ${name}: the backup that started ${started} hasn't ended.`);
		} else if (run.startedAt < now - LATE_MS) {
			lines.push(`- ${name}: no backup has started since ${started}.`);
		}
	}
	if (lines.length === 0) return undefined;
	const day = new Date(now).toISOString().slice(0, 10);
	return {
		key: `late:${day}`,
		subject: "Gateweave Backup: backups are late",
		text: [
			`On ${day}:`,
			"",
			...lines,
			"",
			"The nightly run didn't start, or stopped part way. The Workflow's instances say which.",
		].join("\n"),
	};
}

/** How long the daily check keeps trying an alert that didn't go. */
const RETRY_MS = 3 * 24 * HOUR_MS;

/**
 * The daily check, from the Worker's cron: alerts when backups are late, and sends again the
 * alerts of the last few days that didn't go, such as one a setting kept back that is now fixed.
 * Throws when one doesn't go, so the cron's run shows as failed.
 */
export async function checkBackups(env: Env, now: number, send: typeof fetch = fetch) {
	const late = await lateAlert(env, now);
	if (late) await recordAlert(env.CATALOG, late, now);
	const due = await unsentAlerts(env.CATALOG, now - RETRY_MS);
	const errors: string[] = [];
	for (const alert of due) {
		try {
			await sendAlert(env, alert, () => now, send);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await markAlertFailed(env.CATALOG, alert.key, message);
			errors.push(`${alert.key}: ${message}`);
		}
	}
	if (errors.length > 0) throw new Error(`Alerts weren't sent. ${errors.join(" ")}`);
	return { late: late !== undefined, sent: due.length };
}

function list(names: string[]): string {
	if (names.length < 2) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
