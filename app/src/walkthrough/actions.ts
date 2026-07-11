// Capture actions: every handler writes to the offline store immediately and
// returns — no network, no spinners (Hard Rules 2 & 3). Sync happens behind
// the scenes in db/sync.ts.

import { db, newId, now, putBlob } from "../db/store";
import { humanizeKey, parsedAnswer, parsedMeasurements, type Step } from "./engine";
import { perimeterLF } from "./sketch";
import type { Measurement, Note, Photo, ScopeItem } from "../types";

/** Find-or-create the scope item backing a template prompt in an area. */
export async function ensureScopeItem(step: Step, existing: ScopeItem | null): Promise<ScopeItem> {
  if (existing) return existing;
  const row: ScopeItem = {
    id: newId(),
    area_id: step.areaId,
    checklist_key: step.item.key,
    category: step.item.division,
    title: humanizeKey(step.item.key),
    existing_condition: null,
    planned_change: null,
    action: null,
    answer: null,
    measurements: null,
    flags: step.item.flags.length > 0 ? JSON.stringify(step.item.flags.filter((f) => !f.startsWith("auto:"))) : null,
    skipped: 0,
    skip_reason: null,
    created_at: now(),
    updated_at: now(),
  };
  return db.scope_items.put(row);
}

/** Set or toggle a choice answer. Multi-select items accumulate an array. */
export async function saveChoice(step: Step, existing: ScopeItem | null, choice: string): Promise<ScopeItem> {
  const si = await ensureScopeItem(step, existing);
  let next: string | string[] | null;
  if (step.item.multi) {
    const current = parsedAnswer(si);
    const list = Array.isArray(current) ? current : current ? [current] : [];
    next = list.includes(choice) ? list.filter((c) => c !== choice) : [...list, choice];
    if (next.length === 0) next = null;
  } else {
    next = parsedAnswer(si) === choice ? null : choice;
  }
  return db.scope_items.put({ ...si, answer: next === null ? null : JSON.stringify(next), skipped: 0, skip_reason: null });
}

export async function addMeasurement(step: Step, existing: ScopeItem | null, m: Measurement): Promise<ScopeItem> {
  const si = await ensureScopeItem(step, existing);
  const all = [...parsedMeasurements(si), m];
  const saved = await db.scope_items.put({ ...si, measurements: JSON.stringify(all), skipped: 0, skip_reason: null });

  // Capture-driven area dims: an L×W on a dims prompt (kitchen.dims,
  // bath.dims, general.room_dims, …) IS the room's dimensions, so it writes
  // through to the area row. The values stay contractor-overridable — a later
  // measurement (or future area edit) simply wins. Never invented (Hard Rule
  // 1): these are exactly the numbers the contractor punched in.
  const keyTail = step.item.key.split(".").pop() ?? "";
  if (keyTail.includes("dims") && m.dims?.length && m.dims?.width) {
    const area = await db.areas.get(step.areaId);
    if (area) {
      await db.areas.put({
        ...area,
        length_ft: m.dims.length,
        width_ft: m.dims.width,
        floor_sf: m.qty,
      });
    }
  } else if (keyTail.includes("dims") && m.dims?.points && m.dims.points.length >= 4) {
    // Sketch on a dims prompt: floor SF came from the confirmed wall lengths
    // (shoelace over the polygon — still the contractor's numbers, Hard Rule
    // 1). wall_sf only once ceiling height is known; length/width stay null —
    // the room isn't a rectangle, that's why it was sketched.
    const area = await db.areas.get(step.areaId);
    if (area) {
      await db.areas.put({
        ...area,
        floor_sf: m.qty,
        wall_sf: area.ceiling_height_ft
          ? Math.round(perimeterLF(m.dims.points) * area.ceiling_height_ft * 100) / 100
          : area.wall_sf,
      });
    }
  }
  return saved;
}

export async function removeMeasurement(si: ScopeItem, index: number): Promise<ScopeItem> {
  const all = parsedMeasurements(si).filter((_, i) => i !== index);
  return db.scope_items.put({ ...si, measurements: all.length > 0 ? JSON.stringify(all) : null });
}

export async function skipItem(step: Step, existing: ScopeItem | null, reason: string): Promise<ScopeItem> {
  const si = await ensureScopeItem(step, existing);
  return db.scope_items.put({ ...si, skipped: 1, skip_reason: reason });
}

export async function unskipItem(si: ScopeItem): Promise<ScopeItem> {
  return db.scope_items.put({ ...si, skipped: 0, skip_reason: null });
}

export async function addPhoto(walkthroughId: string, step: Step, existing: ScopeItem | null, blob: Blob): Promise<Photo> {
  const si = await ensureScopeItem(step, existing);
  const photo: Photo = {
    id: newId(),
    scope_item_id: si.id,
    area_id: step.areaId,
    walkthrough_id: walkthroughId,
    r2_key: null, // R2 upload lands next session; blob waits in IndexedDB
    thumbnail_key: null,
    caption: null,
    annotation_data: null,
    taken_at: now(),
    gps_lat: null,
    gps_lng: null,
    sync_status: "pending",
    updated_at: now(),
  };
  await putBlob({ id: photo.id, kind: "photo", blob });
  return db.photos.put(photo);
}

export async function addVoiceNote(step: Step, existing: ScopeItem | null, blob: Blob, durationSec: number): Promise<Note> {
  const si = await ensureScopeItem(step, existing);
  const note: Note = {
    id: newId(),
    parent_type: "scope_item",
    parent_id: si.id,
    type: "voice",
    audio_r2_key: null, // upload + Groq transcription queue: next session
    transcript: null,
    duration_sec: durationSec,
    sync_status: "pending",
    created_at: now(),
    updated_at: now(),
  };
  await putBlob({ id: note.id, kind: "audio", blob });
  return db.notes.put(note);
}

export async function addTextNote(step: Step, existing: ScopeItem | null, text: string): Promise<Note> {
  const si = await ensureScopeItem(step, existing);
  const note: Note = {
    id: newId(),
    parent_type: "scope_item",
    parent_id: si.id,
    type: "text",
    audio_r2_key: null,
    transcript: text,
    duration_sec: null,
    sync_status: "pending",
    created_at: now(),
    updated_at: now(),
  };
  return db.notes.put(note);
}
