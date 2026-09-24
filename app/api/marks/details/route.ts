import { NextRequest } from "next/server";
import { api, json } from "@/lib/server/http";
import { AppError } from "@/lib/server/errors";
import { rpc } from "@/lib/server/db";
import { requireSession } from "@/lib/server/session";
import { decodeUuidCursor, requireWeekParam } from "@/lib/server/pagination";
import { z } from "zod";

export const dynamic = "force-dynamic";

type Detail = { id: string; user_id: string; nickname: string; location: string; created_at: string };
type DetailPage = { items: Detail[]; total: number; hasMore: boolean };

export const GET = api(async (request: NextRequest) => {
  const { tokenHash } = await requireSession();
  const params = request.nextUrl.searchParams;
  const week = requireWeekParam(params.get("week"));
  const dayValue = params.get("day");
  const slotValue = params.get("slot");
  const day = z.coerce.number().int().min(0).max(6).safeParse(dayValue);
  const slot = z.coerce.number().int().min(0).max(3).safeParse(slotValue);
  if (dayValue === null || slotValue === null || !day.success || !slot.success) throw new AppError(422, "invalid_cell", "日期或时段无效。");
  const cursor = decodeUuidCursor(params.get("cursor"));
  const page = await rpc<DetailPage>("app_list_cell", {
    p_session_hash: tokenHash,
    p_week_key: week,
    p_day_index: day.data,
    p_slot_index: slot.data,
    p_before_created_at: cursor?.createdAt ?? null,
    p_before_id: cursor?.id ?? null,
    p_page_size: 30,
  });
  const last = page.items.at(-1);
  const nextCursor = page.hasMore && last ? Buffer.from(last.created_at + "|" + last.id).toString("base64url") : null;
  return json({ items: page.items, total: page.total, nextCursor });
});
