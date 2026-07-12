import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { cachedContractor, db, onStoreChange } from "../db/store";
import { syncNow } from "../db/sync";
import { getOrCreateProposal } from "../proposal/create";
import { mintPublicToken } from "../proposal/seed";
import type { BidSheet, Contractor, LineItem, PaymentMilestone, Project, Proposal, ProposalDisplayMode } from "../types";

// Proposal builder (§9). Contractor-facing editor for the customer-facing
// document: everything seeded is a suggestion to edit (Hard Rule 1), and what
// the customer sees is rendered server-side through the Hard Rule 5 whitelist
// (preview button shows exactly that). Editing after send clones to a new
// version; the customer link always shows the latest sent version.

interface Data {
  proposal: Proposal;
  sheet: BidSheet;
  project: Project;
  lines: LineItem[];
  contractor: Contractor | null;
}

function useProposalData(proposalId: string): Data | null | undefined {
  const [data, setData] = useState<Data | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    async function load() {
      const proposal = await db.proposals.get(proposalId);
      const sheet = proposal ? await db.bid_sheets.get(proposal.bid_sheet_id) : undefined;
      const project = sheet ? await db.projects.get(sheet.project_id) : undefined;
      if (!proposal || !sheet || !project) {
        if (live) setData(null);
        return;
      }
      const [allLines, contractor] = await Promise.all([db.line_items.all(), cachedContractor()]);
      if (live) {
        setData({
          proposal, sheet, project,
          lines: allLines.filter((l) => l.bid_sheet_id === sheet.id && !l.deleted),
          contractor: contractor ?? null,
        });
      }
    }
    void load();
    return onStoreChange(() => void load()) as unknown as () => void;
  }, [proposalId]);
  return data;
}

/** Text field that commits on blur (matches the BidSheet input convention). */
function TextArea({
  value, onCommit, placeholder, rows,
}: {
  value: string | null;
  onCommit: (v: string | null) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <textarea
      key={value ?? ""}
      rows={rows ?? 5}
      defaultValue={value ?? ""}
      placeholder={placeholder}
      onBlur={(e) => {
        const v = e.target.value.trim() || null;
        if (v !== value) onCommit(v);
      }}
    />
  );
}

