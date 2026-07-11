import { useEffect, useState } from "react";
import { db, newId, now, onStoreChange } from "../db/store";
import type { Contractor, Project, ProjectType, Walkthrough } from "../types";

// Home (§11): start a walkthrough + recent projects. Creating a project and
// walkthrough is a pure local write — works in a basement with zero bars.

const PROJECT_TYPES: { value: ProjectType; label: string }[] = [
  { value: "kitchen", label: "Kitchen" },
  { value: "bath", label: "Bath" },
  { value: "basement", label: "Basement" },
  { value: "deck_patio", label: "Deck / Patio" },
  { value: "addition", label: "Addition" },
  { value: "general", label: "General" },
];

const AREA_NAMES: Record<ProjectType, string> = {
  kitchen: "Kitchen",
  bath: "Bathroom",
  basement: "Basement",
  deck_patio: "Deck / Patio",
  addition: "Addition",
  general: "Main area",
};

export function Home({
  contractor, onOpenWalkthrough,
}: {
  contractor: Contractor;
  onOpenWalkthrough: (id: string) => void;
}) {
  const [starting, setStarting] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [walkthroughs, setWalkthroughs] = useState<Walkthrough[]>([]);

  useEffect(() => {
    async function load() {
      setProjects(await db.projects.all());
      setWalkthroughs(await db.walkthroughs.all());
    }
    void load();
    return onStoreChange(() => void load());
  }, []);

  async function startWalkthrough(title: string, type: ProjectType) {
    const project: Project = {
      id: newId(), lead_id: null, project_type: type, title,
      property_year_built: null, occupied: 1, status: "active",
      created_at: now(), updated_at: now(),
    };
    await db.projects.put(project);

    const walkthrough: Walkthrough = {
      id: newId(), project_id: project.id, started_at: now(), completed_at: null,
      completeness_score: null, gps_lat: null, gps_lng: null, weather_note: null,
      status: "in_progress", created_at: now(), updated_at: now(),
    };
    await db.walkthroughs.put(walkthrough);

    // GPS-at-start (§4.2, contractor-visible only): best-effort and strictly
    // fire-and-forget — the walkthrough starts NOW, with or without a fix
    // (Hard Rule 3). GPS works offline; it needs a secure context like the
    // camera does, so LAN-HTTP dev just silently skips it.
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          void db.walkthroughs.get(walkthrough.id).then((wt) => {
            if (wt && wt.gps_lat === null) {
              void db.walkthroughs.put({
                ...wt,
                gps_lat: pos.coords.latitude,
                gps_lng: pos.coords.longitude,
              });
            }
          });
        },
        () => {},
        { timeout: 10_000, maximumAge: 300_000 },
      );
    }

    // Universal block runs first on every project type (§6.0); it gets an
    // implicit area, then the primary project-type area.
    await db.areas.put({
      id: newId(), walkthrough_id: walkthrough.id, name: "Property & systems",
      area_type: "universal", length_ft: null, width_ft: null, ceiling_height_ft: null,
      floor_sf: null, wall_sf: null, sort_order: 0, updated_at: now(),
    });
    await db.areas.put({
      id: newId(), walkthrough_id: walkthrough.id, name: AREA_NAMES[type],
      area_type: type, length_ft: null, width_ft: null, ceiling_height_ft: null,
      floor_sf: null, wall_sf: null, sort_order: 1, updated_at: now(),
    });

    onOpenWalkthrough(walkthrough.id);
  }

  const recent = [...projects].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 10);

  return (
    <div>
      <h1>ScopeWalk</h1>
      <p className="muted">{contractor.business_name}</p>

      {starting ? (
        <StartForm onStart={(t, ty) => void startWalkthrough(t, ty)} onCancel={() => setStarting(false)} />
      ) : (
        <button onClick={() => setStarting(true)}>Start Walkthrough</button>
      )}

      <div className="card">
        <h2>Recent projects</h2>
        {recent.length === 0 && <p className="muted">No projects yet.</p>}
        {recent.map((p) => {
          const wt = walkthroughs
            .filter((w) => w.project_id === p.id)
            .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
          return (
            <button
              key={p.id}
              className="card area-card"
              disabled={!wt}
              onClick={() => wt && onOpenWalkthrough(wt.id)}
            >
              <strong>{p.title}</strong>
              <span className="muted">
                {" "}{p.project_type.replace(/_/g, " ")}
                {wt && ` · ${wt.status === "complete"
                  ? `complete${wt.completeness_score != null ? ` (${Math.round(wt.completeness_score * 100)}%)` : ""}`
                  : "in progress"}`}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StartForm({
  onStart, onCancel,
}: {
  onStart: (title: string, type: ProjectType) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<ProjectType>("kitchen");

  return (
    <div className="card">
      <label>Project title</label>
      <input
        value={title}
        placeholder="e.g. Miller kitchen"
        onChange={(e) => setTitle(e.target.value)}
        autoFocus
      />
      <div className="chip-row wrap">
        {PROJECT_TYPES.map((t) => (
          <button
            key={t.value}
            className={`chip ${type === t.value ? "chip-on" : ""}`}
            onClick={() => setType(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="row">
        <button className="secondary" onClick={onCancel}>Cancel</button>
        <button disabled={!title.trim()} onClick={() => onStart(title.trim(), type)}>Start</button>
      </div>
    </div>
  );
}
