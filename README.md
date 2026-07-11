# ScopeWalk

Contractor field scope & bid tool. See `PROJECT_CONTEXT.md` for the full
specification and `CLAUDE.md` for the hard rules.

## Layout

- `app/` — React PWA (Vite). The field tool: mobile-first, offline-first, dark by default.
- `server/` — Hono API (Node, port 8787). Auth, intake, migrations, seeding.
- `db/migrations/` — SQL schema migrations (libSQL/SQLite dialect).
- `templates/` — seed checklist JSON: universal block + six project types.

## Setup

```sh
npm install
cp .env.example .env   # fill in Turso credentials + seed values
npm run migrate
npm run seed
```

## Develop

```sh
npm run dev:server   # API on http://localhost:8787
npm run dev:app      # PWA on http://localhost:5173 (proxies /api)
```

Sign in with the seeded contractor email; the magic link prints to the
server console (`EMAIL_PROVIDER=console`).

## Website intake

The contractor's existing website form POSTs JSON to
`POST /api/intake/:contractorId` with at minimum `customer_name`
(plus `email`, `phone`, `address_*`, `project_type_interest`,
`budget_range_stated`, `timeline_stated`, `intake_notes`). Creates a Lead
with `source=website_intake`.
