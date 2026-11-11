import { describe, expect, it } from "vitest";
import {
	DEFAULT_RETENTION,
	parseRetention,
	RetentionError,
	retain,
	snapshotTime,
} from "../src/retention";

/** A snapshot name at `iso`, with a fixed random part so names sort by time alone. */
function at(iso: string, tail = "00000000"): string {
	return `${iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "")}-${tail}`;
}

/** One snapshot a day at 03:17 UTC, from `first` for `days` days. */
function nightly(first: string, days: number): string[] {
	const start = Date.parse(`${first}T03:17:00Z`);
	return Array.from({ length: days }, (_, i) => at(new Date(start + i * 86_400_000).toISOString()));
}

describe("a retention policy", () => {
	it("reads counts with units", () => {
		expect(parseRetention("7d 4w 12m")).toEqual({ last: 1, daily: 7, weekly: 4, monthly: 12 });
		expect(parseRetention("3l,30d")).toEqual({ last: 3, daily: 30, weekly: 0, monthly: 0 });
		expect(parseRetention(undefined)).toEqual(DEFAULT_RETENTION);
		expect(parseRetention("  ")).toEqual(DEFAULT_RETENTION);
	});

	it("always keeps the newest snapshot", () => {
		expect(parseRetention("0l 7d").last).toBe(1);
		expect(retain(nightly("2026-11-01", 3), { last: 0, daily: 0, weekly: 0, monthly: 0 })).toEqual({
			keep: [at("2026-11-03T03:17:00Z")],
			forget: [at("2026-11-02T03:17:00Z"), at("2026-11-01T03:17:00Z")],
		});
	});

	it("refuses what it can't read", () => {
		for (const bad of ["7", "7x", "7d 3d", "d7", "-1d", "7days"]) {
			expect(() => parseRetention(bad), bad).toThrow(RetentionError);
		}
	});
});

describe("retention", () => {
	it("keeps the newest snapshot of each of the last days", () => {
		const names = [
			at("2026-11-10T03:00:00Z"),
			at("2026-11-10T15:00:00Z"),
			at("2026-11-11T03:00:00Z"),
			at("2026-11-11T09:00:00Z"),
			at("2026-11-11T21:00:00Z"),
		];
		const { keep, forget } = retain(names, { last: 1, daily: 2, weekly: 0, monthly: 0 });
		expect(keep).toEqual([at("2026-11-11T21:00:00Z"), at("2026-11-10T15:00:00Z")]);
		expect(forget).toEqual([
			at("2026-11-11T09:00:00Z"),
			at("2026-11-11T03:00:00Z"),
			at("2026-11-10T03:00:00Z"),
		]);
	});

	it("keeps a year of nightly backups to 7 days, 4 weeks and 12 months", () => {
		const names = nightly("2025-11-12", 365);
		const { keep, forget } = retain(names, DEFAULT_RETENTION);
		expect(keep.length + forget.length).toBe(365);
		// 7 days (5–11 Nov); the newest of 4 ISO weeks (11 Nov and Sunday 8 Nov, kept already, then
		// Sundays 1 Nov and 25 Oct); and the newest of 12 months (11 Nov, kept already, then each
		// month's last day back to December 2025).
		expect(keep.map((name) => snapshotTime(name).toISOString().slice(0, 10))).toEqual([
			"2026-11-11",
			"2026-11-10",
			"2026-11-09",
			"2026-11-08",
			"2026-11-07",
			"2026-11-06",
			"2026-11-05",
			"2026-11-01",
			"2026-10-31",
			"2026-10-25",
			"2026-09-30",
			"2026-08-31",
			"2026-07-31",
			"2026-06-30",
			"2026-05-31",
			"2026-04-30",
			"2026-03-31",
			"2026-02-28",
			"2026-01-31",
			"2025-12-31",
		]);
	});

	it("counts ISO weeks across a new year", () => {
		// 2026-01-01 is a Thursday, so 2025-12-29 (Monday) starts week 1 of 2026.
		const names = [
			at("2025-12-28T12:00:00Z"),
			at("2025-12-29T12:00:00Z"),
			at("2026-01-02T12:00:00Z"),
		];
		expect(retain(names, { last: 1, daily: 0, weekly: 2, monthly: 0 }).keep).toEqual([
			at("2026-01-02T12:00:00Z"),
			at("2025-12-28T12:00:00Z"),
		]);
	});

	it("keeps everything the policy reaches when there is little", () => {
		const names = nightly("2026-11-09", 3);
		expect(retain(names, DEFAULT_RETENTION)).toEqual({ keep: [...names].reverse(), forget: [] });
		expect(retain([], DEFAULT_RETENTION)).toEqual({ keep: [], forget: [] });
	});
});
