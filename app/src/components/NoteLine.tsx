import { useState } from "react";
import { db } from "../db/store";
import type { Note } from "../types";

// A captured note on the prompt/review screens. Voice-note transcripts fill
// in when the background Groq job lands and are editable in place — the edit
// syncs like any row write. Transcripts are contractor internals: they render
// here and NEVER in customer-facing output (Hard Rule 5).

export function NoteLine({ note }: { note: Note }) {
  const [draft, setDraft] = useState<string | null>(null);

  async function save() {
    if (draft !== null) {
      await db.notes.put({ ...note, transcript: draft.trim() || null });
    }
    setDraft(null);
  }

  const icon = note.type === "voice" ? `🎤 ${note.duration_sec ?? 0}s` : "⌨️";

  if (draft !== null) {
    return (
      <div className="note-editor">
        <textarea autoFocus rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <div className="row">
          <button className="secondary" onClick={() => setDraft(null)}>Cancel</button>
          <button onClick={() => void save()}>Save</button>
        </div>
      </div>
    );
  }

  return (
    <p className="captured-line">
      {icon}{" "}
      {note.transcript ? (
        <button className="transcript" onClick={() => setDraft(note.transcript ?? "")} title="Tap to edit">
          {note.transcript}
        </button>
      ) : note.type === "voice" ? (
        <span className="muted">{note.audio_r2_key ? "transcribing…" : "transcribes on sync"}</span>
      ) : (
        <span className="muted">—</span>
      )}
    </p>
  );
}
