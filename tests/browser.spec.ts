import { expect, test, type Page, type Route } from "@playwright/test";

type Slot = { dayIndex: number; slotIndex: number; count: number; mine: boolean };
const user = { id: "11111111-1111-4111-8111-111111111111", username: "player_01", isAdmin: false };
const admin = { id: "22222222-2222-4222-8222-222222222222", username: "admin_01", isAdmin: true };
const ok = (data: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(data) });
const emptySlots = (): Slot[] => Array.from({ length: 28 }, (_, index) => ({ dayIndex: Math.floor(index / 4), slotIndex: index % 4, count: 0, mine: false }));

async function mockHome(page: Page, options: { detailCounts?: boolean; onSave?: (route: Route, count: number) => Promise<void> } = {}) {
  await page.route("**/api/auth/session", (route) => route.fulfill(ok({ user })));
  let saves = 0;
  await page.route("**/api/marks?*", (route) => {
    const slots = emptySlots();
    if (options.detailCounts) { slots[0].count = 1; slots[4].count = 1; }
    return route.fulfill(ok({ weekKey: new URL(route.request().url()).searchParams.get("week"), slots }));
  });
  await page.route("**/api/marks", async (route) => {
    if (route.request().method() !== "POST") return route.fulfill(ok({ error: "unexpected" }, 405));
    saves += 1;
    if (options.onSave) return options.onSave(route, saves);
    return route.fulfill(ok({ accepted: 1, changed: 1 }));
  });
  await page.route("**/api/auth/logout", (route) => route.fulfill(ok({ error: { message: "logout temporarily unavailable" } }, 503)));
}

