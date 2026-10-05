import { expect, test, type Page, type Request } from "@playwright/test";
import { installSettingsApiRoutes } from "./support/settings-api";
import { expectMinimumTouchTargets, expectNoHorizontalOverflow } from "./support/layout-assertions";

const secret = "synthetic-private-tenant-url-stack";

test.beforeEach(async ({ page, baseURL }) => {
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(baseURL!).origin) return route.abort("blockedbyclient");
    if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 404, json: { message: "unconfigured mock API" } });
    return route.continue();
  });
});

test("lazy settings failure keeps eager account escape and the single logout owner", async ({ page }) => {
  const api = await installSettingsApiRoutes(page, "viewer");
  await page.route("**/src/features/settings/SettingsShell.tsx*", route => route.abort("failed"));
  await page.goto("/settings?siteId=site-1");
  await expect(page.getByText("화면을 불러오지 못했습니다.", { exact: true })).toBeVisible();
  const account = page.getByRole("region", { name: "내 계정" });
  await expect(account).toBeVisible();
  expect(api.logoutRequests).toBe(0);
  await account.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(page.getByRole("heading", { name: "킨다 로그인" })).toBeVisible();
  expect(api.logoutRequests).toBe(1);
  expect(api.requests.filter(request => /commands.*POST|POST .*commands/.test(request))).toHaveLength(0);
});

test("browser offline at boot shows recovery and resumes the real shell when connectivity returns", async ({ page, context }) => {
  const api = await installSettingsApiRoutes(page, "admin");
  // Only the static app resources are delivered by the fixture while the real browser is offline.
  // navigator.onLine and React Query's online manager remain browser-owned; no online-state mock is used.
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).pathname.startsWith("/api/")) return route.fallback();
    return route.fulfill({ response: await route.fetch() });
  });
  await context.setOffline(true);
  await page.goto("/monitoring?siteId=site-1");
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  await expectRecovery(page, "서비스에 연결할 수 없습니다");
  await expect(page.getByRole("heading", { name: "킨다 로그인" })).toHaveCount(0);
  expect(api.requests.filter((request) => request === "GET /auth/me")).toHaveLength(0);
  await context.setOffline(false);
  await expect(page.getByRole("button", { name: "맵 선택" })).toBeVisible();
  expect(api.requests.filter((request) => request === "GET /auth/me")).toHaveLength(1);
});

async function expectRecovery(page: Page, title: string) {
  await expect(page.getByRole("heading", { name: title })).toBeFocused();
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(secret);
  await expectNoHorizontalOverflow(page);
  await expectMinimumTouchTargets(page, "[data-recovery-actions]");
}

