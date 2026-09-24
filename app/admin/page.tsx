"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, apiRequest, postJson } from "@/lib/api";

type User = { id: string; username: string; role: "user" | "admin"; status: "active" | "banned" | "deleted" | "reset_pending"; created_at: string; deleted_at: string | null; active_marks: number };
type Audit = { id: number; actor_username: string | null; target_username: string | null; action: string; reason: string; affected_count: number; created_at: string };
type Action = "ban" | "unban" | "delete" | "restore" | "promote_admin" | "demote_admin" | "reset_password";
type Pending = { user: User; action: Action };

const STATUS: Record<User["status"], string> = { active: "正常", banned: "已封禁", deleted: "已软删除", reset_pending: "重置待确认" };
const ACTION_LABEL: Record<Action, string> = { ban: "封禁账号", unban: "解除封禁", delete: "软删除账号", restore: "恢复账号", promote_admin: "设为管理员", demote_admin: "取消管理员", reset_password: "重置密码" };

function explain(error: unknown) { return error instanceof ApiError ? error.message : "服务暂时不可用，请稍后重试。"; }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }

export default function AdminPage() {
  const router = useRouter();
  const [self, setSelf] = useState("");
  const [users, setUsers] = useState<User[]>([]);
  const [audits, setAudits] = useState<Audit[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [auditCursor, setAuditCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const actionDialog = useRef<HTMLDialogElement>(null);
  const actionOpener = useRef<HTMLElement | null>(null);
  const loadController = useRef<AbortController | null>(null);
  const loadGeneration = useRef(0);

  const load = useCallback(async (selectedCursor: string | null = null) => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError("");
    try {
      const [session, userPage, auditPage] = await Promise.all([
        apiRequest<{ user: { id: string; isAdmin: boolean } | null }>("/api/auth/session", { signal: controller.signal }),
        apiRequest<{ items: User[]; total: number; nextCursor: string | null }>(`/api/admin/users${selectedCursor ? `?cursor=${encodeURIComponent(selectedCursor)}` : ""}`, { signal: controller.signal }),
        selectedCursor ? Promise.resolve(null) : apiRequest<{ items: Audit[]; nextCursor: string | null }>("/api/admin/audit", { signal: controller.signal }),
      ]);
      if (generation !== loadGeneration.current) return;
      if (!session.user) { router.replace("/login"); return; }
      if (!session.user.isAdmin) { router.replace("/"); return; }
      setSelf(session.user.id);
      setUsers(userPage.items);
      setTotal(userPage.total);
      setNextCursor(userPage.nextCursor);
      setCursor(selectedCursor);
      if (auditPage) { setAudits(auditPage.items); setAuditCursor(auditPage.nextCursor); }
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 401) {
        setUsers([]); setAudits([]); setPending(null); setReason(""); setPassword("");
        router.replace("/login");
      }
      else setError(explain(cause));
    } finally { if (generation === loadGeneration.current) setLoading(false); }
  }, [router]);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => () => loadController.current?.abort(), []);
  useEffect(() => {
    const dialog = actionDialog.current;
    if (pending && dialog && !dialog.open) dialog.showModal();
    if (!pending && dialog?.open) dialog.close();
    if (!pending && actionOpener.current?.isConnected && actionOpener.current.offsetParent !== null) actionOpener.current.focus();
  }, [pending]);

  function openAction(user: User, action: Action, opener: HTMLElement) {
    actionOpener.current = opener;
    setError(""); setReason(""); setPassword("");
    setPending({ user, action });
  }

  function actionsFor(user: User): Action[] {
    if (user.id === self) return [];
    const items: Action[] = [];
    if (user.status === "active") items.push("ban");
    if (user.status === "banned") items.push("unban");
    if (user.status === "active" || user.status === "banned") items.push("delete");
    if (user.status === "deleted") items.push("restore");
    if (user.role === "user" && user.status === "active") items.push("promote_admin");
    if (user.role === "admin" && user.status === "active") items.push("demote_admin");
    if (user.id !== self && (user.status === "active" || user.status === "reset_pending")) items.push("reset_password");
    return items;
  }

  async function loadAuditMore() {
    if (!auditCursor || auditLoading) return;
    setAuditLoading(true);
    try {
      const result = await apiRequest<{ items: Audit[]; nextCursor: string | null }>(`/api/admin/audit?cursor=${encodeURIComponent(auditCursor)}`);
      setAudits((old) => [...old, ...result.items]);
      setAuditCursor(result.nextCursor);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) { setUsers([]); setAudits([]); setPending(null); setReason(""); setPassword(""); router.replace("/login"); }
      else setError(explain(cause));
    } finally { setAuditLoading(false); }
  }

  async function submitAction(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = pending.action === "reset_password"
        ? { action: pending.action, reason, password }
        : { action: pending.action, reason };
      const result = await postJson<{ affected: number; status?: string }>(`/api/admin/users/${pending.user.id}`, body, "PATCH");
      setNotice(`${ACTION_LABEL[pending.action]}完成，影响 ${result.affected} 个账号。`);
      setPending(null);
      setReason("");
      setPassword("");
      await load(cursor);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) { setUsers([]); setAudits([]); setPending(null); setReason(""); setPassword(""); router.replace("/login"); return; }
      if (cause instanceof ApiError && cause.fields) setError(explain(cause) + " " + Object.values(cause.fields).flat().join(" "));
      else setError(explain(cause));
    } finally { setBusy(false); }
  }

  async function signOut() {
    try { await postJson("/api/auth/logout", {}); router.replace("/login"); }
    catch (cause) { setError(explain(cause)); }
  }

  function closeAction() {
    if (busy) return;
    setPending(null); setReason(""); setPassword(""); setError("");
  }

  return <main className="mx-auto max-w-7xl px-3 py-5 sm:px-6 sm:py-8">
    <header className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <div><Link href="/" className="text-sm font-medium text-slate-500 hover:text-slate-800">← 返回登记表</Link><h1 className="mt-2 text-2xl font-bold">管理员</h1><p className="mt-1 text-sm text-slate-500">账号状态、角色和操作审计。账号删除为可恢复软删除。</p></div>
      <div className="flex flex-wrap gap-2"><a href="/admin/marks" className="min-h-11 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold hover:bg-slate-50">登记管理</a><button type="button" onClick={() => void signOut()} className="min-h-11 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold">退出</button></div>
    </header>

    {error && <p role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</p>}
    {notice && <p role="status" className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</p>}

    <section className="mb-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4"><div><h2 className="font-bold">账号</h2><p className="text-sm text-slate-500">共 {total} 个账号 · 只显示用户名，不显示邮箱或手机号</p></div><button type="button" onClick={() => void load(cursor)} className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-medium">刷新</button></div>
      {loading ? <p className="p-8 text-center text-slate-500">正在加载…</p> : <div className="divide-y divide-slate-100">
        {users.map((user) => <article key={user.id} className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="break-all font-semibold">{user.username}</h3><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${user.status === "active" ? "bg-emerald-50 text-emerald-800" : user.status === "deleted" || user.status === "banned" ? "bg-rose-50 text-rose-800" : "bg-amber-50 text-amber-900"}`}>{STATUS[user.status]}</span><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs">{user.role === "admin" ? "管理员" : "普通账号"}</span>{user.id === self && <span className="text-xs text-slate-500">（当前账号）</span>}</div><p className="mt-1 text-sm text-slate-500">创建于 {formatDate(user.created_at)} · 未删除登记 {user.active_marks} 条</p></div>
          <div className="flex flex-wrap gap-2">{actionsFor(user).map((action) => <button key={action} type="button" disabled={busy} onClick={(event) => openAction(user, action, event.currentTarget)} className={`min-h-11 rounded-lg border px-3 text-sm font-semibold ${action === "delete" || action === "ban" || action === "demote_admin" ? "border-rose-200 text-rose-800 hover:bg-rose-50" : "border-slate-300 text-slate-700 hover:bg-slate-50"}`}>{ACTION_LABEL[action]}</button>)}</div>
        </article>)}
        {users.length === 0 && <p className="p-8 text-center text-slate-500">没有账号。</p>}
      </div>}
      <div className="flex justify-between border-t border-slate-200 p-3"><button type="button" disabled={!cursor || loading} onClick={() => void load(null)} className="min-h-11 rounded-lg px-4 text-sm font-semibold text-blue-800 disabled:opacity-40">第一页</button><button type="button" disabled={!nextCursor || loading} onClick={() => nextCursor && void load(nextCursor)} className="min-h-11 rounded-lg px-4 text-sm font-semibold text-blue-800 disabled:opacity-40">下一页</button></div>
    </section>

    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 p-4"><h2 className="font-bold">最近管理员操作</h2><p className="text-sm text-slate-500">密码、认证 token 和联系方式不会写入审计记录。</p></div>
      <div className="divide-y divide-slate-100">{audits.map((audit) => <article key={audit.id} className="grid gap-1 p-4 sm:grid-cols-[1fr_auto] sm:gap-4"><div><p className="font-semibold">{audit.action.replaceAll("_", " ")}{audit.target_username ? ` · ${audit.target_username}` : ""}</p><p className="mt-1 break-words text-sm text-slate-600">{audit.reason}</p><p className="mt-1 text-xs text-slate-500">操作者：{audit.actor_username ?? "系统"} · 影响 {audit.affected_count}</p></div><time className="text-xs text-slate-500">{formatDate(audit.created_at)}</time></article>)}{audits.length === 0 && <p className="p-6 text-sm text-slate-500">暂无记录。</p>}</div>
      {auditCursor && <div className="border-t border-slate-200 p-3 text-right"><button type="button" disabled={auditLoading} onClick={() => void loadAuditMore()} className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold disabled:opacity-50">{auditLoading ? "加载中…" : "加载更早操作"}</button></div>}
    </section>

    {pending && <dialog ref={actionDialog} aria-labelledby="action-title" onCancel={(event) => { event.preventDefault(); closeAction(); }} onClick={(event) => { if (event.target === event.currentTarget) closeAction(); }} className="fixed inset-x-0 bottom-0 top-auto m-0 max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl border-0 bg-white p-5 shadow-xl backdrop:bg-slate-950/45 sm:inset-0 sm:m-auto sm:rounded-2xl sm:p-6">
        <div className="flex items-start justify-between gap-4"><div><h2 id="action-title" className="text-xl font-bold">确认{ACTION_LABEL[pending.action]}</h2><p className="mt-1 text-slate-600">目标账号：<strong>{pending.user.username}</strong></p></div><button type="button" autoFocus disabled={busy} aria-label="关闭确认框" onClick={closeAction} className="min-h-11 min-w-11 rounded-lg border border-slate-300 text-xl">×</button></div>
        <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm leading-6 text-amber-950">
          {pending.action === "delete" ? `将软删除账号，并隐藏其 ${pending.user.active_marks} 条未删除登记；可由管理员恢复，既有独立删除的登记不会随账号恢复。` :
            pending.action === "reset_password" ? "将撤销此账号现有登录状态。若上游结果不确定，账号会保持停用，需运维核验。" :
              pending.action === "ban" ? "将封禁账号并撤销现有登录状态。" :
                pending.action === "restore" ? "将恢复账号访问；曾独立删除的登记仍保持删除。" :
                  pending.action === "demote_admin" ? "将移除此账号的管理员权限，系统会保护最后一位有效管理员。" :
                    pending.action === "promote_admin" ? "此账号将获得用户和登记管理权限。" : "将解除账号封禁。"}
        </p>
        <form onSubmit={submitAction} className="mt-4 space-y-4">
          {pending.action === "reset_password" && <div><label htmlFor="reset-password" className="mb-1 block text-sm font-semibold">新密码</label><input id="reset-password" type="password" autoFocus autoComplete="new-password" required maxLength={72} value={password} onChange={(event) => setPassword(event.target.value)} className="min-h-12 w-full rounded-lg border border-slate-300 px-3" aria-describedby="reset-password-help" /><p id="reset-password-help" className="mt-1 text-xs leading-5 text-slate-500">至少 8 位，至少一个大写英文字母和特殊符号（如 !、@、#），不超过 72 个 UTF-8 字节；不要求小写字母或数字。</p></div>}
          <div><label htmlFor="reason" className="mb-1 block text-sm font-semibold">操作原因（必填）</label><textarea id="reason" autoFocus={pending.action !== "reset_password"} required minLength={4} maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} className="min-h-24 w-full rounded-lg border border-slate-300 p-3" placeholder="填写便于审计的简短原因" /></div>
          {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" disabled={busy} onClick={closeAction} className="min-h-11 rounded-lg border border-slate-300 px-4 font-semibold">取消</button><button type="submit" disabled={busy} className="min-h-11 rounded-lg bg-rose-700 px-5 font-semibold text-white disabled:opacity-60">{busy ? "正在处理…" : `确认${ACTION_LABEL[pending.action]}`}</button></div>
        </form>
    </dialog>}
  </main>;
}
