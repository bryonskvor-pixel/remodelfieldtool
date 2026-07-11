-- Phase 1 capture support.
-- scope_items.answer: the contractor's choice answer(s) for checklist items
--   (JSON: string or array when the item is multi-select). Distinct from
--   measurements/notes/photos, which have their own columns/tables.
-- updated_at on every synced table: the app's offline store pushes whole rows
--   and sync is last-write-wins per row (§3), so each row carries the client
--   timestamp of its last edit.

ALTER TABLE scope_items ADD COLUMN answer TEXT;

ALTER TABLE projects ADD COLUMN updated_at TEXT;
ALTER TABLE walkthroughs ADD COLUMN updated_at TEXT;
ALTER TABLE areas ADD COLUMN updated_at TEXT;
ALTER TABLE scope_items ADD COLUMN updated_at TEXT;
ALTER TABLE photos ADD COLUMN updated_at TEXT;
ALTER TABLE notes ADD COLUMN updated_at TEXT;
