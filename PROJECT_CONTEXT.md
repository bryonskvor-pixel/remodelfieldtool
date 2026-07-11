# PROJECT_CONTEXT.md
## ScopeWalk: Contractor Field Scope & Bid Tool
### Master Specification for Claude Code Implementation

**Version:** 1.0 (Planning handoff)
**Owner:** Bryon Skvor, Clarity Companion LLC
**First user:** Solo residential contractor (single-tenant pilot, multi-tenant later)
**Status:** Specification complete, ready for phased build

---

## 1. What This Tool Is

A mobile-first field tool a contractor carries into a site walkthrough. It walks them through capturing a complete scope of work for a project type, refuses to let them miss the things that blow up bids later, and then converts the captured scope into a priced bid sheet and a customer-ready proposal.

The core insight: contractors don't lose money on the work they price. They lose money on the work they forgot to look at. This tool is a structured second brain for the walkthrough, built by someone who has done a thousand of them.

**The pipeline in one line:**

Website intake (lead) → scheduled walkthrough → guided field capture (photos, voice, measurements, conditions) → completeness check → bid sheet (contractor prices line items) → proposal (customer-facing document) → sent, signed → (Phase 3) bid-to-actual reconciliation.

### 1.1 Non-negotiable product principles (CLAUDE.md hard rules)

These go verbatim into CLAUDE.md so build sessions argue against written principles, not in-the-moment judgment:

1. **The tool never invents quantities, dimensions, or prices.** It captures observations, prompts for measurements, and flags conditions. Every number in a bid was entered or confirmed by the contractor. (This mirrors the Catalog-to-Expert hard rule.)
2. **Offline-first is not optional.** Basements, new-construction sites, and rural jobs have no signal. Every capture function works with zero connectivity and syncs later. If a feature can't work offline, it doesn't belong in the field capture flow.
3. **Capture is fast or it doesn't happen.** Every field interaction is designed for one thumb, work gloves optionally on, standing in a dusty room. Voice and photo are first-class inputs, typing is the fallback.
4. **Completeness warnings, not completeness gates.** The tool warns loudly when required items are missing but never hard-blocks the contractor. They know things the tool doesn't. Every skipped item is logged as skipped, and skipped items surface as suggested exclusions/assumptions on the proposal.
5. **The customer proposal never exposes contractor internals.** Markup, cost basis, internal notes, and voice transcripts never render in customer-facing output. There is a hard schema-level separation between internal fields and proposal fields.
6. **The price book belongs to the contractor.** Every price they enter is remembered and offered back next time. The tool gets smarter about their pricing with every bid, and that data is theirs, exportable, never pooled across contractors.
7. **Every query touching contractor-scoped data filters by `contractor_id`, no exceptions.** Turso has no database-enforced row-level security, so this discipline is the tenant-isolation boundary. A missing filter is a data leak between contractors, not a bug — treat it with that severity in code review.

---

## 2. Users & Roles

| Role | Description | Access |
|---|---|---|
| Contractor (owner) | The pilot user. Runs walkthroughs, prices bids, sends proposals. | Everything |
| Crew/estimator (future) | Can run walkthroughs, cannot see pricing or send proposals unless granted. | Capture only by default |
| Customer | Receives proposal link, views, asks questions, signs. | Proposal view only, tokenized link |
| Admin (Bryon) | Support, templates, price book seeding. | Backend |

Single-tenant for the pilot. Every table still carries `contractor_id` from day one so multi-tenant is a filter, not a re-platform.

---

## 3. Architecture Decision Block — LOCKED

**Database: Turso (libSQL / SQLite, embedded replicas).** Decided over Supabase and Neon specifically because Hard Rule 2 (offline-first is not optional) is the hardest engineering problem in this build. Turso's embedded-replica model puts a real local SQLite database on-device that the app reads/writes to directly at all times, with sync happening underneath — this *is* the offline architecture, not a sync queue bolted onto a remote-only Postgres. Bryon holds the Turso API credentials and will provide them at build time.

Trade-off accepted knowingly: Turso doesn't have Postgres-style row-level security. Multi-tenancy (this tool is being built to sell to other contractors, not just the brother) is enforced by a `contractor_id` column on every table plus disciplined application-layer query filtering, not a database-enforced guarantee. Every query against contractor-scoped data must filter by `contractor_id` — this is a CLAUDE.md hard rule (see Hard Rule 7 above), not a suggestion.

**Files:** Cloudflare R2 for photos and audio (no egress fees; photos get re-viewed constantly during pricing). Client-side image compression before upload (target ≤ 400KB per photo at capture, original optionally retained).

