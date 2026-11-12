-- Restore tests: a new snapshot restored into SQLite and counted against its dump, which proves it
-- can be restored. One row per run that tested its snapshot.
CREATE TABLE restore_test (
	run TEXT PRIMARY KEY,
	source TEXT NOT NULL,
	snapshot TEXT NOT NULL,
	tested_at INTEGER NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
	table_count INTEGER NOT NULL,
	row_count INTEGER NOT NULL,
	-- The bytes read back and checked.
	size INTEGER NOT NULL,
	-- Names objects and statements, never data, like the run's.
	error TEXT
);

-- When each source last passed, which decides when its next test is due.
CREATE INDEX restore_test_by_source ON restore_test (source, status, tested_at);
