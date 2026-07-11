// Room-shape sketch math (§11): a rectilinear polygon traced corner-by-corner
// on a grid, then dimensioned wall-by-wall on the numeric pad. Pure module
// (no IO) so the geometry is unit-testable like the completeness engine.
//
// Hard Rule 1 note: nothing here writes a number on its own. suggestedLength
// produces a SUGGESTION for the one wall an axis can derive; the contractor
// confirms it on the pad before it exists as data.

export interface Pt {
  x: number;
  y: number;
}

/** One wall of the traced shape. Grid coords have y growing DOWN (screen
 * sense): dx=+1 is right, dy=+1 is down. `cells` is the grid length used as a
 * placeholder proportion until the real `length_ft` is entered. */
export interface Wall {
  dx: -1 | 0 | 1;
  dy: -1 | 0 | 1;
  cells: number;
  length_ft: number | null;
}

/** Snap a raw tap so the new wall is horizontal or vertical relative to the
 * previous corner (tap-to-place, not freehand — gloves). */
export function snapToAxis(prev: Pt, raw: Pt): Pt {
  return Math.abs(raw.x - prev.x) >= Math.abs(raw.y - prev.y)
    ? { x: raw.x, y: prev.y }
    : { x: prev.x, y: raw.y };
}

/** Walls of the closed loop through `corners` (last corner connects back to
 * the first). Corners must be axis-aligned pairwise — snapToAxis guarantees
 * this for placed corners; the caller only closes when last/first align. */
export function wallsFromCorners(corners: Pt[]): Wall[] {
  const walls: Wall[] = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    if (!a || !b) continue;
    const cells = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (cells === 0) continue;
    walls.push({
      dx: Math.sign(b.x - a.x) as Wall["dx"],
      dy: Math.sign(b.y - a.y) as Wall["dy"],
      cells,
      length_ft: null,
    });
  }
  return walls;
}

/**
 * If wall `i` is the ONLY wall on its axis without a length, the loop-closure
 * constraint (signed lengths per axis sum to zero) determines it. Returned as
 * a suggestion to confirm, never written silently (Hard Rule 1). Null when
 * other walls on the axis are still unentered, or when the entered lengths
 * would force this wall to run backwards (shape can't close that way).
 */
export function suggestedLength(walls: Wall[], i: number): number | null {
  const w = walls[i];
  if (!w || w.length_ft !== null) return null;
  const horizontal = w.dx !== 0;
  let sum = 0;
  for (let j = 0; j < walls.length; j++) {
    if (j === i) continue;
    const o = walls[j];
    if (!o) continue;
    const sign = horizontal ? o.dx : o.dy;
    if (sign === 0) continue;
    if (o.length_ft === null) return null; // another unknown on this axis
    sum += sign * o.length_ft;
  }
  const needed = -sum / (horizontal ? w.dx : w.dy);
  return needed > 0 ? round2(needed) : null;
}

/** Signed closure gap in feet once every wall has a length; null until then.
 * {dx:0, dy:0} means the shape closes. */
export function closureGap(walls: Wall[]): { dx: number; dy: number } | null {
  let dx = 0;
  let dy = 0;
  for (const w of walls) {
    if (w.length_ft === null) return null;
    dx += w.dx * w.length_ft;
    dy += w.dy * w.length_ft;
  }
  return { dx: round2(dx), dy: round2(dy) };
}

/** Corner points in feet from (0,0), walking the walls in order. Walls with
 * no length yet fall back to their grid-cell count so the shape still draws
 * (redraws to scale as real lengths land). */
export function scaledCorners(walls: Wall[]): Pt[] {
  const pts: Pt[] = [{ x: 0, y: 0 }];
  let x = 0;
  let y = 0;
  for (let i = 0; i < walls.length - 1; i++) {
    const w = walls[i];
    if (!w) continue;
    const len = w.length_ft ?? w.cells;
    x += w.dx * len;
    y += w.dy * len;
    pts.push({ x: round2(x), y: round2(y) });
  }
  return pts;
}

/** Floor square footage of the closed polygon (shoelace). */
export function shoelaceSF(pts: Pt[]): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (!a || !b) continue;
    sum += a.x * b.y - b.x * a.y;
  }
  return round2(Math.abs(sum) / 2);
}

/** Total wall linear feet; null while any wall is unentered. */
export function wallLF(walls: Wall[]): number | null {
  let sum = 0;
  for (const w of walls) {
    if (w.length_ft === null) return null;
    sum += w.length_ft;
  }
  return round2(sum);
}

/** Perimeter in feet of a stored rectilinear points polygon (for wall_sf
 * write-through when the polygon comes back out of measurement JSON). */
export function perimeterLF(pts: Pt[]): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (!a || !b) continue;
    sum += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
  }
  return round2(sum);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
