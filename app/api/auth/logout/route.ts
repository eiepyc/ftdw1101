import { NextRequest } from "next/server";
import { api, assertSameOrigin, json } from "@/lib/server/http";
import { revokeCurrentSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export const POST = api(async (request: NextRequest) => {
  assertSameOrigin(request);
  await revokeCurrentSession();
  return json({ ok: true });
});