function shiftWeek(week: string, offset: number): string {
  const date = new Date(`${week}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset * 7);
  return date.toISOString().slice(0, 10);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("registration shows Unicode-codepoint and backend field errors without exposing contact details", async ({ page }) => {
  await page.route("**/api/auth/register", (route) => route.fulfill(ok({ error: { code: "invalid_fields", message: "注册信息无效。", fields: { password: ["模拟后端密码错误"] } } }, 422)));
  await page.goto("/login");
  await page.getByRole("button", { name: "还没有账号？创建一个" }).click();
  await page.getByLabel("用户名").fill("guest_01");
  await page.getByLabel("密码").fill("A!😀😀😀");
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page.getByText("密码至少 8 位。", { exact: true })).toBeVisible();

  await page.getByLabel("密码").fill("A!😀😀😀😀😀😀");
  await page.getByRole("button", { name: "注册并登录" }).click();
  await expect(page.getByText("模拟后端密码错误", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/);
  await expect(page.locator("body")).not.toContainText(/\b\d{7,}\b/);
});

test("home retains failed entry values, saves a blank location, and stays signed in after logout failure", async ({ page }) => {
  let submitted: Record<string, unknown> | undefined;
  await mockHome(page, { onSave: async (route, count) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    if (count === 1) return route.fulfill(ok({ error: { code: "invalid_fields", message: "登记有误。", fields: { items: ["场地格式需要调整"] } } }, 422));
    return route.fulfill(ok({ accepted: 1, changed: 1 }));
  } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "填写登记" })).toBeVisible();
  await page.getByRole("button", { name: "选择时段" }).first().click();
  await page.getByLabel("登记昵称").fill("小林");
  await page.getByLabel(/所在场地/).fill("");
  await page.getByRole("button", { name: "保存登记" }).click();
  await expect(page.locator("main > p[role=alert]")).toContainText("场地格式需要调整");
  await expect(page.getByLabel("登记昵称")).toHaveValue("小林");
  await expect(page.getByRole("button", { name: "已选择" })).toBeVisible();
  await page.getByRole("button", { name: "保存登记" }).click();
  await expect(page.getByRole("status")).toContainText("已保存 1 条登记");
  const items = submitted?.items as Array<{ nickname: string; location: string }>;
  expect(items[0]).toMatchObject({ nickname: "小林", location: "" });
  await page.getByRole("button", { name: "退出" }).click();
  await expect(page.locator("main > p[role=alert]")).toContainText("logout temporarily unavailable");
  await expect(page.getByText("player_01", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test("delayed prior-week and prior-cell responses do not replace current view", async ({ page }) => {
  await page.route("**/api/auth/session", (route) => route.fulfill(ok({ user })));
  const hold = deferred();
  const oldWeekStarted = deferred();
  const firstCellStarted = deferred();
  let currentWeek = "";
  let heldWeek = "";
  await page.route("**/api/marks?*", async (route) => {
    const requested = new URL(route.request().url()).searchParams.get("week") ?? "";
    if (requested === heldWeek && heldWeek) {
      oldWeekStarted.resolve();
      await hold.promise;
    }
    const slots = emptySlots();
    slots[0].count = 1; slots[4].count = 1;
    try { await route.fulfill(ok({ weekKey: requested, slots })); } catch { /* The page may have aborted the stale request. */ }
  });
  await page.route("**/api/marks/details?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const day = params.get("day");
    if (day === "0") {
      firstCellStarted.resolve();
      await holdCell.promise;
    }
    try {
      await route.fulfill(ok({ items: [{ id: day === "1" ? "66666666-6666-4666-8666-666666666666" : "77777777-7777-4777-8777-777777777777", user_id: user.id, nickname: day === "1" ? "周二登记" : "周一登记", location: "皆可", created_at: "2026-09-24T00:00:00.000000+00:00" }], total: 1, nextCursor: null }));
    } catch { /* An aborted stale request is expected in this test. */ }
  });
  const holdCell = deferred();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "填写登记" })).toBeVisible();
  const range = await page.getByText(/Asia\/Shanghai 周一开始/).innerText();
  currentWeek = range.slice(0, 10);
  heldWeek = shiftWeek(currentWeek, -1);
  await page.getByRole("button", { name: "上一周" }).click();
  await oldWeekStarted.promise;
  await page.getByRole("button", { name: "回到本周" }).click();
  await expect(page.getByText(new RegExp(`${currentWeek} 至`))).toBeVisible();
  hold.resolve();
  await expect(page.getByText(new RegExp(`${currentWeek} 至`))).toBeVisible();
  await page.getByRole("button", { name: /周一 12:00 之前.*查看详情/ }).click();
  await firstCellStarted.promise;
  await page.getByRole("button", { name: "关闭详情" }).click();
  await page.getByRole("button", { name: /周二 12:00 之前.*查看详情/ }).click();
  await expect(page.getByRole("heading", { name: /周二.*登记详情/ })).toBeVisible();
  holdCell.resolve();
  await expect(page.getByRole("heading", { name: /周二.*登记详情/ })).toBeVisible();
});

test("admin reset dialog displays backend errors, clears secrets on cancel, and returns focus", async ({ page }) => {
  await page.route("**/api/auth/session", (route) => route.fulfill(ok({ user: admin })));
  const target = { id: "33333333-3333-4333-8333-333333333333", username: "member_01", role: "user", status: "active", created_at: "2026-09-24T00:00:00Z", deleted_at: null, active_marks: 2 };
  await page.route("**/api/admin/users**", (route) => route.fulfill(ok({ items: [target], total: 1, nextCursor: null })));
  await page.route("**/api/admin/audit**", (route) => route.fulfill(ok({ items: [], total: 0, nextCursor: null })));
  await page.route("**/api/admin/users/*", (route) => route.fulfill(ok({ error: { code: "invalid_fields", message: "新密码不符合要求。", fields: { password: ["需要大写字母和特殊符号"] } } }, 422)));
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "管理员", exact: true })).toBeVisible();
  const resetButton = page.getByRole("button", { name: "重置密码" });
  await resetButton.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.getByLabel("新密码").fill("A!123456");
  await page.getByLabel("操作原因（必填）").fill("用户申请重置");
  await page.getByRole("button", { name: "确认重置密码" }).click();
  await expect(dialog.getByRole("alert")).toContainText("需要大写字母和特殊符号");
  await dialog.getByRole("button", { name: "关闭确认框" }).click();
  await expect(resetButton).toBeFocused();
  await resetButton.click();
  await expect(page.getByLabel("新密码")).toHaveValue("");
});

test("admin restores a record on page two after more than 30 deleted records", async ({ page }) => {
  await page.route("**/api/auth/session", (route) => route.fulfill(ok({ user: admin })));
  await page.route("**/api/admin/marks?*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    const state = params.get("state");
    const cursor = params.get("cursor");
    if (state === "active") return route.fulfill(ok({ items: [], total: 0, activeCount: 0, nextCursor: null, state }));
    if (!cursor) {
      const items = Array.from({ length: 30 }, (_, i) => ({ id: `44444444-4444-4444-8444-${String(i + 1).padStart(12, "0")}`, user_id: user.id, username: user.username, day_index: 0, slot_index: 0, nickname: `已删除登记 ${i + 1}`, location: "皆可", created_at: "2026-09-24T00:00:00.000001+00:00", deleted_at: "2026-09-24T01:00:00+00:00" }));
      return route.fulfill(ok({ items, total: 31, activeCount: 0, nextCursor: "cursor-30", state }));
    }
    const item = { id: "55555555-5555-4555-8555-555555555555", user_id: user.id, username: user.username, day_index: 0, slot_index: 1, nickname: "最后一条登记", location: "皆可", created_at: "2026-09-24T00:00:00.000000+00:00", deleted_at: "2026-09-24T01:00:00+00:00" };
    return route.fulfill(ok({ items: [item], total: 31, activeCount: 0, nextCursor: null, state }));
  });
  let restoreIds: string[] = [];
  await page.route("**/api/admin/marks", async (route) => {
    const data = route.request().postDataJSON() as { action: string; mark_ids: string[] };
    restoreIds = data.mark_ids;
    return route.fulfill(ok({ affected: 1 }));
  });
  await page.goto("/admin/marks");
  await expect(page.getByRole("heading", { name: "登记管理" })).toBeVisible();
  await page.getByRole("button", { name: "已删除", exact: true }).click();
  await expect(page.getByText("已删除登记 1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "加载更多" }).click();
  await expect(page.getByText("最后一条登记", { exact: true })).toBeVisible();
  await page.locator("label").filter({ hasText: "最后一条登记" }).locator("input").check();
  await page.getByRole("button", { name: "恢复所选登记" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.getByLabel("操作原因").fill("用户登记遗漏恢复");
  await page.getByRole("button", { name: "确认处理 1 条" }).click();
  await expect(page.getByRole("status")).toContainText("实际影响 1 条登记");
  expect(restoreIds).toEqual(["55555555-5555-4555-8555-555555555555"]);
});

test("real Next HTTP handlers enforce origin, body size, authentication, cookies and CSP", async ({ request }) => {
  const response = await request.get("/");
  expect(response.status()).toBe(200);
  const csp = response.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("script-src 'self' 'nonce-");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).not.toContain("unsafe-eval");
  const cspNonce = csp.match(/script-src[^;]*'nonce-([^']+)'/)?.[1];
  expect(cspNonce).toBeTruthy();
  const html = await response.text();
  const scriptTags = html.match(/<script\b/gi) ?? [];
  const scriptNonces = [...html.matchAll(/<script\b[^>]*\bnonce="([^"]+)"/gi)].map((match) => match[1]);
  expect(scriptNonces).toHaveLength(scriptTags.length);
  expect(new Set(scriptNonces)).toEqual(new Set([cspNonce]));
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["strict-transport-security"]).toContain("max-age=63072000");

  const repeatedPage = await request.get("/");
  const repeatedCsp = repeatedPage.headers()["content-security-policy"] ?? "";
  const repeatedNonce = repeatedCsp.match(/script-src[^;]*'nonce-([^']+)'/)?.[1];
  expect(repeatedPage.status()).toBe(200);
  expect(repeatedNonce).toBeTruthy();
  expect(repeatedNonce).not.toBe(cspNonce);

  const badOrigin = await request.post("/api/auth/register", { headers: { origin: "https://attacker.invalid", "content-type": "application/json" }, data: "{}" });
  expect(badOrigin.status()).toBe(403);
  const wrongType = await request.post("/api/auth/register", { headers: { origin: "http://127.0.0.1:3400", "content-type": "text/plain" }, data: "{}" });
  expect(wrongType.status()).toBe(415);
  const tooLarge = await request.post("/api/auth/register", { headers: { origin: "http://127.0.0.1:3400", "content-type": "application/json" }, data: JSON.stringify({ payload: "x".repeat(17_000) }) });
  expect(tooLarge.status()).toBe(413);
  const privateRead = await request.get("/api/marks?week=2026-09-21");
  expect(privateRead.status()).toBe(401);
  const adminRead = await request.get("/api/admin/users");
  expect(adminRead.status()).toBe(401);
  const session = await request.get("/api/auth/session");
  expect(session.status()).toBe(200);
  expect(session.headers()["cache-control"]).toContain("no-store");
  expect((await session.json()).user).toBeNull();
  expect(session.headers()["set-cookie"]).toContain("HttpOnly");
});
