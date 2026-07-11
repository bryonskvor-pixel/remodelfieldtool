import { getDb } from "./db.js";

// Phase 1 sync: the PWA's offline store pushes whole dirty rows in one batch.
// Last-write-wins per row via updated_at (§3). HARD RULE 7 enforcement lives
// here: contractor_id is ALWAYS taken from the session, never from the client
// payload, and every upsert's ON CONFLICT clause refuses to touch a row owned
// by a different contractor. Parent references (project/walkthrough/area/…)
// are verified to belong to the same contractor before children are applied —
// a cross-tenant parent id is rejected, not silently written.

type Row = Record<string, unknown>;

export interface SyncBatch {
  projects?: Row[];
  walkthroughs?: Row[];
  areas?: Row[];
  scope_items?: Row[];
  photos?: Row[];
  notes?: Row[];
}

export interface SyncResult {
  applied: Record<string, string[]>;
  rejected: { table: string; id: string; reason: string }[];
}

// Client-writable columns per table. contractor_id is intentionally absent —
// it is injected server-side. Anything not listed is dropped.
const COLUMNS: Record<string, string[]> = {
  projects: [
    "id", "lead_id", "project_type", "title", "property_year_built",
    "occupied", "status", "created_at", "updated_at",
  ],
  walkthroughs: [
    "id", "project_id", "started_at", "completed_at", "completeness_score",
    "gps_lat", "gps_lng", "weather_note", "status", "created_at", "updated_at",
  ],
  areas: [
    "id", "walkthrough_id", "name", "area_type", "length_ft", "width_ft",
    "ceiling_height_ft", "floor_sf", "wall_sf", "sort_order", "updated_at",
  ],
  scope_items: [
    "id", "area_id", "checklist_key", "category", "title",
    "existing_condition", "planned_change", "action", "answer",
    "measurements", "flags", "skipped", "skip_reason", "created_at", "updated_at",
  ],
  photos: [
    "id", "scope_item_id", "area_id", "walkthrough_id", "r2_key",
    "thumbnail_key", "caption", "annotation_data", "taken_at",
    "gps_lat", "gps_lng", "sync_status", "updated_at",
  ],
  notes: [
    "id", "parent_type", "parent_id", "type", "audio_r2_key", "transcript",
    "duration_sec", "sync_status", "created_at", "updated_at",
  ],
};

/** Returns the subset of `ids` that exist in `table` AND belong to `contractorId`. */
async function ownedIds(table: string, ids: string[], contractorId: string): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");
  const result = await db.execute({
    // Hard Rule 7: ownership check filters by contractor_id.
    sql: `SELECT id FROM ${table} WHERE id IN (${placeholders}) AND contractor_id = ?`,
    args: [...ids, contractorId],
  });
  return new Set(result.rows.map((r) => String(r.id)));
}

async function upsert(
  table: string,
  row: Row,
  contractorId: string,
): Promise<void> {
  const db = getDb();
  const cols = COLUMNS[table];
  if (!cols) throw new Error(`unknown sync table: ${table}`);
  const present = cols.filter((c) => row[c] !== undefined);
  const insertCols = [...present, "contractor_id"];
  const values = [...present.map((c) => row[c] as never), contractorId];
  const updates = present
    .filter((c) => c !== "id" && c !== "created_at")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  await db.execute({
    // The WHERE on DO UPDATE is the tenant guard (Hard Rule 7): a row id owned
    // by another contractor is never overwritten. The updated_at comparison is
    // the last-write-wins rule.
    sql: `INSERT INTO ${table} (${insertCols.join(", ")})
          VALUES (${insertCols.map(() => "?").join(", ")})
          ON CONFLICT(id) DO UPDATE SET ${updates}
          WHERE ${table}.contractor_id = excluded.contractor_id
            AND (${table}.updated_at IS NULL OR excluded.updated_at >= ${table}.updated_at)`,
    args: values,
  });
}

export async function applySyncBatch(batch: SyncBatch, contractorId: string): Promise<SyncResult> {
  const applied: Record<string, string[]> = {};
  const rejected: SyncResult["rejected"] = [];

  const take = (table: keyof SyncBatch): Row[] =>
    (batch[table] ?? []).filter((r): r is Row => !!r && typeof r["id"] === "string");

  const reject = (table: string, row: Row, reason: string) =>
    rejected.push({ table, id: String(row.id), reason });

  const apply = async (table: string, rows: Row[]) => {
    applied[table] = [];
    for (const row of rows) {
      await upsert(table, row, contractorId);
      applied[table].push(String(row.id));
    }
  };

  // Parents first, children verified against parents already in the DB.

  const projects = take("projects");
  {
    const leadIds = [...new Set(projects.map((p) => p.lead_id).filter((v): v is string => typeof v === "string"))];
    const owned = await ownedIds("leads", leadIds, contractorId);
    const ok: Row[] = [];
    for (const p of projects) {
      if (typeof p.lead_id === "string" && !owned.has(p.lead_id)) reject("projects", p, "lead not owned");
      else ok.push(p);
    }
    await apply("projects", ok);
  }

  const filterByParent = async (
    table: string,
    rows: Row[],
    parentTable: string,
    fkCol: string,
    required: boolean,
  ): Promise<Row[]> => {
    const ids = [...new Set(rows.map((r) => r[fkCol]).filter((v): v is string => typeof v === "string"))];
    const owned = await ownedIds(parentTable, ids, contractorId);
    const ok: Row[] = [];
    for (const r of rows) {
      const fk = r[fkCol];
      if (typeof fk === "string" && !owned.has(fk)) reject(table, r, `${fkCol} not owned`);
      else if (required && typeof fk !== "string") reject(table, r, `${fkCol} required`);
      else ok.push(r);
    }
    return ok;
  };

  await apply("walkthroughs", await filterByParent("walkthroughs", take("walkthroughs"), "projects", "project_id", true));
  await apply("areas", await filterByParent("areas", take("areas"), "walkthroughs", "walkthrough_id", true));
  await apply("scope_items", await filterByParent("scope_items", take("scope_items"), "areas", "area_id", true));

  {
    // photos: walkthrough_id required; area_id / scope_item_id optional but verified.
    let photos = await filterByParent("photos", take("photos"), "walkthroughs", "walkthrough_id", true);
    photos = await filterByParent("photos", photos, "areas", "area_id", false);
    photos = await filterByParent("photos", photos, "scope_items", "scope_item_id", false);
    await apply("photos", photos);
  }

  {
    // notes: polymorphic parent (area | scope_item | walkthrough).
    const notes = take("notes");
    const parentTable: Record<string, string> = {
      area: "areas", scope_item: "scope_items", walkthrough: "walkthroughs",
    };
    const byType = new Map<string, Row[]>();
    const ok: Row[] = [];
    for (const n of notes) {
      const t = parentTable[String(n.parent_type)];
      if (!t || typeof n.parent_id !== "string") { reject("notes", n, "invalid parent"); continue; }
      const list = byType.get(t) ?? [];
      list.push(n);
      byType.set(t, list);
    }
    for (const [table, rows] of byType) {
      const owned = await ownedIds(table, [...new Set(rows.map((r) => String(r.parent_id)))], contractorId);
      for (const n of rows) {
        if (owned.has(String(n.parent_id))) ok.push(n);
        else reject("notes", n, "parent not owned");
      }
    }
    await apply("notes", ok);
  }

  return { applied, rejected };
}
