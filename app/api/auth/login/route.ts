import { NextRequest } from "next/server";
import { api, assertSameOrigin, json, readJson } from "@/lib/server/http";
import { loginWithPassword } from "@/lib/server/auth";
import { loginSchema } from "@/lib/server/validation";
import { consumeRateLimits, sourceLimitKey, usernameLimitKey } from "@/lib/server/security";

export const dynamic = "force-dynamic";

export const POST = api(async (request: NextRequest) => {
  assertSameOrigin(request);
  const input = await readJson(request, loginSchema);
  await consumeRateLimits([
    { key: sourceLimitKey(request) + ":login", limit: 60, windowSeconds: 900 },
    { key: usernameLimitKey(input.username) + ":login", limit: 10, windowSeconds: 900 },
  ]);
  await loginWithPassword(input.username, input.password);
  return json({ ok: true });
});
