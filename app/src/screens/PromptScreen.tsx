import { useState } from "react";
import { BlobThumb } from "../components/BlobThumb";
import { FloorPlanThumb } from "../components/FloorPlanThumb";
import { NoteLine } from "../components/NoteLine";
import { MeasurementPad } from "../components/MeasurementPad";
import { PhotoCapture } from "../components/PhotoCapture";
import { VoiceNote } from "../components/VoiceNote";
import {
  addMeasurement, addPhoto, addTextNote, addVoiceNote, removeMeasurement, saveChoice, skipItem, unskipItem,
} from "../walkthrough/actions";
import { conditionalPhotoFired, parsedAnswer, parsedMeasurements, type Step } from "../walkthrough/engine";
import { SKIP_REASONS, type Note, type Photo, type ScopeItem } from "../types";

// The prompt screen (§11): big prompt text, capture buttons in fixed order
// [Photo] [Voice] [Note] [Measurement], Skip with a one-tap reason, Next.
// Every action writes locally and returns instantly (Hard Rules 2 & 3).

interface Props {
  step: Step;
  scopeItem: ScopeItem | null;
  photos: Photo[];
  notes: Note[];
  walkthroughId: string;
  onNext: () => void;
  onBack: () => void;
  canGoBack: boolean;
  isLast: boolean;
}

function label(choice: string): string {
  const words = choice.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function PromptScreen({
  step, scopeItem, photos, notes, walkthroughId, onNext, onBack, canGoBack, isLast,
}: Props) {
  const [showPad, setShowPad] = useState(false);
  const [showSkip, setShowSkip] = useState(false);
  const [noteDraft, setNoteDraft] = useState<string | null>(null);

  const answer = parsedAnswer(scopeItem);
  const answers = Array.isArray(answer) ? answer : answer ? [answer] : [];
  const measurements = parsedMeasurements(scopeItem);
  const skipped = scopeItem?.skipped === 1;
  const wantsPhotoNow =
    (step.item.photo_required || conditionalPhotoFired(step.item, scopeItem)) && photos.length === 0;

  async function saveNote() {
    if (noteDraft && noteDraft.trim()) {
      await addTextNote(step, scopeItem, noteDraft.trim());
    }
    setNoteDraft(null);
  }

  return (
    <div className="prompt-screen">
      <p className="crumb">
        {step.areaName} · {step.blockTitle}
        {step.item.required_level === "required" && <span className="req"> · required</span>}
      </p>

      <h2 className="prompt-text">{step.item.prompt}</h2>

      {step.item.choices && (
        <div className="chip-row wrap">
          {step.item.choices.map((c) => (
            <button
              key={c}
              className={`chip ${answers.includes(c) ? "chip-on" : ""}`}
              onClick={() => void saveChoice(step, scopeItem, c)}
            >
              {label(c)}
            </button>
          ))}
        </div>
      )}

      {/* Fixed capture-button order per §11 */}
      <div className="capture-row">
        <PhotoCapture onCapture={(blob) => void addPhoto(walkthroughId, step, scopeItem, blob)} />
        <VoiceNote onCapture={(blob, sec) => void addVoiceNote(step, scopeItem, blob, sec)} />
        <button className="capture-btn" onClick={() => setNoteDraft(noteDraft === null ? "" : null)}>
          ⌨️<span>Note</span>
        </button>
        <button className="capture-btn" onClick={() => setShowPad(true)}>
          📏<span>Measure</span>
        </button>
      </div>

      {wantsPhotoNow && (
        <p className="photo-nudge">
          📷 {step.item.conditional_photo && conditionalPhotoFired(step.item, scopeItem)
            ? step.item.conditional_photo.prompt
            : "Photo required for this item"}
        </p>
      )}

      {noteDraft !== null && (
        <div className="note-editor">
          <textarea
            autoFocus
            rows={3}
            value={noteDraft}
            placeholder="Type a note…"
            onChange={(e) => setNoteDraft(e.target.value)}
          />
          <button onClick={() => void saveNote()} disabled={!noteDraft.trim()}>Save note</button>
        </div>
      )}

      {/* Captured-so-far summary */}
      {(photos.length > 0 || notes.length > 0 || measurements.length > 0) && (
        <div className="captured">
          {photos.length > 0 && (
            <div className="thumb-row">
              {photos.map((p) => <BlobThumb key={p.id} id={p.id} />)}
            </div>
          )}
          {measurements.map((m, i) => (
            <p key={i} className="captured-line">
              {m.dims?.points ? (
                <FloorPlanThumb points={m.dims.points} size={40} />
              ) : (
                "📏 "
              )}
              {m.dims?.length && m.dims?.width ? `${m.dims.length} × ${m.dims.width} ft = ` : ""}{m.qty} {m.unit}
              <button className="inline-x" onClick={() => scopeItem && void removeMeasurement(scopeItem, i)}>✕</button>
            </p>
          ))}
          {notes.map((n) => <NoteLine key={n.id} note={n} />)}
        </div>
      )}

      {skipped && (
        <p className="skip-banner">
          Skipped — {scopeItem?.skip_reason}.{" "}
          <button className="inline-link" onClick={() => scopeItem && void unskipItem(scopeItem)}>Undo</button>
        </p>
      )}

      <div className="prompt-footer">
        <div className="row">
          <button className="secondary" onClick={onBack} disabled={!canGoBack}>Back</button>
          {!skipped && (
            <button className="secondary" onClick={() => setShowSkip(true)}>Skip</button>
          )}
          <button onClick={onNext}>{isLast ? "Finish area" : "Next"}</button>
        </div>
      </div>

      {showPad && (
        <MeasurementPad
          defaultUnit={step.item.unit ?? (step.item.key.includes("dims") ? "sf" : "ea")}
          onSave={(m) => void addMeasurement(step, scopeItem, m)}
          onClose={() => setShowPad(false)}
        />
      )}

      {showSkip && (
        <div className="sheet-backdrop" onClick={() => setShowSkip(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <p className="muted">Why skip? (logged; surfaces as a suggested exclusion/assumption)</p>
            {SKIP_REASONS.map((r) => (
              <button
                key={r}
                className="secondary"
                onClick={() => {
                  void skipItem(step, scopeItem, r);
                  setShowSkip(false);
                  onNext();
                }}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