for (const width of [1440, 1024, 390, 320]) {
  test(`503 exhausts two retries and keyboard manual retry restores the real customer shell at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await installSettingsApiRoutes(page, "admin");
    let available = false;
    let authRequests = 0;
    const starts: Request[] = [];
    const completions: Array<{ request: Request; status: number; order: number }> = [];
    const failures: Array<{ request: Request; error: string | undefined; order: number }> = [];
    let eventOrder = 0;
    page.on("request", request => { if (request.url().endsWith("/api/auth/me")) starts.push(request); });
    page.on("response", response => {
      if (!response.url().endsWith("/api/auth/me")) return;
      authRequests++;
      completions.push({ request: response.request(), status: response.status(), order: eventOrder++ });
    });
    page.on("requestfailed", request => {
      if (request.url().endsWith("/api/auth/me")) failures.push({ request, error: request.failure()?.errorText, order: eventOrder++ });
    });
    const expectOnlyStrictModeBootCancellation = () => {
      // Genuine dev StrictMode cancels the first observer transport before its
      // response, then remounts. Count completed retry responses separately;
      // every raw start must still be explained, never discarded from budget.
      expect(failures).toHaveLength(1);
      expect(failures[0].error).toBe("net::ERR_ABORTED");
      expect(failures[0].request).toBe(starts[0]);
      expect(failures[0].order).toBeLessThan(completions[0].order);
      expect(completions[0].status).toBe(503);
      expect(starts).toHaveLength(authRequests + failures.length);
      expect(starts.every(request => request.method() === "GET")).toBe(true);
    };
    await page.route("**/api/auth/me", async (route) => {
      if (available) return route.fallback();
      return route.fulfill({ status: 503, json: { message: secret } });
    });
    await page.goto("/monitoring?siteId=site-1");
    await expectRecovery(page, "서비스에 연결할 수 없습니다");
    expect(authRequests).toBe(3);
    expect(completions.map(item => item.status)).toEqual([503, 503, 503]);
    expectOnlyStrictModeBootCancellation();
    await expect(page.getByRole("heading", { name: "킨다 로그인" })).toHaveCount(0);
    available = true;
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "다시 시도" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "맵 선택" })).toBeVisible();
    expect(authRequests).toBe(4);
    expect(completions.map(item => item.status)).toEqual([503, 503, 503, 200]);
    expectOnlyStrictModeBootCancellation();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}

test("network exhaustion recovers without reloading the document", async ({ page }) => {
  await installSettingsApiRoutes(page, "admin");
  let available = false;
  let requests = 0;
  await page.route("**/api/auth/me", (route) => {
    requests++;
    return available ? route.fallback() : route.abort("connectionrefused");
  });
  await page.goto("/monitoring?siteId=site-1");
  await expectRecovery(page, "서비스에 연결할 수 없습니다");
  expect(requests).toBe(3);
  await page.evaluate(() => { (window as Window & { recoverySentinel?: string }).recoverySentinel = "same-document"; });
  available = true;
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByRole("button", { name: "맵 선택" })).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { recoverySentinel?: string }).recoverySentinel)).toBe("same-document");
  expect(requests).toBe(4);
});

test("401 uses the existing login without retry", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/auth/me", (route) => {
    requests++;
    return route.fulfill({ status: 401, json: { message: secret } });
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "킨다 로그인" })).toBeVisible();
  expect(requests).toBe(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("403 relogin clears only tenant drafts and reaches login even when logout fails", async ({ page }) => {
  const requests: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem("led-floor-draft:v1:old-tenant", "private draft");
    localStorage.setItem("unrelated-preference", "keep");
  });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    // Vite의 /src/api/*.ts 모듈도 glob에 맞으므로 실제 same-origin API 경로만 대체한다.
    if (!path.startsWith("/api/")) return route.continue();
    requests.push(path);
    return route.fulfill({ status: route.request().url().endsWith("/auth/me") ? 403 : 503, json: { message: secret } });
  });
  await page.goto("/settings");
  await expectRecovery(page, "다시 로그인이 필요합니다");
  expect(requests).toEqual(["/api/auth/me"]);
  expect(await page.evaluate(() => localStorage.getItem("led-floor-draft:v1:old-tenant"))).toBeNull();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "다시 로그인" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "킨다 로그인" })).toBeVisible();
  expect(requests).toEqual(["/api/auth/me", "/api/auth/logout"]);
  expect(await page.evaluate(() => localStorage.getItem("unrelated-preference"))).toBe("keep");
});

for (const action of ["reload", "relogin"] as const) {
  test(`real lazy customer shell rejection has accessible ${action} recovery`, async ({ page }) => {
    await installSettingsApiRoutes(page, "admin");
    let blockChunk = true;
    let chunkRequests = 0;
    await page.route("**/src/features/shells/CustomerShell.tsx*", (route) => {
      chunkRequests++;
      return blockChunk ? route.abort("failed") : route.continue();
    });
    await page.goto("/monitoring?siteId=site-1");
    await expectRecovery(page, "화면을 불러오지 못했습니다");
    expect(chunkRequests).toBe(1);
    if (action === "reload") {
      await page.evaluate(() => { (window as Window & { recoverySentinel?: boolean }).recoverySentinel = true; });
      blockChunk = false;
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "새로고침" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: "맵 선택" })).toBeVisible();
      expect(chunkRequests).toBe(2);
      expect(await page.evaluate(() => (window as Window & { recoverySentinel?: boolean }).recoverySentinel)).toBeUndefined();
    } else {
      await page.route("**/api/auth/logout", (route) => route.fulfill({ status: 503, json: { message: secret } }));
      await page.getByRole("button", { name: "다시 로그인" }).click();
      await expect(page.getByRole("heading", { name: "킨다 로그인" })).toBeVisible();
      expect(chunkRequests).toBe(1);
      await expect(page.getByRole("alert")).toHaveCount(0);
    }
  });
}
