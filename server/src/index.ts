import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { getDb } from "./db.js";
import { migrate } from "./migrate.js";
import { requestMagicLink, requireSession, verifyMagicLink } from "./auth.js";
import { applySyncBatch, type SyncBatch } from "./sync.js";
import { media } from "./media.js";
import { proposalPublic, proposalsApi } from "./proposals.js";
import { recoverPendingTranscriptions } from "./transcribe.js";

type Env = { Variables: { contractorId: string } };

const app = new Hono<Env>();
app.use(logger());

app.get("/api/health", (c) => c.json({ ok: true }));

// ---- Auth -----------------------------------------------------------------

app.post("/api/auth/request-link", async (c) => {
  const body = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string });
  if (!body.email) return c.json({ error: "email required" }, 400);
  // Always 200: no account enumeration. A delivery failure (e.g. Resend
  // rejects) is logged server-side but never distinguishes a known email
  // from an unknown one in the response.
  await requestMagicLink(body.email).catch((err) => {
    console.error("[auth] request-link failed:", err);
  });
  return c.json({ ok: true, message: "If that email exists, a sign-in link was sent." });
});

app.post("/api/auth/verify", async (c) => {
  const body = await c.req.json<{ token?: string }>().catch(() => ({}) as { token?: string });
  if (!body.token) return c.json({ error: "token required" }, 400);
  const session = await verifyMagicLink(c, body.token);
  if (!session) return c.json({ error: "invalid or expired link" }, 401);
  return c.json({ ok: true });
});

app.get("/api/me", requireSession, async (c) => {
  const contractorId = c.get("contractorId");
  const db = getDb();
  const result = await db.execute({
    // Hard Rule 7: contractor-scoped query filters by contractor_id.
    sql: `SELECT ${CONTRACTOR_FIELDS} FROM contractors WHERE id = ?`,
    args: [contractorId],
  });
  const me = result.rows[0];
  if (!me) return c.json({ error: "not found" }, 404);
  return c.json({ contractor: me });
});

// Contractor profile fields the app reads (never the whole row — Turso auth
// columns etc. stay server-side).
const CONTRACTOR_FIELDS = `id, business_name, owner_name, email, phone,
  license_number, insurance_note, address, default_markup_pct,
  default_tax_rule, payment_schedule_default, terms_boilerplate,
  proposal_expiration_days`;

// Profile editing (Phase 2 §9: the proposal consumes these defaults).
// Online-only by design — profile edits aren't a field-capture flow.
const PROFILE_EDITABLE = [
  "business_name", "owner_name", "phone", "license_number", "insurance_note",
  "address", "default_markup_pct", "default_tax_rule",
  "payment_schedule_default", "terms_boilerplate", "proposal_expiration_days",
] as const;

app.patch("/api/me", requireSession, async (c) => {
  const contractorId = c.get("contractorId");
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "invalid body" }, 400);
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const col of PROFILE_EDITABLE) {
    if (body[col] !== undefined) {
      sets.push(`${col} = ?`);
      args.push(body[col] === "" ? null : body[col]);
    }
  }
  if (sets.length === 0) return c.json({ error: "no editable fields in body" }, 400);
  const db = getDb();
  await db.execute({
    // Hard Rule 7: contractor_id in the WHERE.
    sql: `UPDATE contractors SET ${sets.join(", ")} WHERE id = ?`,
    args: [...args, contractorId] as never[],
  });
  const result = await db.execute({
    sql: `SELECT ${CONTRACTOR_FIELDS} FROM contractors WHERE id = ?`,
    args: [contractorId],
  });
  return c.json({ contractor: result.rows[0] });
});

// ---- Website intake (§10, §14.4: his site's form POSTs here) ---------------
// Public endpoint keyed by contractor id in the path; creates a Lead with
// source=website_intake. Notification (SMS/email) lands with Phase 3.

app.post("/api/intake/:contractorId", async (c) => {
  const contractorId = c.req.param("contractorId");
  const db = getDb();
  const exists = await db.execute({
    sql: "SELECT id FROM contractors WHERE id = ?",
    args: [contractorId],
  });
  if (!exists.rows[0]) return c.json({ error: "unknown contractor" }, 404);

  const b = await c.req.json<Record<string, string>>().catch(() => null);
  if (!b || !b.customer_name) return c.json({ error: "customer_name required" }, 400);

  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO leads (id, contractor_id, source, customer_name, email, phone,
            address_street, address_city, address_state, address_zip,
            project_type_interest, budget_range_stated, timeline_stated, intake_notes,
            updated_at)
          VALUES (?, ?, 'website_intake', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    args: [
      id, contractorId, b.customer_name, b.email ?? null, b.phone ?? null,
      b.address_street ?? null, b.address_city ?? null, b.address_state ?? null,
      b.address_zip ?? null, b.project_type_interest ?? null,
      b.budget_range_stated ?? null, b.timeline_stated ?? null, b.intake_notes ?? null,
    ],
  });
  return c.json({ ok: true, lead_id: id }, 201);
});

// ---- Contractor-scoped reads (Phase 0 smoke surface) ------------------------

app.get("/api/leads", requireSession, async (c) => {
  const contractorId = c.get("contractorId");
  const db = getDb();
  const result = await db.execute({
    // Hard Rule 7: contractor-scoped query filters by contractor_id.
    sql: `SELECT * FROM leads WHERE contractor_id = ? ORDER BY created_at DESC`,
    args: [contractorId],
  });
  return c.json({ leads: result.rows });
});

