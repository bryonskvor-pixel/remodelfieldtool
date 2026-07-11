// Temporary Phase 1 smoke test for the media pipeline: photo + audio upload
// to R2, background Groq transcription, and download when the local blob is
// gone. Creates its rows via /api/sync, verifies, then deletes everything it
// created (rows, session, and R2 objects).
//
// Usage: tsx scripts/smoke-media.ts <path-to-audio.wav>
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { getDb } from "../src/db.js";
import { r2Delete } from "../src/r2.js";

const API = "http://localhost:8787";
const audioPath = process.argv[2];
if (!audioPath) throw new Error("usage: tsx scripts/smoke-media.ts <audio.wav>");
const audio = readFileSync(audioPath);

// Tiny valid JPEG (1x1, red) so the script needs no image tooling.
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  "base64",
);

const db = getDb();
const contractor = await db.execute("SELECT id FROM contractors LIMIT 1");
const contractorId = String(contractor.rows[0]!.id);

const token = randomBytes(32).toString("base64url");
const sessionId = randomUUID();
await db.execute({
  sql: `INSERT INTO sessions (id, contractor_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
  args: [sessionId, contractorId, createHash("sha256").update(token).digest("hex"),
    new Date(Date.now() + 3600_000).toISOString()],
});
const cookie = `scopewalk_session=${token}`;

const ids = { project: randomUUID(), wt: randomUUID(), area: randomUUID(), si: randomUUID(), photo: randomUUID(), note: randomUUID() };
const now = new Date().toISOString();
const r2Keys: string[] = [];
let failures = 0;

function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

try {
  // Rows first (media upload requires the owning row to exist and be owned).
  const sync = await fetch(`${API}/api/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({
      projects: [{ id: ids.project, lead_id: null, project_type: "kitchen", title: "SMOKE media", occupied: 1, status: "active", created_at: now, updated_at: now }],
      walkthroughs: [{ id: ids.wt, project_id: ids.project, started_at: now, status: "in_progress", created_at: now, updated_at: now }],
      areas: [{ id: ids.area, walkthrough_id: ids.wt, name: "Kitchen", area_type: "kitchen", sort_order: 1, updated_at: now }],
      scope_items: [{ id: ids.si, area_id: ids.area, checklist_key: "kitchen.flooring", title: "Flooring", skipped: 0, created_at: now, updated_at: now }],
      photos: [{ id: ids.photo, scope_item_id: ids.si, area_id: ids.area, walkthrough_id: ids.wt, taken_at: now, sync_status: "pending", updated_at: now }],
      notes: [{ id: ids.note, parent_type: "scope_item", parent_id: ids.si, type: "voice", duration_sec: 6, sync_status: "pending", created_at: now, updated_at: now }],
    }),
  });
  check("row sync", sync.ok);

  // Photo upload (multipart, photo + thumb).
  const form = new FormData();
  form.append("photo", new Blob([TINY_JPEG], { type: "image/jpeg" }), "p.jpg");
  form.append("thumb", new Blob([TINY_JPEG], { type: "image/jpeg" }), "t.jpg");
  const up = await fetch(`${API}/api/media/photo/${ids.photo}`, { method: "POST", headers: { cookie }, body: form });
  const upData = (await up.json()) as { r2_key?: string; thumbnail_key?: string; error?: string };
  check("photo upload", up.ok && !!upData.r2_key && !!upData.thumbnail_key, JSON.stringify(upData));
  if (upData.r2_key) r2Keys.push(upData.r2_key);
  if (upData.thumbnail_key) r2Keys.push(upData.thumbnail_key);

  // Photo download roundtrip (thumb + full).
  const dl = await fetch(`${API}/api/media/photo/${ids.photo}?variant=thumb`, { headers: { cookie } });
  const dlBytes = new Uint8Array(await dl.arrayBuffer());
  check("photo download (thumb from R2)", dl.ok && dlBytes.length === TINY_JPEG.length,
    `${dl.status}, ${dlBytes.length} bytes, ${dl.headers.get("content-type")}`);

  // Upload to a row we don't own / that doesn't exist must 404 (Hard Rule 7 path).
  const evil = await fetch(`${API}/api/media/photo/${randomUUID()}`, { method: "POST", headers: { cookie }, body: form });
  check("upload to unowned row rejected", evil.status === 404, `HTTP ${evil.status}`);

  // Audio upload → queued Groq transcription.
  const au = await fetch(`${API}/api/media/audio/${ids.note}`, {
    method: "POST",
    headers: { cookie, "Content-Type": "audio/wav" },
    body: audio,
  });
  const auData = (await au.json()) as { audio_r2_key?: string; error?: string };
  check("audio upload", au.ok && !!auData.audio_r2_key, JSON.stringify(auData));
  if (auData.audio_r2_key) r2Keys.push(auData.audio_r2_key);

  // Transcript should land within seconds (background job, real Groq call).
  let transcript: string | null = null;
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    const t = await fetch(`${API}/api/media/transcript/${ids.note}`, { headers: { cookie } });
    transcript = ((await t.json()) as { transcript: string | null }).transcript;
    if (transcript) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  check("transcription", !!transcript && /dishwasher/i.test(transcript), `${secs}s: "${transcript}"`);

  // Audio download roundtrip.
  const adl = await fetch(`${API}/api/media/audio/${ids.note}`, { headers: { cookie } });
  check("audio download from R2", adl.ok && (await adl.arrayBuffer()).byteLength === audio.length);

  // Bootstrap pull must now carry the child rows (second-device path).
  const boot = await fetch(`${API}/api/bootstrap`, { headers: { cookie } });
  const b = (await boot.json()) as { photos: { id: string; r2_key: string | null }[]; notes: { id: string; transcript: string | null }[] };
  const bp = b.photos.find((p) => p.id === ids.photo);
  const bn = b.notes.find((n) => n.id === ids.note);
  check("bootstrap pulls photo row w/ r2_key", !!bp?.r2_key);
  check("bootstrap pulls note row w/ transcript", !!bn?.transcript);
} finally {
  for (const [table, id] of [
    ["notes", ids.note], ["photos", ids.photo], ["scope_items", ids.si],
    ["areas", ids.area], ["walkthroughs", ids.wt], ["projects", ids.project],
  ] as const) {
    await db.execute({ sql: `DELETE FROM ${table} WHERE id = ? AND contractor_id = ?`, args: [id, contractorId] });
  }
  await db.execute({ sql: "DELETE FROM sessions WHERE id = ?", args: [sessionId] });
  for (const key of r2Keys) await r2Delete(key).catch((e) => console.warn("r2 cleanup:", e));
  console.log("cleanup done");
}

process.exit(failures === 0 ? 0 : 1);