function parseLines(v: string | null): string[] {
  if (!v) return [];
  try {
    const arr = JSON.parse(v) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const DISPLAY_MODES: { value: ProposalDisplayMode; label: string; hint: string }[] = [
  { value: "lump_sum", label: "Lump sum", hint: "one total, no breakdown" },
  { value: "by_division", label: "By division", hint: "subtotals per trade (default)" },
  { value: "full_line_item", label: "Full line item", hint: "every line, priced" },
];

export function ProposalBuilder({
  proposalId, onBack, onOpenProposal,
}: {
  proposalId: string;
  onBack: () => void;
  onOpenProposal: (id: string) => void;
}) {
  const data = useProposalData(proposalId);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    document.body.classList.add("wide-page");
    return () => document.body.classList.remove("wide-page");
  }, []);

  const unpriced = useMemo(
    () =>
      data?.lines.filter(
        (l) => !l.is_excluded_display && (l.qty === null || l.unit_price === null),
      ).length ?? 0,
    [data],
  );

  if (data === undefined) return <p className="muted">Loading…</p>;
  if (data === null) return <p className="error">Proposal not found.</p>;
  const { proposal, project } = data;
  const isDraft = proposal.status === "draft";

  async function commit(patch: Partial<Proposal>) {
    await db.proposals.put({ ...proposal, ...patch });
  }

  async function preview() {
    setBusy("preview");
    setError(null);
    try {
      // Preview renders server-side from the synced row — push edits first.
      await syncNow();
      window.open(`/api/proposals/${proposal.id}/preview`, "_blank");
    } finally {
      setBusy(null);
    }
  }

  async function draftNarrative() {
    if (
      proposal.scope_narrative &&
      !window.confirm("Replace the current narrative with a fresh AI draft? Your edits will be lost.")
    ) {
      return;
    }
    setBusy("narrative");
    setError(null);
    try {
      await syncNow(); // the server drafts from synced scope data
      const { narrative } = await api.draftNarrative(proposal.id);
      // Suggestion lands in the editor (Hard Rule 1: contractor edits before send).
      await commit({ scope_narrative: narrative });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Draft failed");
    } finally {
      setBusy(null);
    }
  }

  async function send() {
    const warnings: string[] = [];
    if (unpriced > 0) warnings.push(`${unpriced} line item(s) have no qty or price and will show $0.`);
    if (!proposal.scope_narrative) warnings.push("There is no scope narrative.");
    if (
      warnings.length > 0 &&
      !window.confirm(`Send anyway?\n\n${warnings.join("\n")}`)
    ) {
      return; // warn, never block (Hard Rule 4)
    }
    setBusy("send");
    setError(null);
    try {
      const token = proposal.public_token ?? mintPublicToken();
      await db.proposals.put({
        ...proposal,
        public_token: token,
        status: "sent",
        sent_at: new Date().toISOString(),
      });
      await syncNow();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setBusy(null);
    }
  }

  async function editAsNewVersion() {
    setBusy("clone");
    try {
      const id = await getOrCreateProposal(proposal.bid_sheet_id);
      onOpenProposal(id);
    } finally {
      setBusy(null);
    }
  }

  const link = proposal.public_token ? `${window.location.origin}/p/${proposal.public_token}` : null;
  const views = parseLines(proposal.viewed_at);
  const signature = (() => {
    if (!proposal.signature_data) return null;
    try {
      return JSON.parse(proposal.signature_data) as { typed_name: string; timestamp: string };
    } catch {
      return null;
    }
  })();

  return (
    <div className="bid-page">
      <div className="runner-header">
        <button className="inline-link" onClick={onBack}>← Bid sheet</button>
      </div>
      <h1>Proposal</h1>
      <p className="muted">
        {project.title} · v{proposal.version} · {proposal.status}
        {proposal.sent_at && ` · sent ${new Date(proposal.sent_at).toLocaleDateString()}`}
      </p>

      {!isDraft && (
        <div className="card">
          <h2>Status</h2>
          {views.length > 0 ? (
            <p>
              Viewed {views.length} time{views.length === 1 ? "" : "s"} — last{" "}
              {new Date(views[views.length - 1]!).toLocaleString()}
            </p>
          ) : (
            <p className="muted">Not viewed yet.</p>
          )}
          {signature && (
            <p>
              ✍️ Signed by <strong>{signature.typed_name}</strong> on{" "}
              {new Date(signature.timestamp).toLocaleString()}
            </p>
          )}
          {link && (
            <>
              <p className="proposal-link">{link}</p>
              <div className="chip-row wrap">
                <button
                  className="chip"
                  onClick={() => {
                    void navigator.clipboard.writeText(link).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    });
                  }}
                >
                  {copied ? "✓ Copied" : "Copy link"}
                </button>
                <button className="chip" onClick={() => window.open(link, "_blank")}>Open</button>
                <button className="chip" onClick={() => window.open(`${link}/pdf`, "_blank")}>PDF</button>
              </div>
            </>
          )}
          {proposal.status !== "signed" && (
            <button className="secondary" disabled={busy !== null} onClick={() => void editAsNewVersion()}>
              Make changes (creates v{proposal.version + 1})
            </button>
          )}
        </div>
      )}

      {isDraft && (
        <>
          <div className="card">
            <h2>Pricing display</h2>
            <div className="chip-row wrap">
              {DISPLAY_MODES.map((m) => (
                <button
                  key={m.value}
                  className={proposal.display_mode === m.value ? "chip-on" : "chip"}
                  onClick={() => void commit({ display_mode: m.value })}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <p className="muted">{DISPLAY_MODES.find((m) => m.value === proposal.display_mode)?.hint}</p>
            {unpriced > 0 && (
              <p className="error">⚠ {unpriced} line item(s) still need qty or price on the bid sheet.</p>
            )}
          </div>

          <div className="card">
            <h2>Scope of work</h2>
            <p className="muted">
              Plain homeowner language, by area. The AI draft only describes what you captured —
              review and edit before sending.
            </p>
            <TextArea
              rows={12}
              value={proposal.scope_narrative}
              placeholder="What you'll do, area by area…"
              onCommit={(v) => void commit({ scope_narrative: v })}
            />
            <button className="secondary" disabled={busy !== null} onClick={() => void draftNarrative()}>
              {busy === "narrative" ? "Drafting…" : "✨ Draft with AI"}
            </button>
          </div>

          <div className="card">
            <h2>Inclusions summary <span className="muted">(optional)</span></h2>
            <TextArea
              rows={3}
              value={proposal.inclusions_summary}
              placeholder="A short 'what's included' paragraph…"
              onCommit={(v) => void commit({ inclusions_summary: v })}
            />
          </div>

          <div className="card">
            <h2>Exclusions</h2>
            <p className="muted">One per line. Seeded from lines you moved to exclusions.</p>
            <TextArea
              value={parseLines(proposal.exclusions).join("\n") || null}
              placeholder={"Painting by owner\nAppliances supplied by owner"}
              onCommit={(v) =>
                void commit({ exclusions: JSON.stringify(v ? v.split("\n").map((s) => s.trim()).filter(Boolean) : []) })
              }
            />
          </div>

          <div className="card">
            <h2>Assumptions</h2>
            <p className="muted">One per line. Seeded from items you skipped during the walkthrough.</p>
            <TextArea
              value={parseLines(proposal.assumptions).join("\n") || null}
              placeholder="Bid assumes existing footings are reusable…"
              onCommit={(v) =>
                void commit({ assumptions: JSON.stringify(v ? v.split("\n").map((s) => s.trim()).filter(Boolean) : []) })
              }
            />
          </div>

          <div className="card">
            <h2>Allowances summary</h2>
            <TextArea
              rows={3}
              value={proposal.allowances_summary}
              placeholder="Shower glass — $800 allowance…"
              onCommit={(v) => void commit({ allowances_summary: v })}
            />
          </div>

          <PaymentScheduleEditor
            value={proposal.payment_schedule}
            onCommit={(v) => void commit({ payment_schedule: v })}
          />

          <div className="card">
            <h2>Timeline &amp; terms</h2>
            <label>Estimated timeline (ranges encouraged)</label>
            <input
              key={proposal.timeline_estimate ?? ""}
              defaultValue={proposal.timeline_estimate ?? ""}
              placeholder="e.g. 6–8 weeks from start"
              onBlur={(e) => {
                const v = e.target.value.trim() || null;
                if (v !== proposal.timeline_estimate) void commit({ timeline_estimate: v });
              }}
            />
            <label>Proposal valid through</label>
            <input
              type="date"
              key={proposal.expiration_date ?? ""}
              defaultValue={proposal.expiration_date ?? ""}
              onBlur={(e) => {
                const v = e.target.value || null;
                if (v !== proposal.expiration_date) void commit({ expiration_date: v });
              }}
            />
            <label>Terms</label>
            <TextArea
              rows={6}
              value={proposal.terms}
              placeholder="Terms boilerplate (set a default in Settings)…"
              onCommit={(v) => void commit({ terms: v })}
            />
          </div>

          {error && <p className="error">{error}</p>}
          <div className="row">
            <button className="secondary" disabled={busy !== null} onClick={() => void preview()}>
              {busy === "preview" ? "Opening…" : "Preview as customer"}
            </button>
            <button disabled={busy !== null} onClick={() => void send()}>
              {busy === "send" ? "Sending…" : "Send to customer"}
            </button>
          </div>
          <p className="muted">
            Sending creates the customer link. You'll copy it into a text or email —
            nothing goes out automatically.
          </p>
        </>
      )}
      {error && !isDraft && <p className="error">{error}</p>}
    </div>
  );
}

function PaymentScheduleEditor({
  value, onCommit,
}: {
  value: string | null;
  onCommit: (v: string) => void;
}) {
  const parsed = useMemo<PaymentMilestone[]>(() => {
    if (!value) return [];
    try {
      const arr = JSON.parse(value) as unknown;
      return Array.isArray(arr) ? (arr as PaymentMilestone[]) : [];
    } catch {
      return [];
    }
  }, [value]);
  const total = parsed.reduce((s, m) => s + (m.percent || 0), 0);

  const update = (next: PaymentMilestone[]) => onCommit(JSON.stringify(next));

  return (
    <div className="card">
      <h2>Payment schedule</h2>
      {parsed.map((m, i) => (
        <div className="row" key={`${i}-${m.label}-${m.percent}`}>
          <input
            defaultValue={m.label}
            placeholder="Milestone"
            onBlur={(e) => {
              if (e.target.value !== m.label) {
                const next = [...parsed];
                next[i] = { ...m, label: e.target.value };
                update(next);
              }
            }}
          />
          <input
            className="pct-input"
            inputMode="numeric"
            defaultValue={String(m.percent)}
            onBlur={(e) => {
              const n = Number(e.target.value);
              if (!Number.isNaN(n) && n !== m.percent) {
                const next = [...parsed];
                next[i] = { ...m, percent: n };
                update(next);
              }
            }}
          />
          <button className="inline-link" onClick={() => update(parsed.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button className="inline-link" onClick={() => update([...parsed, { label: "", percent: 0 }])}>
        ＋ Add milestone
      </button>
      <p className={total === 100 ? "muted" : "error"}>
        Total: {total}%{total !== 100 ? " — should add to 100%" : ""}
      </p>
    </div>
  );
}
