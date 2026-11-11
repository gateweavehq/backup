-- The catalog: what ran, what it made and who is writing. It describes the bucket and never
-- replaces it; every snapshot can be found again from the repositories themselves.

-- One row per source per Workflow instance.
CREATE TABLE run (
	id TEXT PRIMARY KEY,
	instance TEXT NOT NULL,
	source TEXT NOT NULL,
	started_at INTEGER NOT NULL,
	finished_at INTEGER,
	status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
	snapshot TEXT,
	table_count INTEGER,
	row_count INTEGER,
	size INTEGER,
	new_bytes INTEGER,
	-- Snapshots let go by retention, and those a locked bucket still keeps.
	forgotten INTEGER,
	held_snapshots INTEGER,
	-- Chunks no snapshot used any more: deleted, or kept by a lock until a later run.
	deleted_chunks INTEGER,
	held_chunks INTEGER,
	-- Names objects and steps, never data: the errors it comes from are written that way.
	error TEXT
);

CREATE INDEX run_by_source ON run (source, started_at);

CREATE TABLE snapshot (
	source TEXT NOT NULL,
	name TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	table_count INTEGER NOT NULL,
	row_count INTEGER NOT NULL,
	size INTEGER NOT NULL,
	-- Contentless FTS5 tables, which come back empty, as a JSON list of names.
	empty TEXT NOT NULL DEFAULT '[]',
	forgotten_at INTEGER,
	PRIMARY KEY (source, name)
);

-- Who may write to a source's repository. A prune deletes the chunks no manifest points to, so a
-- run that has just found a chunk stored must not meet a prune before its manifest is written.
CREATE TABLE lock (
	source TEXT PRIMARY KEY,
	holder TEXT NOT NULL,
	until INTEGER NOT NULL
);
