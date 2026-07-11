// Completeness engine v1 (§7). First-class module with its own tests.
// Scores a walkthrough: required items unanswered → red; conditional items
// whose trigger fired but weren't answered → red; missing required/conditional
// photos → red; skipped items → yellow, each auto-drafting a suggested
// exclusion/assumption for the proposal. Warn, never block (Hard Rule 4).

import {
  captureFor, conditionalPhotoFired, humanizeKey, isAnswered, type ItemCapture, type Step,
} from "./engine";
import type { Note, Photo, ScopeItem } from "../types";

export interface RedFlag {
  key: string;
  areaName: string;
  message: string;
}

export interface YellowFlag {
  key: string;
  areaName: string;
  skipReason: string;
  /** Auto-drafted exclusion/assumption; contractor approves or deletes (§7). */
  draftedAssumption: string;
}

export interface CompletenessReport {
  /** Fully-captured count over active required+conditional items. */
  answered: number;
  total: number;
  score: number; // 0..1, 1 when total is 0
  redFlags: RedFlag[];
  yellowFlags: YellowFlag[];
}

function draftAssumption(c: ItemCapture, skipReason: string): string {
  if (c.item.proposal_assumption) return c.item.proposal_assumption;
  const title = humanizeKey(c.item.key);
  return `${title} not verified (${skipReason.toLowerCase()}); bid assumes existing conditions — confirm or exclude on proposal.`;
}

/**
 * Score one walkthrough. `steps` must come from buildSteps, which already
 * excluded conditional items whose trigger hasn't fired — so every conditional
 * item present here has a fired trigger.
 */
export function scoreWalkthrough(
  steps: Step[],
  scopeItems: ScopeItem[],
  photos: Photo[],
  notes: Note[],
): CompletenessReport {
  const redFlags: RedFlag[] = [];
  const yellowFlags: YellowFlag[] = [];
  let answered = 0;
  let total = 0;

  for (const step of steps) {
    const c = captureFor(step, scopeItems, photos, notes);
    const counts = step.item.required_level !== "optional";
    if (counts) total += 1;

    if (c.scopeItem?.skipped) {
      yellowFlags.push({
        key: step.item.key,
        areaName: step.areaName,
        skipReason: c.scopeItem.skip_reason ?? "No reason given",
        draftedAssumption: draftAssumption(c, c.scopeItem.skip_reason ?? "skipped"),
      });
      continue;
    }

    const title = humanizeKey(step.item.key);
    const answeredHere = isAnswered(c);

    if (!answeredHere) {
      if (counts) {
        redFlags.push({
          key: step.item.key,
          areaName: step.areaName,
          message:
            step.item.required_level === "conditional"
              ? `${title} applies here but wasn't answered`
              : `${title} not captured`,
        });
      }
      continue;
    }

    let photoOk = true;
    if (step.item.photo_required && c.photoCount === 0) {
      photoOk = false;
      redFlags.push({ key: step.item.key, areaName: step.areaName, message: `No photo of ${title.toLowerCase()}` });
    }
    if (conditionalPhotoFired(step.item, c.scopeItem) && c.photoCount === 0) {
      photoOk = false;
      redFlags.push({
        key: step.item.key,
        areaName: step.areaName,
        message: step.item.conditional_photo?.prompt ?? `Photo required for ${title.toLowerCase()}`,
      });
    }

    if (counts && photoOk) answered += 1;
  }

  return {
    answered,
    total,
    score: total === 0 ? 1 : answered / total,
    redFlags,
    yellowFlags,
  };
}