**Frontend:** React PWA (installable to home screen, service worker). Mobile-first, one-thumb usable, works in portrait.

**Offline store (clarified at Phase 1 build, 2026-07-11):** Turso embedded replicas are a Node-side construct — the *server* runs one; they don't run inside a browser PWA. The phone-side offline store is **IndexedDB**: entity rows shaped 1:1 like the server schema plus a `_dirty` flag, and photo/audio blobs (which needed IndexedDB regardless). Every capture writes locally first and works with zero connectivity; the service worker precaches the app shell so reloads work offline too. Auth is offline-tolerant: only an explicit 401 signs the device out; a network failure falls back to the cached contractor.

**Sync:** the app pushes whole dirty rows to `POST /api/sync` (batch upsert) on start, on the `online` event, and debounced after writes. Last-write-wins per row via `updated_at`. The endpoint is a Hard Rule 7 enforcement point: `contractor_id` always comes from the session (never the payload), upserts refuse to touch rows owned by another contractor, and parent references (project/walkthrough/area/scope item) are ownership-verified before children are applied — cross-tenant parent ids are rejected. Conflicts are rare for a solo contractor; log them, don't build a merge UI yet. Revisit if/when a crew role is added (§2).

**Pull (added with the media slice, 2026-07-11):** `GET /api/bootstrap` returns not just contractor/templates/projects but every walkthrough child row the contractor owns (areas, scope_items, photos, notes); the app merges them into IndexedDB last-write-wins, with locally-dirty rows always winning. This is how a second device renders walkthroughs it never captured and how server-written transcripts reach every device. Pilot scale pulls everything; move to per-walkthrough pulls when data outgrows it.

**Media pipeline (built 2026-07-11):** after rows push, the sync pass uploads pending photo/audio blobs from IndexedDB to the server (`POST /api/media/photo/:id`, `POST /api/media/audio/:id`), which stores them in R2 under `c/<contractor_id>/...` and writes `r2_key`/`thumbnail_key`/`audio_r2_key` + `sync_status='synced'` back to the row. **Server-mediated, not presigned** — every media request passes session auth plus an ownership check on the owning row (Hard Rule 7), which presigned URLs would scatter. Thumbnails are generated on-device (canvas, ≤320px) and uploaded alongside the photo. Failed uploads stay `pending`/`failed` locally and retry on the next sync pass; capture never waits (Hard Rule 3). Downloads (`GET /api/media/photo/:id?variant=thumb`, `GET /api/media/audio/:id`) serve from R2 with the same ownership check — the app renders local blobs when present, else falls back to the server copy. Audio upload enqueues an in-process Groq transcription job (retry ×3 with backoff; on server boot, notes with audio in R2 but no transcript are re-enqueued). The transcript only fills an empty `notes.transcript` — a contractor edit always wins — and the app polls briefly after upload so it appears live, with the bootstrap pull as the fallback path. Transcripts are editable in the UI and remain internal-only (Hard Rule 5).

