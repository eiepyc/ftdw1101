import { NextRequest } from "next/server";
import { api, assertSameOrigin, json, readJson } from "@/lib/server/http";
import { rpc } from "@/lib/server/db";
import { requireSession } from "@/lib/server/session";
import { consumeRateLimits } from "@/lib/server/security";
import { marksWriteSchema } from "@/lib/server/validation";
import { requireWeekParam } from "@/lib/server/pagination";

export const dynamic = "force-dynamic";

type SlotRow = { day_index: number; slot_index: number; mark_count: number; mine: boolean };
type SavedMarks = { accepted: number; changed: number; week_key: string; week_end: string };

export const GET = api(async (request: NextRequest) => {
  const { tokenHash } = await requireSession();
  const week = requireWeekParam(request.nextUrl.searchParams.get("week"));
  const rows = await rpc<SlotRow[]>("app_list_week", { p_session_hash: tokenHash, p_week_key: week });
  const lookup = new Map(rows.map((row) => [row.day_index + "-" + row.slot_index, row]));
  const slots = Array.from({ length: 28 }, (_, index) => {
    const dayIndex = Math.floor(index / 4);
    const slotIndex = index % 4;
    const row = lookup.get(dayIndex + "-" + slotIndex);
    return { dayIndex, slotIndex, count: row?.mark_count ?? 0, mine: row?.mine ?? false };
  });
  return json({ weekKey: week, slots });
});

export const POST = api(async (request: NextRequest) => {
  assertSameOrigin(request);
  const input = await readJson(request, marksWriteSchema);
  const { session, tokenHash } = await requireSession();
  await consumeRateLimits([
    { key: "account:" + session.id + ":write", limit: 60, windowSeconds: 60 },
  ]);
  const result = await rpc<SavedMarks>("app_upsert_marks", {
    p_session_hash: tokenHash,
    p_week_key: input.week_key,
    p_items: input.items.map((item) => ({
      day_index: item.day_index,
      slot_index: item.slot_index,
      nickname: item.nickname,
      location: item.location.trim() || "皆可",
    })),
  });
  return json({ accepted: result.accepted, changed: result.changed, weekKey: result.week_key, weekEnd: result.week_end });
});
