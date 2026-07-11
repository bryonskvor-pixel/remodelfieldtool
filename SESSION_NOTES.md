# Session Notes — ScopeWalk (remodelfieldtool)

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
