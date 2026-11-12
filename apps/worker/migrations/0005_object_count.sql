-- How many objects a snapshot holds: an app's Durable Objects, or an R2 bucket's objects. Empty
-- for a D1 database, and for what was recorded before.
ALTER TABLE run ADD COLUMN object_count INTEGER;
ALTER TABLE snapshot ADD COLUMN object_count INTEGER;
ALTER TABLE restore_test ADD COLUMN object_count INTEGER;
