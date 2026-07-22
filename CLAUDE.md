# ScopeWalk — agent rules

## Session protocol (standing instruction)

- At the start of **every** session, re-read `PROJECT_CONTEXT.md` (the single
  source of truth) and this file, fully, before doing any work.
- Before ending any session in which product or technical decisions were made,
  sync those decisions back into `PROJECT_CONTEXT.md` so it stays the single
  source of truth.

## Hard rules (from PROJECT_CONTEXT.md §1.1 — no deviation without human sign-off)

1. **The tool never invents quantities, dimensions, or prices.** It captures
   observations, prompts for measurements, and flags conditions. Every number
   in a bid was entered or confirmed by the contractor.
2. **Offline-first is not optional.** Basements, new-construction sites, and
   rural jobs have no signal. Every capture function works with zero
   connectivity and syncs later. If a feature can't work offline, it doesn't
   belong in the field capture flow.
3. **Capture is fast or it doesn't happen.** Every field interaction is
   designed for one thumb, work gloves optionally on, standing in a dusty
   room. Voice and photo are first-class inputs, typing is the fallback.
4. **Completeness warnings, not completeness gates.** The tool warns loudly
   when required items are missing but never hard-blocks the contractor. They
   know things the tool doesn't. Every skipped item is logged as skipped, and
   skipped items surface as suggested exclusions/assumptions on the proposal.
5. **The customer proposal never exposes contractor internals.** Markup, cost
   basis, internal notes, and voice transcripts never render in
   customer-facing output. There is a hard schema-level separation between
   internal fields and proposal fields.
6. **The price book belongs to the contractor.** Every price they enter is
   remembered and offered back next time. That data is theirs, exportable,
   never pooled across contractors.
7. **Every query touching contractor-scoped data filters by `contractor_id`,
   no exceptions.** Turso has no database-enforced row-level security, so this
   discipline is the tenant-isolation boundary. A missing filter is a data
   leak between contractors, not a bug — treat it with that severity in code
   review.

## Current phase

