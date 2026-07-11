// Small floor-plan rendering of a sketched room polygon (measurement JSON
// points, in feet). Shown wherever the measurement is summarized so the
// contractor can recognize the room at a glance.

interface Props {
  points: { x: number; y: number }[];
  size?: number;
}

export function FloorPlanThumb({ points, size = 56 }: Props) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const w = Math.max(Math.max(...xs) - minX, 1);
  const h = Math.max(Math.max(...ys) - minY, 1);
  const pad = Math.max(w, h) * 0.08;
  return (
    <svg
      className="floorplan-thumb"
      width={size}
      height={size}
      viewBox={`${minX - pad} ${minY - pad} ${w + pad * 2} ${h + pad * 2}`}
      preserveAspectRatio="xMidYMid meet"
    >
      <polygon
        points={points.map((p) => `${p.x},${p.y}`).join(" ")}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
