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

**Phase 1 capture slice done (2026-07-11); Phase 1 continues.** The offline
walkthrough capture flow works end-to-end (verified in-browser with network
off: capture → reload → nothing lost → syncs on reconnect). App-side offline
store is IndexedDB (embedded replicas are server-side only — see §3
clarification in PROJECT_CONTEXT.md); dirty rows push to `POST /api/sync`,
which enforces Hard Rule 7 (contractor_id from session, ownership-guarded
upserts). Completeness engine v1 lives in `app/src/walkthrough/` with vitest
tests (`npm test`). Repo layout: `app/` (React PWA, Vite), `server/` (Hono
API, port 8787), `db/migrations/`, `templates/` (seed JSON). Turso
credentials live in root `.env` (gitignored) — never commit them.
Next: R2 photo/audio upload + Groq transcription queue, then Phase 2.

## Out of scope (v1 — see §12)

Scheduling/calendar, invoicing/payments, change orders, material takeoff
automation, supplier price feeds, sub bid solicitation, multi-user crews,
customer portal beyond proposal view.