**Phase 1 media-sync slice done (2026-07-11); Phase 1 nearly complete.** The
offline capture flow works end-to-end, and media now flows too: photo/audio
blobs upload from IndexedDB to R2 via server-mediated `/api/media/*`
endpoints (ownership-checked per Hard Rule 7 — no presigned URLs), a
background Groq Whisper queue writes transcripts back (editable in UI,
internal-only per Hard Rule 5), and `GET /api/bootstrap` pull-merges all
entity rows so a second device renders everything (LWW, locally-dirty rows
win). L×W measurements on dims prompts write through to
`areas.length_ft/width_ft/floor_sf`. Verified in an automated two-device
browser run (offline capture → reconnect → photo in R2, transcript in
seconds, second device renders both). App-side offline store is IndexedDB
(embedded replicas are server-side only — §3 in PROJECT_CONTEXT.md); dirty
rows push to `POST /api/sync`. Completeness engine v1 lives in
`app/src/walkthrough/` with vitest tests (`npm test`). Repo layout: `app/`
(React PWA, Vite), `server/` (Hono API, port 8787), `db/migrations/`,
`templates/` (seed JSON). Turso/Groq/R2 credentials live in root `.env`
(gitignored) — never commit them.
Room-shape sketch mode (2026-07-11): third measurement-pad mode
(`Qty | L×W | Sketch`) — tap-to-place corners, H/V snap, per-wall lengths
with confirmed closure suggestions (Hard Rule 1), floor SF/wall LF,
`areas.floor_sf` write-through; geometry in `app/src/walkthrough/sketch.ts`
(unit-tested). Verified in an automated browser run.
Photo annotation + GPS-at-start (2026-07-11): tap a photo thumb → full-screen
annotator (drag arrows/circles, vector JSON in `photos.annotation_data`,
✏️ badge); walkthrough start fills `gps_lat/lng` best-effort, never blocking.
Media-upload write-backs now patch the current row (stale-snapshot clobber
fixed in `app/src/db/media.ts`).
**Phase 1 COMPLETE** — Bryon's real-phone run done 2026-07-11, no issues.
**Phase 2 bid-sheet slice done (2026-07-11).** "Generate bid sheet" on review
→ template `bid_mapping` evaluation (when: answer/answer_in/flag), qty only
from contractor-entered numbers (unit-matching measurements, positional when
mappings share a unit; or `qty_source: floor_sf|wall_sf` reading area dims —
Hard Rule 1), GC auto-seed from captured universal answers (dedupes against
template-produced GC lines), price book keyed by normalized description+unit
(history + "Last: $X" suggestion chips, Hard Rule 6), allowance/alternate/
exclusion/labor-material-split/soft-delete per line, live totals + gross
margin, additive regeneration (touched lines never overwritten, orphans
badged). `bid_sheets`/`line_items`/`price_book_items` sync + bootstrap like
everything else (migrations 0003/0004); the bid screen (`#/bid/:id`) is the
first wide layout (`body.wide-page`). Pure engine in `app/src/bid/` (vitest).
Verified in an automated browser run (24/24 checks incl. Turso sync).
**Phase 2 proposal slice done (2026-07-11) — Phase 2 code complete.**
Proposal builder (§9): "Customer proposal" on the bid screen; seeded
exclusions (excluded lines) / assumptions (yellow-flag drafted assumptions) /
allowances summary / payment-terms-expiration from contractor defaults (new
Settings screen + `PATCH /api/me`); display modes lump/division/line-item;
AI narrative via Claude API (`POST /api/proposals/:id/narrative`,
`ANTHROPIC_API_KEY` in root .env, suggestion-only per Hard Rule 1, structured
answers only — no transcripts). Hard Rule 5 is enforced in ONE place:
`server/src/proposal/customer.ts` builds a whitelist DTO (vitest leak tests
in `customer.test.ts`) — markup/internal_note/cost_breakdown/transcripts/GPS/
signer IP never render; deleted lines nowhere; excluded lines unpriced;
customer prices are markup-distributed so nothing is derivable by
subtraction. One renderer (`render.ts`) serves public page `/p/:token`
(intake-pattern unauthenticated; view tracking; typed-name sign; lazy
expiration), contractor preview, and the Playwright/Chromium PDF (R2-stored).
Versioning: edit-after-send clones to v(n+1); any token resolves to the
latest sent version. Proposals sync offline like everything else (migration
0005, IndexedDB v3) EXCEPT viewed_at/signed_at/signature_data/pdf_r2_key
(server-authoritative, not client-writable; signed rows immutable via sync).
Verified in an automated browser run (34 checks) + Turso row inspection.
**DEPLOYED (2026-07-21): live at `https://scopewalk.cleanconstructionllc.com`**
— single Render web service serves PWA + API + `/p/:token` from one origin;
`DB_REMOTE_ONLY=true` (direct-HTTP Turso, embedded replica is local-dev only);
magic-link login emails via Resend; env values trimmed at startup
(`server/src/env.ts`). Full deployment decisions in PROJECT_CONTEXT.md §15.
**KNOWN GAP: proposal PDF 503s on Render (no Chromium there) — needs
build-time Chromium or Docker+Playwright image. Flagged to revisit.**
**CRM lead slice done (2026-07-22).** Leads are now a synced offline entity
(migration 0006 adds `leads.updated_at`; IndexedDB v4; leads in `/api/sync`
COLUMNS, applied before projects). Start-walkthrough form captures customer
name/phone/email/address → creates a `manual` lead linked via
`project.lead_id`; website-intake leads (`POST /api/intake/:contractorId`)
surface in a "New leads" card on Home after the bootstrap pull — tapping one
prefills the start form (title suggestion, type from interest, contact
fields, intake notes) and links the project. Lead status auto-advances to
`walkthrough_scheduled` on start. Recent-projects list shows the customer
name. Verified in an automated browser run (19 checks incl. offline manual
lead + Turso sync).
**Remaining for the Phase 2 milestone: one real bid sent to one real
customer.**

## Out of scope (v1 — see §12)

Scheduling/calendar, invoicing/payments, change orders, material takeoff
automation, supplier price feeds, sub bid solicitation, multi-user crews,
customer portal beyond proposal view.
