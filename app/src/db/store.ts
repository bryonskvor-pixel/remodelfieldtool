// Offline entity store. Every write stamps updated_at and marks the row dirty;
// the sync engine (db/sync.ts) pushes dirty rows when a connection exists and
// clears the flag on server ack. Reads always come from IndexedDB — the app
// never needs the network to run a walkthrough (Hard Rule 2).

import { ENTITY_STORES, idbDelete, idbGet, idbGetAll, idbGetDirty, idbPut, type EntityStore } from "./idb";
import type { Area, Contractor, Note, Photo, Project, ScopeItem, Template, Walkthrough } from "../types";

export type Synced<T> = T & { _dirty?: 0 | 1 };

export function newId(): string {
  return crypto.randomUUID();
}

export function now(): string {
  return new Date().toISOString();
}

export async function put<T extends { id: string; updated_at?: string }>(
  store: EntityStore,
  row: T,
): Promise<T> {
  const stamped = { ...row, updated_at: now(), _dirty: 1 as const };
  await idbPut(store, stamped);
  notifyChange();
  return stamped;
}

export async function get<T>(store: EntityStore, id: string): Promise<T | undefined> {
  return idbGet<T>(store, id);
}

export async function all<T>(store: EntityStore): Promise<T[]> {
  return idbGetAll<T>(store);
}

export async function remove(store: EntityStore, id: string): Promise<void> {
  await idbDelete(store, id);
  notifyChange();
}

// Typed conveniences ----------------------------------------------------------

export const db = {
  projects: {
    put: (r: Project) => put<Project>("projects", r),
    get: (id: string) => get<Project>("projects", id),
    all: () => all<Project>("projects"),
  },
  walkthroughs: {
    put: (r: Walkthrough) => put<Walkthrough>("walkthroughs", r),
    get: (id: string) => get<Walkthrough>("walkthroughs", id),
    all: () => all<Walkthrough>("walkthroughs"),
  },
  areas: {
    put: (r: Area) => put<Area>("areas", r),
    get: (id: string) => get<Area>("areas", id),
    all: () => all<Area>("areas"),
  },
  scope_items: {
    put: (r: ScopeItem) => put<ScopeItem>("scope_items", r),
    get: (id: string) => get<ScopeItem>("scope_items", id),
    all: () => all<ScopeItem>("scope_items"),
  },
  photos: {
    put: (r: Photo) => put<Photo>("photos", r),
    get: (id: string) => get<Photo>("photos", id),
    all: () => all<Photo>("photos"),
  },
  notes: {
    put: (r: Note) => put<Note>("notes", r),
    get: (id: string) => get<Note>("notes", id),
    all: () => all<Note>("notes"),
  },
};

// Blobs (photo/audio payloads awaiting R2 upload — next session) --------------

export interface StoredBlob {
  id: string; // matches the photo/note id
  kind: "photo" | "audio";
  blob: Blob;
}

export async function putBlob(entry: StoredBlob): Promise<void> {
  await idbPut("blobs", entry);
}

export async function getBlob(id: string): Promise<StoredBlob | undefined> {
  return idbGet<StoredBlob>("blobs", id);
}

// KV (contractor cache, cached templates) --------------------------------------

export async function kvSet(key: string, value: unknown): Promise<void> {
  await idbPut("kv", { key, value });
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const row = await idbGet<{ key: string; value: T }>("kv", key);
  return row?.value;
}

export async function cacheContractor(c: Contractor): Promise<void> {
  await kvSet("contractor", c);
}

export async function cachedContractor(): Promise<Contractor | undefined> {
  return kvGet<Contractor>("contractor");
}

export async function cacheTemplates(templates: Template[]): Promise<void> {
  await kvSet("templates", templates);
}

export async function cachedTemplates(): Promise<Template[]> {
  return (await kvGet<Template[]>("templates")) ?? [];
}

// Dirty scan for the sync engine ----------------------------------------------

export async function dirtyRows(): Promise<Record<EntityStore, Record<string, unknown>[]>> {
  const out = {} as Record<EntityStore, Record<string, unknown>[]>;
  for (const store of ENTITY_STORES) {
    out[store] = await idbGetDirty<Record<string, unknown>>(store);
  }
  return out;
}

/** Marks rows clean after a server ack — but only if the row wasn't edited again mid-sync. */
export async function markClean(store: EntityStore, id: string, syncedUpdatedAt: string): Promise<void> {
  const row = await idbGet<{ id: string; updated_at: string; _dirty: 0 | 1 }>(store, id);
  if (row && row.updated_at === syncedUpdatedAt) {
    await idbPut(store, { ...row, _dirty: 0 });
  }
}

// Change notification: screens re-read from IDB when anything writes.
type Listener = () => void;
const listeners = new Set<Listener>();

export function onStoreChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyChange() {
  for (const fn of listeners) fn();
}
