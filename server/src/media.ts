import { Hono } from "hono";
import { getDb } from "./db.js";
import { requireSession } from "./auth.js";
import { r2Configured, r2Get, r2Put } from "./r2.js";
import { enqueueTranscription } from "./transcribe.js";

// Media pipeline (§3): the app pushes photo/audio blobs here after the owning
// row has synced; the server stores them in R2 and serves them back when the
// local blob is gone (fresh device / cleared storage). Server-mediated on
// purpose — every request passes requireSession plus an ownership check on
// the target row (Hard Rule 7), which presigned URLs would scatter.

type Env = { Variables: { contractorId: string } };

export const media = new Hono<Env>();
media.use(requireSession);

/** The row must exist AND belong to the session's contractor (Hard Rule 7). */
async function ownedRow(
  table: "photos" | "notes",
  id: string,
  contractorId: string,
): Promise<Record<string, unknown> | null> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT * FROM ${table} WHERE id = ? AND contractor_id = ?`,
    args: [id, contractorId],
  });
  return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
}

function audioExt(mimeType: string): string {
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}

// Photo upload: multipart with `photo` (compressed jpeg) and `thumb`.
// Both land under the contractor's prefix; keys write back to the photos row.
media.post("/photo/:id", async (c) => {
  if (!r2Configured()) return c.json({ error: "media storage not configured" }, 503);
  const contractorId = c.get("contractorId");
  const id = c.req.param("id");
  const row = await ownedRow("photos", id, contractorId);
  if (!row) return c.json({ error: "photo row not found" }, 404);

  const body = await c.req.parseBody();
  const photo = body["photo"];
  const thumb = body["thumb"];
  if (!(photo instanceof File)) return c.json({ error: "photo file required" }, 400);

  const r2Key = `c/${contractorId}/photos/${id}.jpg`;
  const thumbKey = thumb instanceof File ? `c/${contractorId}/photos/${id}.thumb.jpg` : null;
  await r2Put(r2Key, new Uint8Array(await photo.arrayBuffer()), photo.type || "image/jpeg");
  if (thumb instanceof File && thumbKey) {
    await r2Put(thumbKey, new Uint8Array(await thumb.arrayBuffer()), thumb.type || "image/jpeg");
  }

  const db = getDb();
  await db.execute({
    // Hard Rule 7: contractor_id in the WHERE.
    sql: `UPDATE photos SET r2_key = ?, thumbnail_key = ?, sync_status = 'synced', updated_at = ?
          WHERE id = ? AND contractor_id = ?`,
    args: [r2Key, thumbKey, new Date().toISOString(), id, contractorId],
  });
  return c.json({ ok: true, r2_key: r2Key, thumbnail_key: thumbKey });
});

// Audio upload: raw body (the recorded blob), content-type preserved.
// On success the note is queued for Groq transcription — capture never waits.
media.post("/audio/:id", async (c) => {
  if (!r2Configured()) return c.json({ error: "media storage not configured" }, 503);
  const contractorId = c.get("contractorId");
  const id = c.req.param("id");
  const row = await ownedRow("notes", id, contractorId);
  if (!row) return c.json({ error: "note row not found" }, 404);
  if (row.type !== "voice") return c.json({ error: "not a voice note" }, 400);

  const audio = new Uint8Array(await c.req.arrayBuffer());
  if (audio.byteLength === 0) return c.json({ error: "empty audio body" }, 400);
  const mimeType = c.req.header("content-type") ?? "audio/webm";
  const r2Key = `c/${contractorId}/audio/${id}.${audioExt(mimeType)}`;
  await r2Put(r2Key, audio, mimeType);

  const db = getDb();
  await db.execute({
    // Hard Rule 7: contractor_id in the WHERE.
    sql: `UPDATE notes SET audio_r2_key = ?, sync_status = 'synced', updated_at = ?
          WHERE id = ? AND contractor_id = ?`,
    args: [r2Key, new Date().toISOString(), id, contractorId],
  });
  enqueueTranscription({ noteId: id, contractorId, r2Key, mimeType, audio });
  return c.json({ ok: true, audio_r2_key: r2Key });
});

// Photo download (?variant=thumb for the review/prompt grids). Serves from R2
// so a fresh device renders photos whose local blobs never existed.
media.get("/photo/:id", async (c) => {
  const contractorId = c.get("contractorId");
  const row = await ownedRow("photos", c.req.param("id"), contractorId);
  if (!row) return c.json({ error: "not found" }, 404);
  const wantThumb = c.req.query("variant") === "thumb";
  const key = (wantThumb && row.thumbnail_key ? row.thumbnail_key : row.r2_key) as string | null;
  if (!key) return c.json({ error: "not uploaded yet" }, 404);
  const obj = await r2Get(key);
  if (!obj) return c.json({ error: "object missing" }, 404);
  return c.body(obj.body.buffer as ArrayBuffer, 200, {
    "Content-Type": obj.contentType,
    "Cache-Control": "private, max-age=31536000, immutable",
  });
});

// Audio download (playback of a voice note when the local blob is gone).
media.get("/audio/:id", async (c) => {
  const contractorId = c.get("contractorId");
  const row = await ownedRow("notes", c.req.param("id"), contractorId);
  if (!row || !row.audio_r2_key) return c.json({ error: "not found" }, 404);
  const obj = await r2Get(String(row.audio_r2_key));
  if (!obj) return c.json({ error: "object missing" }, 404);
  return c.body(obj.body.buffer as ArrayBuffer, 200, {
    "Content-Type": obj.contentType,
    "Cache-Control": "private, max-age=31536000, immutable",
  });
});

// Transcript poll: the app checks here for a few seconds after an audio
// upload so the transcript appears "live" without waiting for the next pull.
media.get("/transcript/:id", async (c) => {
  const contractorId = c.get("contractorId");
  const row = await ownedRow("notes", c.req.param("id"), contractorId);
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({ transcript: (row.transcript as string | null) ?? null, updated_at: row.updated_at ?? null });
});
