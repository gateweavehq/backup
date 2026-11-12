/**
 * How an alert reads: the same message as plain text and as HTML for email. The HTML is a card of
 * tables with inline styles, which mail clients render alike, with no images and no links to load.
 * Every value is escaped, since error messages may hold any character.
 */

export type Tone = "good" | "bad" | "late";

export interface AlertItem {
	source: string;
	/** A word or two for the badge: "Backed up", "Failed", "Late". */
	label: string;
	tone: Tone;
	/** What happened, in a sentence. */
	detail?: string;
	/** The error, as the catalog has it. */
	error?: string;
}

export interface AlertMessage {
	tone: Tone;
	/** The heading, a sentence without its full stop: "The backup of track failed". */
	heading: string;
	/** When, and of what: "Nightly run · 12 Nov 2026, 03:17 UTC". */
	meta: string;
	items: AlertItem[];
	/** Where to read more, and a command or id to go with it. */
	more: { text: string; code?: string };
}

const COLORS: Record<Tone, { accent: string; badge: string; ink: string }> = {
	good: { accent: "#17b26a", badge: "#ecfdf3", ink: "#067647" },
	bad: { accent: "#f04438", badge: "#fef3f2", ink: "#b42318" },
	late: { accent: "#f79009", badge: "#fffaeb", ink: "#b54708" },
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const FOOTER =
	"Gateweave Backup runs in your own Cloudflare account. Its alerts name sources, snapshots and steps, never your data.";

/** A moment as an alert gives it: "12 Nov 2026, 03:17 UTC". */
export function when(at: Date | number): string {
	const format = new Intl.DateTimeFormat("en-GB", {
		day: "numeric",
		month: "short",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		timeZone: "UTC",
	});
	return `${format.format(at)} UTC`;
}

export function renderText(message: AlertMessage): string {
	const width = Math.max(...message.items.map((item) => item.source.length), 0) + 3;
	const items = message.items.flatMap((item) => [
		`${item.source.padEnd(width)}${item.label}`,
		...[item.detail, item.error]
			.filter((line): line is string => Boolean(line))
			.map((line) => `${" ".repeat(width)}${line}`),
	]);
	return [
		`${message.heading}.`,
		message.meta,
		"",
		...items,
		"",
		message.more.text,
		...(message.more.code ? [`  ${message.more.code}`] : []),
		"",
		"--",
		FOOTER,
		"",
	].join("\n");
}

export function renderHtml(message: AlertMessage, subject: string): string {
	const tone = COLORS[message.tone];
	const items = message.items.map((item) => {
		const colors = COLORS[item.tone];
		const detail = item.detail
			? `<p style="margin:4px 0 0;font-size:13px;line-height:1.5;color:#525252">${esc(item.detail)}</p>`
			: "";
		const error = item.error
			? `<p style="margin:8px 0 0;padding:8px 10px;background:#fafafa;border-left:3px solid ${colors.accent};font:12px/1.5 ${MONO};color:#262626;word-break:break-word">${esc(item.error)}</p>`
			: "";
		return `<tr><td style="padding:14px 0;border-top:1px solid #f0f0f0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="font-size:15px;font-weight:600;color:#171717">${esc(item.source)}</td>
<td align="right" style="white-space:nowrap"><span style="display:inline-block;padding:2px 10px;border-radius:999px;background:${colors.badge};color:${colors.ink};font-size:12px;font-weight:600;line-height:1.6">${esc(item.label)}</span></td>
</tr></table>${detail}${error}
</td></tr>`;
	});
	const code = message.more.code
		? `<p style="margin:8px 0 0;padding:8px 10px;background:#fafafa;border-radius:4px;font:12px/1.5 ${MONO};color:#262626;overflow-wrap:anywhere;word-break:break-word">${esc(message.more.code)}</p>`
		: "";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;color:#171717;font-family:${FONT}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(`${message.heading}. ${message.meta}`)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e5e5;border-radius:8px;border-collapse:separate">
<tr><td style="height:4px;line-height:4px;font-size:0;background:${tone.accent};border-radius:8px 8px 0 0">&nbsp;</td></tr>
<tr><td style="padding:24px 28px 4px">
<p style="margin:0 0 12px;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#737373">Gateweave Backup</p>
<h1 style="margin:0 0 6px;font-size:20px;line-height:1.35;font-weight:600;color:#171717">${esc(message.heading)}</h1>
<p style="margin:0;font-size:13px;color:#525252">${esc(message.meta)}</p>
</td></tr>
<tr><td style="padding:12px 28px 4px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${items.join("\n")}
</table>
</td></tr>
<tr><td style="padding:12px 28px 24px;border-top:1px solid #f0f0f0">
<p style="margin:0;font-size:13px;line-height:1.5;color:#525252">${esc(message.more.text)}</p>${code}
</td></tr>
</table>
<p style="max-width:520px;margin:16px auto 0;font-size:12px;line-height:1.5;color:#737373;text-align:center">${esc(FOOTER)}</p>
</td></tr>
</table>
</body>
</html>
`;
}

function esc(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
