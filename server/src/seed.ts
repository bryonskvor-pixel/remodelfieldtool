import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "./db.js";
import { migrate } from "./migrate.js";

const TEMPLATES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../templates",
);

async function seedSystemTemplates(): Promise<void> {
  const db = getDb();
  for (const file of readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".json"))) {
    const raw = readFileSync(path.join(TEMPLATES_DIR, file), "utf8");
    const parsed = JSON.parse(raw) as { project_type: string };
    // Upsert the system default (contractor_id NULL) for this project type.
    const existing = await db.execute({
      sql: "SELECT id FROM templates WHERE contractor_id IS NULL AND project_type = ?",
      args: [parsed.project_type],
    });
    if (existing.rows[0]) {
      await db.execute({
        sql: "UPDATE templates SET checklist_json = ?, updated_at = datetime('now') WHERE id = ?",
        args: [raw, String(existing.rows[0].id)],
      });
      console.log(`updated system template: ${parsed.project_type}`);
    } else {
      await db.execute({
        sql: `INSERT INTO templates (id, contractor_id, project_type, checklist_json)
              VALUES (?, NULL, ?, ?)`,
        args: [randomUUID(), parsed.project_type, raw],
      });
      console.log(`seeded system template: ${parsed.project_type}`);
    }
  }
}

async function seedPilotContractor(): Promise<void> {
  const email = process.env.SEED_CONTRACTOR_EMAIL?.trim().toLowerCase();
  if (!email) {
    console.log("SEED_CONTRACTOR_EMAIL not set — skipping contractor seed");
    return;
  }
  const db = getDb();
  const existing = await db.execute({
    sql: "SELECT id FROM contractors WHERE email = ?",
    args: [email],
  });
  if (existing.rows[0]) {
    console.log(`contractor already exists: ${email}`);
    return;
  }
  await db.execute({
    sql: `INSERT INTO contractors (id, business_name, owner_name, email)
          VALUES (?, ?, ?, ?)`,
    args: [
      randomUUID(),
      process.env.SEED_CONTRACTOR_BUSINESS_NAME ?? "Pilot Contractor",
      process.env.SEED_CONTRACTOR_OWNER_NAME ?? null,
      email,
    ],
  });
  console.log(`seeded contractor: ${email}`);
}

await migrate();
await seedSystemTemplates();
await seedPilotContractor();
console.log("seed complete");
