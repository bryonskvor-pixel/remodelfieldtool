import { useEffect, useState } from "react";
import { db, newId, now, onStoreChange } from "../db/store";
import type { Contractor, Lead, Project, ProjectType, Walkthrough } from "../types";

// Home (§11): start a walkthrough + recent projects. Creating a project and
// walkthrough is a pure local write — works in a basement with zero bars.
// CRM slice: incoming leads (website intake or phone) surface here; starting
// a walkthrough from one links the project to the customer record.

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

const isProjectType = (v: string | null): v is ProjectType =>
  PROJECT_TYPES.some((t) => t.value === v);

/** Contact fields the contractor can enter/edit on the start form. */
interface CustomerDraft {
  customer_name: string;
  phone: string;
  email: string;
  address_street: string;
  address_city: string;
  address_state: string;
  address_zip: string;
}

const EMPTY_CUSTOMER: CustomerDraft = {
  customer_name: "", phone: "", email: "",
  address_street: "", address_city: "", address_state: "", address_zip: "",
};

export function Home({
  contractor, onOpenWalkthrough, onSettings,
}: {
  contractor: Contractor;
  onOpenWalkthrough: (id: string) => void;
  onSettings: () => void;
}) {
  const [startingFrom, setStartingFrom] = useState<Lead | null | undefined>(undefined); // undefined = form closed
  const [projects, setProjects] = useState<Project[]>([]);
  const [walkthroughs, setWalkthroughs] = useState<Walkthrough[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);

  useEffect(() => {
    async function load() {
      setProjects(await db.projects.all());
      setWalkthroughs(await db.walkthroughs.all());
      setLeads(await db.leads.all());
    }
    void load();
    return onStoreChange(() => void load());
  }, []);

  async function startWalkthrough(
    title: string,
    type: ProjectType,
    customer: CustomerDraft,
    fromLead: Lead | null,
  ) {
    // Customer info lands on a lead row (the CRM record), never on the
    // project itself — one customer, many downstream artifacts.
    let leadId: string | null = fromLead?.id ?? null;
    const name = customer.customer_name.trim();
    if (fromLead || name) {
      const blank = (s: string) => (s.trim() ? s.trim() : null);
      const lead: Lead = {
        id: leadId ?? newId(),
        source: fromLead?.source ?? "manual",
        customer_name: name || fromLead?.customer_name || "Unknown",
        email: blank(customer.email) ?? fromLead?.email ?? null,
        phone: blank(customer.phone) ?? fromLead?.phone ?? null,
        address_street: blank(customer.address_street) ?? fromLead?.address_street ?? null,
        address_city: blank(customer.address_city) ?? fromLead?.address_city ?? null,
        address_state: blank(customer.address_state) ?? fromLead?.address_state ?? null,
        address_zip: blank(customer.address_zip) ?? fromLead?.address_zip ?? null,
        project_type_interest: fromLead?.project_type_interest ?? type,
        budget_range_stated: fromLead?.budget_range_stated ?? null,
        timeline_stated: fromLead?.timeline_stated ?? null,
        intake_notes: fromLead?.intake_notes ?? null,
        status: "walkthrough_scheduled",
        created_at: fromLead?.created_at ?? now(),
        updated_at: now(),
      };
      leadId = lead.id;
      await db.leads.put(lead);
    }

    const project: Project = {
      id: newId(), lead_id: leadId, project_type: type, title,
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
  const leadById = new Map(leads.map((l) => [l.id, l]));

  // Leads awaiting a walkthrough: not yet linked to any project and still in
  // the pre-walkthrough part of the pipeline. Website intake rows land here
  // via the bootstrap pull as soon as the app opens with a connection.
  const usedLeadIds = new Set(projects.map((p) => p.lead_id).filter(Boolean));
  const incoming = leads
    .filter((l) => !usedLeadIds.has(l.id) && ["new", "contacted", "walkthrough_scheduled"].includes(l.status))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  return (
    <div>
      <h1>ScopeWalk</h1>
      <p className="muted">
        {contractor.business_name}
        {" · "}
        <button className="inline-link" onClick={onSettings}>⚙ Settings</button>
      </p>

      {startingFrom !== undefined ? (
        <StartForm
          lead={startingFrom}
          onStart={(t, ty, cust) => void startWalkthrough(t, ty, cust, startingFrom ?? null)}
          onCancel={() => setStartingFrom(undefined)}
        />
      ) : (
        <button onClick={() => setStartingFrom(null)}>Start Walkthrough</button>
      )}

      {incoming.length > 0 && startingFrom === undefined && (
        <div className="card">
          <h2>New leads</h2>
          {incoming.map((l) => (
            <button key={l.id} className="card area-card" onClick={() => setStartingFrom(l)}>
              <strong>{l.customer_name}</strong>
              <span className="muted">
                {" "}
                {[
                  l.project_type_interest?.replace(/_/g, " "),
                  l.phone,
                  l.budget_range_stated,
                  l.source === "website_intake" ? "via website" : l.source,
                ].filter(Boolean).join(" · ")}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="card">
        <h2>Recent projects</h2>
        {recent.length === 0 && <p className="muted">No projects yet.</p>}
        {recent.map((p) => {
          const wt = walkthroughs
            .filter((w) => w.project_id === p.id)
            .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
          const customer = p.lead_id ? leadById.get(p.lead_id) : undefined;
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
                {customer && ` · ${customer.customer_name}`}
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
  lead, onStart, onCancel,
}: {
  lead: Lead | null;
  onStart: (title: string, type: ProjectType, customer: CustomerDraft) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(lead ? suggestTitle(lead) : "");
  const [type, setType] = useState<ProjectType>(
    lead && isProjectType(lead.project_type_interest) ? lead.project_type_interest : "kitchen",
  );
  const [customer, setCustomer] = useState<CustomerDraft>(
    lead
      ? {
          customer_name: lead.customer_name,
          phone: lead.phone ?? "",
          email: lead.email ?? "",
          address_street: lead.address_street ?? "",
          address_city: lead.address_city ?? "",
          address_state: lead.address_state ?? "",
          address_zip: lead.address_zip ?? "",
        }
      : EMPTY_CUSTOMER,
  );

  const set = (field: keyof CustomerDraft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setCustomer((c) => ({ ...c, [field]: e.target.value }));

  return (
    <div className="card">
      <label>Project title</label>
      <input
        value={title}
        placeholder="e.g. Miller kitchen"
        onChange={(e) => setTitle(e.target.value)}
        autoFocus={!lead}
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

      <h2>Customer</h2>
      {lead?.intake_notes && <p className="muted">Intake: {lead.intake_notes}</p>}
      <label>Name</label>
      <input value={customer.customer_name} placeholder="e.g. Sarah Miller" onChange={set("customer_name")} />
      <div className="row">
        <div style={{ flex: 1 }}>
          <label>Phone</label>
          <input type="tel" value={customer.phone} onChange={set("phone")} />
        </div>
        <div style={{ flex: 1 }}>
          <label>Email</label>
          <input type="email" value={customer.email} onChange={set("email")} />
        </div>
      </div>
      <label>Street address</label>
      <input value={customer.address_street} onChange={set("address_street")} />
      <div className="row">
        <div style={{ flex: 2 }}>
          <label>City</label>
          <input value={customer.address_city} onChange={set("address_city")} />
        </div>
        <div style={{ flex: 1 }}>
          <label>State</label>
          <input value={customer.address_state} onChange={set("address_state")} />
        </div>
        <div style={{ flex: 1 }}>
          <label>Zip</label>
          <input value={customer.address_zip} inputMode="numeric" onChange={set("address_zip")} />
        </div>
      </div>

      <div className="row">
        <button className="secondary" onClick={onCancel}>Cancel</button>
        <button disabled={!title.trim()} onClick={() => onStart(title.trim(), type, customer)}>Start</button>
      </div>
    </div>
  );
}

/** "Sarah Miller" + interest "kitchen" → "Miller kitchen". */
function suggestTitle(lead: Lead): string {
  const lastName = lead.customer_name.trim().split(/\s+/).pop() ?? lead.customer_name;
  const interest = lead.project_type_interest?.replace(/_/g, " ") ?? "project";
  return `${lastName} ${interest}`;
}
