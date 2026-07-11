import { useEffect, useState } from "react";
import { getBlob } from "../db/store";

/** Renders a locally-stored photo blob (photos live in IndexedDB until R2 upload). */
export function BlobThumb({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let revoke: string | null = null;
    void getBlob(id).then((entry) => {
      if (entry) {
        revoke = URL.createObjectURL(entry.blob);
        setUrl(revoke);
      }
    });
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [id]);

  if (!url) return <div className="thumb thumb-empty" />;
  return <img className="thumb" src={url} alt="" />;
}
