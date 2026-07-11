import { useEffect, useMemo, useState } from "react";
import { PromptScreen } from "./PromptScreen";
import { db, newId, now, onStoreChange } from "../db/store";
import { cachedTemplates } from "../db/store";
import { buildSteps, captureFor, type Step } from "../walkthrough/engine";
import { scoreWalkthrough } from "../walkthrough/completeness";
import type { Area, Note, Photo, Project, ScopeItem, Template, Walkthrough } from "../types";

// Walkthrough flow (§11): universal block → project-type blocks → per-area
// loops with add-area. Reads only from the offline store; reload-safe.

interface Data {
  walkthrough: Walkthrough;
  project: Project;
  areas: Area[];
  scopeItems: ScopeItem[];
  photos: Photo[];
  notes: Note[];
  templates: Map<string, Template>;
}

export function useWalkthroughData(walkthroughId: string): Data | null | undefined {
  const [data, setData] = useState<Data | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    async function load() {
      const walkthrough = await db.walkthroughs.get(walkthroughId);
      if (!walkthrough) {
        if (live) setData(null);
        return;
      }
      const project = await db.projects.get(walkthrough.project_id);
      if (!project) {
        if (live) setData(null);
        return;
      }
      const [allAreas, allItems, allPhotos, allNotes, templates] = await Promise.all([
        db.areas.all(), db.scope_items.all(), db.photos.all(), db.notes.all(), cachedTemplates(),
      ]);
      const areas = allAreas.filter((a) => a.walkthrough_id === walkthroughId);
      const areaIds = new Set(areas.map((a) => a.id));
      if (live) {
        setData({
          walkthrough,
          project,
          areas,
          scopeItems: allItems.filter((si) => areaIds.has(si.area_id)),
          photos: allPhotos.filter((p) => p.walkthrough_id === walkthroughId),
          notes: allNotes,
          templates: new Map(templates.map((t) => [t.project_type, t])),
        });
      }
    }
    void load();
    const unsub = onStoreChange(() => void load());
    return () => {
      live = false;
      unsub();
    };
  }, [walkthroughId]);

  return data;
}

function stepKey(s: Step): string {
  return `${s.areaId}:${s.item.key}`;
}

