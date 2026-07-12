// Dev helper: confirm proposal schema + list applied migrations.
import { getDb } from "../src/db.js";

const db = getDb();
const col = await db.execute(
  "SELECT name FROM pragma_table_info('proposals') WHERE name='timeline_estimate'",
);
console.log("timeline_estimate present:", col.rows.length === 1);
const m = await db.execute("SELECT name FROM _migrations ORDER BY name");
console.log("applied:", m.rows.map((x) => String(x.name)).join(", "));
