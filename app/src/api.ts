export interface Contractor {
  id: string;
  business_name: string;
  owner_name: string | null;
  email: string;
  default_markup_pct: number;
  proposal_expiration_days: number;
}

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
};
