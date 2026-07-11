# Session Notes — ScopeWalk (remodelfieldtool)

## 2026-07-11 (session 5) — Sketch mode + photo annotation + GPS: Phase 1 code complete

**Accomplished**
- **Room-shape sketch mode** (commit `db8774c`), per the §11 spec: third
  measurement-pad mode `Qty | L×W | Sketch`. Tap-to-place corners on a dot
  grid (walls snap H/V), tap the first corner to close, then each wall
  highlights for numeric-pad entry; auto-derivable closing walls are shown as
  "✓ Confirm N ft" — suggested, never silently written (Hard Rule 1). Misclose
  reported in feet with Save disabled until fixed (tap any wall to re-enter).
  Shoelace floor SF + wall LF; on `*dims*` prompts writes `areas.floor_sf`
  (+ `wall_sf` once ceiling height known; length/width stay null — the room
  isn't rectangular). Polygon stores as `points` in measurement JSON — syncs
  through the existing pipeline, offline, no schema change. Floor-plan
  thumbnails on prompt + review. Pure geometry in
  `app/src/walkthrough/sketch.ts` (18 vitest tests). Browser-verified:
  L-room traced, suggestions 7/12 ft confirmed, 124 SF/48 LF; misclose
  flagged + fixed; L×W regression OK.
- **Photo annotation** (commit `3864fba`): tap any photo thumb (prompt or
  review) → full-screen annotator, drag-to-draw arrows/circles, Undo/Cancel/
  Done. Vector shapes only, stored in `photos.annotation_data` as JSON with
  units = % of image WIDTH on both axes (circles stay round on any aspect;
  device-independent). ✏️ badge on annotated thumbs. Syncs as a row write.
- **GPS-at-start** (same commit): walkthrough creation fires a non-blocking
  `getCurrentPosition` filling `walkthroughs.gps_lat/lng` (Hard Rule 3 —
  never waits; silently skipped on insecure contexts, like the camera).
- **Bug fix — media upload stale-snapshot clobber** (`app/src/db/media.ts`):
  upload write-backs used the pre-upload row snapshot with `_dirty: 0`, so an
  annotation/caption/transcript edit made while bytes were in flight was
  clobbered AND lost its dirty flag (never synced). Now re-reads the row and
  patches only the media fields, preserving dirty state.
- New project verify skill: `.claude/skills/verify/SKILL.md` (dev-server +
  mint-session + Playwright recipe, IndexedDB assertions, Turso cleanup).
- All browser runs verified with Playwright (fake geolocation + real photo
  upload → shapes on server, badge rendered, cancel/undo/bare-tap probes
  held). Test walkthroughs cleaned from Turso + R2 after each run.

**State**
- Phase 1 code is DONE. Both workspaces typecheck; 36 vitest tests pass.
  Dev servers stopped. Turso holds only "Miller" (Bryon's earlier test) and
  "Smith" (basement, created 2026-07-11 21:05Z — not by an agent session;
  presumably Bryon's, left alone).
- Only remaining Phase 1 item: **Bryon's real-phone offline walkthrough**
  (the true milestone) — he's doing it next. Camera/mic/GPS need HTTPS or
  localhost; capture/skip/measure/sketch work over LAN HTTP regardless.

**Next steps**
- Bryon: real-phone run. Then **Phase 2: bid sheet generation + price book
  auto-suggest + proposal builder** (§8–9) in a fresh session.
- Phase 2 reminder from earlier notes: transcripts and internal notes must
  never render in the proposal (Hard Rule 5); annotation overlays are
  internal too unless deliberately included on proposal photos.
- Still parked: Ohio local-code defaults from Bradford; rotate Turso token;
  real email provider before Phase 3.

**Context**
- Annotation coordinate space: y runs 0..100·h/w (NOT 0..100). Any future
  renderer must draw shapes over the image with that convention
  (`AnnotationShapes` in PhotoAnnotator.tsx is the shared renderer).
- Sketch UX detail: the closing tap only lands when the last placed corner
  shares an axis with the first corner (snapToAxis makes this natural).
- During wall entry the sketch sheet is taller than a phone viewport; the
  canvas top scrolls off. Watch on the real-phone run.
- The sketch measurement's floor_sf write-through is latest-wins with L×W
  (either overwrite the area row; contractor-overridable later).

## 2026-07-11 (session 4) — Phase 1 media sync: R2 + Groq transcription

**Accomplished**
- Media pipeline end-to-end (spec'd in PROJECT_CONTEXT §3 "Media pipeline"):
  - Server: `server/src/r2.ts` (R2 S3 API via aws4fetch), `media.ts` routes
    (`POST/GET /api/media/photo|audio/:id` + `GET /api/media/transcript/:id`),
    all requireSession + ownership-checked on the owning row (Hard Rule 7) —
    server-mediated by choice, no presigned URLs. Keys:
    `c/<contractor_id>/photos|audio/<row_id>.*`.
  - Server: `transcribe.ts` — in-process Groq Whisper queue
    (whisper-large-v3-turbo), retry ×3 with backoff, boot-time recovery of
    notes with audio in R2 but no transcript. Only fills an EMPTY transcript
    (contractor edits always win). Real transcription measured at ~2.3 s.
  - App: `app/src/db/media.ts` — after rows push, the sync pass uploads
    pending blobs (photo + on-device ≤320px thumbnail as multipart; audio
    raw), updates r2_key/thumbnail_key/audio_r2_key + sync_status locally as
    CLEAN writes (no dirty-loop), failures retry next pass; brief transcript
    polling after audio upload so it appears live.
  - Pull-merge: `/api/bootstrap` now returns areas/scope_items/photos/notes;
    app merges via `putServer` (LWW; locally-dirty rows always win). This is
    the second-device path. Sync badge counts owed media as pending.
  - UI: BlobThumb falls back to `/api/media/photo/:id?variant=thumb` when the
    local blob is gone; new NoteLine component renders transcripts with
    tap-to-edit (edit syncs as a normal row write); Review screen now shows
    photo thumbs + transcripts per item.
- Capture-driven area dims: an L×W measurement on a `*dims*` prompt writes
  `areas.length_ft/width_ft/floor_sf` (latest wins, contractor-overridable).
- Milestone VERIFIED (automated two-browser-profile Playwright run):
  offline kitchen capture with photo + voice note → reconnect → photo in R2,
  transcript in seconds, second profile on the same account renders the photo
  from R2 + shows/edits the transcript + has the pulled area dims. Server
  smoke (`server/scripts/smoke-media.ts`) covers upload/download roundtrips,
  unowned-row 404, and bootstrap child rows; cleans up rows AND R2 objects.
- Fixed `.env`: the R2 endpoint URL had been pasted into `R2_ACCOUNT_ID`
  (code now tolerates either form). `.env.example` checked: clean.

**State**
- Phase 1 remaining: photo annotation, GPS-at-start, and Bryon's real-phone
  walkthrough (camera/mic need HTTPS or localhost — same caveat as before).
- Typecheck (both workspaces) + 18 vitest tests pass. Dev servers stopped.
- One project left in Turso: "Miller" kitchen (2e7705f2…, from earlier
  testing — left alone; `server/scripts/cleanup-walkthrough.ts <wt_id>`
  removes a test walkthrough incl. its R2 objects if wanted).
- New dev helpers: `smoke-media.ts`, `cleanup-walkthrough.ts`,
  `list-projects.ts` (all under server/scripts/).

**Next steps**
- **Room-shape sketch (requested by Bryon 2026-07-11): third mode on the
  measurement pad — `Qty | L×W | Sketch`.** Tap-to-place corners on a grid
  (NOT freehand — gloves), walls snap to horizontal/vertical, tap first
  corner to close. Then each wall highlights in turn and the existing
  numeric pad enters its length; shape redraws to scale. Auto-derivable
  closing segments are SUGGESTED for confirmation, never silently written
  (Hard Rule 1). Computes floor SF (shoelace) + wall LF, writes
  `areas.floor_sf` (and `wall_sf` once ceiling height known), overridable.
  Polygon stores as measurement JSON on the scope item (`dims` grows a
  `points` array) — syncs through the existing pipeline, no schema change,
  fully offline. Render a small floor-plan thumbnail on the review screen.
  Keep L×W the default fast path; sketch is the escape hatch for
  non-rectangular rooms. ~1 session, no new deps, unit tests for the math.
- Bryon: real-phone offline run (the true Phase 1 milestone).
- Photo annotation + GPS-at-start, or explicitly defer them to Phase 3.
- Then Phase 2: bid sheet generation + price book + proposal.
- Still parked: Ohio local-code defaults from Bradford; rotate Turso token.

**Context**
- Transcripts are internal-only (Hard Rule 5) — when Phase 2 builds the
  proposal renderer, NoteLine/transcript data must never cross into
  customer-facing output.
- The media upload runs INSIDE syncNow after row push (rows must exist
  server-side for the ownership check) — don't reorder.
- Groq on near-silent audio returns filler ("um", "."); server writes
  "(no speech detected)" only for fully empty results.

## 2026-07-11 (session 3) — Phase 1 capture slice: offline walkthrough flow

**Accomplished**
- Full offline walkthrough capture flow, milestone verified: an automated
  Edge/Playwright run captured a fake kitchen walkthrough with the network
  off (measurement via numeric pad, choice chips, one-tap skip, typed note),
  reloaded the page still offline with nothing lost, and drained the sync
  queue on reconnect ("Offline · 7 queued" → "Synced").
- App offline layer (`app/src/db/`): minimal IndexedDB wrapper, entity store
  mirroring the server schema + `_dirty` flags, blob store for photo/audio,
  sync engine (push on start/online-event/debounced-after-write). Decision
  documented in PROJECT_CONTEXT §3: Turso embedded replicas are server-side
  only; the browser store is IndexedDB.
- Walkthrough engine + completeness engine v1 (`app/src/walkthrough/`),
  pure modules with 18 vitest tests (`npm test`): required/conditional/
  skipped scoring, lt/in/project_type/answer conditions, conditional photos
  ("vented hood → exterior wall photo"), skip → drafted assumption text.
- UI: Home (start walkthrough creates project + walkthrough + universal area
  + primary area, all local), prompt screens (big prompt, [Photo] [Voice]
  [Note] [Measurement], choice chips, skip sheet with the three one-tap
  reasons), measurement pad with unit presets + L×W→SF live, voice via
  MediaRecorder (3-min cap), photo via camera input + canvas compression
  (≤400KB target), per-area loop with add-area (any project type, §6.6),
  review screen (flags on top, score X of Y, complete-anyway never blocks),
  live progress bar, sync badge, hash routing (offline-reload safe).
- Server: migration 0002 (scope_items.answer + updated_at everywhere),
  `GET /api/bootstrap` (contractor/templates/projects cache pull),
  `POST /api/sync` batch upsert — contractor_id from session only, tenant-
  guarded ON CONFLICT, parent-ownership validation (smoke-tested: bogus
  area_id rejected, LWW verified).
- Auth is offline-tolerant now: only explicit 401 signs out; network failure
  falls back to the cached contractor.

**State**
- Phase 1 partially done. Photos/voice notes save as local IndexedDB blobs
  and their metadata rows sync; the media bytes do NOT upload yet.
- Dev helpers kept: `server/scripts/smoke-sync.ts` (endpoint smoke, cleans up
  after itself) and `server/scripts/mint-session.ts` (prints a 1-hour session
  cookie token for local testing).
- Not verified by Bryon on a real phone yet — that's the true milestone.

**Next steps**
- R2 upload for photo/audio blobs + Groq Whisper transcription queue on sync.
- Bryon: run a fake kitchen walkthrough on your actual phone with wifi off
  (`npm run dev:server` + `npm run dev:app`, open on phone via LAN IP —
  note: camera/mic need HTTPS or localhost, so test media capture via
  desktop or set up HTTPS dev; capture/skip/measure work regardless).
- Write capture-driven area dims into `areas.length_ft/width_ft/floor_sf`.
- Still open from last session: Ohio local-code defaults from Bradford;
  rotate Turso token eventually.

**Context**
- The runner resumes at the first untouched prompt on load; position is
  anchored by step key, not index, because conditional prompts appear
  mid-flow as answers land (e.g. year built 1962 → lead-paint prompt).
- Vite preview now proxies /api (added for the milestone test).
- `.env.example` checked this session: clean, no pasted secrets.

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
