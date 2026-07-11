import { useState } from "react";
import type { Measurement } from "../types";

// Numeric pad with unit presets (§11). Two modes: single quantity, or L×W
// which computes SF live. Big keys — gloves on, one thumb (Hard Rule 3).

const UNITS = ["ea", "lf", "sf", "ft", "in", "year"];
const KEYS = ["7", "8", "9", "4", "5", "6", "1", "2", "3", ".", "0", "⌫"];

interface Props {
  defaultUnit?: string;
  onSave: (m: Measurement) => void;
  onClose: () => void;
}

export function MeasurementPad({ defaultUnit, onSave, onClose }: Props) {
  const [unit, setUnit] = useState(defaultUnit ?? "ea");
  const [mode, setMode] = useState<"qty" | "lxw">(defaultUnit === "sf" ? "lxw" : "qty");
  const [fields, setFields] = useState<{ qty: string; length: string; width: string }>({
    qty: "", length: "", width: "",
  });
  const [active, setActive] = useState<"qty" | "length" | "width">(defaultUnit === "sf" ? "length" : "qty");

  const sf = Number(fields.length) * Number(fields.width);
  const sfLive = mode === "lxw" && fields.length !== "" && fields.width !== "" && !Number.isNaN(sf);

  function press(key: string) {
    setFields((f) => {
      const cur = f[active];
      if (key === "⌫") return { ...f, [active]: cur.slice(0, -1) };
      if (key === "." && cur.includes(".")) return f;
      if (cur.length >= 7) return f;
      return { ...f, [active]: cur + key };
    });
  }

  function save() {
    if (mode === "lxw") {
      if (!sfLive) return;
      onSave({
        qty: Math.round(sf * 100) / 100,
        unit: "sf",
        dims: { length: Number(fields.length), width: Number(fields.width) },
      });
    } else {
      const qty = Number(fields.qty);
      if (fields.qty === "" || Number.isNaN(qty)) return;
      onSave({ qty, unit });
    }
    onClose();
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="chip-row">
          <button className={`chip ${mode === "qty" ? "chip-on" : ""}`} onClick={() => { setMode("qty"); setActive("qty"); }}>
            Qty
          </button>
          <button className={`chip ${mode === "lxw" ? "chip-on" : ""}`} onClick={() => { setMode("lxw"); setActive("length"); }}>
            L × W
          </button>
        </div>

        {mode === "qty" ? (
          <>
            <div className="measure-display">
              <span className="measure-value">{fields.qty || "0"}</span>
              <span className="measure-unit">{unit}</span>
            </div>
            <div className="chip-row">
              {UNITS.map((u) => (
                <button key={u} className={`chip ${unit === u ? "chip-on" : ""}`} onClick={() => setUnit(u)}>
                  {u}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="measure-display">
              <button
                className={`measure-field ${active === "length" ? "measure-field-on" : ""}`}
                onClick={() => setActive("length")}
              >
                {fields.length || "L"} ft
              </button>
              <span className="measure-unit">×</span>
              <button
                className={`measure-field ${active === "width" ? "measure-field-on" : ""}`}
                onClick={() => setActive("width")}
              >
                {fields.width || "W"} ft
              </button>
            </div>
            <p className="measure-sf">{sfLive ? `= ${Math.round(sf * 100) / 100} SF` : "= — SF"}</p>
          </>
        )}

        <div className="keypad">
          {KEYS.map((k) => (
            <button key={k} className="key" onClick={() => press(k)}>
              {k}
            </button>
          ))}
        </div>

        <div className="row">
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button onClick={save} disabled={mode === "lxw" ? !sfLive : fields.qty === ""}>Save</button>
        </div>
      </div>
    </div>
  );
}
