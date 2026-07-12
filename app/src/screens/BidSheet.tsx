import { useEffect, useMemo, useState } from "react";
import { cachedContractor, db, onStoreChange } from "../db/store";
import {
  computeTotals, divisionLabel, divisionRank, lineExtended, DIVISION_ORDER,
} from "../bid/bidgen";
import { recordPrice, suggestPrice } from "../bid/pricebook";
import { getOrCreateProposal } from "../proposal/create";
import { newId, now } from "../db/store";
import type { BidSheet as BidSheetRow, Contractor, LineItem, PriceBookItem, Project } from "../types";

// Bid pricing screen (§8): generated line items grouped by division, unit
// prices auto-suggested from the contractor's price book, live totals with
// markup and gross margin always visible. Contractor-facing only — markup and
// internal notes are fine here; Hard Rule 5 applies at the proposal renderer.
// Desktop-friendly too (§11): pricing happens at the kitchen table at night.

const ORPHAN_NOTE = "⚠ source item no longer in scope";
const UNITS = ["ea", "lf", "sf", "sy", "hr", "day", "lump", "allowance"];

interface Data {
  sheet: BidSheetRow;
  lines: LineItem[]; // undeleted lines for this sheet
  book: PriceBookItem[];
  project: Project;
  projects: Project[];
  contractor: Contractor | null;
}

function useBidData(bidSheetId: string): Data | null | undefined {
  const [data, setData] = useState<Data | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    async function load() {
      const sheet = await db.bid_sheets.get(bidSheetId);
      if (!sheet) {
        if (live) setData(null);
        return;
      }
      const [allLines, book, projects, contractor] = await Promise.all([
        db.line_items.all(), db.price_book_items.all(), db.projects.all(), cachedContractor(),
      ]);
      const project = projects.find((p) => p.id === sheet.project_id);
      if (!project) {
        if (live) setData(null);
        return;
      }
      if (live) {
        setData({
          sheet,
          lines: allLines
            .filter((l) => l.bid_sheet_id === bidSheetId && !l.deleted)
            .sort((a, b) => a.sort_order - b.sort_order),
          book,
          projects,
          project,
          contractor: contractor ?? null,
        });
      }
    }
    void load();
    return onStoreChange(() => void load()) as unknown as () => void;
  }, [bidSheetId]);
  return data;
}

