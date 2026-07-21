import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// .env lives at the repo root regardless of which workspace invoked us.
config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env") });

// Values pasted into a hosting dashboard routinely carry a trailing newline or
// space. It is invisible in the UI but fatal, and the resulting errors point
// nowhere near the real cause: a newline in TURSO_DATABASE_URL is encoded as
// %0A and the URL fails to parse (the native libsql driver aborts the process
// outright), and a newline in an API key makes an invalid HTTP header.
// Trim every value once, here, so no caller has to remember to.
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== value) process.env[key] = trimmed;
  }
}
