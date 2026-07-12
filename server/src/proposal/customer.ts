// Customer-facing proposal DTO builder — THE Hard Rule 5 enforcement point.
// Everything the public page / PDF renders is built HERE, as a whitelist:
// fields are copied out one by one, never spread. Markup, cost basis
// (cost_breakdown), internal notes, transcripts, GPS, and skip reasons never
// enter this module's output. Deleted lines render nowhere; excluded-display
// lines render under Exclusions with no pricing; add-alternates render as
// priced options outside the totals.
//
// Pricing shown to the customer is MARKUP-DISTRIBUTED: each division (or
// line) is scaled so the visible numbers sum to the bid total. Rendering raw
// line prices next to a grand total that includes markup would expose the
// markup amount by simple subtraction — itself a Hard Rule 5 leak.

type Row = Record<string, unknown>;

export interface CustomerLine {
  description: string;
  qty: number | null;
  unit: string | null;
  unit_price: number | null; // marked-up
  extended: number | null;   // marked-up
}

export interface CustomerDivision {
  key: string;
  label: string;
  subtotal: number; // marked-up
  lines: CustomerLine[]; // populated only in full_line_item mode
}

export interface CustomerProposal {
  business: {
    name: string;
    owner: string | null;
    phone: string | null;
    email: string | null;
    address: string | null;
    license_number: string | null;
    insurance_note: string | null;
  };
  customer: { name: string; address: string | null } | null;
  project: { title: string; type: string };
  version: number;
  display_mode: "lump_sum" | "by_division" | "full_line_item";
  scope_narrative: string | null;
  inclusions_summary: string | null;
  exclusions: string[];
  assumptions: string[];
  allowances_summary: string | null;
  payment_schedule: { label: string; percent: number }[];
  timeline_estimate: string | null;
  expiration_date: string | null;
  terms: string | null;
  status: string;
  sent_at: string | null;
  signed: { typed_name: string; timestamp: string } | null;
  investment: {
    divisions: CustomerDivision[]; // empty in lump_sum mode
    options: CustomerLine[];       // add-alternates, priced individually
    excluded_display: string[];    // rendered under Exclusions, NO pricing
    pre_tax_total: number;
    tax: number;
    total: number;
  };
}

// §5 division order/labels, duplicated server-side (the app copy lives in
// app/src/bid/bidgen.ts; keep in sync if divisions ever change).
const DIVISION_LABELS: [string, string][] = [
  ["general_conditions", "General Conditions"],
  ["demolition", "Demolition & Disposal"],
  ["sitework", "Sitework / Excavation / Concrete"],
  ["structural", "Structural & Framing"],
  ["exterior", "Exterior"],
  ["plumbing", "Plumbing"],
  ["electrical", "Electrical"],
  ["hvac", "HVAC / Mechanical"],
  ["insulation", "Insulation & Air Sealing"],
  ["drywall", "Drywall & Plaster"],
  ["doors_trim", "Interior Doors & Trim / Carpentry"],
  ["cabinetry", "Cabinetry & Countertops"],
  ["tile", "Tile & Stone"],
  ["flooring", "Flooring"],
  ["paint", "Paint & Finishes"],
  ["fixtures", "Fixtures & Appliances"],
  ["specialties", "Specialties"],
  ["allowances", "Allowances"],
  ["exclusions", "Exclusions"],
];

function divisionLabel(key: string): string {
  return DIVISION_LABELS.find(([k]) => k === key)?.[1] ?? key;
}

