// Generate-bid-sheet orchestration: loads walkthrough data from the offline
// store, runs the pure generator, and merges the result into the project's
// draft bid sheet. Regeneration is additive (§8 / plan decision 2): lines the
// contractor has touched are never overwritten or deleted; a generated line
// whose source item left the scope is badged for manual review instead.

import { cachedContractor, cachedTemplates, db, newId, now } from "../db/store";
import { buildSteps } from "../walkthrough/engine";
import type { BidSheet, LineItem, Template } from "../types";
import {
  divisionRank, generateBidLines, mergeLines, seedGeneralConditions, type GeneratedLine,
} from "./bidgen";

const ORPHAN_NOTE = "⚠ source item no longer in scope";

function toLineItem(g: GeneratedLine, bidSheetId: string, sortOrder: number): LineItem {
  return {
    id: newId(),
    bid_sheet_id: bidSheetId,
    scope_item_id: g.scope_item_id,
    price_book_item_id: null,
    division: g.division,
    description: g.description,
    qty: g.qty,
    unit: g.unit,
    unit_price: null,
    extended: null,
    is_allowance: g.is_allowance,
    allowance_note: null,
    is_optional: 0,
    is_excluded_display: g.is_excluded_display,
    internal_note: g.internal_note,
    cost_breakdown: null,
    deleted: 0,
    sort_order: sortOrder,
    created_at: now(),
    updated_at: now(),
  };
}

/** Generate (or regenerate into) the project's draft bid sheet; returns its id. */
export async function generateBidSheet(walkthroughId: string): Promise<string> {
  const walkthrough = await db.walkthroughs.get(walkthroughId);
  if (!walkthrough) throw new Error("walkthrough not found");
  const project = await db.projects.get(walkthrough.project_id);
  if (!project) throw new Error("project not found");

  const [allAreas, allItems, templates, contractor] = await Promise.all([
    db.areas.all(), db.scope_items.all(), cachedTemplates(), cachedContractor(),
  ]);
  const areas = allAreas.filter((a) => a.walkthrough_id === walkthroughId);
  const areaIds = new Set(areas.map((a) => a.id));
  const scopeItems = allItems.filter((si) => areaIds.has(si.area_id));
  const templatesByType = new Map<string, Template>(templates.map((t) => [t.project_type, t]));

  const steps = buildSteps(areas, templatesByType, scopeItems);
  const fromMappings = generateBidLines({ steps, scopeItems, areas });
  const generated = [
    ...fromMappings,
    ...seedGeneralConditions(project, scopeItems, fromMappings),
  ];

  // Find or create the project's draft sheet. Version stays 1 this phase;
  // versioning arrives with proposals (§9).
  const sheets = await db.bid_sheets.all();
  let sheet = sheets.find((s) => s.project_id === project.id && s.status === "draft");
  if (!sheet) {
    sheet = {
      id: newId(),
      project_id: project.id,
      version: 1,
      status: "draft",
      subtotal: null,
      markup_pct: contractor?.default_markup_pct ?? 20,
      markup_amount: null,
      tax_amount: null,
      total: null,
      created_at: now(),
      updated_at: now(),
    } satisfies BidSheet;
    await db.bid_sheets.put(sheet);
  }

  const allLines = await db.line_items.all();
  const existing = allLines.filter((l) => l.bid_sheet_id === sheet.id);
  const { toInsert, orphanIds } = mergeLines(existing, generated);

  // sort_order groups by §5 division; appended lines land after existing ones
  // in the same division.
  let index = existing.length;
  for (const g of toInsert) {
    await db.line_items.put(toLineItem(g, sheet.id, divisionRank(g.division) * 1000 + index++));
  }
  const orphanSet = new Set(orphanIds);
  for (const line of existing) {
    if (orphanSet.has(line.id) && line.internal_note !== ORPHAN_NOTE) {
      await db.line_items.put({ ...line, internal_note: ORPHAN_NOTE });
    } else if (!orphanSet.has(line.id) && line.internal_note === ORPHAN_NOTE) {
      // Source item re-entered the scope (e.g. un-skipped): clear the badge.
      await db.line_items.put({ ...line, internal_note: null });
    }
  }
  return sheet.id;
}
