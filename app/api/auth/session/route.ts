import { api, json } from "@/lib/server/http";
import { currentSession } from "@/lib/server/session";
import { ensureDeviceHash } from "@/lib/server/security";

export const dynamic = "force-dynamic";

export const GET = api(async () => {
  await ensureDeviceHash();
  const session = await currentSession();
  return json({ user: session ? { id: session.id, username: session.username, isAdmin: session.isAdmin } : null });
});
