// Price book (§8.3, Hard Rule 6): every price the contractor enters is
// remembered per-contractor and offered back next time. Matching is by
// normalized description + unit — bid_mapping descriptions are
// template-stable, so repeat projects hit the same entry, and an edited
// description naturally forks its own entry. Rows live in the offline store
// and sync like everything else; the server never pools them across
// contractors.

import { db, newId, now } from "../db/store";
import type { LineItem, PriceBookItem, PriceHistoryEntry, Unit } from "../types";
import { normalizeDesc } from "./bidgen";

export function priceKey(description: string, unit: string): string {
  return `${normalizeDesc(description)}|${unit}`;
}

export interface PriceSuggestion {
  item: PriceBookItem;
  price: number;
  lastProjectId: string | null;
  lastDate: string | null;
}

function parseHistory(item: PriceBookItem): PriceHistoryEntry[] {
  if (!item.price_history) return [];
  try {
    const v = JSON.parse(item.price_history) as PriceHistoryEntry[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Pure lookup: the contractor's last price for this description+unit, with
 * provenance for the "Last used $X on [project], [date]" chip. */
export function suggestPrice(
  description: string,
  unit: string,
  book: PriceBookItem[],
): PriceSuggestion | null {
  const key = priceKey(description, unit);
  const item = book.find((b) => b.active && priceKey(b.description, b.unit) === key);
  if (!item || item.last_unit_price === null) return null;
  const history = parseHistory(item);
  const last = history[history.length - 1];
  return {
    item,
    price: item.last_unit_price,
    lastProjectId: last?.project_id ?? null,
    lastDate: last?.date ?? null,
  };
}

/**
 * Record a committed price (accepted suggestion or typed fresh): find-or-create
 * the book entry by key, append to price_history, update last_unit_price, and
 * point the line at it. Looked up at commit time so an edited description
 * creates/updates its own entry.
 */
export async function recordPrice(
  line: LineItem,
  price: number,
  projectId: string | null,
  split?: { labor: number; material: number },
): Promise<PriceBookItem> {
  const key = priceKey(line.description, line.unit);
  const book = await db.price_book_items.all();
  const existing = book.find((b) => priceKey(b.description, b.unit) === key);
  const entry: PriceHistoryEntry = { price, project_id: projectId, date: now() };
  let item: PriceBookItem;
  if (existing) {
    const history = [...parseHistory(existing), entry];
    item = {
      ...existing,
      last_unit_price: price,
      price_history: JSON.stringify(history),
      labor_material_split: split ? JSON.stringify(split) : existing.labor_material_split,
      active: 1,
    };
  } else {
    item = {
      id: newId(),
      category: line.division,
      description: line.description,
      unit: line.unit as Unit,
      last_unit_price: price,
      price_history: JSON.stringify([entry]),
      labor_material_split: split ? JSON.stringify(split) : null,
      active: 1,
      created_at: now(),
      updated_at: now(),
    };
  }
  await db.price_book_items.put(item);
  return item;
}
