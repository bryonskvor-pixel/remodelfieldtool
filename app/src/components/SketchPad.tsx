import { useRef, useState } from "react";
import {
  closureGap, scaledCorners, shoelaceSF, snapToAxis, suggestedLength,
  wallLF, wallsFromCorners, type Pt, type Wall,
} from "../walkthrough/sketch";
import type { Measurement } from "../types";

// Sketch mode on the measurement pad (§11): tap-to-place corners on a grid
// (NOT freehand — gloves), walls snap to horizontal/vertical, tap the first
// corner to close. Then each wall highlights in turn and the numeric pad
// enters its length; the shape redraws to scale. Auto-derivable closing walls
// are SUGGESTED for confirmation, never silently written (Hard Rule 1).

const COLS = 14;
const ROWS = 10;
const KEYS = ["7", "8", "9", "4", "5", "6", "1", "2", "3", ".", "0", "⌫"];

interface Props {
  onSave: (m: Measurement) => void;
  onCancel: () => void;
}

export function SketchPad({ onSave, onCancel }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [corners, setCorners] = useState<Pt[]>([]);
  const [walls, setWalls] = useState<Wall[] | null>(null); // non-null = length phase
  const [activeWall, setActiveWall] = useState(0);
  const [input, setInput] = useState("");

  // ---- Corner-placement phase ------------------------------------------------

  function gridPointFromTap(e: React.PointerEvent<SVGSVGElement>): Pt {
    const rect = svgRef.current!.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * COLS);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * ROWS);
    return { x: Math.max(0, Math.min(COLS, x)), y: Math.max(0, Math.min(ROWS, y)) };
  }

  function placeCorner(e: React.PointerEvent<SVGSVGElement>) {
    if (walls) return;
    const raw = gridPointFromTap(e);
    if (corners.length === 0) {
      setCorners([raw]);
      return;
    }
    const prev = corners[corners.length - 1];
    const first = corners[0];
    if (!prev || !first) return;
    const p = snapToAxis(prev, raw);
    if (p.x === prev.x && p.y === prev.y) return; // zero-length wall
    // Tapping the first corner closes the loop (needs ≥3 corners placed and
    // an axis-aligned closing wall — snapToAxis lands on the start exactly
    // when the last wall lines up with it).
    if (corners.length >= 3 && p.x === first.x && p.y === first.y) {
      setWalls(wallsFromCorners(corners));
      setActiveWall(0);
      setInput("");
      return;
    }
    const beforePrev = corners[corners.length - 2];
    if (beforePrev && p.x === beforePrev.x && p.y === beforePrev.y) return; // backtrack
    // Continuing straight extends the current wall instead of adding a corner.
    if (beforePrev && ((beforePrev.x === prev.x && prev.x === p.x) || (beforePrev.y === prev.y && prev.y === p.y))) {
      setCorners([...corners.slice(0, -1), p]);
      return;
    }
    setCorners([...corners, p]);
  }

  function undoCorner() {
    setCorners(corners.slice(0, -1));
  }

  // ---- Wall-length phase -------------------------------------------------------

  const suggested = walls ? suggestedLength(walls, activeWall) : null;
  const gap = walls ? closureGap(walls) : null;
  const closed = gap !== null && gap.dx === 0 && gap.dy === 0;
  const pts = walls ? scaledCorners(walls) : corners;
  const sf = walls && closed ? shoelaceSF(pts) : null;
  const lf = walls ? wallLF(walls) : null;
  const allEntered = walls !== null && walls.every((w) => w.length_ft !== null);

  function press(key: string) {
    setInput((cur) => {
      if (key === "⌫") return cur.slice(0, -1);
      if (key === "." && cur.includes(".")) return cur;
      if (cur.length >= 6) return cur;
      return cur + key;
    });
  }

  function enterLength() {
    if (!walls) return;
    const value = input !== "" ? Number(input) : suggested;
    if (value === null || Number.isNaN(value) || value <= 0) return;
    const next = walls.map((w, i) => (i === activeWall ? { ...w, length_ft: value } : w));
    setWalls(next);
    setInput("");
    const following = next.findIndex((w, i) => i > activeWall && w.length_ft === null);
    setActiveWall(following !== -1 ? following : next.findIndex((w) => w.length_ft === null));
  }

  function editWall(i: number) {
    if (!walls) return;
    setWalls(walls.map((w, j) => (j === i ? { ...w, length_ft: null } : w)));
    setActiveWall(i);
    setInput("");
  }

  function save() {
    if (!walls || !closed || sf === null) return;
    onSave({ qty: sf, unit: "sf", dims: { points: pts } });
  }

  function reset() {
    setCorners([]);
    setWalls(null);
    setInput("");
  }

  // ---- Render ------------------------------------------------------------------

  // Fit the shape into the grid viewBox. During placement pts are grid coords
  // already; during the length phase they're feet, so rescale to fit.
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const w = Math.max(...xs, 1) - Math.min(...xs, 0);
  const h = Math.max(...ys, 1) - Math.min(...ys, 0);
  const scale = walls ? Math.min((COLS - 2) / Math.max(w, 1), (ROWS - 2) / Math.max(h, 1)) : 1;
  const ox = walls ? 1 - Math.min(...xs, 0) * scale : 0;
  const oy = walls ? 1 - Math.min(...ys, 0) * scale : 0;
  const view = (p: Pt): Pt => ({ x: p.x * scale + ox, y: p.y * scale + oy });
  const vpts = pts.map(view);

  const dirGlyph = (wall: Wall) =>
    wall.dx === 1 ? "→" : wall.dx === -1 ? "←" : wall.dy === 1 ? "↓" : "↑";

  return (
    <div className="sketch">
      <p className="muted sketch-hint">
        {walls
          ? allEntered
            ? closed
              ? "Shape closes. Save writes the floor SF."
              : `Doesn't close — off by ${Math.abs(gap!.dx)} ft ←→, ${Math.abs(gap!.dy)} ft ↑↓. Tap a wall to fix it.`
            : suggested !== null && input === ""
              ? `Suggested ${suggested} ft from the other walls — ✓ to confirm, or type the real length.`
              : "Enter this wall's length."
          : corners.length === 0
            ? "Tap corners to trace the room. Walls snap straight."
            : corners.length < 3
              ? "Keep tapping corners."
              : "Tap the first corner to close the shape."}
      </p>

      <svg
        ref={svgRef}
        className="sketch-canvas"
        viewBox={`-0.5 -0.5 ${COLS + 1} ${ROWS + 1}`}
        onPointerDown={placeCorner}
      >
        {Array.from({ length: COLS + 1 }, (_, x) =>
          Array.from({ length: ROWS + 1 }, (_, y) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r={0.07} className="sketch-dot" />
          )),
        )}
        {vpts.length > 1 &&
          vpts.map((a, i) => {
            const b = vpts[(i + 1) % vpts.length];
            if (!b) return null;
            if (!walls && i === vpts.length - 1) return null; // open shape while placing
            const isActive = walls !== null && i === activeWall;
            const wall = walls?.[i];
            return (
              <g key={i} onPointerDown={(e) => { if (walls) { e.stopPropagation(); editWall(i); } }}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  className={`sketch-wall ${isActive ? "sketch-wall-on" : ""}`} />
                {wall?.length_ft !== null && wall !== undefined && (
                  <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2} className="sketch-len"
                    dx={wall.dx === 0 ? 0.35 : 0} dy={wall.dy === 0 ? -0.25 : 0.15}>
                    {wall.length_ft}
                  </text>
                )}
              </g>
            );
          })}
        {vpts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={0.28}
            className={`sketch-corner ${!walls && i === 0 && corners.length >= 3 ? "sketch-corner-start" : ""}`} />
        ))}
      </svg>

      {!walls ? (
        <div className="row">
          <button className="secondary" onClick={undoCorner} disabled={corners.length === 0}>Undo corner</button>
        </div>
      ) : (
        <>
          <div className="chip-row">
            {walls.map((wall, i) => (
              <button key={i} className={`chip ${i === activeWall ? "chip-on" : ""}`} onClick={() => editWall(i)}>
                {dirGlyph(wall)} {wall.length_ft ?? "?"}
              </button>
            ))}
          </div>

          {!allEntered && (
            <>
              <div className="measure-display">
                <span className="measure-value">
                  {input || (suggested !== null ? suggested : "—")}
                </span>
                <span className="measure-unit">
                  ft{input === "" && suggested !== null ? " (suggested)" : ""}
                </span>
              </div>
              <div className="keypad">
                {KEYS.map((k) => (
                  <button key={k} className="key" onClick={() => press(k)}>{k}</button>
                ))}
              </div>
              <button onClick={enterLength} disabled={input === "" && suggested === null}>
                {input === "" && suggested !== null ? `✓ Confirm ${suggested} ft` : "Next wall"}
              </button>
            </>
          )}

          {allEntered && closed && (
            <p className="measure-sf">= {sf} SF floor · {lf} LF wall</p>
          )}
        </>
      )}

      <div className="row">
        <button className="secondary" onClick={onCancel}>Cancel</button>
        <button className="secondary" onClick={reset} disabled={corners.length === 0}>Start over</button>
        {walls && <button onClick={save} disabled={!closed}>Save</button>}
      </div>
    </div>
  );
}
