import type { Contractor } from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
}

export const api = {
  requestLink: async (email: string) =>
    json<{ ok: boolean; message: string }>(
      await post("/api/auth/request-link", { email }),
    ),
  verify: async (token: string) =>
    json<{ ok: boolean }>(await post("/api/auth/verify", { token })),
  me: async () =>
    json<{ contractor: Contractor }>(
      await fetch("/api/me", { credentials: "include" }),
    ),
  // Profile editing is online-only by design (not a field-capture flow).
  patchMe: async (patch: Partial<Contractor>) =>
    json<{ contractor: Contractor }>(
      await fetch("/api/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(patch),
      }),
    ),
  // Scope-narrative draft (§9): returns a suggestion the contractor edits
  // before send (Hard Rule 1). Requires the proposal row to be synced.
  draftNarrative: async (proposalId: string) =>
    json<{ narrative: string }>(
      await post(`/api/proposals/${proposalId}/narrative`, {}),
    ),
};
