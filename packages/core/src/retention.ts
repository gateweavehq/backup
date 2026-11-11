/**
 * Which snapshots to keep: docs/format.md, "Retention". The newest `last` snapshots stay, and for
 * each of the newest `daily` days, `weekly` ISO weeks and `monthly` months that have a snapshot,
 * the newest snapshot in it stays. Days, weeks and months are UTC. A snapshot kept by any rule is
 * kept; nothing else is.
 */
export interface RetentionPolicy {
	last: number;
	daily: number;
	weekly: number;
	monthly: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { last: 1, daily: 7, weekly: 4, monthly: 12 };

export class RetentionError extends Error {
	override name = "RetentionError";
}

const UNITS = { l: "last", d: "daily", w: "weekly", m: "monthly" } as const;

/**
 * Reads a policy written as counts with units, such as `7d 4w 12m` or `3l 30d`: `l` for the newest
 * snapshots, `d`, `w` and `m` for days, weeks and months. Units left out keep none, except `l`,
 * which is at least 1, so the newest snapshot always stays.
 */
export function parseRetention(text: string | undefined): RetentionPolicy {
	if (text === undefined || text.trim() === "") return { ...DEFAULT_RETENTION };
	const policy: RetentionPolicy = { last: 1, daily: 0, weekly: 0, monthly: 0 };
	const seen = new Set<string>();
	for (const part of text.trim().split(/[\s,]+/)) {
		const match = /^(\d{1,4})([ldwm])$/.exec(part);
		const unit = match?.[2] as keyof typeof UNITS | undefined;
		if (!match?.[1] || !unit || seen.has(unit)) {
			throw new RetentionError(
				`"${text}" is not a retention policy. Write counts with units, like "7d 4w 12m".`,
			);
		}
		seen.add(unit);
		policy[UNITS[unit]] = Number(match[1]);
	}
	policy.last = Math.max(policy.last, 1);
	return policy;
}

const SNAPSHOT_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{8}$/;

/** When a snapshot was made, from its name. */
export function snapshotTime(name: string): Date {
	const m = SNAPSHOT_TIME.exec(name);
	if (!m) throw new RetentionError(`${name} is not a snapshot's name.`);
	const [, y, mo, d, h, mi, s] = m.map(Number);
	return new Date(Date.UTC(y as number, (mo as number) - 1, d, h, mi, s));
}

function day(at: Date): string {
	return at.toISOString().slice(0, 10);
}

function month(at: Date): string {
	return at.toISOString().slice(0, 7);
}

/** The ISO week: weeks start on Monday, and a week belongs to the year its Thursday is in. */
function week(at: Date): string {
	const thursday = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
	thursday.setUTCDate(thursday.getUTCDate() + 3 - ((thursday.getUTCDay() + 6) % 7));
	const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
	const n = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / 604_800_000);
	return `${thursday.getUTCFullYear()}-W${String(n).padStart(2, "0")}`;
}

/** Splits snapshot names into those the policy keeps and those it lets go, each newest first. */
export function retain(
	names: string[],
	policy: RetentionPolicy,
): { keep: string[]; forget: string[] } {
	const newest = [...new Set(names)].sort().reverse();
	const kept = new Set(newest.slice(0, Math.max(policy.last, 1)));
	const rules: [number, (at: Date) => string][] = [
		[policy.daily, day],
		[policy.weekly, week],
		[policy.monthly, month],
	];
	for (const [count, bucket] of rules) {
		let left = count;
		let previous: string | undefined;
		for (const name of newest) {
			if (left <= 0) break;
			const current = bucket(snapshotTime(name));
			if (current === previous) continue;
			previous = current;
			kept.add(name);
			left--;
		}
	}
	return {
		keep: newest.filter((name) => kept.has(name)),
		forget: newest.filter((name) => !kept.has(name)),
	};
}
