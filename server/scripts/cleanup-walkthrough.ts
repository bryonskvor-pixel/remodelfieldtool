// Dev helper: deletes a test walkthrough and everything under it — rows AND
// the R2 objects its photos/notes point at. Used to clean up after browser
// milestone runs. Usage: tsx scripts/cleanup-walkthrough.ts <walkthrough_id>
import { getDb } from "../src/db.js";
import { r2Delete } from "../src/r2.js";

const wtId = process.argv[2];
if (!wtId) throw new Error("usage: tsx scripts/cleanup-walkthrough.ts <walkthrough_id>");
const db = getDb();

const wt = await db.execute({ sql: "SELECT project_id, contractor_id FROM walkthroughs WHERE id = ?", args: [wtId] });
if (!wt.rows[0]) {
  console.log("walkthrough not found (nothing to clean)");
  process.exit(0);
}
const projectId = String(wt.rows[0].project_id);
const contractorId = String(wt.rows[0].contractor_id);

const keys: string[] = [];
const photos = await db.execute({
  sql: "SELECT r2_key, thumbnail_key FROM photos WHERE walkthrough_id = ? AND contractor_id = ?",
  args: [wtId, contractorId],
});
for (const p of photos.rows) {
  if (p.r2_key) keys.push(String(p.r2_key));
  if (p.thumbnail_key) keys.push(String(p.thumbnail_key));
}
const areaIds = (await db.execute({
  sql: "SELECT id FROM areas WHERE walkthrough_id = ? AND contractor_id = ?",
  args: [wtId, contractorId],
})).rows.map((r) => String(r.id));
const siIds = areaIds.length
  ? (await db.execute({
      sql: `SELECT id FROM scope_items WHERE area_id IN (${areaIds.map(() => "?").join(",")}) AND contractor_id = ?`,
      args: [...areaIds, contractorId],
    })).rows.map((r) => String(r.id))
  : [];
const parentIds = [wtId, ...areaIds, ...siIds];
const notes = await db.execute({
  sql: `SELECT id, audio_r2_key FROM notes WHERE parent_id IN (${parentIds.map(() => "?").join(",")}) AND contractor_id = ?`,
  args: [...parentIds, contractorId],
});
for (const n of notes.rows) if (n.audio_r2_key) keys.push(String(n.audio_r2_key));

for (const key of keys) {
  await r2Delete(key).catch((e) => console.warn("r2 delete failed:", key, e));
}
const del = (sql: string, args: (string | null)[]) => db.execute({ sql, args });
if (notes.rows.length) {
  await del(`DELETE FROM notes WHERE id IN (${notes.rows.map(() => "?").join(",")}) AND contractor_id = ?`,
    [...notes.rows.map((n) => String(n.id)), contractorId]);
}
await del("DELETE FROM photos WHERE walkthrough_id = ? AND contractor_id = ?", [wtId, contractorId]);
// Phase 2 children first: line_items reference scope_items and bid_sheets.
const bsIds = (await db.execute({
  sql: "SELECT id FROM bid_sheets WHERE project_id = ? AND contractor_id = ?",
  args: [projectId, contractorId],
})).rows.map((r) => String(r.id));
if (bsIds.length) {
  await del(`DELETE FROM line_items WHERE bid_sheet_id IN (${bsIds.map(() => "?").join(",")}) AND contractor_id = ?`,
    [...bsIds, contractorId]);
  await del(`DELETE FROM bid_sheets WHERE id IN (${bsIds.map(() => "?").join(",")}) AND contractor_id = ?`,
    [...bsIds, contractorId]);
}
if (siIds.length) {
  await del(`DELETE FROM scope_items WHERE id IN (${siIds.map(() => "?").join(",")}) AND contractor_id = ?`, [...siIds, contractorId]);
}
await del("DELETE FROM areas WHERE walkthrough_id = ? AND contractor_id = ?", [wtId, contractorId]);
await del("DELETE FROM walkthroughs WHERE id = ? AND contractor_id = ?", [wtId, contractorId]);
await del("DELETE FROM projects WHERE id = ? AND contractor_id = ?", [projectId, contractorId]);
console.log(`cleaned walkthrough ${wtId}: ${keys.length} R2 object(s), rows removed`);
