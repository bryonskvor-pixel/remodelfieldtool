import { useMemo } from "react";
import { useWalkthroughData } from "./WalkthroughRunner";
import { db, now } from "../db/store";
import { buildSteps, captureFor, humanizeKey, parsedMeasurements } from "../walkthrough/engine";
import { scoreWalkthrough } from "../walkthrough/completeness";

// Review screen (§11/§7): everything captured grouped by area, flags on top,
// score as X of Y. "Complete" warns loudly but NEVER blocks (Hard Rule 4).

export function Review({
  walkthroughId, onBack, onDone,
}: {
  walkthroughId: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const data = useWalkthroughData(walkthroughId);

  const steps = useMemo(
    () => (data ? buildSteps(data.areas, data.templates, data.scopeItems) : []),
    [data],
  );
  const report = useMemo(
    () => (data ? scoreWalkthrough(steps, data.scopeItems, data.photos, data.notes) : null),
    [data, steps],
  );

  if (!data || !report) return <p className="muted">Loading…</p>;

  async function complete() {
    await db.walkthroughs.put({
      ...data!.walkthrough,
      status: "complete",
      completed_at: now(),
      completeness_score: report!.score,
    });
    onDone();
  }

  const complete_ = data.walkthrough.status === "complete";

  return (
    <div>
      <div className="runner-header">
        <button className="inline-link" onClick={onBack}>← Back to walkthrough</button>
      </div>
      <h1>Review</h1>
      <p className={report.redFlags.length > 0 ? "error" : "muted"}>
        {report.answered} of {report.total} captured ({Math.round(report.score * 100)}%)
      </p>

      {report.redFlags.length > 0 && (
        <div className="card flag-card-red">
          <h2>🚩 Missing ({report.redFlags.length})</h2>
          {report.redFlags.map((f, i) => (
            <p key={i}>{f.message} <span className="muted">— {f.areaName}</span></p>
          ))}
        </div>
      )}

      {report.yellowFlags.length > 0 && (
        <div className="card flag-card-yellow">
          <h2>⚠️ Skipped ({report.yellowFlags.length})</h2>
          <p className="muted">Each skip drafts a suggested exclusion/assumption for the proposal:</p>
          {report.yellowFlags.map((f, i) => (
            <div key={i} className="yellow-flag">
              <p>{humanizeKey(f.key)} <span className="muted">— {f.skipReason}, {f.areaName}</span></p>
              <p className="assumption">"{f.draftedAssumption}"</p>
            </div>
          ))}
        </div>
      )}

      {data.areas
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((area) => {
          const areaSteps = steps.filter((s) => s.areaId === area.id);
          return (
            <div key={area.id} className="card">
              <h2>{area.name}</h2>
              {areaSteps.map((s) => {
                const c = captureFor(s, data.scopeItems, data.photos, data.notes);
                const m = parsedMeasurements(c.scopeItem);
                const answer = c.scopeItem?.answer ? JSON.parse(c.scopeItem.answer) as string | string[] : null;
                return (
                  <p key={s.item.key} className="review-line">
                    <strong>{humanizeKey(s.item.key)}</strong>{" "}
                    {c.scopeItem?.skipped ? (
                      <span className="muted">skipped — {c.scopeItem.skip_reason}</span>
                    ) : (
                      <span className="muted">
                        {[
                          answer ? (Array.isArray(answer) ? answer.join(", ") : answer).replace(/_/g, " ") : null,
                          m.length > 0 ? m.map((x) => `${x.qty} ${x.unit}`).join(", ") : null,
                          c.photoCount > 0 ? `${c.photoCount} 📷` : null,
                          c.noteCount > 0 ? `${c.noteCount} note(s)` : null,
                        ].filter(Boolean).join(" · ") || "—"}
                      </span>
                    )}
                  </p>
                );
              })}
            </div>
          );
        })}

      <button onClick={() => void complete()}>
        {complete_ ? "Update completeness score" : report.redFlags.length > 0
          ? `Complete anyway (${report.redFlags.length} missing)`
          : "Complete walkthrough"}
      </button>
      <p className="muted">
        Completing never blocks you — missing items stay logged and skipped items
        surface as exclusions/assumptions on the proposal.
      </p>
    </div>
  );
}
