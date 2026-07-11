import { useRef, useState } from "react";

// Photo capture (§11): opens the device camera directly, compresses on-device
// (target ≤400KB, §3) and hands the blob to the caller for local storage.
// Works fully offline — the blob waits in IndexedDB for R2 upload later.

const MAX_DIM = 1600;
const TARGET_BYTES = 400 * 1024;

export async function compressImage(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  let quality = 0.8;
  let blob: Blob | null = null;
  for (let i = 0; i < 4; i++) {
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob || blob.size <= TARGET_BYTES) break;
    quality -= 0.15;
  }
  return blob ?? file;
}

interface Props {
  onCapture: (blob: Blob) => void | Promise<void>;
}

export function PhotoCapture({ onCapture }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // burst-friendly: allow re-capturing immediately
    if (files.length === 0) return;
    setBusy(true);
    try {
      for (const file of files) {
        await onCapture(await compressImage(file));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="capture-btn" onClick={() => inputRef.current?.click()} disabled={busy}>
        📷<span>{busy ? "Saving…" : "Photo"}</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        hidden
        onChange={onChange}
      />
    </>
  );
}
