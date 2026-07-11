import { useEffect, useState } from "react";
import { getBlob } from "../db/store";

/**
 * Renders a photo: the local IndexedDB blob when it exists (capture device,
 * works offline), else streamed from R2 via the server (fresh device /
 * cleared storage). Ownership is enforced server-side (Hard Rule 7).
 */
export function BlobThumb({ id, full = false }: { id: string; full?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let revoke: string | null = null;
    setFailed(false);
    void getBlob(id).then((entry) => {
      if (entry) {
        revoke = URL.createObjectURL(entry.blob);
        setUrl(revoke);
      } else {
        // No local blob — fall back to the server copy (same-origin, cookie auth).
        setUrl(`/api/media/photo/${id}${full ? "" : "?variant=thumb"}`);
      }
    });
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [id, full]);

  if (!url || failed) return <div className="thumb thumb-empty" />;
  return <img className="thumb" src={url} alt="" onError={() => setFailed(true)} />;
}
