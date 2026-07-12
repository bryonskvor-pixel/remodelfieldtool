// Minimal promisified IndexedDB wrapper. IndexedDB is the PWA's offline store
// (Hard Rule 2): every capture lands here first and survives airplane mode and
// page reloads; sync to the server happens opportunistically on top.
// (Turso embedded replicas are a Node-side construct — the server uses one;
// the browser side is IndexedDB, which we need for photo/audio blobs anyway.)

const DB_NAME = "scopewalk";
const DB_VERSION = 2; // v2: bid_sheets/line_items/price_book_items (Phase 2)

// Entity stores hold rows shaped like the server schema plus a `_dirty` flag.
// `blobs` holds { id, blob, kind } for photos/audio awaiting R2 upload.
// `kv` holds contractor cache, cached templates, and misc app state.
export const ENTITY_STORES = [
  "projects", "walkthroughs", "areas", "scope_items", "photos", "notes",
  "price_book_items", "bid_sheets", "line_items",
] as const;
export type EntityStore = (typeof ENTITY_STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ENTITY_STORES) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: "id" });
          store.createIndex("_dirty", "_dirty");
        }
      }
      if (!db.objectStoreNames.contains("blobs")) {
        db.createObjectStore("blobs", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("kv")) {
        db.createObjectStore("kv", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbPut(store: string, value: unknown): Promise<void> {
  const db = await openDb();
  await request(db.transaction(store, "readwrite").objectStore(store).put(value));
}

export async function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return request(db.transaction(store, "readonly").objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function idbGetAll<T>(store: string): Promise<T[]> {
  const db = await openDb();
  return request(db.transaction(store, "readonly").objectStore(store).getAll()) as Promise<T[]>;
}

export async function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  const db = await openDb();
  await request(db.transaction(store, "readwrite").objectStore(store).delete(key));
}

export async function idbGetDirty<T>(store: EntityStore): Promise<T[]> {
  const db = await openDb();
  const index = db.transaction(store, "readonly").objectStore(store).index("_dirty");
  return request(index.getAll(1)) as Promise<T[]>;
}
