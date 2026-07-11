import { describe, expect, it } from "vitest";
import {
  closureGap, perimeterLF, scaledCorners, shoelaceSF, snapToAxis,
  suggestedLength, wallLF, wallsFromCorners, type Wall,
} from "./sketch";

// L-shaped room used throughout: 12 ft across the top, 12 ft down the left,
// with a 5×4 ft notch out of the bottom-right corner. Floor = 144 − 20 = 124.
// Traced clockwise from top-left (grid y grows down):
//   E12, S8, W5, S4, W7, N12
const L_CORNERS = [
  { x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 8 },
  { x: 7, y: 8 }, { x: 7, y: 12 }, { x: 0, y: 12 },
];
const L_LENGTHS = [12, 8, 5, 4, 7, 12];

function lRoom(entered: number): Wall[] {
  const walls = wallsFromCorners(L_CORNERS);
  for (let i = 0; i < entered; i++) walls[i]!.length_ft = L_LENGTHS[i]!;
  return walls;
}

describe("snapToAxis", () => {
  it("snaps to horizontal when x delta dominates", () => {
    expect(snapToAxis({ x: 2, y: 2 }, { x: 7, y: 3 })).toEqual({ x: 7, y: 2 });
  });
  it("snaps to vertical when y delta dominates", () => {
    expect(snapToAxis({ x: 2, y: 2 }, { x: 3, y: 8 })).toEqual({ x: 2, y: 8 });
  });
});

describe("wallsFromCorners", () => {
  it("builds the closed loop including the closing wall", () => {
    const walls = wallsFromCorners(L_CORNERS);
    expect(walls).toHaveLength(6);
    expect(walls[0]).toMatchObject({ dx: 1, dy: 0, cells: 12 });   // E12
    expect(walls[5]).toMatchObject({ dx: 0, dy: -1, cells: 12 });  // closing N12
  });
  it("skips zero-length segments", () => {
    const walls = wallsFromCorners([
      { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 },
    ]);
    expect(walls).toHaveLength(4);
  });
});

describe("suggestedLength", () => {
  it("suggests nothing while another wall on the axis is unknown", () => {
    // Only E12 entered: W5 has W7 still unknown on the horizontal axis.
    expect(suggestedLength(lRoom(1), 2)).toBeNull();
  });
  it("derives the last horizontal wall from closure", () => {
    // All but W7 (index 4) and the closing N12 entered.
    const walls = lRoom(6);
    walls[4]!.length_ft = null;
    walls[5]!.length_ft = 12;
    expect(suggestedLength(walls, 4)).toBe(7); // 12 − 5 = 7 remaining westward
  });
  it("derives the closing vertical wall", () => {
    const walls = lRoom(5);
    expect(suggestedLength(walls, 5)).toBe(12); // 8 + 4 southward
  });
  it("returns null when entered lengths would force a backwards wall", () => {
    const walls = lRoom(6);
    walls[2]!.length_ft = 20; // W20 overshoots the 12 ft top wall
    walls[4]!.length_ft = null;
    expect(suggestedLength(walls, 4)).toBeNull();
  });
  it("returns null for a wall that already has a length", () => {
    expect(suggestedLength(lRoom(6), 0)).toBeNull();
  });
});

describe("closureGap", () => {
  it("is null until every wall is entered", () => {
    expect(closureGap(lRoom(5))).toBeNull();
  });
  it("is zero for a closing shape", () => {
    expect(closureGap(lRoom(6))).toEqual({ dx: 0, dy: 0 });
  });
  it("reports the signed misclose", () => {
    const walls = lRoom(6);
    walls[0]!.length_ft = 14; // top wall entered 2 ft long
    expect(closureGap(walls)).toEqual({ dx: 2, dy: 0 });
  });
});

describe("scaledCorners / shoelaceSF / wallLF", () => {
  it("reproduces the corners from entered lengths", () => {
    expect(scaledCorners(lRoom(6))).toEqual(L_CORNERS);
  });
  it("falls back to grid cells for unentered walls so the shape still draws", () => {
    const pts = scaledCorners(lRoom(0));
    expect(pts).toEqual(L_CORNERS); // cells were traced 1:1 with feet here
  });
  it("computes the L-room floor SF via shoelace", () => {
    expect(shoelaceSF(L_CORNERS)).toBe(124);
  });
  it("handles a plain rectangle", () => {
    expect(shoelaceSF([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 12 }, { x: 0, y: 12 }])).toBe(120);
  });
  it("totals wall LF only once complete", () => {
    expect(wallLF(lRoom(5))).toBeNull();
    expect(wallLF(lRoom(6))).toBe(48);
  });
});

describe("perimeterLF", () => {
  it("walks the stored points polygon", () => {
    expect(perimeterLF(L_CORNERS)).toBe(48);
  });
});
