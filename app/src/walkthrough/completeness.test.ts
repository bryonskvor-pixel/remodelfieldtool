import { describe, expect, it } from "vitest";
import { scoreWalkthrough } from "./completeness";
import { buildAnswerContext, buildSteps, conditionFired } from "./engine";
import type { Area, Note, Photo, ScopeItem, Template, TemplateItem } from "../types";

// ---- fixtures ----------------------------------------------------------------

function tItem(overrides: Partial<TemplateItem> & { key: string }): TemplateItem {
  return {
    division: "general_conditions",
    prompt: "Prompt",
    capture: ["choice", "note"],
    required_level: "required",
    condition: null,
    photo_required: false,
    flags: [],
    bid_mapping: [],
    ...overrides,
  };
}

function template(projectType: string, items: TemplateItem[]): Template {
  return {
    project_type: projectType,
    version: 1,
    name: projectType,
    description: "",
    blocks: [{ key: "main", title: "Main", items }],
  };
}

function area(id: string, areaType: string, sortOrder = 0): Area {
  return {
    id, walkthrough_id: "wt1", name: id, area_type: areaType,
    length_ft: null, width_ft: null, ceiling_height_ft: null,
    floor_sf: null, wall_sf: null, sort_order: sortOrder, updated_at: "",
  };
}

function scopeItem(overrides: Partial<ScopeItem> & { id: string; area_id: string; checklist_key: string }): ScopeItem {
  return {
    category: null, title: overrides.checklist_key,
    existing_condition: null, planned_change: null, action: null,
    answer: null, measurements: null, flags: null,
    skipped: 0, skip_reason: null, created_at: "", updated_at: "",
    ...overrides,
  } as ScopeItem;
}

function photo(id: string, scopeItemId: string): Photo {
  return {
    id, scope_item_id: scopeItemId, area_id: null, walkthrough_id: "wt1",
    r2_key: null, thumbnail_key: null, caption: null, annotation_data: null,
    taken_at: "", gps_lat: null, gps_lng: null, sync_status: "pending", updated_at: "",
  };
}

const noNotes: Note[] = [];
const noPhotos: Photo[] = [];

function run(items: TemplateItem[], scopeItems: ScopeItem[], photos: Photo[] = noPhotos) {
  const areas = [area("a1", "kitchen")];
  const templates = new Map([["kitchen", template("kitchen", items)]]);
  const steps = buildSteps(areas, templates, scopeItems);
  return { steps, report: scoreWalkthrough(steps, scopeItems, photos, noNotes) };
}

// ---- required items (§7) -------------------------------------------------------

describe("required items", () => {
  it("flags an unanswered required item red and scores it incomplete", () => {
    const { report } = run([tItem({ key: "kitchen.scope_tier" })], []);
    expect(report.total).toBe(1);
    expect(report.answered).toBe(0);
    expect(report.redFlags).toHaveLength(1);
    expect(report.redFlags[0]!.message).toMatch(/Scope tier not captured/);
  });

  it("counts a choice answer as answered", () => {
    const { report } = run(
      [tItem({ key: "kitchen.scope_tier", choices: ["full_gut"] })],
      [scopeItem({ id: "s1", area_id: "a1", checklist_key: "kitchen.scope_tier", answer: JSON.stringify("full_gut") })],
    );
    expect(report.answered).toBe(1);
    expect(report.redFlags).toHaveLength(0);
    expect(report.score).toBe(1);
  });

  it("counts a measurement as answered", () => {
    const { report } = run(
      [tItem({ key: "kitchen.dims", capture: ["measurement"] })],
      [scopeItem({
        id: "s1", area_id: "a1", checklist_key: "kitchen.dims",
        measurements: JSON.stringify([{ qty: 120, unit: "sf", dims: { length: 12, width: 10 } }]),
      })],
    );
    expect(report.answered).toBe(1);
  });

  it("counts photos and notes as answers (voice/photo are first-class inputs)", () => {
    const si = scopeItem({ id: "s1", area_id: "a1", checklist_key: "universal.staging" });
    const { report } = run(
      [tItem({ key: "universal.staging", capture: ["photo", "note"], photo_required: true })],
      [si],
      [photo("p1", "s1")],
    );
    expect(report.answered).toBe(1);
    expect(report.redFlags).toHaveLength(0);
  });

  it("excludes optional items from the score but not required ones", () => {
    const { report } = run(
      [tItem({ key: "kitchen.scope_tier" }), tItem({ key: "kitchen.window_door_changes", required_level: "optional" })],
      [],
    );
    expect(report.total).toBe(1);
  });
});

