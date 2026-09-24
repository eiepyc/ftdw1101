"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ApiError, apiRequest, postJson } from "@/lib/api";
import { formatWeekDay, getCurrentWeekKey, getShanghaiDateKey, shiftDayKey, shiftWeekKey } from "@/lib/week";

const DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const SLOTS = ["12:00 之前", "12:00–15:00", "15:00–18:00", "18:00 之后"];
const EMPTY_SLOTS = Array.from({ length: 28 }, (_, index) => ({ dayIndex: Math.floor(index / 4), slotIndex: index % 4, count: 0, mine: false }));

type User = { id: string; username: string; isAdmin: boolean };
type Slot = { dayIndex: number; slotIndex: number; count: number; mine: boolean };
type Mark = { id: string; user_id: string; nickname: string; location: string; created_at: string };
type Cell = { dayIndex: number; slotIndex: number };
type DetailState = { cell: Cell; items: Mark[]; total: number; nextCursor: string | null; loading: boolean };

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : "服务暂时不可用，请稍后重试。";
}

export default function Home() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [todayWeek, setTodayWeek] = useState(() => getCurrentWeekKey());
  const [todayDate, setTodayDate] = useState(() => getShanghaiDateKey());
  const [weekOffset, setWeekOffset] = useState(0);
  const [dayIndex, setDayIndex] = useState(0);
  const [slots, setSlots] = useState<Slot[]>(EMPTY_SLOTS);
  const [selected, setSelected] = useState<string[]>([]);
  const [nickname, setNickname] = useState("");
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [sessionUnavailable, setSessionUnavailable] = useState(false);
  const [online, setOnline] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const weekKey = shiftWeekKey(todayWeek, weekOffset);
  const isHistorical = weekKey < todayWeek;
  const selectedKeys = useMemo(() => new Set(selected), [selected]);
  const slotController = useRef<AbortController | null>(null);
  const slotGeneration = useRef(0);
  const detailController = useRef<AbortController | null>(null);
  const detailGeneration = useRef(0);
  const detailDialog = useRef<HTMLDialogElement>(null);
  const detailOpener = useRef<HTMLElement | null>(null);
  const currentWeekKey = useRef(weekKey);
  const calendarWeek = useRef(todayWeek);
  const loadedStorageUser = useRef<string | null>(null);
  const formStorageKey = user ? `lai-pai-form:v1:${user.id}` : null;
  const todayDayIndex = weekKey === todayWeek
    ? Math.floor((Date.parse(`${todayDate}T00:00:00Z`) - Date.parse(`${weekKey}T00:00:00Z`)) / 86_400_000)
    : -1;

  const handleUnauthorized = useCallback(() => {
    slotController.current?.abort();
    detailController.current?.abort();
    setUser(null);
    setSlots(EMPTY_SLOTS);
    setSelected([]);
    setDetail(null);
    setNickname("");
    setLocation("");
    router.replace("/login");
  }, [router]);

  const checkSession = useCallback(async () => {
    setReady(false);
    setSessionUnavailable(false);
    setError("");
    try {
      const { user: currentUser } = await apiRequest<{ user: User | null }>("/api/auth/session");
      if (!currentUser) { router.replace("/login"); return; }
      setUser(currentUser);
      setReady(true);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) handleUnauthorized();
      else { setError(messageOf(reason)); setSessionUnavailable(true); setReady(true); }
    }
  }, [handleUnauthorized, router]);

  useEffect(() => { const timer = window.setTimeout(() => void checkSession(), 0); return () => window.clearTimeout(timer); }, [checkSession]);
  useEffect(() => () => { slotController.current?.abort(); detailController.current?.abort(); }, []);
  useEffect(() => { currentWeekKey.current = weekKey; }, [weekKey]);
  useEffect(() => {
    const updateCalendar = () => {
      const nextWeek = getCurrentWeekKey();
      const nextDate = getShanghaiDateKey();
      if (nextWeek !== calendarWeek.current) {
        slotController.current?.abort(); detailController.current?.abort();
        slotGeneration.current += 1; detailGeneration.current += 1;
        setSelected([]); setDetail(null); setSlots(EMPTY_SLOTS); setNotice("");
      }
      calendarWeek.current = nextWeek;
      setTodayWeek(nextWeek); setTodayDate(nextDate);
    };
    const timer = window.setInterval(updateCalendar, 60_000);
    return () => window.clearInterval(timer);
  }, [weekOffset]);
  useEffect(() => {
    const onlineHandler = () => setOnline(true);
    const offlineHandler = () => setOnline(false);
    const onlineCheck = window.setTimeout(() => setOnline(navigator.onLine), 0);
    window.addEventListener("online", onlineHandler);
    window.addEventListener("offline", offlineHandler);
    return () => { window.clearTimeout(onlineCheck); window.removeEventListener("online", onlineHandler); window.removeEventListener("offline", offlineHandler); };
  }, []);
  useEffect(() => {
    if (!formStorageKey) return;
    const timer = window.setTimeout(() => {
      const id = formStorageKey.slice("lai-pai-form:v1:".length);
      try {
        const saved = localStorage.getItem(formStorageKey);
        if (saved) {
          const values = JSON.parse(saved) as { nickname?: string; location?: string };
          setNickname(typeof values.nickname === "string" ? values.nickname : "");
          setLocation(typeof values.location === "string" ? values.location : "");
        }
      } catch { /* Continue with empty form if local storage is unavailable. */ }
      loadedStorageUser.current = id;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [formStorageKey]);
  useEffect(() => {
    if (!formStorageKey || loadedStorageUser.current !== formStorageKey.slice("lai-pai-form:v1:".length)) return;
    try { localStorage.setItem(formStorageKey, JSON.stringify({ nickname, location })); } catch { /* Browser storage may be disabled. */ }
  }, [formStorageKey, location, nickname]);

  const loadSlots = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    slotController.current?.abort();
    const controller = new AbortController();
    slotController.current = controller;
    const generation = ++slotGeneration.current;
    const requestWeek = weekKey;
    try {
      const result = await apiRequest<{ slots: Slot[] }>(`/api/marks?week=${encodeURIComponent(requestWeek)}`, { signal: controller.signal });
      if (generation !== slotGeneration.current || requestWeek !== currentWeekKey.current) return;
      setSlots(result.slots);
      setError("");
      setLastUpdated(new Date().toISOString());
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiError && reason.status === 401) handleUnauthorized();
      else setError(messageOf(reason));
    } finally {
      if (generation === slotGeneration.current && !quiet) setLoading(false);
    }
  }, [handleUnauthorized, weekKey]);

  useEffect(() => {
    if (!ready || !user) return;
    const initial = window.setTimeout(() => void loadSlots(), 0);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible" && navigator.onLine) void loadSlots(true); }, 30_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); slotController.current?.abort(); };
  }, [loadSlots, ready, user]);

  useEffect(() => {
    const element = detailDialog.current;
    if (detail && element && !element.open) element.showModal();
    if (!detail && element?.open) element.close();
    if (!detail && detailOpener.current?.isConnected && detailOpener.current.offsetParent !== null) detailOpener.current.focus();
  }, [detail]);

  function toggleSelected(day: number, slot: number) {
    if (isHistorical || busy) return;
    const key = `${day}-${slot}`;
    setSelected((old) => old.includes(key) ? old.filter((item) => item !== key) : [...old, key]);
  }

  function closeDetails() {
    detailController.current?.abort();
    detailGeneration.current += 1;
    setDetail(null);
  }

  function changeWeekOffset(next: number) {
    if (busy) return;
    slotController.current?.abort(); detailController.current?.abort();
    slotGeneration.current += 1; detailGeneration.current += 1;
    setSelected([]); setDetail(null); setSlots(EMPTY_SLOTS); setNotice("");
    setWeekOffset(next);
  }

  async function openDetails(cell: Cell, opener?: HTMLElement) {
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    const generation = ++detailGeneration.current;
    detailOpener.current = opener ?? null;
    const requestWeek = weekKey;
    setDetail({ cell, items: [], total: 0, nextCursor: null, loading: true });
    try {
      const params = new URLSearchParams({ week: requestWeek, day: String(cell.dayIndex), slot: String(cell.slotIndex) });
      const result = await apiRequest<{ items: Mark[]; total: number; nextCursor: string | null }>(`/api/marks/details?${params}`, { signal: controller.signal });
      if (generation !== detailGeneration.current || requestWeek !== currentWeekKey.current) return;
      setDetail((state) => state?.cell.dayIndex === cell.dayIndex && state.cell.slotIndex === cell.slotIndex ? { ...state, ...result, loading: false } : state);
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiError && reason.status === 401) handleUnauthorized();
      else { setError(messageOf(reason)); closeDetails(); }
    }
  }

  async function loadMoreDetails() {
    if (!detail?.nextCursor) return;
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    const generation = ++detailGeneration.current;
    const selectedDetail = detail;
    const nextCursor = selectedDetail.nextCursor;
    if (!nextCursor) return;
    setDetail((state) => state ? { ...state, loading: true } : null);
    const requestWeek = weekKey;
    const params = new URLSearchParams({ week: requestWeek, day: String(selectedDetail.cell.dayIndex), slot: String(selectedDetail.cell.slotIndex), cursor: nextCursor });
    try {
      const result = await apiRequest<{ items: Mark[]; total: number; nextCursor: string | null }>(`/api/marks/details?${params}`, { signal: controller.signal });
      if (generation !== detailGeneration.current || requestWeek !== currentWeekKey.current) return;
      setDetail((state) => state?.cell.dayIndex === selectedDetail.cell.dayIndex && state.cell.slotIndex === selectedDetail.cell.slotIndex ? { ...state, items: [...state.items, ...result.items], total: result.total, nextCursor: result.nextCursor, loading: false } : state);
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiError && reason.status === 401) handleUnauthorized();
      else { setError(messageOf(reason)); setDetail((state) => state ? { ...state, loading: false } : null); }
    }
  }

  async function submitMarks(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("");
    setError("");
    if (isHistorical) { setError("历史周只可查看，不能修改登记。"); return; }
    if (selected.length === 0) { setError("请先选择至少一个日期和时段。"); return; }
    setBusy(true);
    const submittedWeek = weekKey;
    try {
      const items = selected.map((key) => {
        const [day, slot] = key.split("-").map(Number);
        return { day_index: day, slot_index: slot, nickname, location };
      });
      const result = await postJson<{ accepted: number; changed: number }>("/api/marks", { week_key: submittedWeek, items });
      if (submittedWeek !== currentWeekKey.current) return;
      setNotice(result.changed === 0 ? "这些登记已是最新状态，没有需要更改的内容。" : `已保存 ${result.changed} 条登记。空场地按“皆可”保存。`);
      setSelected([]);
      await loadSlots(true);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) handleUnauthorized();
      else if (submittedWeek === currentWeekKey.current) setError(reason instanceof ApiError && reason.fields
        ? messageOf(reason) + " " + Object.values(reason.fields).flat().join(" ")
        : messageOf(reason));
    } finally {
      setBusy(false);
    }
  }

  async function deleteMark(mark: Mark) {
    if (mark.user_id !== user?.id) return;
    if (!window.confirm(`删除 ${mark.nickname} 的这条登记？`)) return;
    const deletedWeek = weekKey;
    const deletedCell = detail?.cell;
    const detailAtDelete = detailGeneration.current;
    setError("");
    try {
      const result = await apiRequest<{ changed: number }>(`/api/marks/${mark.id}`, { method: "DELETE" });
      if (deletedWeek !== currentWeekKey.current) return;
      setNotice(result.changed ? "已删除这条登记。" : "这条登记已不存在或已被删除。");
      await loadSlots(true);
      if (deletedCell && detailGeneration.current === detailAtDelete) await openDetails(deletedCell);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) handleUnauthorized();
      else if (deletedWeek === currentWeekKey.current) setError(messageOf(reason));
    }
  }

  async function signOut() {
    setLoggingOut(true);
    try { await postJson("/api/auth/logout", {}); router.replace("/login"); router.refresh(); }
    catch (reason) { setError(messageOf(reason)); setLoggingOut(false); }
  }

  function cell(day: number, slot: number) {
    const data = slots[day * 4 + slot] ?? EMPTY_SLOTS[day * 4 + slot];
    const key = `${day}-${slot}`;
    const isSelected = selectedKeys.has(key);
    return (
      <td key={key} className={`border border-slate-200 p-2 align-top ${isSelected ? "bg-blue-50" : "bg-white"}`}>
        <div className="flex min-h-24 flex-col items-stretch gap-2">
          <button type="button" disabled={data.count === 0} onClick={(event) => void openDetails({ dayIndex: day, slotIndex: slot }, event.currentTarget)}
            aria-label={`${DAYS[day]} ${SLOTS[slot]}，${data.count} 条登记，查看详情`}
            className="min-h-11 rounded-md bg-slate-100 px-2 text-sm font-medium text-slate-700 hover:bg-slate-200 disabled:cursor-default disabled:opacity-50">
            {data.count === 0 ? "暂无登记" : `查看 ${data.count} 条`}
          </button>
          <button type="button" aria-pressed={isSelected} disabled={isHistorical || busy} onClick={() => toggleSelected(day, slot)}
            className={`min-h-11 rounded-md border px-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${isSelected ? "border-blue-700 bg-blue-700 text-white" : "border-blue-200 bg-white text-blue-800 hover:bg-blue-50"}`}>
            {isHistorical ? "历史只读" : isSelected ? "已选择" : "选择时段"}
          </button>
          {data.mine && <span className="text-center text-xs text-emerald-700">你已登记</span>}
        </div>
      </td>
    );
  }

  if (!ready) return <main className="p-8 text-center text-slate-600">正在验证登录状态…</main>;
  if (!user) return <main className="mx-auto mt-16 max-w-lg rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm"><h1 className="text-xl font-bold">暂时无法验证登录状态</h1><p role="alert" className="mt-2 text-sm text-rose-800">{error || "请重新尝试连接服务。"}</p><button type="button" onClick={() => void checkSession()} className="mt-4 min-h-11 rounded-lg bg-blue-700 px-5 font-semibold text-white">{sessionUnavailable ? "重新连接" : "重试"}</button><a href="/login" className="ml-3 inline-flex min-h-11 items-center px-3 text-sm font-semibold text-blue-800 underline">前往登录</a></main>;

  return (
    <main className="mx-auto max-w-7xl px-3 py-5 sm:px-6 sm:py-8">
      <header className="mb-6 flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div>
          <p className="text-sm font-medium text-blue-700">共享登记表</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">来牌</h1>
          <p className="mt-1 text-sm text-slate-500">{weekKey} 至 {shiftDayKey(weekKey, 6)} · Asia/Shanghai 周一开始</p>
        </div>
        <nav aria-label="账户导航" className="flex flex-wrap items-center gap-2">
          <span className="mr-1 rounded-full bg-slate-100 px-3 py-2 text-sm font-medium">{user.username}{user.isAdmin ? " · 管理员" : ""}</span>
          {user.isAdmin && <Link href="/admin" className="min-h-11 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold hover:bg-slate-50">管理</Link>}
          <button type="button" disabled={loggingOut} onClick={() => void signOut()} className="min-h-11 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold hover:bg-slate-50 disabled:opacity-50">{loggingOut ? "正在退出…" : "退出"}</button>
        </nav>
      </header>

      <section className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
        <div>
          <h2 className="font-semibold">{weekOffset === 0 ? "本周安排" : weekOffset < 0 ? `${Math.abs(weekOffset)} 周前` : `${weekOffset} 周后`}</h2>
          <p className="text-sm text-slate-500">{isHistorical ? "历史周只可查看，不能修改登记。" : "选择时段填写登记；查看详情与选择登记分开操作。"}</p>
        </div>
        <div className="flex gap-2">
          <button type="button" disabled={weekOffset <= -8 || busy} onClick={() => changeWeekOffset(weekOffset - 1)} className="min-h-11 rounded-lg border border-slate-300 px-4 font-medium disabled:opacity-40">上一周</button>
          <button type="button" disabled={weekOffset >= 4 || busy} onClick={() => changeWeekOffset(weekOffset + 1)} className="min-h-11 rounded-lg border border-slate-300 px-4 font-medium disabled:opacity-40">下一周</button>
          {weekOffset !== 0 && <button type="button" disabled={busy} onClick={() => changeWeekOffset(0)} className="min-h-11 rounded-lg bg-blue-50 px-4 font-medium text-blue-800">回到本周</button>}
        </div>
      </section>

      {!online && <p role="status" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">当前离线，已显示最近加载的数据；网络恢复后可刷新。</p>}
      <div className="mb-3 flex flex-wrap items-center justify-end gap-3 text-xs text-slate-500"><span>{lastUpdated ? `最近更新 ${new Intl.DateTimeFormat("zh-CN", { timeStyle: "short" }).format(new Date(lastUpdated))}` : "尚未成功刷新"}</span><button type="button" disabled={loading || !online} onClick={() => void loadSlots()} className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 disabled:opacity-50">{loading ? "刷新中…" : "手动刷新"}</button></div>
      {error && <p role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</p>}
      {notice && <p role="status" className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</p>}

      <section aria-label="每周可预约时间" className="mb-6 rounded-xl border border-slate-200 bg-white p-3 shadow-sm sm:p-5">
        {loading ? <p className="py-12 text-center text-slate-500">正在加载安排…</p> : <>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[900px] border-collapse" aria-label="本周七天四个时段登记表">
              <thead><tr><th className="w-32 border border-slate-200 bg-slate-50 p-3 text-left text-sm">时段</th>{DAYS.map((day, index) => <th key={day} className={`border border-slate-200 p-3 text-center text-sm ${todayDayIndex === index ? "bg-blue-50 text-blue-900" : "bg-slate-50"}`}>{day}{todayDayIndex === index && <span className="ml-1 text-xs">今天</span>}<span className="mt-1 block font-normal text-slate-500">{formatWeekDay(weekKey, index)}</span></th>)}</tr></thead>
              <tbody>{SLOTS.map((slot, slotIndex) => <tr key={slot}><th scope="row" className="border border-slate-200 bg-slate-50 p-3 text-left text-sm font-semibold">{slot}</th>{DAYS.map((_, day) => cell(day, slotIndex))}</tr>)}</tbody>
            </table>
          </div>
          <div className="md:hidden">
            <div className="mb-3 grid grid-cols-4 gap-1 sm:grid-cols-7">
              {DAYS.map((day, index) => <button key={day} type="button" aria-pressed={dayIndex === index} onClick={() => setDayIndex(index)} className={`min-h-12 rounded-lg border px-1 text-xs font-semibold ${dayIndex === index ? "border-blue-700 bg-blue-700 text-white" : todayDayIndex === index ? "border-blue-200 bg-blue-50 text-blue-900" : "border-slate-200 bg-white text-slate-700"}`}>
                {day}{todayDayIndex === index && <span aria-label="今天"> ·</span>}<span className={`mt-0.5 block text-[11px] font-normal ${dayIndex === index ? "text-blue-100" : "text-slate-500"}`}>{formatWeekDay(weekKey, index)}</span>
              </button>)}
            </div>
            <div className="space-y-2">
              {SLOTS.map((slot, slotIndex) => {
                const data = slots[dayIndex * 4 + slotIndex] ?? EMPTY_SLOTS[dayIndex * 4 + slotIndex];
                const key = `${dayIndex}-${slotIndex}`;
                const isSelected = selectedKeys.has(key);
                return <article key={slot} className={`rounded-lg border p-3 ${isSelected ? "border-blue-400 bg-blue-50" : "border-slate-200 bg-white"}`}>
                  <div className="mb-2 flex items-start justify-between gap-3"><h3 className="font-semibold">{slot}</h3><span className="whitespace-nowrap text-sm text-slate-500">{data.count} 条{data.mine ? " · 你已登记" : ""}</span></div>
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" disabled={data.count === 0} onClick={(event) => void openDetails({ dayIndex, slotIndex }, event.currentTarget)} className="min-h-11 rounded-md bg-slate-100 px-3 text-sm font-medium disabled:opacity-50">查看详情</button>
                    <button type="button" aria-pressed={isSelected} disabled={isHistorical || busy} onClick={() => toggleSelected(dayIndex, slotIndex)} className={`min-h-11 rounded-md border px-3 text-sm font-semibold disabled:opacity-40 ${isSelected ? "border-blue-700 bg-blue-700 text-white" : "border-blue-200 text-blue-800"}`}>{isHistorical ? "历史只读" : isSelected ? "已选择" : "选择时段"}</button>
                  </div>
                </article>;
              })}
            </div>
          </div>
        </>}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
          <div><h2 className="text-lg font-bold">填写登记</h2><p className="mt-1 text-sm text-slate-500">已选 {selected.length} 个时段；一次提交将使用相同昵称和场地。</p>{isHistorical && <p className="mt-1 text-sm font-medium text-amber-800">历史周为只读。</p>}</div>
          {selected.length > 0 && <button type="button" disabled={busy || isHistorical} onClick={() => setSelected([])} className="min-h-10 px-2 text-sm text-slate-600 underline disabled:opacity-40">清除选择</button>}
        </div>
        {selected.length > 0 && <div className="mb-4 flex flex-wrap gap-1.5" aria-label="选择摘要">{selected.map((key) => {
          const [day, slot] = key.split("-").map(Number);
          return <span key={key} className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-900">{DAYS[day]} {formatWeekDay(weekKey, day)} · {SLOTS[slot]}</span>;
        })}</div>}
        <form onSubmit={submitMarks} className="grid gap-3 md:grid-cols-[1fr_1.4fr_auto] md:items-end">
          <div><label htmlFor="nickname" className="mb-1.5 block text-sm font-semibold">登记昵称</label><input id="nickname" name="nickname" required maxLength={30} disabled={busy || isHistorical} value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="填写其他人能识别的昵称" className="min-h-12 w-full rounded-lg border border-slate-300 px-3 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-100" /></div>
          <div><label htmlFor="location" className="mb-1.5 block text-sm font-semibold">所在场地 <span className="font-normal text-slate-500">（选填）</span></label><input id="location" name="location" maxLength={100} disabled={busy || isHistorical} value={location} onChange={(event) => setLocation(event.target.value)} aria-describedby="location-help" placeholder="留空表示场地皆可" className="min-h-12 w-full rounded-lg border border-slate-300 px-3 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-100" /><p id="location-help" className="mt-1 text-xs text-slate-500">场地可以留空，保存后显示“皆可”。长场地名称会自动换行。</p></div>
          <button disabled={busy || isHistorical || selected.length === 0} className="min-h-12 rounded-lg bg-blue-700 px-6 font-semibold text-white hover:bg-blue-800 disabled:opacity-60">{busy ? "正在保存…" : "保存登记"}</button>
        </form>
      </section>

      {detail && <dialog ref={detailDialog} aria-labelledby="detail-title" onCancel={(event) => { event.preventDefault(); closeDetails(); }} onClick={(event) => { if (event.target === event.currentTarget) closeDetails(); }} className="fixed inset-x-0 bottom-0 top-auto m-0 max-h-[88dvh] w-full max-w-xl overflow-y-auto rounded-t-2xl border-0 bg-white p-4 shadow-xl backdrop:bg-slate-950/45 sm:inset-0 sm:m-auto sm:rounded-2xl sm:p-6">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div><h2 id="detail-title" className="text-lg font-bold">{DAYS[detail.cell.dayIndex]} {SLOTS[detail.cell.slotIndex]} 登记详情</h2><p className="mt-1 text-sm text-slate-500">{formatWeekDay(weekKey, detail.cell.dayIndex)} · 共 {detail.total} 条</p></div>
            <button type="button" autoFocus onClick={closeDetails} aria-label="关闭详情" className="min-h-11 min-w-11 rounded-lg border border-slate-300 text-xl">×</button>
          </div>
          {detail.items.length === 0 && !detail.loading ? <p className="py-8 text-center text-slate-500">暂无登记。</p> : <div className="space-y-2">
            {detail.items.map((mark) => <article key={mark.id} className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="min-w-0"><h3 className="break-words font-semibold">{mark.nickname}</h3><p className="mt-1 break-words text-sm text-slate-600">场地：{mark.location?.trim() || "皆可"}</p></div>
              {mark.user_id === user.id && !isHistorical && <button type="button" onClick={() => void deleteMark(mark)} className="min-h-11 shrink-0 rounded-lg border border-rose-200 px-3 text-sm font-semibold text-rose-800 hover:bg-rose-50">删除</button>}
            </article>)}
          </div>}
          {detail.loading && <p className="py-4 text-center text-sm text-slate-500">正在加载…</p>}
          {detail.nextCursor && !detail.loading && <button type="button" onClick={() => void loadMoreDetails()} className="mt-3 min-h-11 w-full rounded-lg border border-slate-300 font-medium">加载更多</button>}
          <p className="mt-4 text-xs text-slate-500">登录用户名、手机号和邮箱不会显示在这里。</p>
      </dialog>}
    </main>
  );
}
