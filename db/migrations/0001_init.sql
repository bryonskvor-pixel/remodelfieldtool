-- ScopeWalk schema v1 — PROJECT_CONTEXT.md §4.2
-- SQLite/libSQL dialect. JSON columns are TEXT holding JSON.
-- Tenancy decision (§14.6, resolved 2026-07-11): ONE shared database.
-- Every contractor-scoped table carries contractor_id directly (even child
-- tables, per §2) so Hard Rule 7 filtering never depends on a join.
-- The single exception: templates.contractor_id IS NULL means "system default
-- template" (§4.2 templates are seeded from system defaults).

CREATE TABLE contractors (
  id TEXT PRIMARY KEY,
  business_name TEXT NOT NULL,
  owner_name TEXT,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  logo_url TEXT,
  license_number TEXT,
  insurance_note TEXT,
  address TEXT,
  default_markup_pct REAL NOT NULL DEFAULT 20,
  default_tax_rule TEXT,
  payment_schedule_default TEXT,        -- JSON
  terms_boilerplate TEXT,
  proposal_expiration_days INTEGER NOT NULL DEFAULT 30,
  local_code_defaults TEXT,             -- JSON (§14.5: frost depth, permit quirks; captured per contractor)
  airtable_connection TEXT,             -- JSON, nullable; mirror deferred (§4.3)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  contractor_id TEXT NOT NULL REFERENCES contractors(id),
  source TEXT NOT NULL CHECK (source IN ('website_intake','manual','referral')),
  customer_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  address_street TEXT,
  address_city TEXT,
  address_state TEXT,
  address_zip TEXT,
  project_type_interest TEXT,
  budget_range_stated TEXT,
  timeline_stated TEXT,
  intake_notes TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN
    ('new','contacted','walkthrough_scheduled','walkthrough_done','bid_sent','won','lost','dead')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_leads_contractor ON leads(contractor_id, status);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  lead_id TEXT REFERENCES leads(id),
  contractor_id TEXT NOT NULL REFERENCES contractors(id),
  project_type TEXT NOT NULL CHECK (project_type IN
    ('kitchen','bath','basement','deck_patio','addition','general')),
  title TEXT NOT NULL,
  -- Liability-grade field (§4.2): drives lead-paint (pre-1978 EPA RRP) and
  -- asbestos-era (pre-~1985) flags. Always prompted, may be unknown at creation.
  property_year_built INTEGER,
  occupied INTEGER NOT NULL DEFAULT 1,  -- bool
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_projects_contractor ON projects(contractor_id, status);

CREATE TABLE walkthroughs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  contractor_id TEXT NOT NULL REFERENCES contractors(id),
  started_at TEXT,
  completed_at TEXT,
  completeness_score REAL,              -- computed by completeness engine (§7)
  gps_lat REAL,                         -- contractor-visible only, never on proposals
  gps_lng REAL,
  weather_note TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','complete')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_walkthroughs_contractor ON walkthroughs(contractor_id);
CREATE INDEX idx_walkthroughs_project ON walkthroughs(project_id);

CREATE TABLE areas (
  id TEXT PRIMARY KEY,
  walkthrough_id TEXT NOT NULL REFERENCES walkthroughs(id),
  contractor_id TEXT NOT NULL REFERENCES contractors(id),
  name TEXT NOT NULL,
  area_type TEXT,                       -- from taxonomy
  length_ft REAL,
  width_ft REAL,
  ceiling_height_ft REAL,
  floor_sf REAL,                        -- computed from dims, contractor-overridable
  wall_sf REAL,                         -- computed from dims, contractor-overridable
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_areas_contractor ON areas(contractor_id);
CREATE INDEX idx_areas_walkthrough ON areas(walkthrough_id);

CREATE TABLE scope_items (
  id TEXT PRIMARY KEY,
  area_id TEXT NOT NULL REFERENCES areas(id),
  contractor_id TEXT NOT NULL REFERENCES contractors(id),
  checklist_key TEXT,                   -- links to template item; NULL = freeform
  category TEXT,                        -- division key (§5)
  title TEXT NOT NULL,
  existing_condition TEXT,
  planned_change TEXT,
  action TEXT CHECK (action IN
    ('remove','replace','repair','new','relocate','no_change','tbd')),
  measurements TEXT,                    -- JSON {qty, unit, dims}
  flags TEXT,                           -- JSON array e.g. ["load_bearing_suspect"]
  skipped INTEGER NOT NULL DEFAULT 0,   -- bool; skipped items seed exclusions/assumptions (Hard Rule 4)
  skip_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_scope_items_contractor ON scope_items(contractor_id);
CREATE INDEX idx_scope_items_area ON scope_items(area_id);

CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  scope_item_id TEXT REFERENCES scope_items(id),
  area_id TEXT REFERENCES areas(id),
  walkthrough_id TEXT NOT NULL REFERENCES walkthroughs(id),
  contractor_id TEXT NOT NULL REFERENCES contractors(id),
  r2_key TEXT,
  thumbnail_key TEXT,
  caption TEXT,
  annotation_data TEXT,                 -- JSON (drawn arrows/circles)
  taken_at TEXT,
  gps_lat REAL,                         -- internal only, never customer-facing (Hard Rule 5)
  gps_lng REAL,
  sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending','uploading','synced','failed'))
);
CREATE INDEX idx_photos_contractor ON photos(contractor_id);
CREATE INDEX idx_photos_walkthrough ON photos(walkthrough_id);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  parent_type TEXT NOT NULL CHECK (parent_type IN ('area','scope_item','walkthrough')),
  parent_id TEXT NOT NULL,
  contractor_id TEXT NOT NULL REFERENCES contractors(id),
  type TEXT NOT NULL CHECK (type IN ('voice','text')),
  audio_r2_key TEXT,
  transcript TEXT,                      -- editable; NEVER renders in customer output (Hard Rule 5)
  duration_sec INTEGER,
  sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending','uploading','synced','failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_notes_contractor ON notes(contractor_id);
CREATE INDEX idx_notes_parent ON notes(parent_type, parent_id);

CREATE TABLE price_book_items (
  id TEXT PRIMARY KEY,
  contractor_id TEXT NOT NULL REFERENCES contractors(id),  -- Hard Rule 6: never pooled across contractors
  category TEXT,
  description TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('ea','lf','sf','sy','hr','day','lump','allowance')),
  last_unit_price REAL,
  price_history TEXT,                   -- JSON array of {price, project_id, date}
  labor_material_split TEXT,            -- JSON, optional
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_price_book_contractor ON price_book_items(contractor_id, active);

CREATE TABLE bid_sheets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  contractor_id TEXT NOT NULL REFERENCES contractors(id),
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','priced','locked')),
  subtotal REAL,
  markup_pct REAL,                      -- internal only (Hard Rule 5)
  markup_amount REAL,
  tax_amount REAL,
  total REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_bid_sheets_contractor ON bid_sheets(contractor_id);
CREATE INDEX idx_bid_sheets_project ON bid_sheets(project_id);

CREATE TABLE line_items (
  id TEXT PRIMARY KEY,
  bid_sheet_id TEXT NOT NULL REFERENCES bid_sheets(id),
  contractor_id TEXT NOT NULL REFERENCES contractors(id),
  scope_item_id TEXT REFERENCES scope_items(id),      -- traceability to walkthrough
  price_book_item_id TEXT REFERENCES price_book_items(id),
  division TEXT NOT NULL,
  description TEXT NOT NULL,
  qty REAL,
  unit TEXT,
  unit_price REAL,
  extended REAL,                        -- computed qty * unit_price
  is_allowance INTEGER NOT NULL DEFAULT 0,
  allowance_note TEXT,
  is_optional INTEGER NOT NULL DEFAULT 0,             -- add-alternate
  is_excluded_display INTEGER NOT NULL DEFAULT 0,     -- renders in exclusions, no pricing
  internal_note TEXT,                   -- NEVER renders to customer (Hard Rule 5)
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_line_items_contractor ON line_items(contractor_id);
CREATE INDEX idx_line_items_bid_sheet ON line_items(bid_sheet_id);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  bid_sheet_id TEXT NOT NULL REFERENCES bid_sheets(id),
  contractor_id TEXT NOT NULL REFERENCES contractors(id),
  version INTEGER NOT NULL DEFAULT 1,
  display_mode TEXT NOT NULL DEFAULT 'by_division' CHECK (display_mode IN
    ('lump_sum','by_division','full_line_item')),
  scope_narrative TEXT,                 -- AI-drafted, contractor-edited (Hard Rule 1: suggestions only)
  inclusions_summary TEXT,
  exclusions TEXT,                      -- JSON array, auto-seeded from skipped/excluded items
  assumptions TEXT,                     -- JSON array, auto-seeded, editable
  allowances_summary TEXT,
  payment_schedule TEXT,                -- JSON
  expiration_date TEXT,
  terms TEXT,
  pdf_r2_key TEXT,
  public_token TEXT UNIQUE,             -- tokenized customer link
  sent_at TEXT,
  viewed_at TEXT,                       -- JSON array of timestamps
  signed_at TEXT,
  signature_data TEXT,                  -- JSON {typed_name, timestamp, ip}
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','sent','viewed','signed','expired','declined')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_proposals_contractor ON proposals(contractor_id);
CREATE INDEX idx_proposals_token ON proposals(public_token);

CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  -- NULL contractor_id = system default template; contractor copies are
  -- seeded from these and then customized (§4.2).
  contractor_id TEXT REFERENCES contractors(id),
  project_type TEXT NOT NULL CHECK (project_type IN
    ('universal','kitchen','bath','basement','deck_patio','addition','general')),
  checklist_json TEXT NOT NULL,         -- full §5–§6 taxonomy as JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_templates_scope ON templates(project_type, ifnull(contractor_id, ''));

-- Auth: email magic link (§14 Phase 0 decision) with long-lived device sessions.
CREATE TABLE magic_link_tokens (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,      -- sha256 of the token; raw token only in the emailed link
  contractor_id TEXT REFERENCES contractors(id),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  contractor_id TEXT NOT NULL REFERENCES contractors(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE INDEX idx_sessions_contractor ON sessions(contractor_id);
