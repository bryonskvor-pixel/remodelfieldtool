// Entity + template types shared across the capture flow. Field names mirror
// the server schema (db/migrations) 1:1 so sync pushes rows verbatim.
// contractor_id is deliberately absent from client rows: the server always
// derives it from the session (Hard Rule 7).

export interface Contractor {
  id: string;
  business_name: string;
  owner_name: string | null;
  email: string;
  default_markup_pct: number;
  proposal_expiration_days: number;
}

export type ProjectType = "kitchen" | "bath" | "basement" | "deck_patio" | "addition" | "general";

export interface Project {
  id: string;
  lead_id: string | null;
  project_type: ProjectType;
  title: string;
  property_year_built: number | null;
  occupied: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface Walkthrough {
  id: string;
  project_id: string;
  started_at: string | null;
  completed_at: string | null;
  completeness_score: number | null;
  gps_lat: number | null;
  gps_lng: number | null;
  weather_note: string | null;
  status: "in_progress" | "complete";
  created_at: string;
  updated_at: string;
}

export interface Area {
  id: string;
  walkthrough_id: string;
  name: string;
  area_type: string | null; // project type whose blocks this area runs, or "universal"
  length_ft: number | null;
  width_ft: number | null;
  ceiling_height_ft: number | null;
  floor_sf: number | null;
  wall_sf: number | null;
  sort_order: number;
  updated_at: string;
}

export interface Measurement {
  qty: number | null;
  unit: string;
  /** L×W entry uses length/width; sketch mode stores the room polygon as
   * corner points in feet (rectilinear, from the sketch pad). */
  dims?: { length?: number; width?: number; points?: { x: number; y: number }[] };
  label?: string;
}

export interface ScopeItem {
  id: string;
  area_id: string;
  checklist_key: string | null;
  category: string | null;
  title: string;
  existing_condition: string | null;
  planned_change: string | null;
  action: string | null;
  answer: string | null;        // JSON: string or string[] for multi-select
  measurements: string | null;  // JSON: Measurement[]
  flags: string | null;         // JSON: string[]
  skipped: number;
  skip_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface Photo {
  id: string;
  scope_item_id: string | null;
  area_id: string | null;
  walkthrough_id: string;
  r2_key: string | null;
  thumbnail_key: string | null;
  caption: string | null;
  annotation_data: string | null;
  taken_at: string;
  gps_lat: number | null;
  gps_lng: number | null;
  sync_status: "pending" | "uploading" | "synced" | "failed";
  updated_at: string;
}

export interface Note {
  id: string;
  parent_type: "area" | "scope_item" | "walkthrough";
  parent_id: string;
  type: "voice" | "text";
  audio_r2_key: string | null;
  transcript: string | null;
  duration_sec: number | null;
  sync_status: "pending" | "uploading" | "synced" | "failed";
  created_at: string;
  updated_at: string;
}

// ---- Templates (shape of templates/*.json checklist_json) -------------------

export type CaptureKind = "photo" | "voice" | "note" | "measurement" | "choice";

export interface ItemCondition {
  item?: string;
  lt?: number;
  in?: string[];
  answer?: string;
  project_type?: string;
}

export interface ConditionalPhoto {
  when: { answer?: string; answer_in?: string[] };
  prompt: string;
}

export interface TemplateItem {
  key: string;
  division: string;
  prompt: string;
  capture: CaptureKind[];
  choices?: string[];
  multi?: boolean;
  unit?: string;
  required_level: "required" | "conditional" | "optional";
  condition: ItemCondition | null;
  photo_required: boolean;
  flags: string[];
  bid_mapping: unknown[];
  proposal_assumption?: string;
  conditional_photo?: ConditionalPhoto;
}

export interface TemplateBlock {
  key: string;
  title: string;
  items: TemplateItem[];
}

export interface Template {
  project_type: string;
  version: number;
  name: string;
  description: string;
  blocks: TemplateBlock[];
}

export const SKIP_REASONS = ["Not applicable", "Will verify later", "Customer undecided"] as const;
