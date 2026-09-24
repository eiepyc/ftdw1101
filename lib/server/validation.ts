import { z } from "zod";

const username = z.string().trim().transform((value) => value.toLowerCase()).pipe(
  z.string().regex(/^[a-z0-9_]{3,24}$/, "用户名需为 3–24 位小写英文字母、数字或下划线。"),
);
const password = z.string()
  .refine((value) => Array.from(value).length >= 8, "密码至少 8 位。")
  .refine((value) => Array.from(value).length <= 128, "密码不能超过 128 位。")
  .refine((value) => /[A-Z]/.test(value), "密码至少包含一个大写英文字母。")
  .refine((value) => /[!-/:-@[-`{-~]/.test(value), "密码至少包含一个特殊符号（如 !、@、#）。")
  .refine((value) => new TextEncoder().encode(value).byteLength <= 72, "新密码最多 72 个 UTF-8 字节。");

export const registerSchema = z.object({
  username,
  password,
}).strict();

export const loginSchema = z.object({
  username,
  password: z.string().min(1, "请填写密码。").max(128, "密码不能超过 128 位。"),
}).strict();

const markInputSchema = z.object({
  day_index: z.number().int().min(0).max(6),
  slot_index: z.number().int().min(0).max(3),
  nickname: z.string().trim().min(1, "请填写昵称。").max(30, "昵称最多 30 字。"),
  location: z.string().trim().max(100, "场地最多 100 字。").optional().default(""),
}).strict();

export const marksWriteSchema = z.object({
  week_key: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
  items: z.array(markInputSchema).min(1).max(28),
}).strict().superRefine((input, context) => {
  const seen = new Set<string>();
  input.items.forEach((item, index) => {
    const key = item.day_index + "-" + item.slot_index;
    if (seen.has(key)) context.addIssue({ code: "custom", path: ["items", index], message: "同一格不能重复提交。" });
    seen.add(key);
  });
});

export const adminActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["ban", "unban", "delete", "restore", "promote_admin", "demote_admin"]), reason: z.string().trim().min(4).max(300) }).strict(),
  z.object({ action: z.literal("reset_password"), reason: z.string().trim().min(4).max(300), password }).strict(),
]);

export const adminMarksActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("clear_week"), week_key: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/), reason: z.string().trim().min(4).max(300) }).strict(),
  z.object({ action: z.enum(["delete_marks", "restore_marks"]), week_key: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/), mark_ids: z.array(z.string().uuid()).min(1).max(100), reason: z.string().trim().min(4).max(300) }).strict(),
]);

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type MarkInput = z.infer<typeof markInputSchema>;
