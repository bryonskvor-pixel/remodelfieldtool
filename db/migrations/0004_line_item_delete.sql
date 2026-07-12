-- Line-item soft delete: hard deletes don't survive the bootstrap pull (a
-- pulled row would resurrect locally), so deletion is a synced flag.
ALTER TABLE line_items ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
