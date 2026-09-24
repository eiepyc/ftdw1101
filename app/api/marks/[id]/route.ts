import { NextRequest } from "next/server";
import { api, assertSameOrigin, json } from "@/lib/server/http";
import { AppError } from "@/lib/server/errors";
import { rpc } from "@/lib/server/db";
import { requireSession } from "@/lib/server/session";
import { consumeRateLimits } from "@/lib/server/security";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  return api(async (innerRequest) => {
    assertSameOrigin(innerRequest);
    const { id } = await context.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new AppError(422, "invalid_mark_id", "登记编号无效。");
    }
    const { session, tokenHash } = await requireSession();
    await consumeRateLimits([{ key: "account:" + session.id + ":write", limit: 60, windowSeconds: 60 }]);
    const changed = await rpc<number>("app_delete_mark", { p_session_hash: tokenHash, p_mark_id: id });
    if (changed === 0) return json({ changed: 0 });
    return json({ changed });
  })(request);
}
