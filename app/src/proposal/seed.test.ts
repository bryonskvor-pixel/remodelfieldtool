import { describe, expect, it } from "vitest";
import type { Contractor, LineItem } from "../types";
import {
  FALLBACK_PAYMENT_SCHEDULE, defaultPaymentSchedule, expirationDate,
  seedAllowancesSummary, seedAssumptions, seedExclusions,
} from "./seed";

function line(patch: Partial<LineItem>): LineItem {
  return {
    id: "l1", bid_sheet_id: "b1", scope_item_id: null, price_book_item_id: null,
    division: "flooring", description: "Flooring", qty: null, unit: "sf",
    unit_price: null, extended: null, is_allowance: 0, allowance_note: null,
    is_optional: 0, is_excluded_display: 0, internal_note: null,
    cost_breakdown: null, deleted: 0, sort_order: 0,
    created_at: "t", updated_at: "t",
    ...patch,
  };
}

describe("seedExclusions", () => {
  it("takes excluded-display lines, skips deleted ones, dedupes", () => {
    const lines = [
      line({ id: "a", is_excluded_display: 1, description: "Appliances by owner" }),
      line({ id: "b", is_excluded_display: 1, description: "Appliances by owner" }),
      line({ id: "c", is_excluded_display: 1, deleted: 1, description: "Gone" }),
      line({ id: "d", description: "Priced work" }),
    ];
    expect(seedExclusions(lines)).toEqual(["Appliances by owner"]);
  });
});

describe("seedAssumptions", () => {
  it("collects drafted assumptions from yellow flags, deduped", () => {
    const flags = [
      { key: "k1", areaName: "Kitchen", skipReason: "Will verify later", draftedAssumption: "Footings assumed reusable." },
      { key: "k2", areaName: "Kitchen", skipReason: "Not applicable", draftedAssumption: "Footings assumed reusable." },
      { key: "k3", areaName: "Bath", skipReason: "Customer undecided", draftedAssumption: "Tile selection pending." },
    ];
    expect(seedAssumptions(flags)).toEqual(["Footings assumed reusable.", "Tile selection pending."]);
  });
});

describe("seedAllowancesSummary", () => {
  it("summarizes allowance lines with contractor-entered amounts only", () => {
    const lines = [
      line({ id: "a", is_allowance: 1, description: "Shower glass", qty: 1, unit_price: 800, allowance_note: "measured after tile" }),
      line({ id: "b", is_allowance: 1, description: "Tile material", qty: null, unit_price: 6 }), // no qty → no invented amount (Hard Rule 1)
      line({ id: "c", is_allowance: 1, deleted: 1, description: "Deleted" }),
      line({ id: "d", description: "Not an allowance" }),
    ];
    const text = seedAllowancesSummary(lines);
    expect(text).toContain("Shower glass — $800.00 allowance (measured after tile)");
    expect(text).toContain("Tile material");
    expect(text).not.toContain("Tile material —"); // no amount fabricated
    expect(text).not.toContain("Deleted");
  });
});

describe("defaultPaymentSchedule", () => {
  const base = { id: "c1", business_name: "B", owner_name: null, email: "e", phone: null,
    license_number: null, insurance_note: null, address: null, default_markup_pct: 20,
    default_tax_rule: null, payment_schedule_default: null, terms_boilerplate: null,
    proposal_expiration_days: 30 } satisfies Contractor;

  it("uses the contractor's saved schedule when present", () => {
    const c = { ...base, payment_schedule_default: JSON.stringify([{ label: "Half up front", percent: 50 }, { label: "On completion", percent: 50 }]) };
    expect(defaultPaymentSchedule(c)[0]!.label).toBe("Half up front");
  });

  it("falls back to the standard schedule on missing or bad JSON", () => {
    expect(defaultPaymentSchedule(base)).toEqual(FALLBACK_PAYMENT_SCHEDULE);
    expect(defaultPaymentSchedule({ ...base, payment_schedule_default: "not json" })).toEqual(FALLBACK_PAYMENT_SCHEDULE);
    expect(defaultPaymentSchedule(null)).toEqual(FALLBACK_PAYMENT_SCHEDULE);
  });
});

describe("expirationDate", () => {
  it("adds days and formats YYYY-MM-DD", () => {
    expect(expirationDate(30, new Date("2026-07-11T12:00:00Z"))).toBe("2026-08-10");
  });
});