function divisionRank(key: string): number {
  const i = DIVISION_LABELS.findIndex(([k]) => k === key);
  return i === -1 ? DIVISION_LABELS.length : i;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function jsonArray(v: unknown): string[] {
  if (typeof v !== "string" || !v) return [];
  try {
    const parsed = JSON.parse(v) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface BuildInput {
  contractor: Row;
  lead: Row | null;
  project: Row;
  bidSheet: Row;
  proposal: Row;
  lines: Row[];
}

export function buildCustomerProposal(input: BuildInput): CustomerProposal {
  const { contractor, lead, project, bidSheet, proposal } = input;

  // Line partitioning. Deleted → nowhere. Excluded-display → text only.
  const active = input.lines.filter((l) => !l.deleted);
  const excludedDisplay = active.filter((l) => !!l.is_excluded_display);
  const options = active.filter((l) => !l.is_excluded_display && !!l.is_optional);
  const priced = active.filter((l) => !l.is_excluded_display && !l.is_optional);

  // Markup distribution factor: visible prices scale so they sum to the
  // bid sheet's pre-tax total (subtotal + markup). Markup itself is never a
  // visible field (Hard Rule 5).
  const subtotal = num(bidSheet.subtotal) ?? 0;
  const markupAmount = num(bidSheet.markup_amount) ?? 0;
  const preTaxTotal = round2(subtotal + markupAmount);
  const factor = subtotal > 0 ? (subtotal + markupAmount) / subtotal : 1;

  const rawExtended = (l: Row): number => {
    const qty = num(l.qty);
    const price = num(l.unit_price);
    return qty !== null && price !== null ? qty * price : 0;
  };

  const divisionKeys = [...new Set(priced.map((l) => String(l.division)))]
    .sort((a, b) => divisionRank(a) - divisionRank(b));

  const fullLines = String(proposal.display_mode) === "full_line_item";
  const divisions: CustomerDivision[] = divisionKeys.map((key) => {
    const divLines = priced.filter((l) => String(l.division) === key);
    return {
      key,
      label: divisionLabel(key),
      subtotal: round2(divLines.reduce((s, l) => s + rawExtended(l), 0) * factor),
      lines: fullLines
        ? divLines.map((l) => {
            const qty = num(l.qty);
            const ext = rawExtended(l) * factor;
            return {
              description: str(l.description) ?? "",
              qty,
              unit: str(l.unit),
              unit_price: qty ? round2(ext / qty) : num(l.unit_price) !== null ? round2(num(l.unit_price)! * factor) : null,
              extended: round2(ext),
            };
          })
        : [],
    };
  });

  // Rounding residual: nudge the largest division so the visible numbers sum
  // exactly to the pre-tax total the customer sees.
  const divSum = round2(divisions.reduce((s, d) => s + d.subtotal, 0));
  if (divisions.length > 0 && divSum !== preTaxTotal) {
    const largest = divisions.reduce((a, b) => (b.subtotal > a.subtotal ? b : a));
    largest.subtotal = round2(largest.subtotal + (preTaxTotal - divSum));
  }

  let schedule: { label: string; percent: number }[] = [];
  if (typeof proposal.payment_schedule === "string" && proposal.payment_schedule) {
    try {
      const parsed = JSON.parse(proposal.payment_schedule) as unknown;
      if (Array.isArray(parsed)) {
        schedule = parsed
          .filter((m): m is { label: string; percent: number } =>
            !!m && typeof m === "object" && typeof (m as Row).label === "string" && typeof (m as Row).percent === "number")
          .map((m) => ({ label: m.label, percent: m.percent }));
      }
    } catch {
      schedule = [];
    }
  }

  let signed: { typed_name: string; timestamp: string } | null = null;
  if (typeof proposal.signature_data === "string" && proposal.signature_data) {
    try {
      const sig = JSON.parse(proposal.signature_data) as Row;
      // IP is captured for the record but NOT rendered back to the page.
      if (typeof sig.typed_name === "string" && typeof sig.timestamp === "string") {
        signed = { typed_name: sig.typed_name, timestamp: sig.timestamp };
      }
    } catch {
      signed = null;
    }
  }

  return {
    business: {
      name: str(contractor.business_name) ?? "",
      owner: str(contractor.owner_name),
      phone: str(contractor.phone),
      email: str(contractor.email),
      address: str(contractor.address),
      license_number: str(contractor.license_number),
      insurance_note: str(contractor.insurance_note),
    },
    customer: lead
      ? {
          name: str(lead.customer_name) ?? "",
          address: [lead.address_street, lead.address_city, lead.address_state, lead.address_zip]
            .map((v) => str(v))
            .filter(Boolean)
            .join(", ") || null,
        }
      : null,
    project: { title: str(project.title) ?? "", type: str(project.project_type) ?? "" },
    version: num(proposal.version) ?? 1,
    display_mode: (str(proposal.display_mode) as CustomerProposal["display_mode"]) ?? "by_division",
    scope_narrative: str(proposal.scope_narrative),
    inclusions_summary: str(proposal.inclusions_summary),
    exclusions: jsonArray(proposal.exclusions),
    assumptions: jsonArray(proposal.assumptions),
    allowances_summary: str(proposal.allowances_summary),
    payment_schedule: schedule,
    timeline_estimate: str(proposal.timeline_estimate),
    expiration_date: str(proposal.expiration_date),
    terms: str(proposal.terms),
    status: str(proposal.status) ?? "draft",
    sent_at: str(proposal.sent_at),
    signed,
    investment: {
      divisions: String(proposal.display_mode) === "lump_sum" ? [] : divisions,
      options: options.map((l) => ({
        description: str(l.description) ?? "",
        qty: num(l.qty),
        unit: str(l.unit),
        unit_price: num(l.unit_price) !== null ? round2(num(l.unit_price)! * factor) : null,
        extended: round2(rawExtended(l) * factor) || null,
      })),
      excluded_display: excludedDisplay.map((l) => str(l.description) ?? "").filter(Boolean),
      pre_tax_total: preTaxTotal,
      tax: num(bidSheet.tax_amount) ?? 0,
      total: num(bidSheet.total) ?? preTaxTotal,
    },
  };
}
