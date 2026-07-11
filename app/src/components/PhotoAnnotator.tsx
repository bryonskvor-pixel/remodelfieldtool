import { useEffect, useRef, useState } from "react";
import { db, getBlob } from "../db/store";
import type { Photo } from "../types";

// Quick photo annotation (§11): full-screen viewer with drag-to-draw arrows
// and circles. Vector shapes only — the original photo bytes are never
// touched; shapes store as normalized JSON in photos.annotation_data and sync
// as a normal row write. Big strokes, one drag per shape (Hard Rule 3).

export interface Shape {
  t: "arrow" | "circle";
  // Image-relative units: 100 = the image's width, on BOTH axes (so y runs
  // 0..100·h/w). Equal units keep circles round on any aspect ratio and the
  // shapes land identically on every device. Arrow: tail→head. Circle:
  // center→edge (radius = distance).
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function parsedShapes(photo: Photo): Shape[] {
  if (!photo.annotation_data) return [];
  try {
    const v = JSON.parse(photo.annotation_data) as { shapes?: Shape[] };
    return Array.isArray(v.shapes) ? v.shapes : [];
  } catch {
    return [];
  }
}

interface Props {
  photo: Photo;
  onClose: () => void;
}

export function PhotoAnnotator({ photo, onClose }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [tool, setTool] = useState<Shape["t"]>("arrow");
  const [shapes, setShapes] = useState<Shape[]>(() => parsedShapes(photo));
  const [draft, setDraft] = useState<Shape | null>(null);
  const [aspect, setAspect] = useState<number | null>(null); // h/w, set on img load

  useEffect(() => {
    let revoke: string | null = null;
    void getBlob(photo.id).then((entry) => {
      if (entry) {
        revoke = URL.createObjectURL(entry.blob);
        setUrl(revoke);
      } else {
        setUrl(`/api/media/photo/${photo.id}`);
      }
    });
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [photo.id]);

  function pos(e: React.PointerEvent<SVGSVGElement>): { x: number; y: number } {
    const rect = svgRef.current!.getBoundingClientRect();
    const yMax = 100 * (aspect ?? 1);
    return {
      x: Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100)),
      y: Math.max(0, Math.min(yMax, ((e.clientY - rect.top) / rect.height) * yMax)),
    };
  }

  function down(e: React.PointerEvent<SVGSVGElement>) {
    if (aspect === null) return; // image not decoded yet — no coordinate space
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = pos(e);
    setDraft({ t: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y });
  }

  function move(e: React.PointerEvent<SVGSVGElement>) {
    if (!draft) return;
    const p = pos(e);
    setDraft({ ...draft, x2: p.x, y2: p.y });
  }

  function up() {
    if (!draft) return;
    // Ignore accidental taps — a shape needs a real drag.
    if (Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) >= 4) {
      setShapes([...shapes, roundShape(draft)]);
    }
    setDraft(null);
  }

  async function done() {
    // Re-read the row: a sync pass may have written r2_key etc. while the
    // annotator was open — only annotation_data belongs to this edit.
    const fresh = (await db.photos.get(photo.id)) ?? photo;
    await db.photos.put({
      ...fresh,
      annotation_data: shapes.length > 0 ? JSON.stringify({ shapes }) : null,
    });
    onClose();
  }

  const all = draft ? [...shapes, draft] : shapes;

  return (
    <div className="annotator">
      <div className="annotator-stage">
        {/* The frame shrink-wraps the img so the 0–100 SVG space maps exactly
            onto the photo regardless of its aspect ratio. */}
        <div className="annotator-frame">
          {url && (
            <img
              src={url}
              alt=""
              draggable={false}
              onLoad={(e) => {
                const img = e.currentTarget;
                if (img.naturalWidth > 0) setAspect(img.naturalHeight / img.naturalWidth);
              }}
            />
          )}
          <svg
            ref={svgRef}
            viewBox={`0 0 100 ${100 * (aspect ?? 1)}`}
            preserveAspectRatio="none"
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={() => setDraft(null)}
          >
            <AnnotationShapes shapes={all} />
          </svg>
        </div>
      </div>

      <div className="annotator-bar">
        <button className={`chip ${tool === "arrow" ? "chip-on" : ""}`} onClick={() => setTool("arrow")}>
          ↗ Arrow
        </button>
        <button className={`chip ${tool === "circle" ? "chip-on" : ""}`} onClick={() => setTool("circle")}>
          ◯ Circle
        </button>
        <button className="chip" onClick={() => setShapes(shapes.slice(0, -1))} disabled={shapes.length === 0}>
          Undo
        </button>
        <button className="chip" onClick={onClose}>Cancel</button>
        <button className="chip chip-on" onClick={() => void done()}>Done</button>
      </div>
    </div>
  );
}

/** Shared shape renderer, also used to overlay saved annotations elsewhere. */
export function AnnotationShapes({ shapes }: { shapes: Shape[] }) {
  return (
    <>
      {shapes.map((s, i) =>
        s.t === "circle" ? (
          <circle
            key={i}
            cx={s.x1}
            cy={s.y1}
            r={Math.hypot(s.x2 - s.x1, s.y2 - s.y1)}
            className="annotation-stroke"
          />
        ) : (
          <g key={i} className="annotation-stroke">
            <line x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} />
            <ArrowHead s={s} />
          </g>
        ),
      )}
    </>
  );
}

function ArrowHead({ s }: { s: Shape }) {
  const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
  const size = 4;
  const p = (a: number) => `${s.x2 - size * Math.cos(angle + a)},${s.y2 - size * Math.sin(angle + a)}`;
  return <polyline points={`${p(0.5)} ${s.x2},${s.y2} ${p(-0.5)}`} />;
}

function roundShape(s: Shape): Shape {
  const r = (n: number) => Math.round(n * 10) / 10;
  return { ...s, x1: r(s.x1), y1: r(s.y1), x2: r(s.x2), y2: r(s.y2) };
}
