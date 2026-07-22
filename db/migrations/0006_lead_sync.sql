-- Leads become a synced offline entity (CRM slice): the app creates manual
-- leads at project start and edits status, so rows need last-write-wins
-- resolution like every other synced table.
ALTER TABLE leads ADD COLUMN updated_at TEXT;
UPDATE leads SET updated_at = created_at WHERE updated_at IS NULL;
