// Bid generation engine (§8): turns captured scope items into draft line
// items via the templates' bid_mapping rules, seeds General Conditions from
// project facts, and does the bid math. Pure module (no IO), unit-tested like
// the completeness engine.
//
// Hard Rule 1 lives here: a quantity is only ever pre-filled from numbers the
// contractor entered (a measurement whose unit matches, or an area's measured
// floor/wall SF). Anything else stays null for the contractor to enter, and
// prices are never suggested by this module at all (the price book handles
// that, from the contractor's own history).

import type { Area, BidMapping, LineItem, Project, ScopeItem } from "../types";
import { parsedAnswer, parsedMeasurements, type Step } from "../walkthrough/engine";

// §5 divisions, in bid-sheet/proposal order. Keys match templates/*.json
// bid_mapping.division and scope_items.category.
export const DIVISION_ORDER: { key: string; label: string }[] = [
  { key: "general_conditions", label: "General Conditions" },
  { key: "demolition_disposal", label: "Demolition & Disposal" },
  { key: "sitework_concrete", label: "Sitework / Excavation / Concrete" },
  { key: "structural_framing", label: "Structural & Framing" },
  { key: "exterior", label: "Exterior" },
  { key: "plumbing", label: "Plumbing" },
  { key: "electrical", label: "Electrical" },
  { key: "hvac_mechanical", label: "HVAC / Mechanical" },
  { key: "insulation_air_sealing", label: "Insulation & Air Sealing" },
  { key: "drywall_plaster", label: "Drywall & Plaster" },
  { key: "doors_trim_carpentry", label: "Interior Doors & Trim / Carpentry" },
  { key: "cabinetry_countertops", label: "Cabinetry & Countertops" },
  { key: "tile_stone", label: "Tile & Stone" },
  { key: "flooring", label: "Flooring" },
  { key: "paint_finishes", label: "Paint & Finishes" },
  { key: "fixtures_appliances", label: "Fixtures & Appliances" },
  { key: "specialties", label: "Specialties" },
  { key: "allowances", label: "Allowances" },
  { key: "exclusions", label: "Exclusions" },
];

const DIVISION_RANK = new Map(DIVISION_ORDER.map((d, i) => [d.key, i]));

/** Unknown divisions sort after the known ones rather than crashing. */
export function divisionRank(key: string): number {
  return DIVISION_RANK.get(key) ?? DIVISION_ORDER.length;
}

export function divisionLabel(key: string): string {
  return DIVISION_ORDER.find((d) => d.key === key)?.label ?? key.replace(/_/g, " ");
}

