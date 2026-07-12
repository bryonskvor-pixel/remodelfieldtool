import { describe, expect, it } from "vitest";
import { buildCustomerProposal, type BuildInput } from "./customer.js";
import { renderProposalHtml } from "./render.js";

// Hard Rule 5 tests: feed sentinel values into every internal field and prove
// they never survive into the customer DTO or the rendered HTML.

const SENTINELS = {
  markup: "MARKUP_PCT_22_LEAK",
  internalNote: "INTERNAL_NOTE_LEAK",
  costBreakdown: "COST_BREAKDOWN_LEAK",
  gps: "41.123456789",
  ip: "IP_ADDR_LEAK",
};

function input(): BuildInput {
  return {
    contractor: {
      business_name: "Clean Construction LLC", owner_name: "Bradford", email: "b@x.com",
      phone: "555-0100", address: "1 Main St", license_number: "OH-123",
      insurance_note: "Fully insured", default_markup_pct: SENTINELS.markup,
      terms_boilerplate: "unused-here",
    },
    lead: { customer_name: "Jane Miller", address_street: "9 Oak Ln", address_city: "Dayton", address_state: "OH", address_zip: "45400" },
    project: { title: "Miller Kitchen", project_type: "kitchen", gps_lat: SENTINELS.gps },
    bidSheet: {
      subtotal: 1000, markup_pct: 22, markup_amount: 200, tax_amount: 84, total: 1284,
      internal_note: SENTINELS.internalNote,
    },
    proposal: {
      version: 2, display_mode: "by_division",
      scope_narrative: "We will renovate the kitchen.",
      inclusions_summary: null,
      exclusions: JSON.stringify(["Appliances by owner"]),
      assumptions: JSON.stringify(["Footings assumed reusable."]),
      allowances_summary: "Shower glass — $800.00 allowance",
      payment_schedule: JSON.stringify([{ label: "Deposit", percent: 30 }, { label: "Completion", percent: 70 }]),
      timeline_estimate: "6–8 weeks",
      expiration_date: "2026-08-10",
      terms: "Standard terms.",
      status: "sent", sent_at: "2026-07-11T12:00:00Z",
      signature_data: JSON.stringify({ typed_name: "Jane Miller", timestamp: "2026-07-12T09:00:00Z", ip: SENTINELS.ip }),
      viewed_at: JSON.stringify(["2026-07-11T13:00:00Z"]),
    },
    lines: [
      { division: "demolition", description: "Demo cabinets", qty: 10, unit: "lf", unit_price: 20,
        is_allowance: 0, is_optional: 0, is_excluded_display: 0, deleted: 0,
        internal_note: SENTINELS.internalNote, cost_breakdown: SENTINELS.costBreakdown },
      { division: "cabinetry", description: "Install base cabinets", qty: 10, unit: "lf", unit_price: 80,
        is_allowance: 0, is_optional: 0, is_excluded_display: 0, deleted: 0 },
      { division: "electrical", description: "Under-cabinet lighting", qty: 1, unit: "lump", unit_price: 400,
        is_allowance: 0, is_optional: 1, is_excluded_display: 0, deleted: 0 },
      { division: "exclusions", description: "Painting by owner", qty: null, unit: null, unit_price: null,
        is_allowance: 0, is_optional: 0, is_excluded_display: 1, deleted: 0 },
      { division: "flooring", description: "DELETED_LINE_LEAK", qty: 5, unit: "sf", unit_price: 99,
        is_allowance: 0, is_optional: 0, is_excluded_display: 0, deleted: 1 },
    ],
  };
}

describe("buildCustomerProposal — Hard Rule 5", () => {
  it("never leaks markup, internal notes, cost breakdowns, GPS, or signer IP", () => {
    const dto = buildCustomerProposal(input());
    const blob = JSON.stringify(dto);
    for (const sentinel of Object.values(SENTINELS)) {
      expect(blob).not.toContain(sentinel);
    }
    expect(blob).not.toContain("markup");
  });

  it("deleted lines render nowhere; excluded lines carry no pricing; options sit outside divisions", () => {
    const dto = buildCustomerProposal(input());
    const blob = JSON.stringify(dto);
    expect(blob).not.toContain("DELETED_LINE_LEAK");
    expect(dto.investment.excluded_display).toEqual(["Painting by owner"]);
    expect(dto.investment.divisions.map((d) => d.key)).toEqual(["demolition", "cabinetry"]);
    expect(dto.investment.options).toHaveLength(1);
    expect(dto.investment.options[0]!.description).toBe("Under-cabinet lighting");
  });

  it("distributes markup so division subtotals sum to the pre-tax total", () => {
    const dto = buildCustomerProposal(input());
    // subtotal 1000 (200 demo + 800 cabinets), markup 200 → factor 1.2
    expect(dto.investment.pre_tax_total).toBe(1200);
    const sum = dto.investment.divisions.reduce((s, d) => s + d.subtotal, 0);
    expect(Math.round(sum * 100) / 100).toBe(1200);
    expect(dto.investment.divisions[0]!.subtotal).toBe(240); // 200 × 1.2
    expect(dto.investment.divisions[1]!.subtotal).toBe(960); // 800 × 1.2
    expect(dto.investment.tax).toBe(84);
    expect(dto.investment.total).toBe(1284);
  });

  it("scales line prices in full_line_item mode (never exposing raw cost basis)", () => {
    const i = input();
    i.proposal.display_mode = "full_line_item";
    const dto = buildCustomerProposal(i);
    const demo = dto.investment.divisions[0]!.lines[0]!;
    expect(demo.unit_price).toBe(24); // 20 × 1.2
    expect(demo.extended).toBe(240);
  });

  it("keeps the signature name/date but drops the IP; lump_sum hides divisions", () => {
    const i = input();
    i.proposal.display_mode = "lump_sum";
    const dto = buildCustomerProposal(i);
    expect(dto.signed).toEqual({ typed_name: "Jane Miller", timestamp: "2026-07-12T09:00:00Z" });
    expect(dto.investment.divisions).toEqual([]);
    expect(dto.investment.total).toBe(1284);
  });
});

describe("renderProposalHtml", () => {
  it("renders customer sections and no internal sentinels", () => {
    const html = renderProposalHtml(buildCustomerProposal(input()), { signPath: "/p/tok/sign" });
    for (const sentinel of Object.values(SENTINELS)) {
      expect(html).not.toContain(sentinel);
    }
    expect(html).toContain("Miller Kitchen");
    expect(html).toContain("Demolition &amp; Disposal");
    expect(html).toContain("$1,284.00");
    expect(html).toContain("Painting by owner");
    expect(html).toContain("Optional Add-Ons");
    expect(html).toContain("Accepted by Jane Miller");
  });

  it("escapes HTML in contractor-entered text", () => {
    const i = input();
    i.proposal.scope_narrative = `<script>alert("x")</script>`;
    const html = renderProposalHtml(buildCustomerProposal(i));
    expect(html).not.toContain(`<script>alert`);
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows the sign form only when signable", () => {
    const unsigned = input();
    unsigned.proposal.signature_data = null;
    const open = renderProposalHtml(buildCustomerProposal(unsigned), { signPath: "/p/tok/sign" });
    expect(open).toContain("sign-form");
    const expired = renderProposalHtml(buildCustomerProposal(unsigned), { signPath: "/p/tok/sign", expired: true });
    expect(expired).not.toContain("sign-form");
    const preview = renderProposalHtml(buildCustomerProposal(unsigned), { signPath: "/p/tok/sign", preview: true });
    expect(preview).not.toContain("sign-form");
    expect(preview).toContain("Contractor preview");
  });
});
