// Media uploader: pushes photo/audio blobs waiting in IndexedDB to the server
// (which stores them in R2) after the owning rows have synced. Fire-and-forget
// from capture's point of view (Hard Rule 3): this runs inside the background
// sync pass, and anything that fails just retries on the next pass.

import { idbPut } from "./idb";
import { db, getBlob, notifyStoreChange, type Synced } from "./store";
import type { Note, Photo } from "../types";

const THUMB_DIM = 320;

/** Small jpeg thumbnail for grids; generated on-device from the stored blob. */
export async function makeThumb(blob: Blob): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, THUMB_DIM / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.7));
  } catch {
    return null;
  }
}

/** Clean local write of upload results — must NOT re-enter the dirty queue
 * (the server already holds these values; row sync would just echo them). */
async function putUploadResult(store: "photos" | "notes", row: Record<string, unknown>): Promise<void> {
  await idbPut(store, { ...row, _dirty: 0 });
  notifyStoreChange();
}

async function uploadPhoto(photo: Synced<Photo>): Promise<void> {
  const entry = await getBlob(photo.id);
  if (!entry) return; // pulled from another device; media already in R2 or lost
  const form = new FormData();
  form.append("photo", entry.blob, `${photo.id}.jpg`);
  const thumb = await makeThumb(entry.blob);
  if (thumb) form.append("thumb", thumb, `${photo.id}.thumb.jpg`);
  const res = await fetch(`/api/media/photo/${photo.id}`, {
    method: "POST",
    credentials: "include",
    body: form,
  });
  if (!res.ok) throw new Error(`photo upload HTTP ${res.status}`);
  const data = (await res.json()) as { r2_key: string; thumbnail_key: string | null };
  await putUploadResult("photos", {
    ...photo, r2_key: data.r2_key, thumbnail_key: data.thumbnail_key, sync_status: "synced",
  });
}

async function uploadAudio(note: Synced<Note>): Promise<void> {
  const entry = await getBlob(note.id);
  if (!entry) return;
  const res = await fetch(`/api/media/audio/${note.id}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": entry.blob.type || "audio/webm" },
    body: entry.blob,
  });
  if (!res.ok) throw new Error(`audio upload HTTP ${res.status}`);
  const data = (await res.json()) as { audio_r2_key: string };
  await putUploadResult("notes", { ...note, audio_r2_key: data.audio_r2_key, sync_status: "synced" });
  watchTranscript(note.id);
}

/**
 * Upload every blob whose owning row has synced but whose media hasn't.
 * Dirty rows are skipped — the row must exist server-side first (the sync
 * pass pushes rows before calling this, so that's one pass at most).
 * Returns the number of uploads still owed (for retry on the next pass).
 */
export async function uploadPendingMedia(): Promise<number> {
  let remaining = 0;

  const photos = (await db.photos.all()) as Synced<Photo>[];
  for (const p of photos.filter((p) => p.sync_status !== "synced")) {
    if (p._dirty) { remaining += 1; continue; }
    try {
      await uploadPhoto(p);
    } catch (e) {
      remaining += 1;
      await putUploadResult("photos", { ...p, sync_status: "failed" });
      console.warn(`[media] photo ${p.id} upload failed, will retry`, e);
    }
  }

  const notes = (await db.notes.all()) as Synced<Note>[];
  for (const n of notes.filter((n) => n.type === "voice" && n.sync_status !== "synced")) {
    if (n._dirty) { remaining += 1; continue; }
    try {
      await uploadAudio(n);
    } catch (e) {
      remaining += 1;
      await putUploadResult("notes", { ...n, sync_status: "failed" });
      console.warn(`[media] audio ${n.id} upload failed, will retry`, e);
    }
  }

  return remaining;
}

// ---- Transcript arrival ------------------------------------------------------
// After an audio upload the server transcribes in the background (Groq queue).
// Poll briefly so the transcript appears "live" on the prompt screen; if it
// takes longer than that, the next bootstrap pull delivers it instead.

const watching = new Set<string>();

export function watchTranscript(noteId: string): void {
  if (watching.has(noteId)) return;
  watching.add(noteId);
  let tries = 0;
  const tick = async () => {
    tries += 1;
    try {
      const res = await fetch(`/api/media/transcript/${noteId}`, { credentials: "include" });
      if (res.ok) {
        const data = (await res.json()) as { transcript: string | null };
        if (data.transcript) {
          const local = (await db.notes.get(noteId)) as Synced<Note> | undefined;
          // Never clobber a local edit (dirty row or already-set transcript).
          if (local && !local._dirty && !local.transcript) {
            await idbPut("notes", { ...local, transcript: data.transcript, _dirty: 0 });
            notifyStoreChange();
          }
          watching.delete(noteId);
          return;
        }
      }
    } catch {
      // offline again — the bootstrap pull will bring the transcript later
    }
    if (tries < 15 && navigator.onLine) setTimeout(() => void tick(), 2500);
    else watching.delete(noteId);
  };
  setTimeout(() => void tick(), 2000);
}
