import { useEffect, useRef, useState } from "react";

// Voice notes (§11): tap to start, tap to stop, max 3 minutes. The audio blob
// saves locally; transcription (Groq Whisper) runs as a queued job on sync —
// next session. Recording works fully offline.

const MAX_SEC = 180;

interface Props {
  onCapture: (blob: Blob, durationSec: number) => void | Promise<void>;
}

export function VoiceNote({ onCapture }: Props) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedRef = useRef(0);

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => {
      const sec = Math.floor((Date.now() - startedRef.current) / 1000);
      setElapsed(sec);
      if (sec >= MAX_SEC) stop();
    }, 250);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const duration = Math.min(MAX_SEC, Math.round((Date.now() - startedRef.current) / 1000));
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        if (blob.size > 0) void onCapture(blob, duration);
      };
      recorderRef.current = recorder;
      startedRef.current = Date.now();
      setElapsed(0);
      recorder.start();
      setRecording(true);
    } catch {
      setError("Mic unavailable");
    }
  }

  function stop() {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  }

  const mm = String(Math.floor(elapsed / 60));
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <button
      className={`capture-btn ${recording ? "recording" : ""}`}
      onClick={recording ? stop : start}
      title={error ?? undefined}
    >
      🎤<span>{error ?? (recording ? `${mm}:${ss} ■` : "Voice")}</span>
    </button>
  );
}
