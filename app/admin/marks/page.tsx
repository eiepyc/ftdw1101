"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ApiError, apiRequest, postJson } from "@/lib/api";
import { getCurrentWeekKey, formatWeekDay, shiftDayKey, shiftWeekKey } from "@/lib/week";

type Mark = { id: string; user_id: string; username: string; day_index: number; slot_index: number; nickname: string; location: string; created_at: string; deleted_at: string | null };
type WeekData = { items: Mark[]; total: number; activeCount: number; nextCursor: string | null; state: "active" | "deleted" };
type View = "active" | "deleted";
type Pending = { action: "delete_marks" | "restore_marks" | "clear_week"; week: string; count: number; ids: string[] };
const DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const SLOTS = ["12:00 之前", "12:00–15:00", "15:00–18:00", "18:00 之后"];
const explain = (error: unknown) => error instanceof ApiError ? error.message : "服务暂时不可用，请稍后重试。";

export default function AdminMarksPage() {
  const router = useRouter();
  const [currentWeek, setCurrentWeek] = useState(getCurrentWeekKey);
  const [week, setWeek] = useState(getCurrentWeekKey);
  const [view, setView] = useState<View>("active");
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [data, setData] = useState<WeekData>({ items: [], total: 0, activeCount: 0, nextCursor: null, state: "active" });
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const requestGeneration = useRef(0);
  const requestController = useRef<AbortController | null>(null);
  const weekRef = useRef(week);
  const weekOffset = Math.round((Date.parse(`${week}T00:00:00Z`) - Date.parse(`${currentWeek}T00:00:00Z`)) / (7 * 86_400_000));
  const isHistorical = week < currentWeek;

  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = getCurrentWeekKey();
      if (next !== currentWeek) {
        if (week < next) setSelected([]);
        if (pending?.action === "clear_week" && pending.week < next) { setPending(null); setReason(""); }
        setCurrentWeek(next);
      }
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [currentWeek, pending, week]);
  useEffect(() => { weekRef.current = week; }, [week]);

  const load = useCallback(async (selectedCursor: string | null = null) => {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    const generation = ++requestGeneration.current;
    const requestWeek = week;
    const requestView = view;
    setLoading(true);
    setError("");
    try {
      const session = await apiRequest<{ user: { isAdmin: boolean } | null }>("/api/auth/session", { signal: controller.signal });
      if (!session.user) { router.replace("/login"); return; }
      if (!session.user.isAdmin) { router.replace("/"); return; }
      const params = new URLSearchParams({ week: requestWeek, state: requestView });
      if (selectedCursor) params.set("cursor", selectedCursor);
      const result = await apiRequest<WeekData>(`/api/admin/marks?${params}`, { signal: controller.signal });
      if (generation !== requestGeneration.current || requestWeek !== weekRef.current) return;
      setData(result);
      setCursor(selectedCursor);
      setNextCursor(result.nextCursor);
      setSelected([]);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 401) router.replace("/login");
      else setError(explain(cause));
    } finally { if (generation === requestGeneration.current) setLoading(false); }
  }, [router, view, week]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => { window.clearTimeout(timer); requestController.current?.abort(); };
  }, [load]);
  useEffect(() => {
    const element = dialog.current;
    if (pending && element && !element.open) element.showModal();
    if (!pending && element?.open) element.close();
    if (!pending && opener.current?.isConnected && opener.current.offsetParent !== null) opener.current.focus();
  }, [pending]);
  useEffect(() => () => requestController.current?.abort(), []);

  function changeWeek(next: string) {
    if (busy) return;
    requestController.current?.abort(); requestGeneration.current += 1;
    setSelected([]); setPending(null); setReason(""); setNotice("");
    setWeek(next);
  }

  function changeView(next: View) {
    if (busy || next === view) return;
    requestController.current?.abort(); requestGeneration.current += 1;
    setSelected([]); setPending(null); setReason(""); setNotice(""); setCursor(null);
    setView(next);
  }

  function openPending(value: Pending, element: HTMLElement) {
    opener.current = element;
    setReason(""); setError("");
    setPending(value);
  }

  function closePending() {
    if (busy) return;
    setPending(null); setReason(""); setError("");
  }

  async function submitPending(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending) return;
    setBusy(true);
    setError(""); setNotice("");
    const requested = pending;
    try {
      if (requested.action === "clear_week" && requested.week < currentWeek) throw new ApiError("该周已成为历史周，请返回本周重新选择。", "historical_week", 422);
      const body = requested.action === "clear_week"
        ? { action: "clear_week", week_key: requested.week, reason }
        : { action: requested.action, week_key: requested.week, mark_ids: requested.ids, reason };
      const result = await postJson<{ affected: number }>("/api/admin/marks", body);
      if (requested.week === weekRef.current) {
        setNotice(`${requested.action === "restore_marks" ? "恢复" : "软删除"}完成，实际影响 ${result.affected} 条登记。`);
        setPending(null); setReason("");
        await load(cursor);
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) { setData({ items: [], total: 0, activeCount: 0, nextCursor: null, state: view }); setSelected([]); setPending(null); setReason(""); router.replace("/login"); }
      else setError(explain(cause));
    } finally { setBusy(false); }
  }

  async function signOut() {
    try { await postJson("/api/auth/logout", {}); router.replace("/login"); }
    catch (cause) { setError(explain(cause)); }
  }

  const action = view === "active" ? "delete_marks" : "restore_marks";

  return <main className="mx-auto max-w-6xl px-3 py-5 sm:px-6 sm:py-8">
    <header className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <div><Link href="/admin" className="text-sm font-medium text-slate-500 hover:text-slate-800">← 返回管理员</Link><h1 className="mt-2 text-2xl font-bold">登记管理</h1><p className="mt-1 text-sm text-slate-500">单条和整周操作都有审计原因；删除为可恢复软删除。</p></div>
      <button type="button" onClick={() => void signOut()} className="min-h-11 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold">退出</button>
    </header>
    {error && <p role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</p>}
    {notice && <p role="status" className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</p>}

    <section className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div><h2 className="font-bold">{week} 至 {shiftDayKey(week, 6)}</h2><p className="mt-1 text-sm text-slate-500">可查看过去 8 周至未来 4 周；仅本周和未来周可删除登记。</p></div>
      <div className="flex flex-wrap gap-2"><button type="button" disabled={weekOffset <= -8 || busy} onClick={() => changeWeek(shiftWeekKey(week, -1))} className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-medium disabled:opacity-40">上一周</button><button type="button" disabled={weekOffset >= 4 || busy} onClick={() => changeWeek(shiftWeekKey(week, 1))} className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-medium disabled:opacity-40">下一周</button><button type="button" disabled={busy} onClick={() => changeWeek(currentWeek)} className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-medium">本周</button></div>
    </section>

    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="font-bold">{view === "active" ? `未删除登记（${data.total}）` : `已删除登记（${data.total}）`}</h2><p className="mt-1 text-sm text-slate-500">{view === "active" ? `这一周共 ${data.activeCount} 条未删除登记，包含已停用账号的历史登记。` : "恢复仅针对选中记录，不会跟随账号恢复。"}</p></div><button type="button" disabled={loading || busy} onClick={() => void load(cursor)} className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-medium">刷新</button></div>
      <div className="flex border-b border-slate-200 px-3"><button type="button" aria-pressed={view === "active"} onClick={() => changeView("active")} className={`min-h-12 border-b-2 px-4 text-sm font-semibold ${view === "active" ? "border-blue-700 text-blue-800" : "border-transparent text-slate-500"}`}>未删除</button><button type="button" aria-pressed={view === "deleted"} onClick={() => changeView("deleted")} className={`min-h-12 border-b-2 px-4 text-sm font-semibold ${view === "deleted" ? "border-blue-700 text-blue-800" : "border-transparent text-slate-500"}`}>已删除</button></div>

      {view === "active" && <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-rose-50/60 p-3"><p className="text-sm font-medium text-rose-900">本周准确总数：{data.activeCount} 条</p><button type="button" disabled={loading || busy || isHistorical || data.activeCount === 0} onClick={(event) => openPending({ action: "clear_week", week, count: data.activeCount, ids: [] }, event.currentTarget)} className="min-h-11 rounded-lg bg-rose-700 px-4 text-sm font-semibold text-white disabled:opacity-40">清空本周登记</button></div>}

      {loading ? <p className="p-8 text-center text-slate-500">正在加载…</p> : data.items.length === 0 ? <p className="p-8 text-center text-slate-500">这一周没有{view === "active" ? "未删除" : "已删除"}登记。</p> : <div className="divide-y divide-slate-100">
        {data.items.map((mark) => <label key={mark.id} className="flex min-h-16 cursor-pointer items-start gap-3 p-4 hover:bg-slate-50"><input type="checkbox" checked={selected.includes(mark.id)} disabled={busy || (view === "active" && isHistorical)} onChange={(event) => setSelected((old) => event.target.checked ? [...old, mark.id] : old.filter((id) => id !== mark.id))} className="mt-1 h-5 w-5 shrink-0 accent-blue-700" /><span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-x-2 gap-y-1"><strong className="break-all">{mark.nickname}</strong><span className="text-sm text-slate-600">{mark.username}</span><span className="text-sm text-slate-500">{DAYS[mark.day_index]} {formatWeekDay(week, mark.day_index)} · {SLOTS[mark.slot_index]}</span></span><span className="mt-1 block break-words text-sm text-slate-600">场地：{mark.location || "皆可"}</span></span></label>)}
      </div>}

      <div className="flex items-center justify-between border-t border-slate-200 p-3"><button type="button" disabled={!cursor || loading} onClick={() => void load(null)} className="min-h-11 rounded-lg px-4 text-sm font-semibold text-blue-800 disabled:opacity-40">第一页</button><button type="button" disabled={!nextCursor || loading} onClick={() => nextCursor && void load(nextCursor)} className="min-h-11 rounded-lg px-4 text-sm font-semibold text-blue-800 disabled:opacity-40">加载更多</button></div>
      {selected.length > 0 && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 p-4"><p className="text-sm font-semibold">已选 {selected.length} 条{selected.length > 100 ? "（最多每次 100 条）" : ""}</p><button type="button" disabled={busy || selected.length > 100 || (view === "active" && isHistorical)} onClick={(event) => openPending({ action, week, count: selected.length, ids: selected }, event.currentTarget)} className={`min-h-11 rounded-lg px-5 font-semibold text-white disabled:opacity-40 ${view === "active" ? "bg-rose-700" : "bg-blue-700"}`}>{view === "active" ? "软删除所选登记" : "恢复所选登记"}</button></div>}
    </section>

    {pending && <dialog ref={dialog} aria-labelledby="pending-title" onCancel={(event) => { event.preventDefault(); closePending(); }} onClick={(event) => { if (event.target === event.currentTarget) closePending(); }} className="fixed inset-x-0 bottom-0 top-auto m-0 max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl border-0 bg-white p-5 shadow-xl backdrop:bg-slate-950/45 sm:inset-0 sm:m-auto sm:rounded-2xl sm:p-6">
      <div className="flex items-start justify-between gap-3"><div><h2 id="pending-title" className="text-xl font-bold">{pending.action === "restore_marks" ? "确认恢复登记" : "确认软删除登记"}</h2><p className="mt-1 text-slate-600">范围：{pending.week} 至 {shiftDayKey(pending.week, 6)}</p></div><button type="button" autoFocus aria-label="关闭确认框" disabled={busy} onClick={closePending} className="min-h-11 min-w-11 rounded-lg border border-slate-300 text-xl">×</button></div>
      <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm font-semibold leading-6 text-amber-950">{pending.action === "clear_week" ? `将软删除这一周当前全部 ${pending.count} 条未删除登记。该范围包含已停用账号的登记；完成后可在“已删除”列表逐条恢复。` : `将${pending.action === "restore_marks" ? "恢复" : "软删除"}准确选择的 ${pending.count} 条登记。实际变更数可能因并发操作而较少。`}</p>
      <form onSubmit={submitPending} className="mt-4 space-y-4"><div><label htmlFor="reason" className="mb-1 block text-sm font-semibold">操作原因</label><textarea id="reason" autoFocus required minLength={4} maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} className="min-h-24 w-full rounded-lg border border-slate-300 p-3" placeholder="填写审计记录中的原因" /></div>{error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">{error}</p>}<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" disabled={busy} onClick={closePending} className="min-h-11 rounded-lg border border-slate-300 px-4 font-semibold">取消</button><button type="submit" disabled={busy} className="min-h-11 rounded-lg bg-rose-700 px-5 font-semibold text-white disabled:opacity-50">{busy ? "正在处理…" : `确认处理 ${pending.count} 条`}</button></div></form>
    </dialog>}
  </main>;
}