export function WalkthroughRunner({
  walkthroughId, onExit, onReview,
}: {
  walkthroughId: string;
  onExit: () => void;
  onReview: () => void;
}) {
  const data = useWalkthroughData(walkthroughId);
  // Track position by step key, not index: conditional steps appear mid-flow
  // as answers land, and the key keeps us anchored on the same prompt.
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [view, setView] = useState<"prompts" | "areas">("prompts");
  const [addingArea, setAddingArea] = useState(false);

  const steps = useMemo(
    () => (data ? buildSteps(data.areas, data.templates, data.scopeItems) : []),
    [data],
  );

  const report = useMemo(
    () => (data ? scoreWalkthrough(steps, data.scopeItems, data.photos, data.notes) : null),
    [data, steps],
  );

  if (data === undefined) return <p className="muted">Loading…</p>;
  if (data === null) {
    return (
      <div>
        <p className="error">Walkthrough not found on this device.</p>
        <button onClick={onExit}>Home</button>
      </div>
    );
  }

  // Resume at the first untouched step — computed once when data arrives
  // (survives reloads), then the position only moves on explicit Next/Back.
  if (currentKey === null && steps.length > 0) {
    const firstOpen = steps.findIndex((s) => {
      const c = captureFor(s, data.scopeItems, data.photos, data.notes);
      return !c.scopeItem;
    });
    setCurrentKey(stepKey(steps[firstOpen >= 0 ? firstOpen : 0]!));
    return <p className="muted">Loading…</p>;
  }

  const currentIndex = (() => {
    const i = steps.findIndex((s) => stepKey(s) === currentKey);
    return i >= 0 ? i : 0;
  })();

  const step = steps[currentIndex];

  function go(delta: number) {
    const next = currentIndex + delta;
    const target = steps[next];
    if (next >= steps.length) {
      setView("areas");
    } else if (target) {
      setCurrentKey(stepKey(target));
    }
  }

  async function addArea(name: string, areaType: string) {
    const sortOrder = Math.max(0, ...data!.areas.map((a) => a.sort_order)) + 1;
    const area: Area = {
      id: newId(), walkthrough_id: walkthroughId, name, area_type: areaType,
      length_ft: null, width_ft: null, ceiling_height_ft: null,
      floor_sf: null, wall_sf: null, sort_order: sortOrder, updated_at: now(),
    };
    await db.areas.put(area);
    setAddingArea(false);
    setView("prompts");
    setCurrentKey(null); // jump to the new area's first untouched prompt
  }

  const pct = report ? Math.round(report.score * 100) : 0;

  return (
    <div>
      <div className="runner-header">
        <button className="inline-link" onClick={onExit}>← {data.project.title}</button>
        <span className="muted">
          {report ? `${report.answered} of ${report.total}` : ""}
        </span>
      </div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>

      {view === "prompts" && step && (
        <PromptScreen
          key={stepKey(step)}
          step={step}
          scopeItem={captureFor(step, data.scopeItems, data.photos, data.notes).scopeItem}
          photos={data.photos.filter((p) => {
            const si = captureFor(step, data.scopeItems, data.photos, data.notes).scopeItem;
            return si ? p.scope_item_id === si.id : false;
          })}
          notes={data.notes.filter((n) => {
            const si = captureFor(step, data.scopeItems, data.photos, data.notes).scopeItem;
            return si ? n.parent_type === "scope_item" && n.parent_id === si.id : false;
          })}
          walkthroughId={walkthroughId}
          onNext={() => go(1)}
          onBack={() => go(-1)}
          canGoBack={currentIndex > 0}
          isLast={currentIndex === steps.length - 1}
        />
      )}

      {view === "prompts" && !step && (
        <div className="card">
          <p>No prompts for this walkthrough — templates may not be cached yet. Go online once to pull them.</p>
        </div>
      )}

      {view === "areas" && (
        <div>
          <h2>Areas</h2>
          {data.areas
            .sort((a, b) => a.sort_order - b.sort_order)
            .map((a) => {
              const areaSteps = steps.filter((s) => s.areaId === a.id);
              const areaReport = scoreWalkthrough(areaSteps, data.scopeItems, data.photos, data.notes);
              return (
                <button
                  key={a.id}
                  className="card area-card"
                  onClick={() => {
                    const firstStep = areaSteps[0];
                    if (firstStep) {
                      setCurrentKey(stepKey(firstStep));
                      setView("prompts");
                    }
                  }}
                >
                  <strong>{a.name}</strong>
                  <span className="muted"> {areaReport.answered}/{areaReport.total} captured
                    {areaReport.redFlags.length > 0 && ` · ${areaReport.redFlags.length} flags`}
                  </span>
                </button>
              );
            })}

          {addingArea ? (
            <AddAreaForm
              projectType={data.project.project_type}
              templates={data.templates}
              onAdd={(name, type) => void addArea(name, type)}
              onCancel={() => setAddingArea(false)}
            />
          ) : (
            <button className="secondary" onClick={() => setAddingArea(true)}>+ Add area</button>
          )}

          <button onClick={onReview}>Review walkthrough</button>
        </div>
      )}
    </div>
  );
}

function AddAreaForm({
  projectType, templates, onAdd, onCancel,
}: {
  projectType: string;
  templates: Map<string, Template>;
  onAdd: (name: string, areaType: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [areaType, setAreaType] = useState(projectType);
  // An added area can run any project-type block (§6.6 modularity): a hall
  // bath inside a kitchen job pulls the bath block.
  const types = [...templates.keys()].filter((t) => t !== "universal");

  return (
    <div className="card">
      <label>Area name</label>
      <input value={name} placeholder="e.g. Hall bath" onChange={(e) => setName(e.target.value)} />
      <div className="chip-row wrap">
        {types.map((t) => (
          <button key={t} className={`chip ${areaType === t ? "chip-on" : ""}`} onClick={() => setAreaType(t)}>
            {t.replace(/_/g, " ")}
          </button>
        ))}
      </div>
      <div className="row">
        <button className="secondary" onClick={onCancel}>Cancel</button>
        <button disabled={!name.trim()} onClick={() => onAdd(name.trim(), areaType)}>Add</button>
      </div>
    </div>
  );
}