// ---- photo requirements ---------------------------------------------------------

describe("photo requirements", () => {
  it("reds an answered item whose required photo is missing", () => {
    const { report } = run(
      [tItem({ key: "universal.electrical_panel", photo_required: true, choices: ["ok"] })],
      [scopeItem({ id: "s1", area_id: "a1", checklist_key: "universal.electrical_panel", answer: JSON.stringify("ok") })],
    );
    expect(report.answered).toBe(0);
    expect(report.redFlags[0]!.message).toBe("No photo of electrical panel");
  });

  it("reds a fired conditional photo (vented hood, no exterior wall photo)", () => {
    const { report } = run(
      [tItem({
        key: "kitchen.hood",
        choices: ["recirculating", "vented_exterior_wall"],
        conditional_photo: {
          when: { answer_in: ["vented_exterior_wall", "vented_roof"] },
          prompt: "Photo of exterior wall at hood location",
        },
      })],
      [scopeItem({ id: "s1", area_id: "a1", checklist_key: "kitchen.hood", answer: JSON.stringify("vented_exterior_wall") })],
    );
    expect(report.redFlags[0]!.message).toBe("Photo of exterior wall at hood location");
  });

  it("does not require the conditional photo when the trigger answer wasn't chosen", () => {
    const { report } = run(
      [tItem({
        key: "kitchen.hood",
        choices: ["recirculating"],
        conditional_photo: { when: { answer_in: ["vented_exterior_wall"] }, prompt: "Photo of exterior wall" },
      })],
      [scopeItem({ id: "s1", area_id: "a1", checklist_key: "kitchen.hood", answer: JSON.stringify("recirculating") })],
    );
    expect(report.redFlags).toHaveLength(0);
    expect(report.answered).toBe(1);
  });
});

// ---- conditional items ----------------------------------------------------------

