// Customer-facing proposal HTML (§9). One renderer serves the public link,
// the contractor preview, and the PDF print (Playwright prints this same
// markup) so all three are pixel-consistent. Input is ONLY the sanitized
// CustomerProposal DTO from customer.ts — this file cannot leak what it never
// receives (Hard Rule 5).

import type { CustomerLine, CustomerProposal } from "./customer.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function money(n: number | null): string {
  if (n === null) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function nl2p(s: string): string {
  return s
    .split(/\n{2,}/)
    .map((para) => `<p>${esc(para.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function list(items: string[]): string {
  return `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
}

function lineRows(lines: CustomerLine[]): string {
  return lines
    .map(
      (l) => `<tr>
        <td>${esc(l.description)}</td>
        <td class="num">${l.qty ?? ""} ${l.unit ? esc(l.unit) : ""}</td>
        <td class="num">${money(l.extended)}</td>
      </tr>`,
    )
    .join("");
}

export interface RenderOptions {
  /** Contractor-only preview of a draft — banner shown, signing disabled. */
  preview?: boolean;
  /** Past expiration_date — banner shown, signing disabled. */
  expired?: boolean;
  /** POST target for the typed-name signature (the public token route). */
  signPath?: string;
  /** Link to the PDF variant. */
  pdfPath?: string;
}

export function renderProposalHtml(p: CustomerProposal, opts: RenderOptions = {}): string {
  const inv = p.investment;
  const canSign = !opts.preview && !opts.expired && !p.signed && opts.signPath;

  const investmentBody =
    p.display_mode === "lump_sum"
      ? ""
      : `<table class="inv">
          ${inv.divisions
            .map(
              (d) => `
            <tr class="div-row"><td>${esc(d.label)}</td><td class="num">${money(d.subtotal)}</td></tr>
            ${d.lines.length > 0 ? `<tr><td colspan="2"><table class="inv-lines"><tbody>${lineRows(d.lines)}</tbody></table></td></tr>` : ""}`,
            )
            .join("")}
        </table>`;

  const exclusions = [...inv.excluded_display, ...p.exclusions.filter((e) => !inv.excluded_display.includes(e))];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Proposal — ${esc(p.project.title)} — ${esc(p.business.name)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Georgia, 'Times New Roman', serif; color: #26221c; background: #f6f3ec; line-height: 1.55; }
  .page { max-width: 720px; margin: 0 auto; padding: 24px 20px 64px; background: #fffdf8; min-height: 100vh; }
  header { border-bottom: 3px solid #b4530a; padding-bottom: 16px; margin-bottom: 24px; }
  h1 { font-size: 1.5rem; margin: 0 0 2px; }
  h2 { font-size: 1.05rem; text-transform: uppercase; letter-spacing: 0.08em; color: #b4530a; margin: 32px 0 8px; font-family: 'Helvetica Neue', Arial, sans-serif; }
  .muted { color: #6f6657; font-size: 0.9rem; }
  .banner { padding: 10px 14px; border-radius: 6px; margin-bottom: 20px; font-family: Arial, sans-serif; font-size: 0.9rem; }
  .banner-preview { background: #fdf1d7; border: 1px solid #d9a441; }
  .banner-expired { background: #fbe3dd; border: 1px solid #c25b45; }
  .banner-signed { background: #e4efdf; border: 1px solid #6d9a5a; }
  table.inv { width: 100%; border-collapse: collapse; }
  table.inv > tbody > tr > td, table.inv > tr > td { padding: 8px 4px; border-bottom: 1px solid #e7e0d2; vertical-align: top; }
  tr.div-row > td { font-weight: bold; }
  table.inv-lines { width: 100%; border-collapse: collapse; font-size: 0.9rem; color: #4c463c; }
  table.inv-lines td { padding: 3px 4px 3px 18px; border: none; }
  td.num { text-align: right; white-space: nowrap; }
  .totals { margin-top: 12px; border-top: 2px solid #26221c; }
  .totals .row { display: flex; justify-content: space-between; padding: 6px 4px; }
  .totals .grand { font-size: 1.25rem; font-weight: bold; }
  ul { margin: 6px 0; padding-left: 22px; }
  .sig-box { border: 1px solid #c9c0ae; border-radius: 8px; padding: 18px; margin-top: 16px; background: #fbf8f1; }
  .sig-box input[type=text] { width: 100%; padding: 10px; font-size: 1rem; border: 1px solid #b3a98a; border-radius: 6px; margin: 8px 0 12px; }
  .sig-box button { background: #b4530a; color: #fff; border: none; border-radius: 6px; padding: 12px 22px; font-size: 1rem; cursor: pointer; }
  .footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid #e7e0d2; font-size: 0.8rem; color: #6f6657; }
  @media print { body { background: #fff; } .page { max-width: none; padding: 0; } .no-print { display: none !important; } }
</style>
</head>
<body>
<div class="page">
  ${opts.preview ? `<div class="banner banner-preview no-print">Contractor preview — this proposal has not been sent.</div>` : ""}
  ${opts.expired ? `<div class="banner banner-expired">This proposal expired on ${esc(p.expiration_date ?? "")}. Contact ${esc(p.business.name)} for an updated quote.</div>` : ""}
  ${p.signed ? `<div class="banner banner-signed">Accepted by ${esc(p.signed.typed_name)} on ${esc(new Date(p.signed.timestamp).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }))}.</div>` : ""}

  <header>
    <h1>${esc(p.business.name)}</h1>
    <div class="muted">
      ${[p.business.owner, p.business.phone, p.business.email, p.business.address].filter(Boolean).map((v) => esc(v!)).join(" · ")}
      ${p.business.license_number ? `<br>License ${esc(p.business.license_number)}` : ""}
      ${p.business.insurance_note ? `<br>${esc(p.business.insurance_note)}` : ""}
    </div>
  </header>

  <p class="muted">Proposal${p.version > 1 ? ` (rev. ${p.version})` : ""}${p.sent_at ? ` · ${esc(new Date(p.sent_at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }))}` : ""}</p>
  <h1>${esc(p.project.title)}</h1>
  ${p.customer ? `<p>Prepared for ${esc(p.customer.name)}${p.customer.address ? `<br><span class="muted">${esc(p.customer.address)}</span>` : ""}</p>` : ""}

  ${p.scope_narrative ? `<h2>Scope of Work</h2>${nl2p(p.scope_narrative)}` : ""}
  ${p.inclusions_summary ? `<h2>What's Included</h2>${nl2p(p.inclusions_summary)}` : ""}

  <h2>Your Investment</h2>
  ${investmentBody}
  <div class="totals">
    ${p.display_mode !== "lump_sum" || inv.tax > 0 ? `<div class="row"><span>Project total</span><span>${money(inv.pre_tax_total)}</span></div>` : ""}
    ${inv.tax > 0 ? `<div class="row"><span>Tax</span><span>${money(inv.tax)}</span></div>` : ""}
    <div class="row grand"><span>Total investment</span><span>${money(inv.total)}</span></div>
  </div>

  ${inv.options.length > 0 ? `<h2>Optional Add-Ons</h2><p class="muted">Priced separately — not included in the total above. Choose any you'd like added.</p><table class="inv"><tbody>${lineRows(inv.options)}</tbody></table>` : ""}

  ${p.allowances_summary ? `<h2>Allowances</h2><p class="muted">An allowance is a budgeted amount for an item that isn't final yet (like a fixture or material you haven't picked). If the final choice costs more or less, the difference adjusts the contract price — you only ever pay for what you choose.</p>${nl2p(p.allowances_summary)}` : ""}

  ${exclusions.length > 0 ? `<h2>Not Included</h2>${list(exclusions)}` : ""}
  ${p.assumptions.length > 0 ? `<h2>Assumptions</h2><p class="muted">This price is based on the following. If any turn out differently, we'll discuss options before proceeding.</p>${list(p.assumptions)}` : ""}

  ${p.payment_schedule.length > 0 ? `<h2>Payment Schedule</h2>${list(p.payment_schedule.map((m) => `${m.label} — ${m.percent}%`))}` : ""}
  ${p.timeline_estimate ? `<h2>Estimated Timeline</h2>${nl2p(p.timeline_estimate)}` : ""}
  ${p.terms ? `<h2>Terms</h2>${nl2p(p.terms)}` : ""}
  ${p.expiration_date ? `<p class="muted">This proposal is valid through ${esc(p.expiration_date)}.</p>` : ""}

  <h2>Acceptance</h2>
  ${p.signed
    ? `<div class="sig-box">Signed by <strong>${esc(p.signed.typed_name)}</strong> on ${esc(new Date(p.signed.timestamp).toLocaleString("en-US"))}.</div>`
    : canSign
      ? `<div class="sig-box no-print">
          <p>To accept this proposal, type your full legal name below. Your typed name, the date and time, and your network address will be recorded as your electronic signature.</p>
          <form id="sign-form">
            <input type="text" id="typed-name" placeholder="Full legal name" autocomplete="name" required>
            <button type="submit">Accept &amp; Sign</button>
            <p id="sign-error" style="color:#a33;"></p>
          </form>
        </div>
        <script>
          document.getElementById('sign-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = document.getElementById('typed-name').value.trim();
            if (!name) return;
            const res = await fetch(${JSON.stringify(opts.signPath ?? "")}, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ typed_name: name }),
            });
            if (res.ok) { location.reload(); }
            else {
              const body = await res.json().catch(() => ({}));
              document.getElementById('sign-error').textContent = body.error || 'Something went wrong — please try again.';
            }
          });
        </script>`
      : `<p class="muted">${opts.preview ? "Signing is available on the customer link after sending." : "This proposal is not currently open for signing."}</p>`}

  ${opts.pdfPath && !opts.preview ? `<p class="no-print"><a href="${esc(opts.pdfPath)}">Download PDF</a></p>` : ""}

  <div class="footer">Prepared by ${esc(p.business.name)}. Questions? ${[p.business.phone, p.business.email].filter(Boolean).map((v) => esc(v!)).join(" · ")}</div>
</div>
</body>
</html>`;
}
