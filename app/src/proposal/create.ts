// Proposal creation/versioning orchestration (§9). Reads the offline store,
// runs the pure seeders, and writes the proposal row. Versioning: the bid
// sheet's LATEST proposal is the working one; if it has been sent (or signed),
// any edit starts by cloning it into a new draft version — prior versions are
// retained, and the customer link always resolves to the latest sent version
// server-side.

import { cachedContractor, cachedTemplates, db, newId, now } from "../db/store";
import { buildSteps } from "../walkthrough/engine";
import { scoreWalkthrough } from "../walkthrough/completeness";
import type { Proposal, Template } from "../types";
import {
  defaultPaymentSchedule, expirationDate, seedAllowancesSummary, seedAssumptions, seedExclusions,
} from "./seed";

export function latestProposal(proposals: Proposal[], bidSheetId: string): Proposal | null {
  const mine = proposals.filter((p) => p.bid_sheet_id === bidSheetId);
  if (mine.length === 0) return null;
  return mine.reduce((a, b) => (b.version > a.version ? b : a));
}

/** Find the working draft for this bid sheet, or create one (fresh v1, or a
 * clone of the latest sent version). Returns the proposal id. */
export async function getOrCreateProposal(bidSheetId: string): Promise<string> {
  const sheet = await db.bid_sheets.get(bidSheetId);
  if (!sheet) throw new Error("bid sheet not found");

  const proposals = await db.proposals.all();
  const latest = latestProposal(proposals, bidSheetId);
  if (latest && latest.status === "draft") return latest.id;

  const contractor = (await cachedContractor()) ?? null;
  const stamp = now();

  if (latest) {
    // Edit-after-send: clone into v(n+1). Contractor-edited content carries
    // over; send/sign state does not (§9 — prior versions retained).
    const clone: Proposal = {
      ...latest,
      id: newId(),
      version: latest.version + 1,
      status: "draft",
      public_token: null,
      pdf_r2_key: null,
      sent_at: null,
      viewed_at: null,
      signed_at: null,
      signature_data: null,
      expiration_date: expirationDate(contractor?.proposal_expiration_days ?? 30, new Date()),
      created_at: stamp,
      updated_at: stamp,
    };
    await db.proposals.put(clone);
    return clone.id;
  }

  // Fresh v1: seed everything (all of it editable — Hard Rule 1).
  const [allLines, allWalkthroughs, allAreas, allItems, templates] = await Promise.all([
    db.line_items.all(), db.walkthroughs.all(), db.areas.all(), db.scope_items.all(), cachedTemplates(),
  ]);
  const lines = allLines.filter((l) => l.bid_sheet_id === bidSheetId);

  // Yellow flags from the project's most recent walkthrough: each skipped item
  // drafted an assumption during review (§7) — those seed the proposal.
  const walkthroughs = allWalkthroughs
    .filter((w) => w.project_id === sheet.project_id)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  let assumptions: string[] = [];
  const walkthrough = walkthroughs[0];
  if (walkthrough) {
    const areas = allAreas.filter((a) => a.walkthrough_id === walkthrough.id);
    const areaIds = new Set(areas.map((a) => a.id));
    const scopeItems = allItems.filter((si) => areaIds.has(si.area_id));
    const templatesByType = new Map<string, Template>(templates.map((t) => [t.project_type, t]));
    const steps = buildSteps(areas, templatesByType, scopeItems);
    const report = scoreWalkthrough(steps, scopeItems, [], []);
    assumptions = seedAssumptions(report.yellowFlags);
  }

  const proposal: Proposal = {
    id: newId(),
    bid_sheet_id: bidSheetId,
    version: 1,
    display_mode: "by_division",
    scope_narrative: null,
    inclusions_summary: null,
    exclusions: JSON.stringify(seedExclusions(lines)),
    assumptions: JSON.stringify(assumptions),
    allowances_summary: seedAllowancesSummary(lines) || null,
    payment_schedule: JSON.stringify(defaultPaymentSchedule(contractor)),
    timeline_estimate: null,
    expiration_date: expirationDate(contractor?.proposal_expiration_days ?? 30, new Date()),
    terms: contractor?.terms_boilerplate ?? null,
    pdf_r2_key: null,
    public_token: null,
    sent_at: null,
    viewed_at: null,
    signed_at: null,
    signature_data: null,
    status: "draft",
    created_at: stamp,
    updated_at: stamp,
  };
  await db.proposals.put(proposal);
  return proposal.id;
}
