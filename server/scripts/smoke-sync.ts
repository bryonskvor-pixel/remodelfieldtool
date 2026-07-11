// Temporary Phase 1 smoke test for /api/sync and /api/bootstrap.
// Mints a session directly in the DB, pushes a full capture batch, verifies
// cross-tenant rejection, then deletes everything it created.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getDb } from "../src/db.js";

const API = "http://localhost:8787";
const db = getDb();

function sha256(v: string) {
  return createHash("sha256").update(v).digest("hex");
}

const contractor = await db.execute("SELECT id FROM contractors LIMIT 1");
const contractorId = String(contractor.rows[0]!.id);

// session
const token = randomBytes(32).toString("base64url");
const sessionId = randomUUID();
await db.execute({
  sql: `INSERT INTO sessions (id, contractor_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
  args: [sessionId, contractorId, sha256(token), new Date(Date.now() + 3600_000).toISOString()],
});
const cookie = `scopewalk_session=${token}`;

const ids = {
  project: randomUUID(), wt: randomUUID(), areaU: randomUUID(), areaK: randomUUID(),
  si: randomUUID(), photo: randomUUID(), note: randomUUID(), evil: randomUUID(),
};
const now = new Date().toISOString();

const batch = {
  projects: [{ id: ids.project, lead_id: null, project_type: "kitchen", title: "SMOKE kitchen", property_year_built: 1962, occupied: 1, status: "active", created_at: now, updated_at: now }],
  walkthroughs: [{ id: ids.wt, project_id: ids.project, started_at: now, completed_at: null, completeness_score: null, status: "in_progress", created_at: now, updated_at: now }],
  areas: [
    { id: ids.areaU, walkthrough_id: ids.wt, name: "Property & systems", area_type: "universal", sort_order: 0, updated_at: now },
    { id: ids.areaK, walkthrough_id: ids.wt, name: "Kitchen", area_type: "kitchen", sort_order: 1, updated_at: now },
  ],
  scope_items: [
    { id: ids.si, area_id: ids.areaK, checklist_key: "kitchen.scope_tier", category: "general_conditions", title: "Scope tier", answer: JSON.stringify("full_gut"), skipped: 0, created_at: now, updated_at: now },
    // cross-tenant / bogus parent: must be rejected
    { id: ids.evil, area_id: "not-my-area", checklist_key: "x", title: "evil", skipped: 0, created_at: now, updated_at: now },
  ],
  photos: [{ id: ids.photo, scope_item_id: ids.si, area_id: ids.areaK, walkthrough_id: ids.wt, taken_at: now, sync_status: "pending", updated_at: now }],
  notes: [{ id: ids.note, parent_type: "scope_item", parent_id: ids.si, type: "voice", duration_sec: 12, sync_status: "pending", created_at: now, updated_at: now }],
};

const res = await fetch(`${API}/api/sync`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify(batch),
});
const result = (await res.json()) as { applied: Record<string, string[]>; rejected: unknown[] };
console.log("sync status:", res.status);
console.log("applied counts:", Object.fromEntries(Object.entries(result.applied).map(([k, v]) => [k, v.length])));
console.log("rejected:", JSON.stringify(result.rejected));

// LWW update: same row, newer timestamp
const later = new Date(Date.now() + 1000).toISOString();
const res2 = await fetch(`${API}/api/sync`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({ scope_items: [{ ...batch.scope_items[0], answer: JSON.stringify("layout_change"), updated_at: later }] }),
});
console.log("update status:", res2.status);
const check = await db.execute({ sql: "SELECT answer, contractor_id FROM scope_items WHERE id = ?", args: [ids.si] });
console.log("row after update:", JSON.stringify(check.rows[0]));

// bootstrap
const boot = await fetch(`${API}/api/bootstrap`, { headers: { cookie } });
const bootData = (await boot.json()) as { templates: unknown[]; projects: { id: string }[] };
console.log("bootstrap status:", boot.status, "templates:", bootData.templates.length,
  "smoke project present:", bootData.projects.some((p) => p.id === ids.project));

// cleanup
for (const [table, id] of [
  ["notes", ids.note], ["photos", ids.photo], ["scope_items", ids.si],
  ["areas", ids.areaU], ["areas", ids.areaK], ["walkthroughs", ids.wt], ["projects", ids.project],
] as const) {
  await db.execute({ sql: `DELETE FROM ${table} WHERE id = ? AND contractor_id = ?`, args: [id, contractorId] });
}
await db.execute({ sql: "DELETE FROM sessions WHERE id = ?", args: [sessionId] });
console.log("cleanup done");
