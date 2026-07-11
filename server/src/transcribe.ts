import { getDb } from "./db.js";
import { r2Get } from "./r2.js";

// Groq Whisper transcription queue (§3, LOCKED: whisper-large-v3-turbo).
// Runs as an in-process background job: audio upload enqueues, capture never
// waits (Hard Rule 3). The transcript is INTERNAL ONLY — it lands in
// notes.transcript, which never renders in customer output (Hard Rule 5).
// On boot, notes that have audio in R2 but no transcript are re-enqueued so a
// server restart can't strand a voice note.

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODEL = "whisper-large-v3-turbo";
const MAX_ATTEMPTS = 3;

interface Job {
  noteId: string;
  contractorId: string;
  r2Key: string;
  mimeType: string;
  /** Audio bytes if the upload handler still has them; else fetched from R2. */
  audio?: Uint8Array;
  attempts: number;
}

const queue: Job[] = [];
let running = false;

export function transcriptionConfigured(): boolean {
  return Boolean(process.env.GROQ_API_KEY);
}

export function enqueueTranscription(job: Omit<Job, "attempts">): void {
  if (!transcriptionConfigured()) {
    console.warn(`[transcribe] GROQ_API_KEY missing; note ${job.noteId} left untranscribed`);
    return;
  }
  queue.push({ ...job, attempts: 0 });
  void drain();
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift()!;
      try {
        await transcribe(job);
      } catch (e) {
        job.attempts += 1;
        job.audio = undefined; // refetch from R2 on retry; don't pin memory
        if (job.attempts < MAX_ATTEMPTS) {
          const delay = 2000 * job.attempts;
          console.warn(`[transcribe] note ${job.noteId} attempt ${job.attempts} failed, retrying in ${delay}ms:`, e);
          setTimeout(() => {
            queue.push(job);
            void drain();
          }, delay);
        } else {
          // Give up until the next server boot re-enqueues it.
          console.error(`[transcribe] note ${job.noteId} failed after ${MAX_ATTEMPTS} attempts:`, e);
        }
      }
    }
  } finally {
    running = false;
  }
}

async function transcribe(job: Job): Promise<void> {
  let audio = job.audio;
  let mimeType = job.mimeType;
  if (!audio) {
    const obj = await r2Get(job.r2Key);
    if (!obj) throw new Error(`audio object ${job.r2Key} missing from R2`);
    audio = obj.body;
    mimeType = obj.contentType;
  }

  const ext = mimeType.includes("wav") ? "wav" : mimeType.includes("mp4") ? "mp4" : mimeType.includes("ogg") ? "ogg" : "webm";
  const form = new FormData();
  form.append("file", new Blob([audio as BlobPart], { type: mimeType }), `note.${ext}`);
  form.append("model", MODEL);
  form.append("response_format", "json");

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { text?: string };
  const text = (data.text ?? "").trim();

  const db = getDb();
  // Hard Rule 7: contractor_id in the WHERE. Only fill an empty transcript —
  // if the contractor already edited it, their words win.
  await db.execute({
    sql: `UPDATE notes SET transcript = ?, updated_at = ?
          WHERE id = ? AND contractor_id = ? AND (transcript IS NULL OR transcript = '')`,
    args: [text || "(no speech detected)", new Date().toISOString(), job.noteId, job.contractorId],
  });
  console.log(`[transcribe] note ${job.noteId}: "${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"`);
}

/** Re-enqueue voice notes whose audio reached R2 but never got a transcript. */
export async function recoverPendingTranscriptions(): Promise<void> {
  if (!transcriptionConfigured()) return;
  const db = getDb();
  // System-level sweep across tenants (not a request path); each job carries
  // its row's contractor_id and the transcript UPDATE filters by it.
  const result = await db.execute({
    sql: `SELECT id, contractor_id, audio_r2_key FROM notes
          WHERE type = 'voice' AND audio_r2_key IS NOT NULL
            AND (transcript IS NULL OR transcript = '')`,
    args: [],
  });
  for (const row of result.rows) {
    enqueueTranscription({
      noteId: String(row.id),
      contractorId: String(row.contractor_id),
      r2Key: String(row.audio_r2_key),
      mimeType: "audio/webm",
    });
  }
  if (result.rows.length > 0) {
    console.log(`[transcribe] recovered ${result.rows.length} pending transcription(s)`);
  }
}
