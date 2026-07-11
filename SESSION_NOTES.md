# Session Notes — ScopeWalk (remodelfieldtool)

## 2026-07-11 (session 2) — Phase 0 complete

**Accomplished**
- Resolved §14.4–14.6 with Bryon: shared Turso DB + `contractor_id`
  everywhere; intake form stays on the contractor's site POSTing to our API;
  local code defaults stored in `contractors.local_code_defaults` (values
  still to be captured from Bradford). Also chose auth: email magic link,
  90-day sessions, console delivery for pilot.
- Monorepo scaffold: `app/` (React 19 + Vite 6 PWA, dark-default, service
  worker, installable), `server/` (Hono API on :8787, tsx), npm workspaces.
- Schema migration `db/migrations/0001_init.sql`: all §4.2 tables + auth
  tables (magic_link_tokens, sessions). Every scoped table carries
  `contractor_id` directly (Hard Rule 7); `templates.contractor_id IS NULL`
  = system default.
- Seed templates JSON for universal block + all six project types (§6),
  with keys, divisions, conditions, flags, and bid_mapping as data.
- Turso credentials arrived mid-session; wired as embedded replica
  (`libsql://remodel-tool-claritycomp.aws-us-east-2.turso.io`). Migrated
  and seeded against it. Pilot contractor: Clean Construction LLC /
  Bradford Skvor / bryonskvor@gmail.com.
- Smoke-tested end-to-end: magic link → session → /api/me → /api/templates
  (7 rows) → public intake POST creates lead → scoped /api/leads returns it.
  Test lead deleted after. PWA production build passes.

**State**
- Phase 0 done and **verified by Bryon in the browser**: sign-in via magic
  link and home screen both work end-to-end. Server runs with
  `npm run dev:server`, app with `npm run dev:app` (Vite proxies /api →
  :8787). `.env` at repo root holds Turso credentials (gitignored).
  Placeholder PWA icons (solid orange).

**Next steps**
- Phase 1: walkthrough capture flow (universal → project-type blocks →
  per-area loops), photo capture + R2, voice notes + Groq Whisper queue,
  measurements, offline local store in the PWA, completeness engine v1.
- Capture Ohio local-code defaults from Bradford into
  `contractors.local_code_defaults`.
- Swap contractor email to Bradford's when he onboards; wire a real email
  provider before Phase 3.
- Consider rotating the Turso token eventually — it transited through
  `.env.example` briefly (never committed).

**Context**
- Twice this session credentials/values were pasted into `.env.example`
  (a committed file); moved to `.env` both times. Watch for this.
- The permission classifier blocks direct remote-Turso queries from
  scratchpad scripts; migrate/seed through the server workspace is fine.

## 2026-07-11 — Repo bootstrap

**Accomplished**
- Cloned the fresh empty repo (github.com/bryonskvor-pixel/remodelfieldtool).
- Added `PROJECT_CONTEXT.md` — the v1.0 master spec (planning handoff), with
  encoding artifacts from the original paste cleaned up (arrows, ⚠️ flags,
  emoji, dashes).
- Added `CLAUDE.md` with the seven hard rules from §1.1 and the session
  protocol.

**State**
- Spec-only repo; no code yet. Pre-Phase 0.

**Next steps**
- Answer open questions §14.4–14.6 before Phase 0: intake form hosting,
  local code defaults (Ohio frost depth etc.), shared DB with contractor_id
  filtering vs one Turso database per contractor.
- Phase 0: repo scaffold (React PWA), Turso provisioning (Bryon holds
  credentials), auth, §4.2 schema migration, seed template JSON for all six
  project types from §6.

**Context**
- Working name "ScopeWalk". First user is Bryon's brother (solo residential
  contractor); multi-tenant sale to other contractors is the stated intent,
  so contractor_id discipline applies from day one.
