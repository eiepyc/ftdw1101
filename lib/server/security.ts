import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { AppError } from "./errors";
import { rpc } from "./db";
import { getServerEnv } from "./env";
import { trustedClientIp } from "./client-ip";

const DEVICE_COOKIE = "lai_pai_device";
const DEVICE_MAX_AGE = 60 * 60 * 24 * 365;

function hmac(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function signedDeviceId(id: string): string {
  return createHmac("sha256", getServerEnv().deviceSigningSecret)
    .update("device-cookie:v1:" + id)
    .digest("base64url");
}

function makeDeviceId(): string {
  return randomBytes(32).toString("base64url");
}

export async function ensureDeviceHash(): Promise<string> {
  const env = getServerEnv();
  const store = await cookies();
  const cookieValue = store.get(DEVICE_COOKIE)?.value ?? "";
  const [id, signature, extra] = cookieValue.split(".");
  let valid = false;
  if (id && signature && !extra && /^[A-Za-z0-9_-]{40,50}$/.test(id)) {
    const expected = signedDeviceId(id);
    const supplied = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    valid = supplied.length === expectedBytes.length && timingSafeEqual(supplied, expectedBytes);
  }
  const deviceId = valid ? id : makeDeviceId();
  if (!valid) {
    store.set(DEVICE_COOKIE, deviceId + "." + signedDeviceId(deviceId), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: DEVICE_MAX_AGE,
    });
  }
  return hmac(env.deviceHashSecret, "device-quota:v1:" + deviceId);
}

function rotationDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function sourceIp(request: NextRequest): string {
  return trustedClientIp(request.headers, getServerEnv().proxyMode);
}

export type RateLimit = { key: string; limit: number; windowSeconds: number };

export async function consumeRateLimits(limits: RateLimit[]): Promise<void> {
  const secret = getServerEnv().rateLimitHmacSecret;
  for (const limit of limits) {
    const bucket = hmac(secret, "rate:v1:" + rotationDay() + ":" + limit.key);
    const result = await rpc<Array<{ allowed: boolean; retry_after: number }>>("app_consume_rate_limit", {
      p_bucket_hash: bucket,
      p_limit: limit.limit,
      p_window_seconds: limit.windowSeconds,
    });
    if (!result[0]?.allowed) {
      throw new AppError(429, "rate_limited", "操作太频繁，请稍后重试。", {
        retryAfter: Math.max(1, result[0]?.retry_after ?? limit.windowSeconds),
      });
    }
  }
}

export function usernameLimitKey(username: string): string {
  return "username:" + username;
}

export function deviceLimitKey(deviceHash: string): string {
  return "device:" + deviceHash;
}

export function sourceLimitKey(request: NextRequest): string {
  const secret = getServerEnv().rateLimitHmacSecret;
  return "source:" + hmac(secret, "source:v1:" + rotationDay() + ":" + sourceIp(request));
}
