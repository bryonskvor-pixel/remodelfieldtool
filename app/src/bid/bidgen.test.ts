import { describe, expect, it } from "vitest";
import type { Area, LineItem, Project, ScopeItem, TemplateItem } from "../types";
import type { Step } from "../walkthrough/engine";
import {
  computeTotals,
  divisionRank,
  generateBidLines,
  mergeLines,
  normalizeDesc,
  parseTaxRule,
  seedGeneralConditions,
  whenMatches,
  type GeneratedLine,
} from "./bidgen";

// ---- Factories ---------------------------------------------------------------

function templateItem(overrides: Partial<TemplateItem>): TemplateItem {
  return {
    key: "kitchen.test_item",
    division: "electrical",
    prompt: "Test",
    capture: ["choice"],
    required_level: "required",
    condition: null,
    photo_required: false,
    flags: [],
    bid_mapping: [],
    ...overrides,
  };
}

function step(item: TemplateItem, areaId = "area-1"): Step {
  return { areaId, areaName: "Kitchen", blockTitle: "Test block", item };
}

function scopeItem(overrides: Partial<ScopeItem>): ScopeItem {
  return {
    id: "si-1",
    area_id: "area-1",
    checklist_key: "kitchen.test_item",
    category: "electrical",
    title: "Test",
    existing_condition: null,
    planned_change: null,
    action: null,
    answer: null,
    measurements: null,
    flags: null,
    skipped: 0,
    skip_reason: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function area(overrides: Partial<Area>): Area {
  return {
    id: "area-1",
    walkthrough_id: "wt-1",
    name: "Kitchen",
    area_type: "kitchen",
    length_ft: null,
    width_ft: null,
    ceiling_height_ft: null,
    floor_sf: null,
    wall_sf: null,
    sort_order: 1,
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function project(overrides: Partial<Project>): Project {
  return {
    id: "p-1",
    lead_id: null,
    project_type: "kitchen",
    title: "Test Kitchen",
    property_year_built: null,
    occupied: 0,
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function lineItem(overrides: Partial<LineItem>): LineItem {
  return {
    id: "li-1",
    bid_sheet_id: "bs-1",
    scope_item_id: null,
    price_book_item_id: null,
    division: "electrical",
    description: "Test line",
    qty: null,
    unit: "ea",
    unit_price: null,
    extended: null,
    is_allowance: 0,
    allowance_note: null,
    is_optional: 0,
    is_excluded_display: 0,
    internal_note: null,
    cost_breakdown: null,
    deleted: 0,
    sort_order: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// ---- whenMatches ---------------------------------------------------------------

describe("whenMatches", () => {
  it("absent when-clause always matches", () => {
    expect(whenMatches(undefined, [], [])).toBe(true);
  });
  it("answer: exact membership", () => {
    expect(whenMatches({ answer: "vented" }, ["vented"], [])).toBe(true);
    expect(whenMatches({ answer: "vented" }, ["recirculating"], [])).toBe(false);
    expect(whenMatches({ answer: "vented" }, [], [])).toBe(false);
  });
  it("answer works against multi-select arrays", () => {
    expect(whenMatches({ answer: "b" }, ["a", "b", "c"], [])).toBe(true);
  });
  it("answer_in: any-of", () => {
    expect(whenMatches({ answer_in: ["a", "b"] }, ["b"], [])).toBe(true);
    expect(whenMatches({ answer_in: ["a", "b"] }, ["c"], [])).toBe(false);
  });
  it("flag: membership in flags", () => {
    expect(whenMatches({ flag: "island" }, [], ["island"])).toBe(true);
    expect(whenMatches({ flag: "island" }, ["island"], [])).toBe(false);
  });
});

// ---- generateBidLines ------------------------------------------------------------

describe("generateBidLines", () => {
  const mappedItem = templateItem({
    bid_mapping: [
      { division: "cabinetry_countertops", description: "Base cabinets supply & install", unit: "lf" },
      { division: "electrical", description: "Island receptacle (code required)", unit: "ea", when: { flag: "island" } },
    ],
  });

  it("unconditional mapping fires; conditional needs its flag", () => {
    const si = scopeItem({ answer: JSON.stringify("stock") });
    const lines = generateBidLines({ steps: [step(mappedItem)], scopeItems: [si], areas: [area({})] });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.description).toBe("Base cabinets supply & install");
    expect(lines[0]!.scope_item_id).toBe("si-1");
    expect(lines[0]!.internal_note).toBe("from kitchen.test_item");

    const flagged = scopeItem({ flags: JSON.stringify(["island"]) });
    const both = generateBidLines({ steps: [step(mappedItem)], scopeItems: [flagged], areas: [area({})] });
    expect(both.map((l) => l.description)).toContain("Island receptacle (code required)");
  });

  it("skipped items and no_change items produce nothing", () => {
    for (const si of [
      scopeItem({ skipped: 1, skip_reason: "Not applicable" }),
      scopeItem({ action: "no_change" }),
    ]) {
      expect(generateBidLines({ steps: [step(mappedItem)], scopeItems: [si], areas: [area({})] })).toEqual([]);
    }
  });

  it("no scope item captured → nothing (never invents scope)", () => {
    expect(generateBidLines({ steps: [step(mappedItem)], scopeItems: [], areas: [area({})] })).toEqual([]);
  });

  it("qty sums unit-matching measurements only (Hard Rule 1)", () => {
    const si = scopeItem({
      measurements: JSON.stringify([
        { qty: 12, unit: "lf" },
        { qty: 8, unit: "lf" },
        { qty: 140, unit: "sf" }, // different unit — must not leak into an lf line
      ]),
    });
    const lines = generateBidLines({ steps: [step(mappedItem)], scopeItems: [si], areas: [area({})] });
    expect(lines[0]!.qty).toBe(20);
  });

  it("mappings sharing a unit assign measurements by position, never copy (Hard Rule 1)", () => {
    const twoLf = templateItem({
      bid_mapping: [
        { division: "cabinetry_countertops", description: "Base cabinets supply & install", unit: "lf" },
        { division: "cabinetry_countertops", description: "Wall cabinets supply & install", unit: "lf" },
      ],
    });
    // one measurement: first line gets it, second stays null (no invented allocation)
    const one = scopeItem({ measurements: JSON.stringify([{ qty: 14, unit: "lf" }]) });
    const oneLines = generateBidLines({ steps: [step(twoLf)], scopeItems: [one], areas: [area({})] });
    expect(oneLines.map((l) => l.qty)).toEqual([14, null]);
    // two measurements: positional
    const two = scopeItem({
      measurements: JSON.stringify([{ qty: 14, unit: "lf" }, { qty: 22, unit: "lf" }]),
    });
    const twoLines = generateBidLines({ steps: [step(twoLf)], scopeItems: [two], areas: [area({})] });
    expect(twoLines.map((l) => l.qty)).toEqual([14, 22]);
  });

  it("no unit-matching measurement → qty null, never guessed", () => {
    const si = scopeItem({ measurements: JSON.stringify([{ qty: 140, unit: "sf" }]) });
    const lines = generateBidLines({ steps: [step(mappedItem)], scopeItems: [si], areas: [area({})] });
    expect(lines[0]!.qty).toBeNull();
  });

  it("qty_source floor_sf/wall_sf reads the area's measured value", () => {
    const item = templateItem({
      bid_mapping: [
        { division: "flooring", description: "Flooring install", unit: "sf", qty_source: "floor_sf" },
        { division: "paint_finishes", description: "Wall paint", unit: "sf", qty_source: "wall_sf" },
      ],
    });
    const si = scopeItem({ answer: JSON.stringify("lvp") });
    const withDims = generateBidLines({
      steps: [step(item)], scopeItems: [si], areas: [area({ floor_sf: 124 })],
    });
    expect(withDims.find((l) => l.division === "flooring")!.qty).toBe(124);
    expect(withDims.find((l) => l.division === "paint_finishes")!.qty).toBeNull(); // wall_sf unmeasured
  });

  it("lump lines get qty 1", () => {
    const item = templateItem({
      bid_mapping: [{ division: "plumbing", description: "Valve rough-in", unit: "lump" }],
    });
    const lines = generateBidLines({
      steps: [step(item)], scopeItems: [scopeItem({ answer: JSON.stringify("yes") })], areas: [area({})],
    });
    expect(lines[0]!.qty).toBe(1);
  });

  it("allowances/exclusions divisions set the line flags", () => {
    const item = templateItem({
      bid_mapping: [
        { division: "allowances", description: "Appliance allowance", unit: "allowance", when: { answer: "contractor_supplies_allowance" } },
        { division: "exclusions", description: "Appliances supplied by owner", unit: "lump", when: { answer: "owner_supplies" } },
      ],
    });
    const allowance = generateBidLines({
      steps: [step(item)], scopeItems: [scopeItem({ answer: JSON.stringify("contractor_supplies_allowance") })], areas: [area({})],
    });
    expect(allowance[0]!.is_allowance).toBe(1);
    expect(allowance[0]!.is_excluded_display).toBe(0);

    const excluded = generateBidLines({
      steps: [step(item)], scopeItems: [scopeItem({ answer: JSON.stringify("owner_supplies") })], areas: [area({})],
    });
    expect(excluded[0]!.is_excluded_display).toBe(1);
    expect(excluded[0]!.qty).toBeNull();
  });
});

// ---- seedGeneralConditions ---------------------------------------------------------

describe("seedGeneralConditions", () => {
  const descs = (p: Project) => seedGeneralConditions(p).map((l) => l.description);

  it("always seeds permit, dumpster, final clean", () => {
    const d = descs(project({}));
    expect(d.some((x) => x.startsWith("Building permit"))).toBe(true);
    expect(d.some((x) => x.startsWith("Dumpster"))).toBe(true);
    expect(d).toContain("Final clean");
  });

  it("dumpster size by project type", () => {
    expect(descs(project({ project_type: "kitchen" }))).toContain("Dumpster (20 yd) & disposal fees");
    expect(descs(project({ project_type: "basement" }))).toContain("Dumpster (30 yd) & disposal fees");
  });

  it("occupied → floor & dust protection", () => {
    expect(descs(project({ occupied: 1 }))).toContain("Floor & dust protection (occupied home)");
    expect(descs(project({ occupied: 0 }))).not.toContain("Floor & dust protection (occupied home)");
  });

  it("lead-safe only for pre-1978, never on unknown year (Hard Rule 1)", () => {
    const rrp = "Lead-safe work practices (EPA RRP, pre-1978 home)";
    expect(descs(project({ property_year_built: 1977 }))).toContain(rrp);
    expect(descs(project({ property_year_built: 1978 }))).not.toContain(rrp);
    expect(descs(project({ property_year_built: null }))).not.toContain(rrp);
  });

  it("captured universal answers drive seeds (year measurement, occupancy choice)", () => {
    const rrp = "Lead-safe work practices (EPA RRP, pre-1978 home)";
    const captured = [
      scopeItem({
        id: "si-year", checklist_key: "universal.year_built",
        measurements: JSON.stringify([{ qty: 1962, unit: "ea" }]),
      }),
      scopeItem({ id: "si-occ", checklist_key: "universal.occupied", answer: JSON.stringify("vacant") }),
    ];
    // project says occupied+unknown year; captured answers must win
    const d = seedGeneralConditions(project({ occupied: 1, property_year_built: null }), captured)
      .map((l) => l.description);
    expect(d).toContain(rrp);
    expect(d).not.toContain("Floor & dust protection (occupied home)");
    // skipped captures fall back to project fields
    const skippedCapture = [
      scopeItem({ id: "si-year", checklist_key: "universal.year_built", skipped: 1 }),
    ];
    expect(
      seedGeneralConditions(project({ property_year_built: 1950 }), skippedCapture).map((l) => l.description),
    ).toContain(rrp);
  });

  it("portable toilet for additions only", () => {
    expect(descs(project({ project_type: "addition" }))).toContain("Portable toilet");
    expect(descs(project({ project_type: "bath" }))).not.toContain("Portable toilet");
  });

  it("seeds skip topics the template mappings already produced", () => {
    const templateGC = (description: string): GeneratedLine => ({
      scope_item_id: "si-x", division: "general_conditions", description,
      qty: 1, unit: "lump", is_allowance: 0, is_excluded_display: 0, internal_note: null,
    });
    const generated = [
      templateGC("Floor & dust protection (occupied home)"), // from universal.occupied
      templateGC("Building permit"),                          // from deck.permit_setbacks
    ];
    const d = seedGeneralConditions(project({ occupied: 1 }), [], generated)
      .map((l) => l.description);
    expect(d.filter((x) => x.includes("dust protection"))).toEqual([]);
    expect(d.filter((x) => x.includes("permit"))).toEqual([]);
    expect(d).toContain("Final clean");
  });

  it("all seeds are lump qty 1 with no price", () => {
    for (const l of seedGeneralConditions(project({ occupied: 1, property_year_built: 1960 }))) {
      expect(l.unit).toBe("lump");
      expect(l.qty).toBe(1);
      expect(l.division).toBe("general_conditions");
    }
  });
});

// ---- mergeLines ---------------------------------------------------------------------

describe("mergeLines", () => {
  const gen = (over: Partial<GeneratedLine>): GeneratedLine => ({
    scope_item_id: "si-1",
    division: "electrical",
    description: "Island receptacle",
    qty: 1,
    unit: "ea",
    is_allowance: 0,
    is_excluded_display: 0,
    internal_note: null,
    ...over,
  });

  it("existing priced line survives regeneration untouched", () => {
    const existing = lineItem({ scope_item_id: "si-1", description: "Island receptacle", unit_price: 185 });
    const { toInsert, orphanIds } = mergeLines([existing], [gen({})]);
    expect(toInsert).toEqual([]);
    expect(orphanIds).toEqual([]);
  });

  it("description match is case/whitespace-insensitive", () => {
    const existing = lineItem({ scope_item_id: "si-1", description: "  island   RECEPTACLE " });
    expect(mergeLines([existing], [gen({})]).toInsert).toEqual([]);
  });

  it("new generated line inserts", () => {
    const { toInsert } = mergeLines([], [gen({})]);
    expect(toInsert).toHaveLength(1);
  });

  it("orphaned generated line is flagged, never deleted; manual lines never orphan", () => {
    const orphan = lineItem({ id: "li-orphan", scope_item_id: "si-gone", description: "Old line" });
    const manual = lineItem({ id: "li-manual", scope_item_id: null, description: "Custom labor" });
    const { orphanIds } = mergeLines([orphan, manual], [gen({})]);
    expect(orphanIds).toEqual(["li-orphan"]);
  });

  it("GC seeds don't duplicate across regenerations", () => {
    const gcSeed = gen({ scope_item_id: null, division: "general_conditions", description: "Final clean", unit: "lump" });
    const existing = lineItem({ scope_item_id: null, division: "general_conditions", description: "Final clean", unit: "lump" });
    expect(mergeLines([existing], [gcSeed]).toInsert).toEqual([]);
  });
});

// ---- math ---------------------------------------------------------------------------

describe("parseTaxRule", () => {
  it("bare number, JSON rate, garbage, empty", () => {
    expect(parseTaxRule("7.25")).toBe(7.25);
    expect(parseTaxRule('{"rate": 6.5}')).toBe(6.5);
    expect(parseTaxRule("ohio-something")).toBeNull();
    expect(parseTaxRule("")).toBeNull();
    expect(parseTaxRule(null)).toBeNull();
  });
});

describe("computeTotals", () => {
  const lines = [
    lineItem({ qty: 20, unit_price: 100 }),                            // 2000
    lineItem({ qty: 1, unit_price: 500, is_allowance: 1 }),            // 500 — allowances count
    lineItem({ qty: 1, unit_price: 300, is_optional: 1 }),             // add-alternate: excluded
    lineItem({ qty: 1, unit_price: 999, is_excluded_display: 1 }),     // exclusion display: excluded
    lineItem({ qty: null, unit_price: 100 }),                          // unpriced qty: skipped
    lineItem({ qty: 5, unit_price: null }),                            // unpriced: skipped
  ];

  it("subtotal includes allowances, excludes optional/excluded/unpriced", () => {
    const t = computeTotals(lines, 20, null);
    expect(t.subtotal).toBe(2500);
  });

  it("markup, tax, total, margin", () => {
    const t = computeTotals(lines, 20, "7.25");
    expect(t.markup_amount).toBe(500);
    expect(t.tax_amount).toBeCloseTo(3000 * 0.0725);
    expect(t.total).toBeCloseTo(2500 + 500 + 217.5);
    expect(t.margin_pct).toBeCloseTo((500 / 3000) * 100); // ~16.67% gross margin
    expect(t.tax_rule_missing).toBe(false);
  });

  it("missing tax rule → 0 tax, flagged", () => {
    const t = computeTotals(lines, 20, null);
    expect(t.tax_amount).toBe(0);
    expect(t.tax_rule_missing).toBe(true);
  });

  it("zero subtotal is safe", () => {
    const t = computeTotals([], 20, "7.25");
    expect(t.total).toBe(0);
    expect(t.margin_pct).toBe(0);
  });
});

describe("division helpers", () => {
  it("orders per §5 and tolerates unknown keys", () => {
    expect(divisionRank("general_conditions")).toBe(0);
    expect(divisionRank("exclusions")).toBe(18);
    expect(divisionRank("mystery_division")).toBeGreaterThan(divisionRank("exclusions"));
  });
  it("normalizeDesc collapses case and whitespace", () => {
    expect(normalizeDesc("  Base   Cabinets ")).toBe("base cabinets");
  });
});
