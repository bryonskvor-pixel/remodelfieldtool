---
name: verify
description: Build/launch/drive recipe for verifying ScopeWalk changes end-to-end in the running PWA (dev servers + Playwright).
---

# Verifying ScopeWalk changes in the running app

## Launch

1. `npm run dev:server` (Hono API on :8787) and `npm run dev:app` (Vite on :5173, proxies `/api`) — run both in background from repo root.
2. Auth: `cd server && npx tsx scripts/mint-session.ts` prints a 1-hour session token for the first contractor. Set it as cookie `scopewalk_session` on `http://localhost:5173`.

## Drive (Playwright)

- Playwright is NOT a project dep. Install it in the session scratchpad (`npm init -y && npm install playwright`); Chromium builds are already in `%LOCALAPPDATA%/ms-playwright`.
- Use a phone-ish viewport (400×780) — the UI is mobile-first.
- Flow to reach capture prompts: Home → "Start Walkthrough" → fill title input, tap a project-type chip, tap Create/Start → prompt screens. Click "Next" repeatedly to advance; match `.prompt-text` to find a specific prompt (e.g. `/dim/i` for the kitchen dims prompt).
- App state is IndexedDB, database name `scopewalk` (stores mirror server tables: `areas`, `scope_items`, `photos`, `notes`, …). Read it via `page.evaluate` + `indexedDB.open("scopewalk")` to assert write-throughs.
- Sync badge (`.sync-badge`) shows Synced/Offline·N queued; use `context.setOffline(true)` for offline probes.

## Clean up (test rows sync to real Turso!)

Any walkthrough created during a drive pushes to the shared Turso DB. Afterwards:
- `cd server && npx tsx scripts/list-projects.ts` to find the test project.
- Query `walkthroughs` by `project_id` (small tsx script in server/scripts, imports `../src/db.js`) to get the walkthrough id.
- `npx tsx scripts/cleanup-walkthrough.ts <walkthrough_id>` removes rows AND R2 objects.
- Leave the "Miller" kitchen project alone (Bryon's own test data).

## Gotchas

- Camera/mic capture needs HTTPS or localhost — fine headless on localhost, but real-phone runs over LAN IP can't record.
- `npm --workspace app` commands must run from the repo root (PowerShell cwd can drift after `cd server`).
