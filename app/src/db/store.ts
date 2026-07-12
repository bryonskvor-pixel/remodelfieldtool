// Offline entity store. Every write stamps updated_at and marks the row dirty;
// the sync engine (db/sync.ts) pushes dirty rows when a connection exists and
// clears the flag on server ack. Reads always come from IndexedDB — the app
// never needs the network to run a walkthrough (Hard Rule 2).

import { ENTITY_STORES, idbDelete, idbGet, idbGetAll, idbGetDirty, idbPut, type EntityStore } from "./idb";
import type { Area, BidSheet, Contractor, LineItem, Note, Photo, PriceBookItem, Project, Proposal, ScopeItem, Template, Walkthrough } from "../types";

export type Synced<T> = T & { _dirty?: 0 | 1 };

export function newId(): string {
  // crypto.randomUUID only exists in secure contexts (HTTPS/localhost);
  // phone testing over LAN HTTP needs the getRandomValues fallback.
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

/**
 * Merge a server-pulled row into the local store (LWW, §3): a locally-dirty
 * row always wins (its edit pushes on the next sync), otherwise the newer
 * updated_at wins. Written rows are clean — pulls never re-enter the queue.
 */
export async function putServer(store: EntityStore, row: Record<string, unknown>): Promise<boolean> {
  if (typeof row.id !== "string") return false;
  const local = await idbGet<{ updated_at?: string; _dirty?: 0 | 1 }>(store, row.id);
  if (local?._dirty) return false;
  if (local?.updated_at && typeof row.updated_at === "string" && row.updated_at < local.updated_at) return false;
  await idbPut(store, { ...row, _dirty: 0 as const });
  return true;
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
  price_book_items: {
    put: (r: PriceBookItem) => put<PriceBookItem>("price_book_items", r),
    get: (id: string) => get<PriceBookItem>("price_book_items", id),
    all: () => all<PriceBookItem>("price_book_items"),
  },
  bid_sheets: {
    put: (r: BidSheet) => put<BidSheet>("bid_sheets", r),
    get: (id: string) => get<BidSheet>("bid_sheets", id),
    all: () => all<BidSheet>("bid_sheets"),
  },
  line_items: {
    put: (r: LineItem) => put<LineItem>("line_items", r),
    get: (id: string) => get<LineItem>("line_items", id),
    all: () => all<LineItem>("line_items"),
  },
  proposals: {
    put: (r: Proposal) => put<Proposal>("proposals", r),
    get: (id: string) => get<Proposal>("proposals", id),
    all: () => all<Proposal>("proposals"),
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

/** For batch server pulls: one notification after many putServer calls. */
export function notifyStoreChange(): void {
  notifyChange();
}
