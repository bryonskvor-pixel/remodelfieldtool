import { describe, expect, it } from "vitest";
import type { PriceBookItem } from "../types";
import { priceKey, suggestPrice } from "./pricebook";

function bookItem(overrides: Partial<PriceBookItem>): PriceBookItem {
  return {
    id: "pb-1",
    category: "cabinetry_countertops",
    description: "Base cabinets supply & install",
    unit: "lf",
    last_unit_price: 85,
    price_history: JSON.stringify([
      { price: 80, project_id: "p-old", date: "2026-01-05T00:00:00Z" },
      { price: 85, project_id: "p-recent", date: "2026-03-12T00:00:00Z" },
    ]),
    labor_material_split: null,
    active: 1,
    created_at: "2026-01-05T00:00:00Z",
    updated_at: "2026-03-12T00:00:00Z",
    ...overrides,
  };
}

describe("priceKey", () => {
  it("is stable across case and whitespace", () => {
    expect(priceKey("  Base   Cabinets Supply & Install ", "lf")).toBe(
      priceKey("base cabinets supply & install", "lf"),
    );
  });
  it("differs by unit", () => {
    expect(priceKey("tile", "sf")).not.toBe(priceKey("tile", "lf"));
  });
});

describe("suggestPrice", () => {
  const book = [bookItem({})];

  it("hit returns last price with provenance from the newest history entry", () => {
    const s = suggestPrice("Base cabinets supply & install", "lf", book);
    expect(s).not.toBeNull();
    expect(s!.price).toBe(85);
    expect(s!.lastProjectId).toBe("p-recent");
    expect(s!.lastDate).toBe("2026-03-12T00:00:00Z");
  });

  it("matches case/whitespace-insensitively", () => {
    expect(suggestPrice("  base   CABINETS supply & install ", "lf", book)).not.toBeNull();
  });

  it("unit mismatch is a miss", () => {
    expect(suggestPrice("Base cabinets supply & install", "ea", book)).toBeNull();
  });

  it("unknown description is a miss", () => {
    expect(suggestPrice("Unicorn polishing", "lf", book)).toBeNull();
  });

  it("inactive or priceless entries never suggest", () => {
    expect(suggestPrice("Base cabinets supply & install", "lf", [bookItem({ active: 0 })])).toBeNull();
    expect(suggestPrice("Base cabinets supply & install", "lf", [bookItem({ last_unit_price: null })])).toBeNull();
  });

  it("tolerates corrupt history JSON (suggests without provenance)", () => {
    const s = suggestPrice("Base cabinets supply & install", "lf", [bookItem({ price_history: "{oops" })]);
    expect(s!.price).toBe(85);
    expect(s!.lastProjectId).toBeNull();
  });
});
