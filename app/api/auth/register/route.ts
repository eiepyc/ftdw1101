import { NextRequest } from "next/server";
import { api, assertSameOrigin, json, readJson } from "@/lib/server/http";
import { registerAccount } from "@/lib/server/auth";
import { registerSchema } from "@/lib/server/validation";
import { consumeRateLimits, deviceLimitKey, ensureDeviceHash, sourceLimitKey } from "@/lib/server/security";

export const dynamic = "force-dynamic";

export const POST = api(async (request: NextRequest) => {
  assertSameOrigin(request);
  const input = await readJson(request, registerSchema);
  const source = sourceLimitKey(request);
  await consumeRateLimits([
    { key: source + ":register", limit: 20, windowSeconds: 3600 },
  ]);
  const deviceHash = await ensureDeviceHash();
  await consumeRateLimits([
    { key: deviceLimitKey(deviceHash) + ":register", limit: 5, windowSeconds: 3600 },
  ]);
  await registerAccount(input.username, input.password, deviceHash);
  return json({ ok: true }, { status: 201 });
});
