-- Alerts: what a run or the daily check found wrong, kept so that each goes out once and one that
-- didn't go is tried again. One row per alert.
CREATE TABLE alert (
	-- `run:<instance>` or `late:<day>`.
	key TEXT PRIMARY KEY,
	made_at INTEGER NOT NULL,
	subject TEXT NOT NULL,
	-- Names sources, snapshots and steps, never data, like the run's errors.
	text TEXT NOT NULL,
	-- Where it went, such as "email,webhook", or "" when nowhere is set up. NULL until it has gone.
	sent_to TEXT,
	sent_at INTEGER,
	-- Why the last try to send it failed.
	error TEXT
);

-- The daily check's look for alerts that didn't go.
CREATE INDEX alert_unsent ON alert (made_at) WHERE sent_at IS NULL;
