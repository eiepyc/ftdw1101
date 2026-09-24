"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiRequest, ApiError, postJson } from "@/lib/api";

type LoginState = "login" | "register";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<LoginState>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setFieldErrors({});
    if (mode === "register") {
      if (Array.from(password).length < 8) { setFieldErrors({ password: ["密码至少 8 位。"] }); setBusy(false); return; }
      if (new TextEncoder().encode(password).byteLength > 72) { setFieldErrors({ password: ["新密码最多 72 个 UTF-8 字节。"] }); setBusy(false); return; }
      if (!/[A-Z]/.test(password)) { setFieldErrors({ password: ["密码至少包含一个大写英文字母。"] }); setBusy(false); return; }
      if (!/[!-/:-@[-`{-~]/.test(password)) { setFieldErrors({ password: ["密码至少包含一个特殊符号（如 !、@、#）。"] }); setBusy(false); return; }
    }
    try {
      await postJson(mode === "login" ? "/api/auth/login" : "/api/auth/register", { username, password });
      await apiRequest("/api/auth/session");
      router.replace("/");
      router.refresh();
    } catch (error) {
      if (error instanceof ApiError) { setMessage(error.message); setFieldErrors(error.fields ?? {}); }
      else setMessage("服务暂时不可用，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <Link href="/" className="text-sm font-medium text-slate-500 hover:text-slate-800">← 来牌首页</Link>
        <h1 className="mt-6 text-3xl font-bold tracking-tight">来牌</h1>
        <p className="mt-2 text-slate-600">{mode === "login" ? "使用用户名和密码登录。" : "创建账号，加入共享登记表。"}</p>

        <form onSubmit={submit} className="mt-7 space-y-5">
          <div>
            <label htmlFor="username" className="mb-1.5 block text-sm font-semibold">用户名</label>
            <input id="username" name="username" autoComplete="username" required minLength={3} maxLength={24}
              pattern="[A-Za-z0-9_]{3,24}" aria-invalid={Boolean(fieldErrors.username)} aria-describedby="username-help username-error" value={username} onChange={(event) => { setUsername(event.target.value); setFieldErrors((old) => ({ ...old, username: [] })); }}
              className="min-h-12 w-full rounded-lg border border-slate-300 px-3 outline-none transition focus:border-blue-600 focus:ring-2 focus:ring-blue-100" placeholder="3–24 位字母、数字或下划线" />
            <p id="username-help" className="mt-1 text-xs text-slate-500">手机号和邮箱不用于登录，也不会在页面展示。</p>
            {fieldErrors.username?.map((error, index) => <p id="username-error" key={index} className="mt-1 text-sm text-rose-700">{error}</p>)}
          </div>
          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-semibold">密码</label>
            <input id="password" name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"}
              required maxLength={mode === "register" ? 72 : 128} aria-invalid={Boolean(fieldErrors.password)} aria-describedby="password-help password-error"
              value={password} onChange={(event) => { setPassword(event.target.value); setFieldErrors((old) => ({ ...old, password: [] })); }}
              className="min-h-12 w-full rounded-lg border border-slate-300 px-3 outline-none transition focus:border-blue-600 focus:ring-2 focus:ring-blue-100"
              placeholder={mode === "login" ? "输入密码" : "至少 8 个字符，含大写字母和特殊符号"} />
            {mode === "register" && <p id="password-help" className="mt-1 text-xs leading-5 text-slate-500">新密码至少 8 个字符，包含一个大写英文字母和一个特殊符号（如 !、@、#），最多 72 个 UTF-8 字节；不要求小写字母或数字。</p>}
            {fieldErrors.password?.map((error, index) => <p id="password-error" key={index} className="mt-1 text-sm text-rose-700">{error}</p>)}
          </div>
          {mode === "register" && <p className="rounded-lg bg-blue-50 px-3 py-2.5 text-sm leading-5 text-blue-900">每个浏览器设备最多登记 2 个账号。网站使用浏览器中的随机标记计数，不读取硬件信息；清除浏览器数据或更换浏览器会改变计数。</p>}
          {message && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2.5 text-sm text-rose-800">{message}</p>}
          <button disabled={busy} className="min-h-12 w-full rounded-lg bg-blue-700 px-4 font-semibold text-white transition hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:cursor-wait disabled:opacity-60">
            {busy ? "处理中…" : mode === "login" ? "登录" : "注册并登录"}
          </button>
        </form>
        <div className="mt-6 border-t border-slate-100 pt-5 text-center">
          <button type="button" disabled={busy} onClick={() => { setMode(mode === "login" ? "register" : "login"); setMessage(""); }}
            className="min-h-11 px-3 text-sm font-medium text-blue-700 underline-offset-4 hover:underline">
            {mode === "login" ? "还没有账号？创建一个" : "已有账号？返回登录"}
          </button>
        </div>
      </section>
    </main>
  );
}
