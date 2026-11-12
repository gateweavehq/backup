-- Copies outside Cloudflare (COPY_TO): what each run sent there, and what the copy's own retention
-- let go. One row per run that copied.
CREATE TABLE copy (
	run TEXT PRIMARY KEY,
	source TEXT NOT NULL,
	copied_at INTEGER NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
	-- The objects and bytes sent; what was there already isn't counted.
	object_count INTEGER NOT NULL,
	size INTEGER NOT NULL,
	-- The snapshots the copy holds afterwards, and what its retention let go or a lock kept.
	snapshot_count INTEGER,
	forgotten INTEGER,
	held_snapshots INTEGER,
	deleted_chunks INTEGER,
	held_chunks INTEGER,
	-- Names objects and steps, never data, like the run's.
	error TEXT
);

-- When each source was last copied.
CREATE INDEX copy_by_source ON copy (source, copied_at);
