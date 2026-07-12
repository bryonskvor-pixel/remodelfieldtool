import { Hono } from "hono";
import Anthropic from "@anthropic-ai/sdk";
import { getDb } from "./db.js";
import { requireSession } from "./auth.js";
import { r2Configured, r2Put } from "./r2.js";
import { buildCustomerProposal, type BuildInput } from "./proposal/customer.js";
import { renderProposalHtml } from "./proposal/render.js";

// Proposal routes (§9). Two surfaces:
//  - /api/proposals/* — contractor-facing (requireSession + ownership,
//    Hard Rule 7): draft preview and the Claude narrative draft.
//  - /p/:token — the tokenized public customer link (unauthenticated, like
//    /api/intake): view (tracked), typed-name signature, and PDF. Everything
//    rendered goes through buildCustomerProposal, the Hard Rule 5 whitelist.

type Env = { Variables: { contractorId: string } };
type Row = Record<string, unknown>;

// ---- Data loading -----------------------------------------------------------

async function one(sql: string, args: unknown[]): Promise<Row | null> {
  const result = await getDb().execute({ sql, args: args as never[] });
  return (result.rows[0] as Row | undefined) ?? null;
}

async function many(sql: string, args: unknown[]): Promise<Row[]> {
  const result = await getDb().execute({ sql, args: args as never[] });
  return result.rows as unknown as Row[];
}

/** Everything the renderer needs, loaded with the proposal row's own
 * contractor_id on every child query (Hard Rule 7 — the token resolves to
 * exactly one tenant and nothing outside it can be reached). */
async function loadBundle(proposal: Row): Promise<BuildInput | null> {
  const cid = String(proposal.contractor_id);
  const bidSheet = await one(
    "SELECT * FROM bid_sheets WHERE id = ? AND contractor_id = ?",
    [proposal.bid_sheet_id, cid],
  );
  if (!bidSheet) return null;
  const project = await one(
    "SELECT * FROM projects WHERE id = ? AND contractor_id = ?",
    [bidSheet.project_id, cid],
  );
  if (!project) return null;
  const contractor = await one("SELECT * FROM contractors WHERE id = ?", [cid]);
  if (!contractor) return null;
  const lead = project.lead_id
    ? await one("SELECT * FROM leads WHERE id = ? AND contractor_id = ?", [project.lead_id, cid])
    : null;
  const lines = await many(
    "SELECT * FROM line_items WHERE bid_sheet_id = ? AND contractor_id = ? ORDER BY sort_order",
    [proposal.bid_sheet_id, cid],
  );
  return { contractor, lead, project, bidSheet, proposal, lines };
}

/** The customer link always shows the LATEST sent version for the bid sheet
 * (§9 versioning) — any version's token resolves forward. */
async function resolveToken(token: string): Promise<Row | null> {
  const hit = await one("SELECT * FROM proposals WHERE public_token = ?", [token]);
  if (!hit) return null;
  const latest = await one(
    `SELECT * FROM proposals
     WHERE bid_sheet_id = ? AND contractor_id = ? AND status != 'draft'
     ORDER BY version DESC LIMIT 1`,
    [hit.bid_sheet_id, hit.contractor_id],
  );
  return latest ?? hit;
}

function isExpired(proposal: Row): boolean {
  if (proposal.status === "signed" || !proposal.expiration_date) return false;
  return String(proposal.expiration_date) < new Date().toISOString().slice(0, 10);
}

async function markExpired(proposal: Row): Promise<void> {
  if (proposal.status !== "sent" && proposal.status !== "viewed") return;
  await getDb().execute({
    // Hard Rule 7: contractor_id in the WHERE.
    sql: "UPDATE proposals SET status = 'expired', updated_at = ? WHERE id = ? AND contractor_id = ?",
    args: [new Date().toISOString(), String(proposal.id), String(proposal.contractor_id)],
  });
  proposal.status = "expired";
}

// ---- Contractor-facing API ----------------------------------------------------

export const proposalsApi = new Hono<Env>();
proposalsApi.use(requireSession);

async function ownedProposal(id: string, contractorId: string): Promise<Row | null> {
  // Hard Rule 7: ownership check filters by contractor_id.
  return one("SELECT * FROM proposals WHERE id = ? AND contractor_id = ?", [id, contractorId]);
}

// Contractor preview: same renderer as the customer page, banner on, no signing.
proposalsApi.get("/:id/preview", async (c) => {
  const proposal = await ownedProposal(c.req.param("id"), c.get("contractorId"));
  if (!proposal) return c.json({ error: "not found" }, 404);
  const bundle = await loadBundle(proposal);
  if (!bundle) return c.json({ error: "bid sheet missing" }, 404);
  return c.html(renderProposalHtml(buildCustomerProposal(bundle), { preview: true }));
});

