// Dev helper: mints a 1-hour session for the first contractor and prints the
// cookie value. Used by local smoke tests; sessions expire on their own.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getDb } from "../src/db.js";

const db = getDb();
const contractor = await db.execute("SELECT id FROM contractors LIMIT 1");
const token = randomBytes(32).toString("base64url");
await db.execute({
  sql: `INSERT INTO sessions (id, contractor_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
  args: [
    randomUUID(),
    String(contractor.rows[0]!.id),
    createHash("sha256").update(token).digest("hex"),
    new Date(Date.now() + 3600_000).toISOString(),
  ],
});
console.log(token);
