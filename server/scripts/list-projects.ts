// Dev helper: quick look at what projects exist (test-data hygiene checks).
import { getDb } from "../src/db.js";
const p = await getDb().execute("SELECT id, title, project_type, created_at FROM projects ORDER BY created_at");
for (const r of p.rows) console.log(`${r.id}  ${r.project_type}  "${r.title}"  ${r.created_at}`);
console.log(`${p.rows.length} project(s)`);
