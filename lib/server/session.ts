import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { AppError } from "./errors";
import { rpc } from "./db";
import { getServerEnv } from "./env";

const SESSION_COOKIE = "lai_pai_session";
const SESSION_LIFETIME_SECONDS = 60 * 60 * 12;

export type AppSession = {
  id: string;
  username: string;
  isAdmin: boolean;
  expiresAt: string;
};

type SessionRow = { user_id: string; username: string; is_admin: boolean; expires_at: string };

function sessionHash(token: string): string {
  return createHmac("sha256", getServerEnv().sessionHashSecret)
    .update("app-session:v1:" + token)
    .digest("hex");
}

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

export async function issueAppSession(userId: string, expectedAuthEpoch: number): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const hash = sessionHash(token);
  await rpc<string>("app_register_session", {
    p_user_id: userId,
    p_token_hash: hash,
    p_expected_auth_epoch: expectedAuthEpoch,
  });
  const store = await cookies();
  store.set(SESSION_COOKIE, token, cookieOptions(SESSION_LIFETIME_SECONDS));
}

export async function getSessionHash(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token || !/^[A-Za-z0-9_-]{40,50}$/.test(token)) return null;
  return sessionHash(token);
}

export async function currentSession(): Promise<AppSession | null> {
  const tokenHash = await getSessionHash();
  if (!tokenHash) return null;
  const rows = await rpc<SessionRow[]>("app_get_session", { p_token_hash: tokenHash });
  const row = rows[0];
  if (!row) return null;
  return { id: row.user_id, username: row.username, isAdmin: row.is_admin, expiresAt: row.expires_at };
}

export async function requireSession(): Promise<{ session: AppSession; tokenHash: string }> {
  const tokenHash = await getSessionHash();
  if (!tokenHash) throw new AppError(401, "unauthenticated", "请先登录。");
  const rows = await rpc<SessionRow[]>("app_get_session", { p_token_hash: tokenHash });
  const row = rows[0];
  if (!row) throw new AppError(401, "unauthenticated", "登录状态已失效，请重新登录。");
  return {
    tokenHash,
    session: { id: row.user_id, username: row.username, isAdmin: row.is_admin, expiresAt: row.expires_at },
  };
}

export async function clearAppSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", cookieOptions(0));
}

export async function revokeCurrentSession(): Promise<void> {
  const tokenHash = await getSessionHash();
  try {
    if (tokenHash) await rpc<number>("app_revoke_session", { p_token_hash: tokenHash });
  } finally {
    await clearAppSessionCookie();
  }
}
