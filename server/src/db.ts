import { createClient, type Client } from "@libsql/client";
import { config } from "dotenv";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// .env lives at the repo root regardless of which workspace invoked us.
config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env") });

// HARD RULE 7 (PROJECT_CONTEXT.md §1.1): every query touching
// contractor-scoped data MUST filter by contractor_id. Turso has no row-level
// security — this application-layer discipline IS the tenant boundary.
// Tenancy decision (§14.6): one shared database, contractor_id everywhere.

let client: Client | null = null;

export function getDb(): Client {
  if (client) return client;

  const localPath = process.env.LOCAL_DB_PATH ?? "file:./data/scopewalk.db";
  const syncUrl = process.env.TURSO_DATABASE_URL || undefined;
  const authToken = process.env.TURSO_AUTH_TOKEN || undefined;

  // Ensure the data directory exists for the local file.
  const filePath = localPath.replace(/^file:/, "");
  mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });

  // With syncUrl set this becomes a Turso embedded replica (the offline-first
  // architecture, §3). Without it, it is a plain local libSQL file — same API,
  // sync wires in when credentials are provided.
  client = createClient(
    syncUrl
      ? { url: localPath, syncUrl, authToken, syncInterval: 60 }
      : { url: localPath },
  );
  return client;
}
