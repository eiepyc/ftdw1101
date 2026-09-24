import { NextRequest } from "next/server";
import { api, assertSameOrigin, json, readJson } from "@/lib/server/http";
import { AppError } from "@/lib/server/errors";
import { rpc } from "@/lib/server/db";
import { requireSession } from "@/lib/server/session";
import { consumeRateLimits } from "@/lib/server/security";
import { adminMarksActionSchema } from "@/lib/server/validation";
import { decodeUuidCursor, encodeCursor, requireWeekParam } from "@/lib/server/pagination";

export const dynamic = "force-dynamic";

type DeletedMark = {
  id: string; user_id: string; username: string; day_index: number; slot_index: number;
  nickname: string; location: string; created_at: string; deleted_at: string;
};
type Page = { items: DeletedMark[]; total: number; hasMore: boolean };

export const GET = api(async (request: NextRequest) => {
  const { session, tokenHash } = await requireSession();
  if (!session.isAdmin) throw new AppError(403, "forbidden", "没有权限执行此操作。");
  const params = request.nextUrl.searchParams;
  const week = requireWeekParam(params.get("week"));
  const state = params.get("state") === "deleted" ? "deleted" : "active";
  const cursor = decodeUuidCursor(params.get("cursor"));
  await consumeRateLimits([{ key: "account:" + session.id + ":admin-read", limit: 120, windowSeconds: 900 }]);
  const page = await rpc<Page>(state === "deleted" ? "app_admin_list_deleted_marks" : "app_admin_list_active_marks", {
    p_session_hash: tokenHash,
    p_week_key: week,
    p_before_created_at: cursor?.createdAt ?? null,
    p_before_id: cursor?.id ?? null,
    p_page_size: 30,
  });
  const activeCount = await rpc<number>("app_admin_week_active_count", {
    p_session_hash: tokenHash,
    p_week_key: week,
  });
  const last = page.items.at(-1);
  return json({
    items: page.items,
    total: page.total,
    activeCount,
    state,
    nextCursor: page.hasMore && last ? encodeCursor(last.created_at, last.id) : null,
  });
});

export const POST = api(async (request: NextRequest) => {
  assertSameOrigin(request);
  const input = await readJson(request, adminMarksActionSchema);
  const { session, tokenHash } = await requireSession();
  if (!session.isAdmin) throw new AppError(403, "forbidden", "没有权限执行此操作。");
  await consumeRateLimits([{ key: "account:" + session.id + ":admin-write", limit: 30, windowSeconds: 900 }]);
  const count = await rpc<number>("app_admin_marks_action", {
    p_session_hash: tokenHash,
    p_action: input.action,
    p_week_key: input.week_key,
    p_mark_ids: "mark_ids" in input ? input.mark_ids : null,
    p_reason: input.reason,
  });
  return json({ ok: true, affected: count });
});
