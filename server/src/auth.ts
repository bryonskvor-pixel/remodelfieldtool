import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Context, Next } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { getDb } from "./db.js";

const SESSION_COOKIE = "scopewalk_session";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/**
 * Creates a magic-link token for an existing contractor email and delivers it.
 * Pilot delivery is EMAIL_PROVIDER=console: the link prints to the server log.
 * Unknown emails get the same success response (no account enumeration) but
 * no token — contractors are provisioned by the seed script / admin, not by
 * self-signup (Phase 4 concern).
 */
export async function requestMagicLink(email: string): Promise<void> {
  const db = getDb();
  const normalized = email.trim().toLowerCase();
  const contractor = await db.execute({
    sql: "SELECT id FROM contractors WHERE email = ?",
    args: [normalized],
  });
  const row = contractor.rows[0];
  if (!row) return;

  const token = randomBytes(32).toString("base64url");
  const ttl = Number(process.env.MAGIC_LINK_TTL_MINUTES ?? 15);
  await db.execute({
    sql: `INSERT INTO magic_link_tokens (id, email, token_hash, contractor_id, expires_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [randomUUID(), normalized, sha256(token), String(row.id), minutesFromNow(ttl)],
  });

  const origin = process.env.APP_ORIGIN ?? "http://localhost:5173";
  const link = `${origin}/auth/verify?token=${token}`;
  const provider = process.env.EMAIL_PROVIDER ?? "console";
  if (provider === "console") {
    console.log(`\n[auth] magic link for ${normalized}:\n${link}\n`);
  } else {
    // Pluggable providers (e.g. Resend) land with intake work; same shape.
    throw new Error(`EMAIL_PROVIDER "${provider}" not implemented`);
  }
}

/** Verifies a magic-link token and creates a long-lived device session. */
export async function verifyMagicLink(
  c: Context,
  token: string,
): Promise<{ contractorId: string } | null> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT id, contractor_id FROM magic_link_tokens
          WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
    args: [sha256(token), new Date().toISOString()],
  });
  const row = result.rows[0];
  if (!row || !row.contractor_id) return null;

  await db.execute({
    sql: "UPDATE magic_link_tokens SET used_at = ? WHERE id = ?",
    args: [new Date().toISOString(), String(row.id)],
  });

  const sessionToken = randomBytes(32).toString("base64url");
  const ttlDays = Number(process.env.SESSION_TTL_DAYS ?? 90);
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000).toISOString();
  await db.execute({
    sql: `INSERT INTO sessions (id, contractor_id, token_hash, expires_at)
          VALUES (?, ?, ?, ?)`,
    args: [randomUUID(), String(row.contractor_id), sha256(sessionToken), expiresAt],
  });

  setCookie(c, SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    sameSite: "Lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ttlDays * 86_400,
  });
  return { contractorId: String(row.contractor_id) };
}

/**
 * Auth middleware: resolves the session and sets contractorId on the context.
 * Every downstream query uses this value in its WHERE clause (Hard Rule 7).
 */
export async function requireSession(c: Context, next: Next) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: "unauthenticated" }, 401);

  const db = getDb();
  const result = await db.execute({
    sql: `SELECT contractor_id FROM sessions
          WHERE token_hash = ? AND expires_at > ?`,
    args: [sha256(token), new Date().toISOString()],
  });
  const row = result.rows[0];
  if (!row) return c.json({ error: "unauthenticated" }, 401);

  await db.execute({
    sql: "UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?",
    args: [new Date().toISOString(), sha256(token)],
  });

  c.set("contractorId", String(row.contractor_id));
  await next();
}
