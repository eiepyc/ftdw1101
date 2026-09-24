import { NextRequest } from "next/server";
import { api, json } from "@/lib/server/http";
import { AppError } from "@/lib/server/errors";
import { rpc } from "@/lib/server/db";
import { requireSession } from "@/lib/server/session";
import { consumeRateLimits } from "@/lib/server/security";
import { decodeNumericCursor, encodeCursor } from "@/lib/server/pagination";

export const dynamic = "force-dynamic";

type AuditRow = {
  id: number; actor_username: string | null; target_username: string | null; action: string;
  reason: string; affected_count: number; created_at: string;
};
type Page = { items: AuditRow[]; total: number; hasMore: boolean };

export const GET = api(async (request: NextRequest) => {
  const { session, tokenHash } = await requireSession();
  if (!session.isAdmin) throw new AppError(403, "forbidden", "没有权限执行此操作。");
  const cursor = decodeNumericCursor(request.nextUrl.searchParams.get("cursor"));
  await consumeRateLimits([{ key: "account:" + session.id + ":admin-read", limit: 120, windowSeconds: 900 }]);
  const page = await rpc<Page>("app_admin_list_audit", {
    p_session_hash: tokenHash,
    p_before_created_at: cursor?.createdAt ?? null,
    p_before_id: cursor?.id ?? null,
    p_page_size: 30,
  });
  const last = page.items.at(-1);
  return json({
    items: page.items,
    total: page.total,
    nextCursor: page.hasMore && last ? encodeCursor(last.created_at, last.id) : null,
  });
});