// Scope-narrative draft via the Claude API (§9). Returns a SUGGESTION only —
// nothing is written to the row; the app puts the text in the editor and the
// contractor edits before send (Hard Rule 1). Input is structured captured
// answers only — transcripts and internal notes are never sent to the model,
// so they can't surface in customer-facing text (Hard Rule 5).
proposalsApi.post("/:id/narrative", async (c) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return c.json({ error: "narrative drafting not configured (ANTHROPIC_API_KEY missing)" }, 503);
  }
  const contractorId = c.get("contractorId");
  const proposal = await ownedProposal(c.req.param("id"), contractorId);
  if (!proposal) return c.json({ error: "not found" }, 404);
  const bundle = await loadBundle(proposal);
  if (!bundle) return c.json({ error: "bid sheet missing" }, 404);

  // Captured scope, structured fields only (Hard Rule 7 filters throughout).
  const walkthrough = await one(
    `SELECT id FROM walkthroughs WHERE project_id = ? AND contractor_id = ?
     ORDER BY created_at DESC LIMIT 1`,
    [bundle.project.id, contractorId],
  );
  if (!walkthrough) return c.json({ error: "no walkthrough captured for this project" }, 400);
  const areas = await many(
    "SELECT id, name, area_type, floor_sf, ceiling_height_ft FROM areas WHERE walkthrough_id = ? AND contractor_id = ? ORDER BY sort_order",
    [walkthrough.id, contractorId],
  );
  const items = await many(
    `SELECT area_id, checklist_key, title, answer, action, planned_change, existing_condition, measurements
     FROM scope_items WHERE contractor_id = ? AND skipped = 0 AND area_id IN
       (SELECT id FROM areas WHERE walkthrough_id = ? AND contractor_id = ?)`,
    [contractorId, walkthrough.id, contractorId],
  );

  const scopeByArea = areas
    .filter((a) => a.area_type !== "universal")
    .map((a) => {
      const captured = items
        .filter((i) => i.area_id === a.id)
        .map((i) => {
          const parts = [String(i.title)];
          if (i.answer) parts.push(`answer: ${String(i.answer)}`);
          if (i.action && i.action !== "no_change") parts.push(`action: ${String(i.action)}`);
          if (i.planned_change) parts.push(`planned: ${String(i.planned_change)}`);
          if (i.existing_condition) parts.push(`existing: ${String(i.existing_condition)}`);
          if (i.measurements) parts.push(`measured: ${String(i.measurements)}`);
          return `- ${parts.join(" | ")}`;
        });
      return `## ${String(a.name)}${a.floor_sf ? ` (~${String(a.floor_sf)} sq ft)` : ""}\n${captured.join("\n") || "- (no items captured)"}`;
    })
    .join("\n\n");

  const pricedLines = bundle.lines
    .filter((l) => !l.deleted && !l.is_excluded_display)
    .map((l) => `- ${String(l.description)}${l.is_optional ? " (optional add-on)" : ""}${l.is_allowance ? " (allowance)" : ""}`)
    .join("\n");

  const client = new Anthropic();
  try {
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      system:
        "You draft the Scope of Work narrative for a residential remodeling proposal, written by the contractor to the homeowner. " +
        "Write warm, plain homeowner language — no trade jargon, no prices, no internal shorthand. " +
        "Organize by area with a short paragraph (or two) per area describing what will be done. " +
        "Describe ONLY work that appears in the captured scope and bid lines provided — never invent work, quantities, or materials that aren't listed. " +
        "Do not mention anything skipped or uncertain. Output plain text only: area names as single lines followed by paragraphs, no markdown syntax.",
      messages: [
        {
          role: "user",
          content:
            `Project: ${String(bundle.project.title)} (${String(bundle.project.project_type)} remodel)` +
            `\n\nCaptured scope by area:\n${scopeByArea}` +
            `\n\nBid line items (what's actually being proposed):\n${pricedLines}` +
            `\n\nDraft the Scope of Work narrative.`,
        },
      ],
    });
    const text = response.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) return c.json({ error: "model returned no text" }, 502);
    return c.json({ narrative: text });
  } catch (e) {
    console.error("[narrative] Claude API call failed:", e);
    return c.json({ error: "narrative draft failed — try again or write it manually" }, 502);
  }
});

// ---- Public customer link (unauthenticated, like /api/intake) ------------------

export const proposalPublic = new Hono();

