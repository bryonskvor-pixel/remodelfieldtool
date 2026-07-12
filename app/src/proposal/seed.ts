// Pure proposal-seeding logic (§9). Everything here produces SUGGESTIONS the
// contractor edits before send (Hard Rule 1): exclusions from
// excluded-display lines, assumptions from the completeness engine's yellow
// flags (skipped items), an allowances summary from allowance lines, and
// payment schedule / terms / expiration from contractor defaults.

import type { Contractor, LineItem, PaymentMilestone } from "../types";
import type { YellowFlag } from "../walkthrough/completeness";

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Exclusion suggestions: every non-deleted excluded-display line. */
export function seedExclusions(lines: LineItem[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (l.deleted || !l.is_excluded_display) continue;
    const text = l.description.trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

/** Assumption suggestions: each skipped item's drafted assumption (§7). */
export function seedAssumptions(yellowFlags: YellowFlag[]): string[] {
  const out: string[] = [];
  for (const f of yellowFlags) {
    const text = f.draftedAssumption.trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

/** One line per allowance: description, amount (qty × unit price when both
 * were entered by the contractor), and the allowance note. */
export function seedAllowancesSummary(lines: LineItem[]): string {
  const rows: string[] = [];
  for (const l of lines) {
    if (l.deleted || !l.is_allowance || l.is_excluded_display) continue;
    const amount =
      l.qty !== null && l.unit_price !== null ? money(l.qty * l.unit_price) : null;
    rows.push(
      `${l.description.trim() || "Allowance"}${amount ? ` — ${amount} allowance` : ""}` +
        (l.allowance_note ? ` (${l.allowance_note})` : ""),
    );
  }
  return rows.join("\n");
}

/** Standard 30/40/30 residential schedule — used only when the contractor has
 * no default saved; fully editable on the proposal. */
export const FALLBACK_PAYMENT_SCHEDULE: PaymentMilestone[] = [
  { label: "Deposit at signing", percent: 30 },
  { label: "At rough-in complete", percent: 40 },
  { label: "At substantial completion", percent: 30 },
];

export function defaultPaymentSchedule(contractor: Contractor | null): PaymentMilestone[] {
  if (contractor?.payment_schedule_default) {
    try {
      const parsed = JSON.parse(contractor.payment_schedule_default) as PaymentMilestone[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      // fall through to the standard schedule
    }
  }
  return FALLBACK_PAYMENT_SCHEDULE;
}

/** YYYY-MM-DD expiration date `days` from `from` (contractor default: 30). */
export function expirationDate(days: number, from: Date): string {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Unguessable public token for the customer link. Minted at send time; works
 * offline (getRandomValues) though sending itself requires a connection. */
export function mintPublicToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
