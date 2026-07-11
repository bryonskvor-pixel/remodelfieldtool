// Walkthrough engine: turns templates + captured answers into the ordered
// list of prompt steps, and evaluates conditional-item triggers. Pure module
// (no IO) so it's unit-testable alongside the completeness engine.

import type {
  Area, ItemCondition, Measurement, Note, Photo, ScopeItem, Template, TemplateItem,
} from "../types";

/** "universal.electrical_panel" → "Electrical panel" (scope_item.title fallback). */
export function humanizeKey(key: string): string {
  const tail = key.split(".").pop() ?? key;
  const words = tail.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ---- Answer context ----------------------------------------------------------

export interface ItemCapture {
  item: TemplateItem;
  scopeItem: ScopeItem | null;
  photoCount: number;
  noteCount: number;
}

/** Parsed answer for a scope item: a choice string, multi-select array, or null. */
export function parsedAnswer(scopeItem: ScopeItem | null): string | string[] | null {
  if (!scopeItem?.answer) return null;
  try {
    return JSON.parse(scopeItem.answer) as string | string[];
  } catch {
    return scopeItem.answer;
  }
}

export function parsedMeasurements(scopeItem: ScopeItem | null): Measurement[] {
  if (!scopeItem?.measurements) return [];
  try {
    const v = JSON.parse(scopeItem.measurements) as Measurement[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Context a condition is evaluated against. Answers are looked up by
 * checklist_key — same-area capture wins, then any area (universal items like
 * year_built live in the universal area but gate items everywhere).
 */
export interface AnswerContext {
  projectType: string;
  /** checklist_key → captured scope items (same key can repeat across areas). */
  byKey: Map<string, ScopeItem[]>;
  /** the area whose items are being evaluated, for same-area preference */
  areaId?: string;
}

export function buildAnswerContext(
  projectType: string,
  scopeItems: ScopeItem[],
  areaId?: string,
): AnswerContext {
  const byKey = new Map<string, ScopeItem[]>();
  for (const si of scopeItems) {
    if (!si.checklist_key) continue;
    const list = byKey.get(si.checklist_key) ?? [];
    list.push(si);
    byKey.set(si.checklist_key, list);
  }
  return { projectType, byKey, areaId };
}

function lookup(ctx: AnswerContext, key: string): ScopeItem | null {
  const candidates = ctx.byKey.get(key) ?? [];
  if (candidates.length === 0) return null;
  if (ctx.areaId) {
    const local = candidates.find((si) => si.area_id === ctx.areaId);
    if (local) return local;
  }
  return candidates[0] ?? null;
}

/** Numeric value of an item's capture: first measurement qty, else numeric answer. */
function numericValue(scopeItem: ScopeItem | null): number | null {
  const first = parsedMeasurements(scopeItem)[0];
  if (first && typeof first.qty === "number") return first.qty;
  const a = parsedAnswer(scopeItem);
  if (typeof a === "string" && a !== "" && !Number.isNaN(Number(a))) return Number(a);
  return null;
}

function answerValues(scopeItem: ScopeItem | null): string[] {
  const a = parsedAnswer(scopeItem);
  if (a === null) return [];
  return Array.isArray(a) ? a : [a];
}

/**
 * Has this conditional item's trigger fired? Unknown/unanswered trigger items
 * mean "not fired" — §7 only reds a conditional whose trigger actually fired.
 */
export function conditionFired(cond: ItemCondition | null, ctx: AnswerContext): boolean {
  if (!cond) return true;
  if (cond.project_type !== undefined) return ctx.projectType === cond.project_type;
  if (!cond.item) return true;
  const target = lookup(ctx, cond.item);
  if (cond.lt !== undefined) {
    const n = numericValue(target);
    return n !== null && n < cond.lt;
  }
  if (cond.in !== undefined) {
    const answers = answerValues(target);
    return answers.some((a) => cond.in!.includes(a));
  }
  if (cond.answer !== undefined) {
    return answerValues(target).includes(cond.answer);
  }
  return true;
}

/** Is an item's conditional photo requirement active, given its own answer? */
export function conditionalPhotoFired(item: TemplateItem, scopeItem: ScopeItem | null): boolean {
  const cp = item.conditional_photo;
  if (!cp) return false;
  const answers = answerValues(scopeItem);
  if (cp.when.answer !== undefined) return answers.includes(cp.when.answer);
  if (cp.when.answer_in !== undefined) return answers.some((a) => cp.when.answer_in!.includes(a));
  return false;
}

/** An item counts as answered once ANY capture exists on it (choice,
 * measurement, photo, note, or a typed condition note). Skipped is separate. */
export function isAnswered(c: ItemCapture): boolean {
  if (c.scopeItem?.skipped) return false;
  return (
    answerValues(c.scopeItem).length > 0 ||
    parsedMeasurements(c.scopeItem).length > 0 ||
    !!c.scopeItem?.existing_condition ||
    c.photoCount > 0 ||
    c.noteCount > 0
  );
}

// ---- Step sequencing ---------------------------------------------------------

export interface Step {
  areaId: string;
  areaName: string;
  blockTitle: string;
  item: TemplateItem;
}

/**
 * Ordered prompt steps for a walkthrough: universal area first (§11), then
 * each other area's project-type blocks in sort order. Conditional items whose
 * trigger hasn't fired are excluded live — answering "layout change" makes the
 * walls-removed prompt appear.
 */
export function buildSteps(
  areas: Area[],
  templatesByType: Map<string, Template>,
  scopeItems: ScopeItem[],
): Step[] {
  const steps: Step[] = [];
  const ordered = [...areas].sort((a, b) =>
    a.area_type === "universal" ? -1 : b.area_type === "universal" ? 1 : a.sort_order - b.sort_order,
  );
  for (const area of ordered) {
    const template = templatesByType.get(area.area_type ?? "");
    if (!template) continue;
    const projectType = ordered.find((a) => a.area_type !== "universal")?.area_type ?? "";
    const ctx = buildAnswerContext(projectType, scopeItems, area.id);
    for (const block of template.blocks) {
      for (const item of block.items) {
        if (item.required_level === "conditional" && !conditionFired(item.condition, ctx)) continue;
        steps.push({ areaId: area.id, areaName: area.name, blockTitle: block.title, item });
      }
    }
  }
  return steps;
}

/** Attach captured data to a step's item for scoring/rendering. */
export function captureFor(
  step: Step,
  scopeItems: ScopeItem[],
  photos: Photo[],
  notes: Note[],
): ItemCapture {
  const scopeItem =
    scopeItems.find((si) => si.area_id === step.areaId && si.checklist_key === step.item.key) ?? null;
  const photoCount = scopeItem ? photos.filter((p) => p.scope_item_id === scopeItem.id).length : 0;
  const noteCount = scopeItem
    ? notes.filter((n) => n.parent_type === "scope_item" && n.parent_id === scopeItem.id).length
    : 0;
  return { item: step.item, scopeItem, photoCount, noteCount };
}
