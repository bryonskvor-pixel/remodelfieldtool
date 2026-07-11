// Sync engine: pushes dirty rows to POST /api/sync when online, uploads
// pending photo/audio blobs to R2 (via the server), and pulls the bootstrap
// payload — including walkthrough child rows from other devices — into the
// local store. Capture never waits on this (Hard Rule 2/3) — it runs
// opportunistically: on app start, on the browser 'online' event, and
// debounced after writes.

import { ENTITY_STORES, type EntityStore } from "./idb";
import {
  cacheContractor, cacheTemplates, db, dirtyRows, kvGet, kvSet, markClean,
  notifyStoreChange, onStoreChange, putServer, type Synced,
} from "./store";
import { uploadPendingMedia, watchTranscript } from "./media";
import type { Contractor, Note, Template } from "../types";

export type SyncState = {
  online: boolean;
  syncing: boolean;
  pending: number;
  lastError: string | null;
  lastSyncedAt: string | null;
};

let state: SyncState = {
  online: navigator.onLine,
  syncing: false,
  pending: 0,
  lastError: null,
  lastSyncedAt: null,
};

type Listener = (s: SyncState) => void;
const listeners = new Set<Listener>();

export function onSyncState(fn: Listener): () => void {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

function setState(patch: Partial<SyncState>) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
}

async function refreshPending(): Promise<void> {
  const dirty = await dirtyRows();
  let pending = Object.values(dirty).reduce((n, rows) => n + rows.length, 0);
  // Media blobs owed to R2 count as pending too — a clean row whose photo
  // bytes haven't left the phone isn't "synced" from the field's perspective.
  for (const p of await db.photos.all()) {
    if (p.sync_status !== "synced" && !(p as Synced<typeof p>)._dirty) pending += 1;
  }
  for (const n of await db.notes.all()) {
    if (n.type === "voice" && n.sync_status !== "synced" && !(n as Synced<typeof n>)._dirty) pending += 1;
  }
  setState({ pending });
}

let syncQueued = false;

/** Push all dirty rows. Safe to call anytime; no-ops offline or if already running. */
export async function syncNow(): Promise<void> {
  await refreshPending();
  if (!navigator.onLine) {
    setState({ online: false });
    return;
  }
  if (state.syncing) {
    syncQueued = true;
    return;
  }
  setState({ online: true, syncing: true, lastError: null });
  try {
    const dirty = await dirtyRows();
    const batch: Record<string, unknown[]> = {};
    let total = 0;
    for (const store of ENTITY_STORES) {
      // Strip the local-only _dirty flag before shipping rows.
      batch[store] = dirty[store].map(({ _dirty, ...row }) => row);
      total += dirty[store].length;
    }
    if (total > 0) {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(batch),
      });
      if (!res.ok) throw new Error(`sync failed: HTTP ${res.status}`);
      const result = (await res.json()) as {
        applied: Record<string, string[]>;
        rejected: { table: string; id: string; reason: string }[];
      };
      for (const store of ENTITY_STORES) {
        for (const id of result.applied[store] ?? []) {
          const row = dirty[store].find((r) => r["id"] === id) as { updated_at: string } | undefined;
          if (row) await markClean(store as EntityStore, id, row.updated_at);
        }
      }
      if (result.rejected.length > 0) {
        // A rejection here means a bug or tampering, not a transient failure;
        // surface it rather than retrying forever.
        console.error("[sync] rejected rows", result.rejected);
        setState({ lastError: `${result.rejected.length} row(s) rejected by server` });
      }
    }
    // Rows are pushed; now move pending photo/audio blobs into R2. Failures
    // just stay owed and retry on the next pass.
    const owed = await uploadPendingMedia();
    if (owed > 0) console.warn(`[sync] ${owed} media upload(s) still pending`);
    // Voice notes whose transcript hasn't landed yet: watch for it briefly.
    for (const n of (await db.notes.all()) as Synced<Note>[]) {
      if (n.type === "voice" && n.audio_r2_key && !n.transcript && !n._dirty) watchTranscript(n.id);
    }
    setState({ lastSyncedAt: new Date().toISOString() });
  } catch (e) {
    setState({ lastError: e instanceof Error ? e.message : "sync failed" });
  } finally {
    setState({ syncing: false });
    await refreshPending();
    if (syncQueued) {
      syncQueued = false;
      void syncNow();
    }
  }
}

/**
 * Pull contractor + templates + entity rows into the offline store. Entity
 * rows merge last-write-wins with local edits (dirty local rows always win) —
 * this is how a second device renders walkthroughs it never captured, and how
 * server-written transcripts reach every device.
 */
export async function pullBootstrap(): Promise<Contractor | null> {
  try {
    const res = await fetch("/api/bootstrap", { credentials: "include" });
    if (res.status === 401) return null; // genuinely signed out
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      contractor: Contractor;
      templates: { project_type: string; checklist_json: string }[];
    } & Partial<Record<EntityStore, Record<string, unknown>[]>>;
    await cacheContractor(data.contractor);
    await cacheTemplates(data.templates.map((t) => JSON.parse(t.checklist_json) as Template));
    let merged = 0;
    for (const store of ENTITY_STORES) {
      for (const row of data[store] ?? []) {
        // Strip server-only contractor_id: client rows never carry it (Hard Rule 7).
        const { contractor_id, ...clientRow } = row;
        void contractor_id;
        if (await putServer(store, clientRow)) merged += 1;
      }
    }
    if (merged > 0) notifyStoreChange();
    await kvSet("bootstrap_at", new Date().toISOString());
    return data.contractor;
  } catch {
    // Offline or server down: caller falls back to the cached contractor.
    return (await kvGet<Contractor>("contractor")) ?? null;
  }
}

let debounce: ReturnType<typeof setTimeout> | undefined;

/** Wire auto-sync: online event + debounced push after any local write. */
export function startAutoSync(): void {
  window.addEventListener("online", () => {
    setState({ online: true });
    void syncNow();
  });
  window.addEventListener("offline", () => setState({ online: false }));
  onStoreChange(() => {
    void refreshPending();
    clearTimeout(debounce);
    debounce = setTimeout(() => void syncNow(), 2500);
  });
  void syncNow();
}