/** Price-book/merge matching key half: lowercase, trimmed, single-spaced. */
export function normalizeDesc(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

// ---- Line generation ----------------------------------------------------------

export interface GeneratedLine {
  scope_item_id: string | null; // null for GC seeds and freeform adds
  division: string;
  description: string;
  qty: number | null; // null = contractor must enter (Hard Rule 1)
  unit: string;
  is_allowance: 0 | 1;
  is_excluded_display: 0 | 1;
  internal_note: string | null; // provenance, e.g. "from kitchen.soffit"
}

export function whenMatches(
  when: BidMapping["when"],
  answers: string[],
  flags: string[],
): boolean {
  if (!when) return true;
  if (when.answer !== undefined) return answers.includes(when.answer);
  if (when.answer_in !== undefined) return answers.some((a) => when.answer_in!.includes(a));
  if (when.flag !== undefined) return flags.includes(when.flag);
  return true;
}

function parsedFlags(si: ScopeItem): string[] {
  if (!si.flags) return [];
  try {
    const v = JSON.parse(si.flags) as string[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function answerList(si: ScopeItem): string[] {
  const a = parsedAnswer(si);
  if (a === null) return [];
  return Array.isArray(a) ? a : [a];
}

/**
 * qty pre-fill (Hard Rule 1 — contractor-entered numbers only):
 * - qty_source floor_sf/wall_sf → the area's measured value (or null)
 * - lump → 1 (a count, not a measurement)
 * - one mapping for this unit on the item → sum of unit-matching measurement
 *   qtys (several countertop runs add up)
 * - several mappings sharing the unit (e.g. base LF + wall LF cabinets) →
 *   measurements assign by position; a missing one stays null. Copying a
 *   single measurement into every same-unit line would invent an allocation
 *   the contractor never made.
 * - nothing matches → null and the UI asks the contractor.
 */
function prefillQty(
  mapping: BidMapping,
  si: ScopeItem,
  area: Area | undefined,
  unitPeers: number, // mappings on this item that fired with the same unit
  unitIndex: number, // this mapping's position among them
): number | null {
  if (mapping.qty_source === "floor_sf") return area?.floor_sf ?? null;
  if (mapping.qty_source === "wall_sf") return area?.wall_sf ?? null;
  if (mapping.unit === "lump") return 1;
  const matching = parsedMeasurements(si).filter(
    (m) => m.unit === mapping.unit && typeof m.qty === "number",
  );
  if (matching.length === 0) return null;
  if (unitPeers > 1) return matching[unitIndex]?.qty ?? null;
  return matching.reduce((sum, m) => sum + (m.qty as number), 0);
}

/**
 * Every non-skipped scope item with action ≠ no_change seeds line items via
 * its template's bid_mapping (§8.1). Steps come from buildSteps, so
 * conditional prompts that never fired aren't here at all; skipped items feed
 * proposal assumptions later, never pricing.
 */
export function generateBidLines(input: {
  steps: Step[];
  scopeItems: ScopeItem[];
  areas: Area[];
}): GeneratedLine[] {
  const areaById = new Map(input.areas.map((a) => [a.id, a]));
  const lines: GeneratedLine[] = [];
  for (const step of input.steps) {
    const si = input.scopeItems.find(
      (s) => s.area_id === step.areaId && s.checklist_key === step.item.key,
    );
    if (!si || si.skipped || si.action === "no_change") continue;
    const answers = answerList(si);
    const flags = parsedFlags(si);
    const fired = (step.item.bid_mapping ?? []).filter((m) => whenMatches(m.when, answers, flags));
    const unitCounts = new Map<string, number>();
    const unitSeen = new Map<string, number>();
    for (const m of fired) {
      if (!m.qty_source && m.unit !== "lump") {
        unitCounts.set(m.unit, (unitCounts.get(m.unit) ?? 0) + 1);
      }
    }
    for (const mapping of fired) {
      const excluded = mapping.division === "exclusions";
      const measured = !mapping.qty_source && mapping.unit !== "lump";
      const unitIndex = measured ? (unitSeen.get(mapping.unit) ?? 0) : 0;
      if (measured) unitSeen.set(mapping.unit, unitIndex + 1);
      lines.push({
        scope_item_id: si.id,
        division: mapping.division,
        description: mapping.description,
        qty: excluded
          ? null
          : prefillQty(mapping, si, areaById.get(step.areaId), unitCounts.get(mapping.unit) ?? 1, unitIndex),
        unit: mapping.unit,
        is_allowance: mapping.division === "allowances" || mapping.unit === "allowance" ? 1 : 0,
        is_excluded_display: excluded ? 1 : 0,
        internal_note: `from ${step.item.key}`,
      });
    }
  }
  return lines;
}

// ---- General Conditions auto-seed (§8.7) ---------------------------------------

const PROJECT_TYPE_LABEL: Record<string, string> = {
  kitchen: "kitchen remodel",
  bath: "bathroom remodel",
  basement: "basement finishing",
  deck_patio: "deck/patio",
  addition: "addition",
  general: "general remodel",
};

/** First measurement qty (or numeric answer) on a universal item, any area. */
function universalNumber(scopeItems: ScopeItem[], key: string): number | null {
  for (const si of scopeItems) {
    if (si.checklist_key !== key || si.skipped) continue;
    const m = parsedMeasurements(si).find((x) => typeof x.qty === "number");
    if (m) return m.qty;
    const a = parsedAnswer(si);
    if (typeof a === "string" && a !== "" && !Number.isNaN(Number(a))) return Number(a);
  }
  return null;
}

function universalAnswer(scopeItems: ScopeItem[], key: string): string | null {
  for (const si of scopeItems) {
    if (si.checklist_key !== key || si.skipped) continue;
    const a = parsedAnswer(si);
    if (typeof a === "string") return a;
    if (Array.isArray(a) && a.length > 0) return a[0]!;
  }
  return null;
}

/**
 * §8.7 seeds come from what the walkthrough captured: year built and occupancy
 * live on the universal-block scope items (the project row's fields are a
 * fallback — the capture flow doesn't write them).
 *
 * The templates' own bid_mappings already produce some GC lines (dust
 * protection from universal.occupied, lead-safe from universal.lead_paint,
 * the deck permit) — this seeder is the backstop for what capture didn't
 * cover, so a seed whose topic already generated is skipped, not duplicated.
 */
export function seedGeneralConditions(
  project: Project,
  scopeItems: ScopeItem[] = [],
  generated: GeneratedLine[] = [],
): GeneratedLine[] {
  const covered = (topic: string) =>
    generated.some(
      (l) => l.division === "general_conditions" && normalizeDesc(l.description).includes(topic),
    );
  const gc = (description: string): GeneratedLine => ({
    scope_item_id: null,
    division: "general_conditions",
    description,
    qty: 1,
    unit: "lump",
    is_allowance: 0,
    is_excluded_display: 0,
    internal_note: "auto-seeded general condition",
  });
  const label = PROJECT_TYPE_LABEL[project.project_type] ?? project.project_type;
  const bigDumpster = ["basement", "addition", "general"].includes(project.project_type);
  const lines: GeneratedLine[] = [];
  if (!covered("permit")) lines.push(gc(`Building permit — ${label}`));
  if (!covered("dumpster")) lines.push(gc(`Dumpster (${bigDumpster ? "30" : "20"} yd) & disposal fees`));
  const occupancy = universalAnswer(scopeItems, "universal.occupied");
  const occupied = occupancy !== null ? occupancy !== "vacant" : !!project.occupied;
  if (occupied && !covered("dust protection")) {
    lines.push(gc("Floor & dust protection (occupied home)"));
  }
  const yearBuilt =
    universalNumber(scopeItems, "universal.year_built") ?? project.property_year_built;
  if (yearBuilt !== null && yearBuilt < 1978 && !covered("lead-safe")) {
    lines.push(gc("Lead-safe work practices (EPA RRP, pre-1978 home)"));
  }
  if (project.project_type === "addition" && !covered("portable toilet")) {
    lines.push(gc("Portable toilet"));
  }
  if (!covered("final clean")) lines.push(gc("Final clean"));
  return lines;
}

// ---- Regeneration merge ---------------------------------------------------------

function mergeKey(scopeItemId: string | null, division: string, description: string): string {
  return `${scopeItemId ?? ""}|${division}|${normalizeDesc(description)}`;
}

export interface MergeResult {
  /** Generated lines with no existing counterpart — insert these. */
  toInsert: GeneratedLine[];
  /** Existing generated lines whose source scope item no longer produces them
   * (skipped/no_change/answer changed). Badge, never delete (§8 — priced work
   * is the contractor's). */
  orphanIds: string[];
}

/**
 * Regeneration is an additive merge: an existing line matching a generated one
 * on (scope_item_id, division, normalized description) is left entirely alone —
 * its price, qty edits, and allowance state survive. Manual lines (no
 * scope_item_id, unmatched description) are never touched.
 */
export function mergeLines(existing: LineItem[], generated: GeneratedLine[]): MergeResult {
  const generatedKeys = new Set(
    generated.map((g) => mergeKey(g.scope_item_id, g.division, g.description)),
  );
  const existingKeys = new Set(
    existing.map((e) => mergeKey(e.scope_item_id, e.division, e.description)),
  );
  const toInsert = generated.filter(
    (g) => !existingKeys.has(mergeKey(g.scope_item_id, g.division, g.description)),
  );
  const orphanIds = existing
    .filter(
      (e) =>
        e.scope_item_id !== null &&
        !generatedKeys.has(mergeKey(e.scope_item_id, e.division, e.description)),
    )
    .map((e) => e.id);
  return { toInsert, orphanIds };
}

// ---- Bid math (§8.8) ------------------------------------------------------------

export interface BidTotals {
  subtotal: number;
  markup_amount: number;
  tax_amount: number;
  total: number;
  /** Gross margin: markup / (subtotal + markup). Shown to the contractor at
   * all times; internal only (Hard Rule 5). */
  margin_pct: number;
  /** True when the contractor has no parseable tax rule — UI labels tax
   * "No tax rule set" instead of silently pretending 0 was computed. */
  tax_rule_missing: boolean;
}

/** Tax rule is a bare percent ("7.25") or JSON {"rate": n}; else null. */
export function parseTaxRule(rule: string | null | undefined): number | null {
  if (rule === null || rule === undefined || rule.trim() === "") return null;
  const bare = Number(rule);
  if (!Number.isNaN(bare)) return bare;
  try {
    const parsed = JSON.parse(rule) as { rate?: unknown };
    if (typeof parsed === "object" && parsed !== null && typeof parsed.rate === "number") {
      return parsed.rate;
    }
  } catch {
    /* unparseable → null */
  }
  return null;
}

export function lineExtended(
  line: Pick<LineItem, "qty" | "unit_price" | "is_excluded_display">,
): number | null {
  if (line.is_excluded_display) return null;
  if (line.qty === null || line.unit_price === null) return null;
  return line.qty * line.unit_price;
}

/**
 * Subtotal sums priced, non-optional, non-excluded lines — allowances ARE
 * included (they're contract dollars); add-alternates are options on top.
 */
export function computeTotals(
  lines: Pick<LineItem, "qty" | "unit_price" | "is_optional" | "is_excluded_display">[],
  markupPct: number,
  taxRule: string | null | undefined,
): BidTotals {
  let subtotal = 0;
  for (const line of lines) {
    if (line.is_optional || line.is_excluded_display) continue;
    const ext = lineExtended({ ...line, is_excluded_display: 0 });
    if (ext !== null) subtotal += ext;
  }
  const markup_amount = subtotal * (markupPct / 100);
  const rate = parseTaxRule(taxRule);
  const tax_amount = rate !== null ? (subtotal + markup_amount) * (rate / 100) : 0;
  const total = subtotal + markup_amount + tax_amount;
  const priced = subtotal + markup_amount;
  return {
    subtotal,
    markup_amount,
    tax_amount,
    total,
    margin_pct: priced > 0 ? (markup_amount / priced) * 100 : 0,
    tax_rule_missing: rate === null,
  };
}
