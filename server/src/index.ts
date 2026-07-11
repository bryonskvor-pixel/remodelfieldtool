import { serve } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { getDb } from "./db.js";
import { migrate } from "./migrate.js";
import { requestMagicLink, requireSession, verifyMagicLink } from "./auth.js";
import { applySyncBatch, type SyncBatch } from "./sync.js";

type Env = { Variables: { contractorId: string } };

const app = new Hono<Env>();
app.use(logger());

app.get("/api/health", (c) => c.json({ ok: true }));

// ---- Auth -----------------------------------------------------------------

app.post("/api/auth/request-link", async (c) => {
  const body = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string });
  if (!body.email) return c.json({ error: "email required" }, 400);
  await requestMagicLink(body.email);
  // Always 200: no account enumeration.
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
    sql: `SELECT id, business_name, owner_name, email, default_markup_pct,
                 proposal_expiration_days
          FROM contractors WHERE id = ?`,
    args: [contractorId],
  });
  const me = result.rows[0];
  if (!me) return c.json({ error: "not found" }, 404);
  return c.json({ contractor: me });
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
            project_type_interest, budget_range_stated, timeline_stated, intake_notes)
          VALUES (?, ?, 'website_intake', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    sql: `SELECT id, business_name, owner_name, email, default_markup_pct,
                 proposal_expiration_days
          FROM contractors WHERE id = ?`,
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
  return c.json({
    contractor: contractor.rows[0],
    templates: [...byType.values()],
    projects: projects.rows,
    walkthroughs: walkthroughs.rows,
    leads: leads.rows,
  });
});

// Batch upsert from the app's offline store. contractor_id comes from the
// session inside applySyncBatch, never from the payload (Hard Rule 7).
app.post("/api/sync", requireSession, async (c) => {
  const batch = await c.req.json<SyncBatch>().catch(() => null);
  if (!batch || typeof batch !== "object") return c.json({ error: "invalid batch" }, 400);
  const result = await applySyncBatch(batch, c.get("contractorId"));
  return c.json(result);
});

// ---- Boot -------------------------------------------------------------------

const port = Number(process.env.PORT ?? 8787);
await migrate();
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ScopeWalk API listening on http://localhost:${info.port}`);
});
