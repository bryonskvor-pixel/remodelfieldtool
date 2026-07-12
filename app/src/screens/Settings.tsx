import { useState } from "react";
import { api } from "../api";
import { cacheContractor } from "../db/store";
import { FALLBACK_PAYMENT_SCHEDULE } from "../proposal/seed";
import type { Contractor, PaymentMilestone } from "../types";

// Contractor profile (Phase 2 §9): the proposal consumes these defaults —
// tax rule, markup, terms boilerplate, payment schedule, expiration days,
// license/insurance for the letterhead. Online-only by design: profile edits
// happen at the desk, not in a basement.

export function Settings({
  contractor, onSaved, onBack,
}: {
  contractor: Contractor;
  onSaved: (c: Contractor) => void;
  onBack: () => void;
}) {
  const [form, setForm] = useState<Contractor>({ ...contractor });
  const [schedule, setSchedule] = useState<PaymentMilestone[]>(() => {
    try {
      const parsed = contractor.payment_schedule_default
        ? (JSON.parse(contractor.payment_schedule_default) as PaymentMilestone[])
        : null;
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : FALLBACK_PAYMENT_SCHEDULE;
    } catch {
      return FALLBACK_PAYMENT_SCHEDULE;
    }
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const set = (patch: Partial<Contractor>) => {
    setSaved(false);
    setForm((f) => ({ ...f, ...patch }));
  };

  const pctTotal = schedule.reduce((s, m) => s + (m.percent || 0), 0);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const { contractor: fresh } = await api.patchMe({
        business_name: form.business_name,
        owner_name: form.owner_name,
        phone: form.phone,
        license_number: form.license_number,
        insurance_note: form.insurance_note,
        address: form.address,
        default_markup_pct: form.default_markup_pct,
        default_tax_rule: form.default_tax_rule,
        payment_schedule_default: JSON.stringify(schedule.filter((m) => m.label.trim())),
        terms_boilerplate: form.terms_boilerplate,
        proposal_expiration_days: form.proposal_expiration_days,
      });
      await cacheContractor(fresh);
      onSaved(fresh);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed — are you online?");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="runner-header">
        <button className="inline-link" onClick={onBack}>← Back</button>
      </div>
      <h1>Business settings</h1>
      <p className="muted">These defaults feed every bid sheet and proposal.</p>

      <div className="card">
        <h2>Business</h2>
        <label>Business name</label>
        <input value={form.business_name} onChange={(e) => set({ business_name: e.target.value })} />
        <label>Owner name</label>
        <input value={form.owner_name ?? ""} onChange={(e) => set({ owner_name: e.target.value || null })} />
        <label>Phone</label>
        <input value={form.phone ?? ""} inputMode="tel" onChange={(e) => set({ phone: e.target.value || null })} />
        <label>Address</label>
        <input value={form.address ?? ""} onChange={(e) => set({ address: e.target.value || null })} />
        <label>License number</label>
        <input value={form.license_number ?? ""} onChange={(e) => set({ license_number: e.target.value || null })} />
        <label>Insurance statement (shows on proposals)</label>
        <input value={form.insurance_note ?? ""} placeholder="e.g. Fully licensed & insured" onChange={(e) => set({ insurance_note: e.target.value || null })} />
      </div>

      <div className="card">
        <h2>Pricing defaults</h2>
        <label>Default markup % (internal — never shown to customers)</label>
        <input
          inputMode="decimal"
          value={String(form.default_markup_pct)}
          onChange={(e) => {
            const n = Number(e.target.value);
            set({ default_markup_pct: Number.isNaN(n) ? form.default_markup_pct : n });
          }}
        />
        <label>Tax rule (percent, e.g. 7.25 — leave blank for no tax)</label>
        <input
          inputMode="decimal"
          value={form.default_tax_rule ?? ""}
          onChange={(e) => set({ default_tax_rule: e.target.value || null })}
        />
      </div>

      <div className="card">
        <h2>Proposal defaults</h2>
        <label>Payment schedule (percent of total)</label>
        {schedule.map((m, i) => (
          <div className="row" key={i}>
            <input
              value={m.label}
              placeholder="Milestone"
              onChange={(e) => {
                const next = [...schedule];
                next[i] = { ...m, label: e.target.value };
                setSchedule(next);
                setSaved(false);
              }}
            />
            <input
              className="pct-input"
              inputMode="numeric"
              value={String(m.percent)}
              onChange={(e) => {
                const n = Number(e.target.value);
                const next = [...schedule];
                next[i] = { ...m, percent: Number.isNaN(n) ? m.percent : n };
                setSchedule(next);
                setSaved(false);
              }}
            />
            <button className="inline-link" onClick={() => setSchedule(schedule.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <button className="inline-link" onClick={() => setSchedule([...schedule, { label: "", percent: 0 }])}>＋ Add milestone</button>
        <p className={pctTotal === 100 ? "muted" : "error"}>Total: {pctTotal}%{pctTotal !== 100 ? " — should add to 100%" : ""}</p>

        <label>Proposal valid for (days)</label>
        <input
          inputMode="numeric"
          value={String(form.proposal_expiration_days)}
          onChange={(e) => {
            const n = Number(e.target.value);
            set({ proposal_expiration_days: Number.isNaN(n) ? form.proposal_expiration_days : n });
          }}
        />
        <label>Terms boilerplate</label>
        <textarea
          rows={6}
          value={form.terms_boilerplate ?? ""}
          placeholder="Standard terms that appear on every proposal…"
          onChange={(e) => set({ terms_boilerplate: e.target.value || null })}
        />
      </div>

      {error && <p className="error">{error}</p>}
      <button disabled={saving} onClick={() => void save()}>
        {saving ? "Saving…" : saved ? "✓ Saved" : "Save settings"}
      </button>
    </div>
  );
}