describe("conditional triggers", () => {
  const yearBuilt = tItem({ key: "universal.year_built", capture: ["measurement"], unit: "year" });
  const leadPaint = tItem({
    key: "universal.lead_paint",
    required_level: "conditional",
    condition: { item: "universal.year_built", lt: 1978 },
  });

  it("keeps an unfired conditional out of the step list entirely", () => {
    const { steps } = run([yearBuilt, leadPaint], [
      scopeItem({
        id: "s1", area_id: "a1", checklist_key: "universal.year_built",
        measurements: JSON.stringify([{ qty: 2001, unit: "year" }]),
      }),
    ]);
    expect(steps.map((s) => s.item.key)).toEqual(["universal.year_built"]);
  });

  it("does not fire lt-conditions while the trigger item is unanswered", () => {
    const ctx = buildAnswerContext("kitchen", []);
    expect(conditionFired({ item: "universal.year_built", lt: 1978 }, ctx)).toBe(false);
  });

  it("reds a fired conditional that wasn't answered", () => {
    const { steps, report } = run([yearBuilt, leadPaint], [
      scopeItem({
        id: "s1", area_id: "a1", checklist_key: "universal.year_built",
        measurements: JSON.stringify([{ qty: 1962, unit: "year" }]),
      }),
    ]);
    expect(steps.map((s) => s.item.key)).toContain("universal.lead_paint");
    expect(report.redFlags[0]!.message).toMatch(/Lead paint applies here but wasn't answered/);
  });

  it("fires in-conditions from a choice answer (scope tier gates wall removal)", () => {
    const wallsRemoved = tItem({
      key: "kitchen.walls_removed",
      required_level: "conditional",
      condition: { item: "kitchen.scope_tier", in: ["layout_change", "full_gut"] },
    });
    const scoped = (tier: string) => run(
      [tItem({ key: "kitchen.scope_tier", choices: ["pull_and_replace", "layout_change"] }), wallsRemoved],
      [scopeItem({ id: "s1", area_id: "a1", checklist_key: "kitchen.scope_tier", answer: JSON.stringify(tier) })],
    );
    expect(scoped("layout_change").steps.map((s) => s.item.key)).toContain("kitchen.walls_removed");
    expect(scoped("pull_and_replace").steps.map((s) => s.item.key)).not.toContain("kitchen.walls_removed");
  });

  it("fires project_type conditions (radon only on basements)", () => {
    const ctxBasement = buildAnswerContext("basement", []);
    const ctxKitchen = buildAnswerContext("kitchen", []);
    expect(conditionFired({ project_type: "basement" }, ctxBasement)).toBe(true);
    expect(conditionFired({ project_type: "basement" }, ctxKitchen)).toBe(false);
  });

  it("matches multi-select answers against in-conditions", () => {
    const ctx = buildAnswerContext("kitchen", [
      scopeItem({
        id: "s1", area_id: "a1", checklist_key: "kitchen.plumbing_extras",
        answer: JSON.stringify(["disposal", "pot_filler"]),
      }),
    ]);
    expect(conditionFired({ item: "kitchen.plumbing_extras", in: ["pot_filler"] }, ctx)).toBe(true);
    expect(conditionFired({ item: "kitchen.plumbing_extras", in: ["ice_maker"] }, ctx)).toBe(false);
  });
});

// ---- skips (Hard Rule 4: warn, never block) --------------------------------------

describe("skipped items", () => {
  it("yellows a skipped item with its reason and drafts a generic assumption", () => {
    const { report } = run(
      [tItem({ key: "universal.water_supply" })],
      [scopeItem({
        id: "s1", area_id: "a1", checklist_key: "universal.water_supply",
        skipped: 1, skip_reason: "Will verify later",
      })],
    );
    expect(report.redFlags).toHaveLength(0);
    expect(report.yellowFlags).toHaveLength(1);
    expect(report.yellowFlags[0]!.skipReason).toBe("Will verify later");
    expect(report.yellowFlags[0]!.draftedAssumption).toMatch(/Water supply not verified/);
    expect(report.answered).toBe(0); // skipped is acknowledged, not complete
  });

  it("uses the template's proposal_assumption for the draft when present", () => {
    const { report } = run(
      [tItem({
        key: "kitchen.soffit",
        proposal_assumption: "Soffit contents unknown; rerouting priced after opening.",
      })],
      [scopeItem({
        id: "s1", area_id: "a1", checklist_key: "kitchen.soffit",
        skipped: 1, skip_reason: "Customer undecided",
      })],
    );
    expect(report.yellowFlags[0]!.draftedAssumption).toBe("Soffit contents unknown; rerouting priced after opening.");
  });
});

// ---- multi-area ------------------------------------------------------------------

describe("areas", () => {
  it("orders the universal area first and resolves same-key answers per area", () => {
    const universal = template("universal", [tItem({ key: "universal.year_built", capture: ["measurement"] })]);
    const kitchen = template("kitchen", [tItem({ key: "kitchen.scope_tier", choices: ["full_gut"] })]);
    const areas = [area("k1", "kitchen", 1), area("u1", "universal", 0), area("k2", "kitchen", 2)];
    const templates = new Map([["universal", universal], ["kitchen", kitchen]]);
    const items = [
      scopeItem({ id: "s1", area_id: "k1", checklist_key: "kitchen.scope_tier", answer: JSON.stringify("full_gut") }),
    ];
    const steps = buildSteps(areas, templates, items);
    expect(steps[0]!.item.key).toBe("universal.year_built");
    expect(steps.filter((s) => s.item.key === "kitchen.scope_tier")).toHaveLength(2);

    // k1 answered, k2 not: exactly one red flag, attributed to k2.
    const report = scoreWalkthrough(steps, items, noPhotos, noNotes);
    const tierFlags = report.redFlags.filter((f) => f.key === "kitchen.scope_tier");
    expect(tierFlags).toHaveLength(1);
    expect(tierFlags[0]!.areaName).toBe("k2");
  });

  it("scores 100% when every active item in every area is captured", () => {
    const kitchen = template("kitchen", [tItem({ key: "kitchen.scope_tier", choices: ["full_gut"] })]);
    const areas = [area("k1", "kitchen"), area("k2", "kitchen", 1)];
    const items = [
      scopeItem({ id: "s1", area_id: "k1", checklist_key: "kitchen.scope_tier", answer: JSON.stringify("full_gut") }),
      scopeItem({ id: "s2", area_id: "k2", checklist_key: "kitchen.scope_tier", answer: JSON.stringify("full_gut") }),
    ];
    const steps = buildSteps(areas, new Map([["kitchen", kitchen]]), items);
    const report = scoreWalkthrough(steps, items, noPhotos, noNotes);
    expect(report.score).toBe(1);
    expect(report.redFlags).toHaveLength(0);
  });
});