**Transcription: Groq Whisper API (whisper-large-v3-turbo) — LOCKED.** Chosen over OpenAI Whisper (fallback, same request shape, one-line swap if needed) and ruled out consumer tools like Turboscribe (no programmatic API, session-capped, built for manual human upload, not for a backend service transcribing every contractor's every voice note unattended). Runs as a **queued background job on sync**, never blocking capture — contractor records, moves on immediately, transcript fills in within seconds once synced. Editable after.

**AI assist (scoped, optional per feature):** Claude API for scope-narrative drafting on the proposal and for voice-note → structured-scope-item suggestions. Always suggestions, never silent writes (Hard Rule 1).

**PDF generation:** server-side (proposal PDFs must be pixel-identical regardless of the contractor's phone).

**Signature: typed name + timestamp + IP — accepted for now.** Legally adequate for the pilot and for in-person closes (which is how the brother actually closes deals — the proposal/signature is closing-day documentation, not the negotiation itself). DocuSign-grade e-signature is a Phase 4 upgrade, not a blocker.

**Intake: currently a gap, not yet wired.** His website intake today just emails him — nothing lands in a database. Since this tool is being built to *sell*, not just run his brother's business, intake needs to become a first-class Lead-creation path (§10) before Phase 3, not an afterthought. Track this explicitly rather than let it stay "email only" by default as more contractors get added.

**Multi-tenant intent, stated plainly:** Unlike the original single-contractor framing, Bryon intends to sell this to other contractors. This changes the priority of a few things already written elsewhere in this doc: the `contractor_id` isolation discipline (above) matters from day one, not just at Phase 4; the price book (§4.2) must never leak between contractors; and Phase 4 (auth/billing/onboarding) should be treated as "when," not "if."

---

## 4. Data Model

Platform-agnostic entity model. Field names are canonical; map them 1:1 into whichever backend wins the decision block.

### 4.1 Entity relationship overview

```
Contractor 1→* Lead 1→1 Project 1→* Walkthrough 1→* Area 1→* ScopeItem
                                                     Area 1→* Photo
                                                     Area 1→* Note (voice/text)
Project 1→* BidSheet 1→* LineItem *→1 PriceBookItem (optional link)
BidSheet 1→* Proposal (versioned)
Contractor 1→* PriceBookItem
Contractor 1→* Template (project-type checklists, customizable)
```

### 4.2 Tables

**contractors**
- id, business_name, owner_name, email, phone, logo_url, license_number, insurance_note, address, default_markup_pct, default_tax_rule, payment_schedule_default (jsonb), terms_boilerplate (text), proposal_expiration_days (default 30), airtable_connection (jsonb, nullable)

**leads** (fed by website intake or created in-app)
- id, contractor_id, source (website_intake | manual | referral), customer_name, email, phone, address (street/city/state/zip), project_type_interest, budget_range_stated, timeline_stated, intake_notes, status (new | contacted | walkthrough_scheduled | walkthrough_done | bid_sent | won | lost | dead), created_at

**projects**
- id, lead_id, contractor_id, project_type (kitchen | bath | basement | deck_patio | addition | general), title, property_year_built ⚠️, occupied (bool), status, created_at
- ⚠️ year_built drives automatic lead-paint (pre-1978, EPA RRP rules) and asbestos-era (pre-~1985) flags. This is a liability-grade field, always prompted.

**walkthroughs**
- id, project_id, started_at, completed_at, completeness_score (computed), gps_lat/lng (captured at start, contractor-visible only), weather_note (optional), status (in_progress | complete)

**areas** (rooms/zones within a walkthrough; a kitchen remodel has one primary area but may add "adjacent dining," "basement below kitchen," "exterior at meter")
- id, walkthrough_id, name, area_type (from taxonomy), length_ft, width_ft, ceiling_height_ft, floor_sf (computed, overridable), wall_sf (computed, overridable), sort_order

**scope_items** (the atomic unit of captured scope)
- id, area_id, checklist_key (links to taxonomy item, nullable for freeform), category (see §5 divisions), title, existing_condition (text), planned_change (text), action (remove | replace | repair | new | relocate | no_change | tbd), measurements (jsonb: qty, unit, dims), flags (jsonb array: e.g., ["load_bearing_suspect","code_upgrade_required"]), skipped (bool), skip_reason, photos[], notes[], created_at

**photos**
- id, scope_item_id (nullable), area_id, walkthrough_id, r2_key, thumbnail_key, caption, annotation_data (jsonb, for drawn arrows/circles), taken_at, gps (internal only), sync_status

**notes**
- id, parent (area | scope_item | walkthrough), type (voice | text), audio_r2_key (nullable), transcript (text, editable), duration_sec, sync_status, created_at

**price_book_items**
- id, contractor_id, category, description, unit (ea | lf | sf | sy | hr | day | lump | allowance), last_unit_price, price_history (jsonb array of {price, project_id, date}), labor_material_split (jsonb, optional), active (bool)

**bid_sheets**
- id, project_id, version, status (draft | priced | locked), subtotal, markup_pct, markup_amount, tax_amount, total, created_at

**line_items**
- id, bid_sheet_id, scope_item_id (nullable, traceability back to the walkthrough), price_book_item_id (nullable), division, description, qty, unit, unit_price, extended (computed), is_allowance (bool), allowance_note, is_optional (bool, "add-alternate"), is_excluded_display (bool, renders in exclusions not pricing), internal_note (never renders to customer), sort_order

**proposals**
- id, bid_sheet_id, version, display_mode (lump_sum | by_division | full_line_item), scope_narrative (text, AI-drafted, contractor-edited), inclusions_summary, exclusions[] (auto-seeded from skipped/excluded items, editable), assumptions[] (auto-seeded, editable), allowances_summary, payment_schedule (jsonb), expiration_date, terms, pdf_r2_key, public_token, sent_at, viewed_at[], signed_at, signature_data, status (draft | sent | viewed | signed | expired | declined)

**templates** (per contractor, seeded from system defaults)
- id, contractor_id, project_type, checklist_json (the full taxonomy of §5–6, customizable: contractor can add/hide items)

### 4.3 Airtable mirror — deferred, not required for the pilot
Turso is now the system of record outright (§3), not part of a hybrid with Airtable as the visible dashboard. An optional one-way Airtable mirror (Leads + Projects summary only, never photos/notes/pricing) can still be offered later per-contractor as a nice-to-have integration once this is a multi-tenant product, but it's no longer load-bearing architecture. Don't build it in Phase 0–2.

---

## 5. Scope Taxonomy: Divisions

Every scope item and line item belongs to a division. Residential-friendly, roughly CSI-shaped but in field language. This is the grouping the bid sheet and proposal both use.

1. General Conditions (permits, dumpster, protection, supervision, cleanup)
2. Demolition & Disposal
3. Sitework / Excavation / Concrete
4. Structural & Framing
5. Exterior (roofing, siding, windows, exterior doors, decking)
6. Plumbing
7. Electrical
8. HVAC / Mechanical
9. Insulation & Air Sealing
10. Drywall & Plaster
11. Interior Doors & Trim / Carpentry
12. Cabinetry & Countertops
13. Tile & Stone
14. Flooring
15. Paint & Finishes
16. Fixtures & Appliances
17. Specialties (shower glass, mirrors, closet systems, railings)
18. Allowances
19. Exclusions (display division, no pricing)

---

## 6. Project Type Checklists (The Heart of the Tool)

Each project type is a template: an ordered set of capture prompts. Every prompt has:
- `key`, `division`, `prompt` (field language), `capture` (what inputs it wants: measurement, photo, choice, condition note), `required_level` (required | conditional | optional), `condition` (logic that activates conditional items), `photo_required` (bool), and `bid_mapping` (which line items it seeds).

The lists below are the seed content. Claude Code should implement these as data (JSON templates), not hardcoded UI, so contractors can customize per §4.2 templates.

### 6.0 Universal Walkthrough Block (runs first on EVERY project type)

**Property & access**
- Year built (⚠️ drives lead paint / asbestos flags automatically)
- Occupied during work? Pets? Kids? Working hours restrictions?
- Parking / material staging location / dumpster placement (photo)
- Path of travel from entry to work area: floor protection needed? tight turns for materials (photo of narrowest point)? stairs?
- HOA or historic district? (approval lead time kills schedules)
- Existing damage documentation: photo anything already damaged along the path of travel BEFORE work starts (protects against blame later)

**Systems snapshot (always, even if "not relevant," because it is)**
- Electrical panel: photo of open panel + panel label. Brand (⚠️ auto-flag Federal Pacific, Zinsco, Challenger, split-bus as replace/insurance risks), amperage, breaker slots open, visible condition, location, GFCI/AFCI presence
- Water supply: main material (copper / galvanized ⚠️ / PEX / polybutylene ⚠️), main shutoff location + does it actually work, water heater age/type/size (photo of data plate), visible pipe material at fixtures
- HVAC: system type, age (photo of data plate), does ductwork reach the work area, capacity concern flag for additions/basements
- Gas: service present? meter location, visible line material (black iron / CSST ⚠️ bonding check)
- Sewer/septic: which one (septic changes bathroom/addition math), known issues

**Environmental & safety**
- Pre-1978: lead-safe practices required (EPA RRP), flag on bid as compliance line item
- Suspect asbestos: 9x9 tile, vermiculite insulation, pipe wrap, popcorn ceiling pre-1985 (photo, flag "test before disturbing," never scope removal without testing)
- Mold/moisture staining anywhere visible (photo)
- Radon (basement projects, region-dependent)

### 6.1 Kitchen Remodel

**Layout & structure**
- Scope tier: pull-and-replace (same layout) | layout change | full gut. This one choice re-weights the whole checklist.
- Overall dims + ceiling height; sketch/photo of layout with appliance locations
- Any walls coming out? For each: photo both sides, what's above it (second floor? attic?), what's below (beam? nothing?), ⚠️ load-bearing suspect flag → "structural review required" line item + assumption on proposal
- Soffit above cabinets: keep or remove? If remove: what's inside it? (very often ductwork, plumbing vents, or electrical — photo required, flag unknown-contents)
- Window/door changes: sizes, header implications

**Cabinets & counters**
- Existing: linear feet base, linear feet wall, condition, disposal
- New: reface | stock | semi-custom | custom; LF base, LF wall, tall units, island (new island ⚠️ triggers electrical outlet code requirement + possible plumbing/vent if sink)
- Countertop: material, total SF (measure runs), edge profile, sink cutout count, cooktop cutout, backsplash height decision (4" vs full-height tile — moves cost between divisions)

**Plumbing (conditional intensity based on scope tier)**
- Sink staying in place? If moving: distance, drain/vent path (what's below the floor — photo of basement/crawl ceiling under kitchen)
- Disposal, dishwasher location change, ice maker line, pot filler?
- Gas range vs electric: switching? (gas line run OR 240V circuit run — both are commonly missed line items)

**Electrical (this section is a required interview, not optional, per your requirement)**
- Panel capacity vs. new load: modern kitchen needs dedicated circuits for fridge, DW, disposal, microwave, 2× small-appliance 20A, range 240V if electric, hood. Count open slots vs. needed circuits → auto-flag "subpanel or panel upgrade" if short
- Hood: recirculating or vented? If vented: exterior wall path or roof? (photo of exterior wall at hood location)
- Lighting plan: recessed count, pendants over island, under-cabinet, switching/dimmers
- Outlet code compliance: GFCI at counters, island/peninsula outlet rules

**Finishes**
- Flooring: material, SF, what's under existing (height transition to adjacent rooms ⚠️ — flooring height mismatches are a classic missed item), subfloor condition (soft spots near sink/DW — photo)
- Drywall condition after demo assumptions, paint scope (walls/ceiling/trim)
- Appliances: who supplies (contractor vs owner ⚠️ — allowance or exclusion), install-only list, panel-ready?

### 6.2 Bathroom Remodel

- Scope tier: refresh | pull-and-replace | gut | layout change
- Dims, ceiling height, door swing
- Tub/shower: existing vs planned (tub-to-shower conversion is its own path: curb vs curbless ⚠️ curbless needs floor recess/joist review), wet-area wall SF for tile, niche/bench/grab-bar blocking (blocking is cheap now, impossible later — always ask)
- Waterproofing system (must be a named line item, not assumed inside "tile")
- Tile: floor SF, wall SF, size/pattern (large format & herringbone = labor multiplier flag), heated floor? (→ dedicated circuit + thermostat)
- Vanity: size, single/double (double ⚠️ = second drain/supply rough-in), top material, mirrors/medicine cabinet (recessed = wall opening)
- Toilet: staying put? relocating ⚠️ (flange move = subfloor + joist question, photo below if accessible), flange condition
- Exhaust fan: exists? vents to exterior or attic ⚠️ (attic-dumping fans are a code fix line item), CFM upgrade
- Plumbing access: what's below/behind (photo), shutoffs work?
- Electrical: GFCI, dedicated circuits (heated floor, whirlpool/steam if any), lighting, panel capacity check
- Window in wet zone? (privacy glass / waterproof trim detail)
- Subfloor condition around toilet/tub (probe, photo)
- Glass: shower door type → allowance (measured after tile, always an allowance)

### 6.3 Basement Finishing

- Moisture FIRST: any history of water (ask homeowner, log answer verbatim), efflorescence/staining on walls (photo every wall), sump pump present/working, perimeter drain, dehumidifier. ⚠️ Rule: visible moisture = "moisture remediation by others or separate scope" assumption before any finishing scope
- Ceiling height: measure at lowest obstruction (duct/beam) ⚠️ code minimums for habitable space; soffit/wrap plan for ducts and beams
- Egress: any bedroom planned ⚠️ = egress window/well required → excavation, cutting foundation, well, ladder. This is a make-or-break line item
- Layout: rooms planned, measure full footprint, note columns/posts
- Stairs: code compliance of existing (rise/run, headroom ⚠️, railing), lighting at stairs
- Framing: wood vs steel, insulation approach per code (rim joist too), vapor strategy
- Ceiling type: drywall vs drop ⚠️ ask what access is needed later (shutoffs, junctions, cleanouts) → access panels line item
- HVAC: extend supply/return, does existing system have capacity, separate zone?
- Electrical: subpanel likely (count circuits: lighting, outlets per code spacing, bathroom, media), panel capacity check
- Bathroom: existing rough-in ⚠️ (photo, verify locations) or new (breaking slab → plumbing under slab line items, ejector pit if below sewer line ⚠️)
- Windows: existing condition, add/enlarge
- Radon system present? (region flag)
- Utilities in the way: relocate laundry? water heater/furnace clearances maintained?

### 6.4 Deck / Patio

**Deck**
- New vs replace vs repair; if replace: what's salvageable (footings? never assume — flag)
- Attached vs freestanding ⚠️ attached = ledger inspection (photo behind if possible), flashing detail, what siding must be cut
- Dimensions, height off grade ⚠️ (height drives railing requirement 36"+, and guard/stair details), levels?
- Footings: count, frost depth per local code, soil/slope conditions, ⚠️ utility locate call before dig (line item: "utilities marked by 811")
- Framing material, decking material (PT / cedar / composite brand-line → allowance if undecided), fastener type (hidden vs face)
- Railing: material, LF, code height, stairs (count risers, landing, grippable rail)
- Electrical ⚠️ code requires an outlet on decks — commonly missed; lighting?
- Gas line stub for grill? Roof/pergola over? (→ footing + structural + possibly permit change)
- Permit & setbacks: property line distances, HOA approval

**Patio**
- Material: pavers | stamped concrete | broom concrete | natural stone
- SF, existing surface removal, grade/slope ⚠️ (drainage away from house, step-downs), base prep depth per soil
- Edge restraint, drainage additions (french drain?), steps, seat walls, fire feature (gas line?), lighting (low-voltage run)

### 6.5 Addition

- Purpose/rooms, footprint dims, one or two story, over crawl/slab/full basement
- ⚠️ Zoning gate FIRST: setbacks, lot coverage, height. Survey on file? If not → "survey by others" assumption/line item
- Drawings: architect/engineer required? (almost always) → who carries that cost, lead time
- Foundation type, soil unknowns → allowance language
- Tie-in: roofline match (photo of existing roof at tie-in), siding match ⚠️ (discontinued siding = whole-wall reside conversations), floor level match
- Structural: opening into existing house (bearing wall, beam, engineer)
- HVAC ⚠️ load calc: can existing system carry the addition? (mini-split vs extend — this is a real fork, capture data plate + house SF)
- Electrical: panel capacity ⚠️ (addition circuits + possible service upgrade), meter location
- Plumbing if bath/kitchen in addition: DWV tie-in path, vent path, water heater capacity, ⚠️ septic capacity check if on septic (bedroom count changes septic sizing legally)
- Windows/doors/exterior finish selections
- Site: tree removal, access for excavation equipment (photo of access path, measure gate/fence openings), spoils removal, erosion control if required

### 6.6 General Remodeling
Modular: contractor adds Areas, and each area gets the relevant sub-blocks from above (a "kitchenette" pulls the kitchen block, a "hall bath" pulls the bath block, plus generic room block: flooring, drywall, paint, trim, doors, electrical devices, lighting). The universal block always runs.

---

## 7. The Completeness Engine

After capture, the tool scores the walkthrough:

- **Required items** unanswered → red flags, listed by name ("No photo of electrical panel," "Load-bearing status of removed wall not resolved")
- **Conditional items** whose trigger fired but weren't answered → red ("You selected vented hood; no exterior wall photo")
- **Skipped items** → yellow, each with its skip_reason, and each auto-drafts an exclusion or assumption ("Condition of footings not verified; bid assumes reuse of existing footings" — contractor approves or deletes)
- Score displayed as X of Y before "Generate Bid Sheet." Warn, never block (Hard Rule 4).

This engine is what makes the tool worth $100/month. Treat it as a first-class module with its own tests.

---

## 8. Bid Sheet Generation

1. Every non-skipped scope item with an action ≠ no_change seeds one or more line items via its `bid_mapping` (e.g., "vented hood, exterior wall" → line items in Electrical [circuit], HVAC/Mech [duct run + exterior cap], Fixtures [hood install]).
2. Line items group by division, ordered per §5.
3. For each line the contractor sees: description (editable), qty (pre-filled from measurements where captured), unit, unit price. **Unit price auto-suggests from the price book** (their last price for that item, with "last used $X on [project], [date]" shown). Accept, edit, or enter fresh; every entry updates the price book.
4. Quick-entry modes: lump sum per line, or labor + material split (optional toggle, some contractors think one way, some the other).
5. Allowances: one tap converts a line to an allowance (glass doors, appliances, tile material, decking material when undecided) with an allowance amount and note.
6. Add-alternates: optional line items priced but presented as options ("Add under-cabinet lighting: +$X").
7. General Conditions auto-seeds: permit (flagged per project type), dumpster (size suggested by project type), floor/dust protection (from occupied flag), lead-safe practices (from year built), portable toilet (additions/long jobs), final clean.
8. Summary math: subtotal → markup % (default from contractor profile, editable per bid, ⚠️ shown as internal only) → tax per contractor's rule → total. Margin displayed to contractor at all times ("this bid carries 22% gross margin").

---

## 9. Proposal Output (Customer-Facing)

- **Display modes:** lump sum | subtotals by division | full line items. Contractor picks per proposal. Default: subtotals by division (enough transparency to build trust, not enough to invite line-item shopping).
- **Scope narrative:** AI-drafted per area from the captured scope items, in plain homeowner language, contractor edits before send. Photos optionally embedded (before-state photos build trust and document conditions).
- **Always-rendered sections:** Scope of Work (by area), Investment (per display mode), Allowances (with plain-language explanation of what an allowance is), Exclusions, Assumptions, Payment Schedule, Timeline estimate (manual entry, ranges encouraged), Terms, Expiration date, Acceptance/signature block.
- **Delivery:** tokenized public link (mobile-perfect) + PDF attachment. View tracking (viewed_at). Simple e-signature (typed name + timestamp + IP is legally adequate for the pilot; DocuSign-grade later).
- **Versioning:** any edit after send creates v2; customer link always shows latest, prior versions retained internally.
- Branding from contractor profile: logo, license number, insurance statement.

---

## 10. Website Intake Integration

- Intake form (on contractor's site, or hosted by us and embedded) collects: name, contact, address, project type (same taxonomy), description, budget range (optional, ranges not numbers), timeline, photo upload (optional), how-did-you-hear.
- Creates a Lead, notifies contractor (SMS or email), and pre-populates the Project so the walkthrough starts warm: the contractor arrives already knowing it's a "kitchen, layout change, ~$60–80k range, wants an island."
- If Remi-style AI intake gets bolted on later, it writes to the same Lead schema. Design the Lead table to be intake-source agnostic.
- Optional Airtable mirror per §4.3 is deferred; not part of the intake build in Phase 0–2.

---

## 11. Field UX Specification

- **Home:** today's walkthroughs (from leads with scheduled status) + "Start Walkthrough" + recent projects.
- **Walkthrough flow:** Universal block → project-type blocks → per-area loops. Progress bar = completeness score live.
- **Every prompt screen:** big prompt text, capture buttons in fixed order [📷 Photo] [🎤 Voice] [⌨️ Note] [📏 Measurement], Skip (requires one-tap reason: Not applicable | Will verify later | Customer undecided), Next. Target: ≤ 3 taps for the common path.
- **Photo capture:** in-app camera, auto-attach to current item, optional quick annotation (arrow/circle), burst-friendly. Compression on device before queue.
- **Voice notes:** press-and-hold or tap-to-toggle, max 3 min per note, waveform feedback, transcribes on sync. Transcripts searchable.
- **Measurements:** numeric pad with unit presets per item; L×W screens compute SF live; running tallies visible (e.g., cumulative tile SF). **Room-shape sketch (added and built 2026-07-11):** third pad mode (`Qty | L×W | Sketch`) for non-rectangular rooms — tap-to-place corners (not freehand; gloves), walls snap to horizontal/vertical, tap the first corner to close, then each wall highlights in turn and its length is entered on the numeric pad (auto-derivable closing segments are suggested for confirmation, never silently written — Hard Rule 1). A shape that doesn't close shows the misclose in feet and blocks save until a wall is fixed (tap any wall to re-enter it). Computes floor SF (shoelace) + wall LF; on a `*dims*` prompt writes `areas.floor_sf` (and `wall_sf` once ceiling height is known), overridable. Polygon stores as `points` in the measurement JSON (`app/src/walkthrough/sketch.ts` is the pure geometry module with unit tests); a small floor-plan thumbnail renders on prompt + review screens. L×W stays the default fast path.
- **Review screen:** everything captured, grouped by area, flags on top, then "Generate Bid Sheet."
- **Bid pricing UX** is a desktop-friendly view too (contractor prices at the kitchen table at night, on a laptop or tablet). Responsive both ways.
- Dark mode default in field (basements), large touch targets, works in landscape for tablet users.

---

## 12. Things Deliberately Out of Scope (v1)

Scheduling/calendar, invoicing/payments, change orders during construction (Phase 3+), material takeoff automation, supplier price feeds, subcontractor bid solicitation, multi-user crews, customer portal beyond proposal view. Write these down so scope creep argues against a document.

---

## 13. Build Phases for Claude Code

**Phase 0 — Foundations (1 session)**
Repo, PWA scaffold, chosen backend provisioned, auth, schema migration for §4.2, CLAUDE.md with Hard Rules, seed templates JSON for all six project types from §6.

**Phase 1 — Capture (the field tool)**
Universal block + kitchen + bath templates end-to-end, areas, photos (R2 + compression), voice (record/queue/transcribe), measurements, offline store + sync queue, completeness engine v1. **Milestone: brother runs a real kitchen walkthrough on his phone with airplane mode on, and nothing is lost.**

*Status 2026-07-11: capture slice built and verified.* Walkthrough flow (universal → project-type blocks → per-area loops with add-area), prompt screens with [Photo] [Voice] [Note] [Measurement] + one-tap skip reasons, numeric pad with L×W→SF, IndexedDB offline store + `/api/sync` push, completeness engine v1 (18 unit tests) with live progress bar and review screen. Milestone verified in an automated browser run: full kitchen capture with network off survived a reload and synced cleanly on reconnect.

*Status 2026-07-11 (later session): media sync slice built and verified.* R2 photo/audio upload with on-device thumbnails, Groq Whisper transcription queue, bootstrap pull-merge for multi-device, editable transcripts on prompt/review screens, and capture-driven `areas.length_ft/width_ft/floor_sf` from L×W dims prompts (see §3 media pipeline + pull). Milestone verified in an automated two-device browser run: offline kitchen capture with photo + voice note; on reconnect the photo landed in R2, the note transcribed in seconds, and a second browser profile on the same account rendered both (photo streamed from R2, transcript visible and editable, area dims pulled). **Remaining for Phase 1:** Bryon's real-phone run (the true milestone).

*Status 2026-07-11 (later session): room-shape sketch mode built and verified.* Third measurement-pad mode per §11 — corner tracing with H/V snap, per-wall length entry with confirmed (never silent) closure suggestions, misclose detection, floor SF/wall LF, `areas.floor_sf` write-through on dims prompts, and floor-plan thumbnails on prompt/review screens. Geometry lives in `app/src/walkthrough/sketch.ts` (18 unit tests). Verified in an automated browser run: L-shaped kitchen traced and dimensioned (suggestions 7 ft/12 ft confirmed, 124 SF/48 LF), misclose flagged and fixed by re-entering a wall, L×W path regression-checked.

*Status 2026-07-11 (same session): photo annotation + GPS-at-start built and verified.* Tapping any photo thumbnail (prompt or review screen) opens a full-screen annotator: drag-to-draw arrows and circles (vector shapes only — original photo bytes untouched), Undo, Cancel-leaves-row-alone, Done writes `photos.annotation_data` as normalized JSON (units = % of image width on both axes so shapes land identically on any device/aspect). Annotated thumbs show a ✏️ badge; shapes sync as a normal row write. GPS-at-start: walkthrough creation fires a best-effort, strictly non-blocking `getCurrentPosition` that fills `walkthroughs.gps_lat/lng` (contractor-visible only, needs a secure context like the camera). Also fixed a media-upload race: upload write-backs now patch the CURRENT row instead of a pre-upload snapshot, so annotating/captioning a photo (or editing a transcript) while its bytes upload can no longer be clobbered or lose its dirty flag. Verified in an automated browser run (fake geolocation + real photo upload → shapes on server, badge rendered, cancel/undo/bare-tap probes held).

**Phase 2 — Bid & Proposal**
Bid sheet generation from scope items, price book with auto-suggest, allowances/alternates/GC auto-seed, margin display, proposal builder (narrative AI-draft + edit), tokenized link + PDF + signature + view tracking. **Milestone: one real bid sent to one real customer.**

**Phase 3 — Loop closure**
Remaining four project types refined from field feedback, real website intake form + lead flow (replacing the current email-only intake), optional Airtable mirror if a contractor wants it, bid-to-actual reconciliation (log actual costs per line, show variance, feed price book intelligence: "you've underpriced tile labor on 4 of your last 5 jobs by an average of 18%").

**Phase 4 — Productization (only after §Agreed-Next-Steps milestone: works great for one contractor)**
Multi-tenant auth/RLS, onboarding, template marketplace defaults, billing at $100/month.

---

## 14. Open Questions — status update

Resolved:
1. ~~Backend~~ → **Turso**, locked (§3).
2. ~~Transcription~~ → **Groq Whisper**, locked (§3).
3. ~~Signature~~ → **typed name + timestamp + IP**, accepted for now (§3).

Resolved at Phase 0 kickoff (2026-07-11):
4. ~~Intake form hosting~~ → **His existing website platform** hosts the form; it POSTs to a ScopeWalk API endpoint (`POST /api/intake/:contractorId`, live since Phase 0). The Lead schema stays intake-source agnostic; a ScopeWalk-hosted page can be added when selling to other contractors.
5. Local code specifics (Ohio frost depth 32"–36", county permit quirks) → stored in `contractors.local_code_defaults` (JSON column, in schema since Phase 0). **Values still to be captured from Bradford** — not blocking, capture during Phase 1 field use.
6. ~~Tenancy~~ → **One shared Turso database with `contractor_id` filtering everywhere** (Hard Rule 7). Every table (including child tables like areas/scope_items/photos) carries `contractor_id` directly so no query needs a join to enforce isolation. The one exception: `templates.contractor_id IS NULL` means "system default template."

Also decided at Phase 0 kickoff:
7. **Auth: email magic link** with long-lived (90-day) device sessions — passwordless, offline-friendly once signed in, extends cleanly to multi-tenant. Pilot email delivery is `EMAIL_PROVIDER=console` (link prints to server log); a real provider slots in before Phase 3.
