import { AwsClient } from "aws4fetch";

// Cloudflare R2 via its S3-compatible API (§3: photos + audio, no egress
// fees). Server-mediated: the app never talks to R2 directly, so every media
// request passes the session + ownership checks in media.ts (Hard Rule 7).

let client: AwsClient | null = null;

function accountId(): string {
  // Tolerate the full endpoint URL being pasted in place of the bare id.
  const raw = (process.env.R2_ACCOUNT_ID ?? "").trim();
  const m = raw.match(/^https?:\/\/([a-f0-9]+)\.r2\.cloudflarestorage\.com/);
  return m ? m[1]! : raw;
}

export function r2Configured(): boolean {
  return Boolean(accountId() && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
}

function getClient(): AwsClient {
  if (client) return client;
  if (!r2Configured()) throw new Error("R2 is not configured (R2_* env vars missing)");
  client = new AwsClient({
    accessKeyId: process.env.R2_ACCESS_KEY_ID!.trim(),
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!.trim(),
    service: "s3",
    region: "auto",
  });
  return client;
}

function objectUrl(key: string): string {
  const bucket = (process.env.R2_BUCKET ?? "scopewalk-media").trim();
  // Key segments are ids/fixed suffixes we generate — encode defensively anyway.
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return `https://${accountId()}.r2.cloudflarestorage.com/${bucket}/${encoded}`;
}

export async function r2Put(key: string, body: Uint8Array, contentType: string): Promise<void> {
  const res = await getClient().fetch(objectUrl(key), {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: body as unknown as BodyInit,
  });
  if (!res.ok) throw new Error(`R2 PUT ${key} failed: HTTP ${res.status} ${await res.text()}`);
}

export async function r2Delete(key: string): Promise<void> {
  const res = await getClient().fetch(objectUrl(key), { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE ${key} failed: HTTP ${res.status}`);
}

/** Returns the object body + content type, or null if the key doesn't exist. */
export async function r2Get(key: string): Promise<{ body: Uint8Array; contentType: string } | null> {
  const res = await getClient().fetch(objectUrl(key));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 GET ${key} failed: HTTP ${res.status}`);
  return {
    body: new Uint8Array(await res.arrayBuffer()),
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
  };
}
