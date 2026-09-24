import { NextRequest } from "next/server";
import { z } from "zod";
import { api, assertSameOrigin, json, readJson } from "@/lib/server/http";
import { AppError } from "@/lib/server/errors";
import { rpc } from "@/lib/server/db";
import { requireSession } from "@/lib/server/session";
import { consumeRateLimits } from "@/lib/server/security";
import { adminActionSchema } from "@/lib/server/validation";
import { updateAuthPassword } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

type AdminResult = { target_user_id: string; affected_count: number; status: string; role: string; reset_attempt?: string };

export const PATCH = api(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(request);
  const input = await readJson(request, adminActionSchema);
  const { id } = await context.params;
  const target = z.string().uuid().safeParse(id);
  if (!target.success) throw new AppError(422, "invalid_user", "用户编号无效。");
  const { session, tokenHash } = await requireSession();
  if (!session.isAdmin) throw new AppError(403, "forbidden", "没有权限执行此操作。");
  await consumeRateLimits([{ key: "account:" + session.id + ":admin-write", limit: 30, windowSeconds: 900 }]);

  if (input.action === "reset_password") {
    const prepared = await rpc<AdminResult>("app_admin_action", {
      p_session_hash: tokenHash,
      p_target_user_id: target.data,
      p_action: "prepare_password_reset",
      p_reason: input.reason,
    });
    if (!prepared.reset_attempt) throw new AppError(409, "reset_already_pending", "该账号已有重置流程，当前仍保持停用状态。");
    const outcome = await updateAuthPassword(target.data, input.password);
    if (outcome === "unknown") {
      throw new AppError(503, "reset_outcome_unknown", "密码更新结果暂时无法确认；账号已保持停用，请联系运维核验后恢复。 ");
    }
    if (outcome === "rejected") {
      await rpc<number>("app_admin_fail_password_reset", {
        p_session_hash: tokenHash,
        p_target_user_id: target.data,
        p_attempt_id: prepared.reset_attempt,
      });
      throw new AppError(422, "password_rejected", "上游认证服务拒绝了该密码；账号仍保持停用，请使用符合策略的密码重试。 ");
    }
    await rpc("app_admin_finish_password_reset", {
      p_session_hash: tokenHash,
      p_target_user_id: target.data,
      p_attempt_id: prepared.reset_attempt,
      p_reason: input.reason,
    });
    return json({ ok: true, affected: 1, status: "active" });
  }

  const result = await rpc<AdminResult>("app_admin_action", {
    p_session_hash: tokenHash,
    p_target_user_id: target.data,
    p_action: input.action,
    p_reason: input.reason,
  });
  return json({ ok: true, affected: result.affected_count, status: result.status, role: result.role });
});