app.get("/api/templates", requireSession, async (c) => {
  const contractorId = c.get("contractorId");
  const db = getDb();
  const result = await db.execute({
    // Contractor's own templates, falling back to system defaults (contractor_id IS NULL).
    sql: `SELECT id, contractor_id, project_type, checklist_json FROM templates
          WHERE contractor_id = ? OR contractor_id IS NULL
          ORDER BY project_type, contractor_id IS NULL`,
    args: [contractorId],
  });
  // Contractor-customized template wins over the system default per type.
  const byType = new Map<string, (typeof result.rows)[number]>();
  for (const row of result.rows) {
    if (!byType.has(String(row.project_type))) byType.set(String(row.project_type), row);
  }
  return c.json({ templates: [...byType.values()] });
});

// ---- Phase 1: bootstrap + offline sync --------------------------------------

// Everything the PWA needs cached locally to run a walkthrough offline:
// contractor profile, templates, and recent projects/walkthroughs.
app.get("/api/bootstrap", requireSession, async (c) => {
  const contractorId = c.get("contractorId");
  const db = getDb();
  // Hard Rule 7: every query below filters by contractor_id.
  const contractor = await db.execute({
    sql: `SELECT ${CONTRACTOR_FIELDS} FROM contractors WHERE id = ?`,
    args: [contractorId],
  });
  const templates = await db.execute({
    sql: `SELECT id, contractor_id, project_type, checklist_json FROM templates
          WHERE contractor_id = ? OR contractor_id IS NULL
          ORDER BY project_type, contractor_id IS NULL`,
    args: [contractorId],
  });
  const byType = new Map<string, (typeof templates.rows)[number]>();
  for (const row of templates.rows) {
    if (!byType.has(String(row.project_type))) byType.set(String(row.project_type), row);
  }
  const projects = await db.execute({
    sql: `SELECT * FROM projects WHERE contractor_id = ?
          ORDER BY created_at DESC LIMIT 50`,
    args: [contractorId],
  });
  const walkthroughs = await db.execute({
    sql: `SELECT * FROM walkthroughs WHERE contractor_id = ?
          ORDER BY created_at DESC LIMIT 50`,
    args: [contractorId],
  });
  const leads = await db.execute({
    sql: `SELECT * FROM leads WHERE contractor_id = ? ORDER BY created_at DESC LIMIT 50`,
    args: [contractorId],
  });
  // Walkthrough child rows, so a second device (or a device with cleared
  // storage) can render captured walkthroughs — including transcripts written
  // by the server-side Groq queue. Pilot scale: everything the contractor
  // owns; revisit with per-walkthrough pulls when data outgrows this.
  const pull = (table: string) =>
    db.execute({
      // Hard Rule 7: contractor-scoped query filters by contractor_id.
      sql: `SELECT * FROM ${table} WHERE contractor_id = ?`,
      args: [contractorId],
    });
  const [areas, scopeItems, photos, notes, priceBook, bidSheets, lineItems, proposals] = await Promise.all([
    pull("areas"), pull("scope_items"), pull("photos"), pull("notes"),
    pull("price_book_items"), pull("bid_sheets"), pull("line_items"), pull("proposals"),
  ]);
  return c.json({
    contractor: contractor.rows[0],
    templates: [...byType.values()],
    projects: projects.rows,
    walkthroughs: walkthroughs.rows,
    leads: leads.rows,
    areas: areas.rows,
    scope_items: scopeItems.rows,
    photos: photos.rows,
    notes: notes.rows,
    price_book_items: priceBook.rows,
    bid_sheets: bidSheets.rows,
    line_items: lineItems.rows,
    proposals: proposals.rows,
  });
});

// Media upload/download + transcript poll (Phase 1 R2/Groq slice).
app.route("/api/media", media);

// Proposals (§9): contractor preview + AI narrative draft (session-gated),
// and the tokenized public customer link (view/sign/pdf, unauthenticated).
app.route("/api/proposals", proposalsApi);
app.route("/p", proposalPublic);

// Batch upsert from the app's offline store. contractor_id comes from the
// session inside applySyncBatch, never from the payload (Hard Rule 7).
app.post("/api/sync", requireSession, async (c) => {
  const batch = await c.req.json<SyncBatch>().catch(() => null);
  if (!batch || typeof batch !== "object") return c.json({ error: "invalid batch" }, 400);
  const result = await applySyncBatch(batch, c.get("contractorId"));
  return c.json(result);
});

// ---- Static PWA (single-origin production serving) --------------------------
// One deployed service answers the app shell, the API, and public proposal
// links from the same origin. Single-origin keeps the offline/PWA story and
// the session cookie simple — no CORS, no cross-site cookie. In dev this is
// skipped: Vite serves the app and proxies /api + /p here (vite.config.ts).
// Set SERVE_STATIC=false to opt out (e.g. running the API standalone).
if (process.env.SERVE_STATIC !== "false") {
  // Absolute so it resolves regardless of the process cwd (Render, npm
  // workspace, etc.). server/src/index.ts -> repo/app/dist.
  const dist =
    process.env.PWA_DIST ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../app/dist");
  // Real files first (assets, icons, manifest, sw.js, …).
  app.use("*", serveStatic({ root: dist }));
  // SPA fallback: hash routes and the client-handled /auth/verify path all
  // live under index.html. API + public-proposal misses stay real 404s.
  app.get("*", (c, next) => {
    const p = c.req.path;
    if (p.startsWith("/api") || p.startsWith("/p/")) return next();
    return serveStatic({ root: dist, path: "index.html" })(c, next);
  });
}

// ---- Boot -------------------------------------------------------------------

const port = Number(process.env.PORT ?? 8787);
await migrate();
await recoverPendingTranscriptions();
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ScopeWalk API listening on http://localhost:${info.port}`);
});