/** Numeric input that commits on blur/Enter — no write per keystroke. */
function NumField({
  value, onCommit, placeholder, className,
}: {
  value: number | null;
  onCommit: (v: number | null) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <input
      // Re-key by value so external updates (suggestion accepted, regen) show;
      // commit-on-blur means we never remount a field mid-typing unless it
      // actually changed underneath.
      key={value === null ? "null" : String(value)}
      className={className}
      type="text"
      inputMode="decimal"
      defaultValue={value === null ? "" : String(value)}
      placeholder={placeholder}
      onBlur={(e) => {
        const raw = e.target.value.trim();
        const parsed = raw === "" ? null : Number(raw);
        const next = parsed !== null && Number.isNaN(parsed) ? value : parsed;
        if (next !== value) onCommit(next);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

function money(n: number | null): string {
  if (n === null) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function BidSheet({
  bidSheetId, onBack, onProposal,
}: {
  bidSheetId: string;
  onBack: () => void;
  onProposal: (proposalId: string) => void;
}) {
  const data = useBidData(bidSheetId);
  const [sheetLine, setSheetLine] = useState<LineItem | null>(null);
  const [creatingProposal, setCreatingProposal] = useState(false);

  const totals = useMemo(() => {
    if (!data) return null;
    return computeTotals(
      data.lines, data.sheet.markup_pct ?? 0, data.contractor?.default_tax_rule ?? null,
    );
  }, [data]);

  // Persist computed money fields onto the bid_sheets row so they sync and the
  // proposal builder can read them. Writes only when a number actually moved,
  // so the store-change reload settles immediately.
  useEffect(() => {
    if (!data || !totals) return;
    const s = data.sheet;
    const changed =
      Math.abs((s.subtotal ?? -1) - totals.subtotal) > 0.005 ||
      Math.abs((s.markup_amount ?? -1) - totals.markup_amount) > 0.005 ||
      Math.abs((s.tax_amount ?? -1) - totals.tax_amount) > 0.005 ||
      Math.abs((s.total ?? -1) - totals.total) > 0.005;
    const allPriced =
      data.lines.length > 0 &&
      data.lines.every((l) => l.is_excluded_display || (l.qty !== null && l.unit_price !== null));
    const status = s.status === "locked" ? "locked" : allPriced ? "priced" : "draft";
    if (changed || status !== s.status) {
      void db.bid_sheets.put({
        ...s,
        subtotal: totals.subtotal,
        markup_amount: totals.markup_amount,
        tax_amount: totals.tax_amount,
        total: totals.total,
        status,
      });
    }
  }, [data, totals]);

  // The bid screen is the app's first wide layout (§11 — desktop pricing).
  useEffect(() => {
    document.body.classList.add("wide-page");
    return () => document.body.classList.remove("wide-page");
  }, []);

  if (data === undefined) return <p className="muted">Loading…</p>;
  if (data === null) return <p className="error">Bid sheet not found.</p>;
  const { sheet, lines, book, project, projects } = data;

  async function commitLine(line: LineItem, patch: Partial<LineItem>) {
    const next = { ...line, ...patch };
    next.extended = lineExtended(next);
    await db.line_items.put(next);
    if (sheetLine?.id === line.id) setSheetLine(next);
  }

  /** Committing a price (typed or accepted suggestion) feeds the price book
   * (§8.3): every entry is remembered and offered back next time. */
  async function commitPrice(line: LineItem, price: number | null) {
    if (price === null) {
      await commitLine(line, { unit_price: null });
      return;
    }
    const bookItem = await recordPrice(line, price, project.id);
    await commitLine(line, { unit_price: price, price_book_item_id: bookItem.id });
  }

  async function addLine(division: string) {
    const divLines = lines.filter((l) => l.division === division);
    await db.line_items.put({
      id: newId(),
      bid_sheet_id: sheet.id,
      scope_item_id: null,
      price_book_item_id: null,
      division,
      description: "",
      qty: null,
      unit: "ea",
      unit_price: null,
      extended: null,
      is_allowance: 0,
      allowance_note: null,
      is_optional: 0,
      is_excluded_display: division === "exclusions" ? 1 : 0,
      internal_note: null,
      cost_breakdown: null,
      deleted: 0,
      sort_order: divisionRank(division) * 1000 + divLines.length + 500,
      created_at: now(),
      updated_at: now(),
    });
  }

  // Excluded-display lines render under Exclusions regardless of their
  // original division (§5 — display division, no pricing).
  const displayDivision = (l: LineItem) => (l.is_excluded_display ? "exclusions" : l.division);
  const divisions = DIVISION_ORDER.filter((d) => lines.some((l) => displayDivision(l) === d.key));

  return (
    <div className="bid-page">
      <div className="runner-header">
        <button className="inline-link" onClick={onBack}>← Back</button>
      </div>
      <h1>Bid sheet</h1>
      <p className="muted">
        {project.title} · draft v{sheet.version}
        {sheet.status === "priced" && " · all lines priced"}
      </p>

      {divisions.map((d) => {
        const divLines = lines.filter((l) => displayDivision(l) === d.key);
        const divTotal = divLines.reduce((sum, l) => {
          if (l.is_optional || l.is_excluded_display) return sum;
          return sum + (lineExtended(l) ?? 0);
        }, 0);
        return (
          <div key={d.key} className="card bid-division">
            <div className="bid-division-head">
              <h2>{d.label}</h2>
              {d.key !== "exclusions" && <span className="bid-division-total">{money(divTotal)}</span>}
            </div>
            {divLines.map((l) => (
              <LineRow
                key={l.id}
                line={l}
                book={book}
                projects={projects}
                onCommit={(patch) => void commitLine(l, patch)}
                onPrice={(p) => void commitPrice(l, p)}
                onMore={() => setSheetLine(l)}
              />
            ))}
            <button className="inline-link" onClick={() => void addLine(d.key)}>＋ Add line</button>
          </div>
        );
      })}

      <div className="card">
        <p className="muted">Add a line in another division:</p>
        <div className="chip-row wrap">
          {DIVISION_ORDER.filter((d) => !divisions.includes(d)).map((d) => (
            <button key={d.key} className="chip" onClick={() => void addLine(d.key)}>
              {d.label}
            </button>
          ))}
        </div>
      </div>

      {totals && (
        <TotalsBar
          totals={totals}
          markupPct={sheet.markup_pct ?? 0}
          onMarkup={(pct) => void db.bid_sheets.put({ ...sheet, markup_pct: pct ?? 0 })}
        />
      )}

      <button
        disabled={creatingProposal}
        onClick={() => {
          setCreatingProposal(true);
          void getOrCreateProposal(sheet.id)
            .then(onProposal)
            .finally(() => setCreatingProposal(false));
        }}
      >
        {creatingProposal ? "Opening…" : "Customer proposal →"}
      </button>

      {sheetLine && (
        <LineActionsSheet
          line={sheetLine}
          onCommit={(patch) => void commitLine(sheetLine, patch)}
          onClose={() => setSheetLine(null)}
        />
      )}
    </div>
  );
}

function LineRow({
  line, book, projects, onCommit, onPrice, onMore,
}: {
  line: LineItem;
  book: PriceBookItem[];
  projects: Project[];
  onCommit: (patch: Partial<LineItem>) => void;
  onPrice: (price: number | null) => void;
  onMore: () => void;
}) {
  const suggestion =
    line.unit_price === null && !line.is_excluded_display
      ? suggestPrice(line.description, line.unit, book)
      : null;
  const suggestionProject = suggestion?.lastProjectId
    ? projects.find((p) => p.id === suggestion.lastProjectId)?.title ?? null
    : null;
  const orphaned = line.internal_note === ORPHAN_NOTE;
  const excluded = !!line.is_excluded_display;

  return (
    <div className={`bid-line${excluded ? " bid-line-excluded" : ""}`}>
      <div className="bid-line-grid">
        <input
          key={line.description}
          className="bid-desc"
          type="text"
          defaultValue={line.description}
          placeholder="Description"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== line.description) onCommit({ description: v });
          }}
        />
        {!excluded && (
          <>
            <NumField
              className={`bid-qty${line.qty === null ? " bid-needs" : ""}`}
              value={line.qty}
              placeholder="qty"
              onCommit={(qty) => onCommit({ qty })}
            />
            <select
              className="bid-unit"
              value={line.unit}
              onChange={(e) => onCommit({ unit: e.target.value })}
            >
              {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
            <NumField
              className="bid-price"
              value={line.unit_price}
              placeholder="$/unit"
              onCommit={onPrice}
            />
            <span className="bid-ext">{money(lineExtended(line))}</span>
          </>
        )}
        <button className="inline-link bid-more" onClick={onMore}>⋯</button>
      </div>
      <div className="bid-line-meta">
        {line.qty === null && !excluded && <span className="bid-hint">qty needed</span>}
        {suggestion && (
          <button className="chip bid-suggest" onClick={() => onPrice(suggestion.price)}>
            Last: {money(suggestion.price)}/{line.unit}
            {suggestionProject ? ` — ${suggestionProject}` : ""}
            {suggestion.lastDate ? `, ${new Date(suggestion.lastDate).toLocaleDateString()}` : ""}
          </button>
        )}
        {!!line.is_allowance && <span className="chip-static">Allowance</span>}
        {!!line.is_optional && <span className="chip-static">Add-alternate</span>}
        {line.cost_breakdown && <span className="chip-static">L/M split</span>}
        {orphaned && <span className="bid-orphan">{ORPHAN_NOTE}</span>}
      </div>
    </div>
  );
}

function TotalsBar({
  totals, markupPct, onMarkup,
}: {
  totals: ReturnType<typeof computeTotals>;
  markupPct: number;
  onMarkup: (pct: number | null) => void;
}) {
  return (
    <div className="bid-totals">
      <div className="bid-totals-row">
        <span className="muted">Subtotal</span>
        <span>{money(totals.subtotal)}</span>
      </div>
      <div className="bid-totals-row">
        <span className="muted">
          Markup{" "}
          <NumField className="bid-markup-input" value={markupPct} onCommit={onMarkup} />%
          <span className="muted"> (internal)</span>
        </span>
        <span>{money(totals.markup_amount)}</span>
      </div>
      <div className="bid-totals-row">
        <span className="muted">{totals.tax_rule_missing ? "Tax — no tax rule set" : "Tax"}</span>
        <span>{money(totals.tax_amount)}</span>
      </div>
      <div className="bid-totals-row bid-totals-grand">
        <span>Total</span>
        <span>{money(totals.total)}</span>
      </div>
      <p className="bid-margin">
        This bid carries {totals.margin_pct.toFixed(1)}% gross margin
      </p>
    </div>
  );
}

function LineActionsSheet({
  line, onCommit, onClose,
}: {
  line: LineItem;
  onCommit: (patch: Partial<LineItem>) => void;
  onClose: () => void;
}) {
  const split = useMemo(() => {
    if (!line.cost_breakdown) return null;
    try {
      return JSON.parse(line.cost_breakdown) as { labor: number; material: number };
    } catch {
      return null;
    }
  }, [line.cost_breakdown]);
  const [splitOpen, setSplitOpen] = useState(!!split);

  function commitSplit(labor: number | null, material: number | null) {
    if (labor === null && material === null) {
      onCommit({ cost_breakdown: null });
      return;
    }
    const l = labor ?? 0;
    const m = material ?? 0;
    // The split is contractor-internal detail; unit_price stays the sum.
    onCommit({ cost_breakdown: JSON.stringify({ labor: l, material: m }), unit_price: l + m });
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>{line.description || "Line item"}</h2>

        <button
          className={line.is_allowance ? "chip-on" : "chip"}
          onClick={() => onCommit({ is_allowance: line.is_allowance ? 0 : 1 })}
        >
          {line.is_allowance ? "✓ Allowance" : "Make allowance"}
        </button>
        {!!line.is_allowance && (
          <input
            key={line.allowance_note ?? ""}
            type="text"
            defaultValue={line.allowance_note ?? ""}
            placeholder="Allowance note (what it covers, when it's settled)"
            onBlur={(e) => {
              const v = e.target.value.trim() || null;
              if (v !== line.allowance_note) onCommit({ allowance_note: v });
            }}
          />
        )}

        <button
          className={line.is_optional ? "chip-on" : "chip"}
          onClick={() => onCommit({ is_optional: line.is_optional ? 0 : 1 })}
        >
          {line.is_optional ? "✓ Add-alternate (optional)" : "Make add-alternate"}
        </button>

        <button
          className={line.is_excluded_display ? "chip-on" : "chip"}
          onClick={() => onCommit({ is_excluded_display: line.is_excluded_display ? 0 : 1 })}
        >
          {line.is_excluded_display ? "✓ In exclusions" : "Move to exclusions"}
        </button>

        <button className="chip" onClick={() => setSplitOpen(!splitOpen)}>
          Labor / material split
        </button>
        {splitOpen && (
          <div className="row">
            <NumField
              value={split?.labor ?? null}
              placeholder="labor $/unit"
              onCommit={(v) => commitSplit(v, split?.material ?? null)}
            />
            <NumField
              value={split?.material ?? null}
              placeholder="material $/unit"
              onCommit={(v) => commitSplit(split?.labor ?? null, v)}
            />
          </div>
        )}

        <textarea
          key={line.internal_note ?? ""}
          defaultValue={line.internal_note ?? ""}
          placeholder="Internal note (never shows to the customer)"
          onBlur={(e) => {
            const v = e.target.value.trim() || null;
            if (v !== line.internal_note) onCommit({ internal_note: v });
          }}
        />

        <button
          className="secondary bid-delete"
          onClick={() => {
            onCommit({ deleted: 1 });
            onClose();
          }}
        >
          Delete line
        </button>
        <button className="secondary" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}