proposalPublic.get("/:token", async (c) => {
  const proposal = await resolveToken(c.req.param("token"));
  if (!proposal) return c.text("Not found", 404);
  const bundle = await loadBundle(proposal);
  if (!bundle) return c.text("Not found", 404);

  const expired = isExpired(proposal);
  if (expired) await markExpired(proposal);

  // View tracking: append a timestamp; first view flips sent → viewed.
  if (!expired && (proposal.status === "sent" || proposal.status === "viewed")) {
    let views: string[] = [];
    try {
      views = proposal.viewed_at ? (JSON.parse(String(proposal.viewed_at)) as string[]) : [];
    } catch {
      views = [];
    }
    views.push(new Date().toISOString());
    const nowIso = new Date().toISOString();
    await getDb().execute({
      // Hard Rule 7: contractor_id in the WHERE.
      sql: `UPDATE proposals SET viewed_at = ?, status = 'viewed', updated_at = ?
            WHERE id = ? AND contractor_id = ?`,
      args: [JSON.stringify(views), nowIso, String(proposal.id), String(proposal.contractor_id)],
    });
    proposal.status = "viewed";
  }

  const token = c.req.param("token");
  return c.html(
    renderProposalHtml(buildCustomerProposal(bundle), {
      expired,
      signPath: `/p/${token}/sign`,
      pdfPath: `/p/${token}/pdf`,
    }),
  );
});

// Typed-name signature (§3: name + timestamp + IP is the pilot's e-signature).
proposalPublic.post("/:token/sign", async (c) => {
  const proposal = await resolveToken(c.req.param("token"));
  if (!proposal) return c.json({ error: "not found" }, 404);
  if (proposal.status === "signed") return c.json({ error: "already signed" }, 409);
  if (isExpired(proposal)) {
    await markExpired(proposal);
    return c.json({ error: "this proposal has expired — contact the contractor for an updated quote" }, 410);
  }
  if (proposal.status !== "sent" && proposal.status !== "viewed") {
    return c.json({ error: "this proposal is not open for signing" }, 409);
  }
  const body = await c.req.json<{ typed_name?: string }>().catch(() => null);
  const name = body?.typed_name?.trim();
  if (!name || name.length < 2 || name.length > 200) {
    return c.json({ error: "please type your full name" }, 400);
  }
  const nowIso = new Date().toISOString();
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "unknown";
  // IP lives in signature_data for the record; it never renders (Hard Rule 5).
  const signature = JSON.stringify({ typed_name: name, timestamp: nowIso, ip });
  await getDb().execute({
    // Hard Rule 7: contractor_id in the WHERE. Guard on status so two
    // concurrent submits can't both win.
    sql: `UPDATE proposals SET signature_data = ?, signed_at = ?, status = 'signed', updated_at = ?
          WHERE id = ? AND contractor_id = ? AND status IN ('sent','viewed')`,
    args: [signature, nowIso, nowIso, String(proposal.id), String(proposal.contractor_id)],
  });
  return c.json({ ok: true });
});

// Server-side PDF (§3: pixel-identical regardless of device). Prints the same
// HTML as the page via headless Chromium; the copy is stored in R2.
proposalPublic.get("/:token/pdf", async (c) => {
  const proposal = await resolveToken(c.req.param("token"));
  if (!proposal) return c.text("Not found", 404);
  const bundle = await loadBundle(proposal);
  if (!bundle) return c.text("Not found", 404);
  const html = renderProposalHtml(buildCustomerProposal(bundle), { expired: isExpired(proposal) });
  try {
    const pdf = await htmlToPdf(html);
    if (r2Configured()) {
      const key = `c/${String(proposal.contractor_id)}/proposals/${String(proposal.id)}.pdf`;
      try {
        await r2Put(key, pdf, "application/pdf");
        await getDb().execute({
          // Hard Rule 7: contractor_id in the WHERE.
          sql: "UPDATE proposals SET pdf_r2_key = ? WHERE id = ? AND contractor_id = ?",
          args: [key, String(proposal.id), String(proposal.contractor_id)],
        });
      } catch (e) {
        console.warn("[proposal-pdf] R2 store failed (serving anyway):", e);
      }
    }
    return c.body(pdf.buffer as ArrayBuffer, 200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="proposal-v${String(proposal.version)}.pdf"`,
    });
  } catch (e) {
    console.error("[proposal-pdf] render failed:", e);
    return c.text("PDF generation is unavailable on this server right now — the web version above is identical.", 503);
  }
});

// ---- PDF via headless Chromium -------------------------------------------------
// playwright-core with a fallback chain: a Playwright-managed Chromium if one
// is installed, else the system Edge/Chrome channel (always present on the
// Windows pilot box). Browser instance is lazy and reused.

type Browser = import("playwright-core").Browser;
let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    const { chromium } = await import("playwright-core");
    const attempts: (string | undefined)[] = [undefined, "msedge", "chrome"];
    let lastError: unknown;
    for (const channel of attempts) {
      try {
        const browser = await chromium.launch(channel ? { channel } : {});
        browser.on("disconnected", () => {
          browserPromise = null;
        });
        return browser;
      } catch (e) {
        lastError = e;
      }
    }
    browserPromise = null;
    throw lastError;
  })();
  return browserPromise;
}

async function htmlToPdf(html: string): Promise<Uint8Array> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({
      format: "Letter",
      margin: { top: "0.6in", bottom: "0.6in", left: "0.6in", right: "0.6in" },
      printBackground: true,
    });
    return new Uint8Array(pdf);
  } finally {
    await page.close();
  }
}
