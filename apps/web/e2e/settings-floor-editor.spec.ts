import { expect, test } from "@playwright/test";
import {
  expectMinimumTouchTargets,
  expectNoHorizontalOverflow
} from "./support/layout-assertions";
import { installSettingsApiRoutes } from "./support/settings-api";

const responsiveViewports = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 320, height: 740 }
] as const;

test("operator customer routes are blocked and admin floor changes are reflected in monitoring", async ({ browser }) => {
  const operatorPage = await browser.newPage();
  const operatorApi = await installSettingsApiRoutes(operatorPage, "operator");
  await operatorPage.goto("/settings/commissioning?siteId=site-1");
  await expect(operatorPage).toHaveURL(/\/operator\/site-admins$/);
  await expect(operatorPage.getByRole("heading", { name: "현장 관리자 계정" })).toBeVisible();
  expect(operatorApi.requests.filter((request) => request.includes("/sites"))).toEqual([]);

  const adminPage = await browser.newPage();
  const adminApi = await installSettingsApiRoutes(adminPage, "admin");
  await adminPage.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
  await expect(adminPage.getByRole("heading", { name: "B2 도면 편집" })).toBeVisible();
  await expect.poll(() => {
    const latestLease = [...adminApi.editorRequests].reverse().find((request) => request.type === "lease-acquire");
    return latestLease?.type === "lease-acquire" && latestLease.result.editable;
  }).toBe(true);

  await adminPage.getByLabel("B2 편집 캔버스").click({ position: { x: 120, y: 140 } });
  await expect(adminPage.getByRole("complementary", { name: "속성 패널" }).getByRole("heading", { name: "B2-L01" })).toBeVisible();
  await adminPage.getByRole("complementary", { name: "속성 패널" }).getByLabel("X").fill("240");
  await adminPage.getByRole("button", { name: "저장", exact: true }).click();

  await expect(adminPage).toHaveURL(/\/settings\/floor-plans\?siteId=site-1$/);
  await expect.poll(() => adminApi.editorRequests.filter(({ type }) => type === "atomic-save")).toHaveLength(1);

  const save = adminApi.editorRequests.find(({ type }) => type === "atomic-save");
  if (!save || save.type !== "atomic-save") throw new Error("atomic save request was not captured");
  const acquireBeforeSave = [...adminApi.editorRequests].reverse().find((request) => (
    request.type === "lease-acquire" && request.result.editable && request.sequence < save.sequence
  ));
  if (!acquireBeforeSave || acquireBeforeSave.type !== "lease-acquire") throw new Error("lease acquire before save was not captured");
  const { sequence: saveSequence, ...saveRequest } = save;
  expect(saveRequest).toEqual({
    type: "atomic-save",
    payload: {
      expectedRevision: 7,
      leaseToken: acquireBeforeSave.result.token,
      leaseFence: acquireBeforeSave.result.fence,
      fixtureUpdates: [{ id: "fixture-1", x: 240 }],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    }
  });
  expect(acquireBeforeSave).toMatchObject({ type: "lease-acquire", payload: {}, result: { editable: true } });
  expect(acquireBeforeSave.sequence).toBeLessThan(saveSequence);

  await expect.poll(() => adminApi.editorRequests.some((request) => (
    request.type === "lease-release"
    && request.sequence > saveSequence
    && request.payload.token === acquireBeforeSave.result.token
    && request.released
  ))).toBe(true);

  expect(adminApi.fixtureUpdates).toEqual([{ id: "fixture-1", x: 240 }]);

  await adminPage.goto("/monitoring?siteId=site-1");
  const movedFixture = adminPage.getByRole("button", { name: "B2-L01 정상 70%" });
  await expect(movedFixture).toBeVisible();
  await expect(movedFixture).toHaveCSS("--fixture-left", "20%");

  await operatorPage.close();
  await adminPage.close();
});

test("viewer is redirected before editor state and lease requests while mutation fixtures reject changes", async ({ page }) => {
  const api = await installSettingsApiRoutes(page, "viewer");
  await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");

  await expect(page).toHaveURL(/\/settings\/floor-plans\?siteId=site-1$/);
  const floorRow = page.locator(".floor-plan-card").filter({ hasText: "B2" });
  await expect(floorRow).toContainText("도면 등록됨");
  await expect(floorRow.getByRole("link", { name: "B2 도면 편집" })).toHaveCount(0);
  expect(api.requests.filter((path) => path.includes("/editor-state") || path.includes("/editor-lease"))).toEqual([]);

  const status = await page.evaluate(async () => {
    const response = await fetch("/api/floors/floor-1/editor-state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 7, fixtureUpdates: [], objectCreates: [], objectUpdates: [], objectDeletes: [] })
    });
    return response.status;
  });
  expect(status).toBe(403);
});

test("browser lease fixture preserves active tokens across conflict, renewal, and stale release", async ({ page }) => {
  await installSettingsApiRoutes(page, "admin");
  await page.goto("/");

  const outcomes = await page.evaluate(async () => {
    const request = async (path: string, method: string, body: Record<string, unknown>) => {
      const response = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() };
    };
    const payload = {
      expectedRevision: 7,
      fixtureUpdates: [],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    };
    const saveWithoutLease = await request("/api/floors/floor-1/editor-state", "PUT", payload);
    const acquired = await request("/api/floors/floor-1/editor-lease", "POST", {});
    const conflict = await request("/api/floors/floor-1/editor-lease", "POST", {});
    const staleRenewal = await request("/api/floors/floor-1/editor-lease", "POST", { token: "stale-token" });
    const staleRelease = await request("/api/floors/floor-1/editor-lease", "DELETE", { token: "stale-token" });
    const missingRelease = await request("/api/floors/floor-1/editor-lease", "DELETE", {});
    const renewed = await request("/api/floors/floor-1/editor-lease", "POST", { token: acquired.body.token });
    const released = await request("/api/floors/floor-1/editor-lease", "DELETE", { token: acquired.body.token });
    const noHolderRelease = await request("/api/floors/floor-1/editor-lease", "DELETE", { token: acquired.body.token });
    const reacquired = await request("/api/floors/floor-1/editor-lease", "POST", {});
    return { saveWithoutLease, acquired, conflict, staleRenewal, staleRelease, missingRelease, renewed, released, noHolderRelease, reacquired };
  });

  expect(outcomes.saveWithoutLease.status).toBe(409);
  expect(outcomes.acquired.body).toMatchObject({ editable: true });
  expect(outcomes.acquired.body.token).toEqual(expect.any(String));
  expect(outcomes.conflict.body).toMatchObject({ editable: false });
  expect(outcomes.conflict.body).not.toHaveProperty("token");
  expect(outcomes.staleRenewal.body).toMatchObject({ editable: false });
  expect(outcomes.staleRenewal.body).not.toHaveProperty("token");
  expect(outcomes.staleRelease).toEqual({ status: 403, body: { message: "floor editor lease is held by another user" } });
  expect(outcomes.missingRelease).toEqual({ status: 403, body: { message: "floor editor lease is held by another user" } });
  expect(outcomes.renewed.body).toMatchObject({ editable: true, token: outcomes.acquired.body.token });
  expect(outcomes.released.body).toEqual({ released: true });
  expect(outcomes.noHolderRelease).toEqual({ status: 200, body: { released: false } });
  expect(outcomes.reacquired.body).toMatchObject({ editable: true });
  expect(outcomes.reacquired.body.token).not.toBe(outcomes.acquired.body.token);
});

test("settings browser fixture isolates unknown tenant route data", async ({ page }) => {
  await installSettingsApiRoutes(page, "admin");
  await page.goto("/settings/floor-plans?siteId=site-1");

  const status = await page.evaluate(async () => {
    const response = await fetch("/api/sites/site-foreign/dashboard");
    return response.status;
  });
  expect(status).toBe(404);
});

test("dirty editor logout keeps the draft on cancel and logs out only after confirmation", async ({ page }) => {
  const api = await installSettingsApiRoutes(page, "admin");
  await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
  await expect(page.getByRole("heading", { name: "B2 도면 편집" })).toBeVisible();
  await expect.poll(() => {
    const latestLease = [...api.editorRequests].reverse().find((request) => request.type === "lease-acquire");
    return latestLease?.type === "lease-acquire" && latestLease.result.editable;
  }).toBe(true);

  await page.evaluate(() => {
    const key = "__floorEditorDirtySentinel";
    const state = window.history.state ?? {};
    window.history.pushState(
      { ...state, idx: typeof state.idx === "number" ? state.idx + 1 : 1, [key]: "playwright-dirty" },
      "",
      window.location.href
    );
  });

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("저장하지 않은 변경사항");
    await dialog.dismiss();
  });
  await page.getByRole("button", { name: "로그아웃" }).click();

  await expect(page).toHaveURL(/\/settings\/floor-plans\/floor-1\/edit\?siteId=site-1$/);
  expect(api.logoutRequests).toBe(0);
  await expect.poll(async () => page.evaluate(async () => (await fetch("/api/auth/me")).status)).toBe(200);

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("저장하지 않은 변경사항");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "로그아웃" }).click();

  await expect(page.getByRole("heading", { name: "LED Control 로그인" })).toBeVisible();
  expect(api.logoutRequests).toBe(1);
  await expect.poll(async () => page.evaluate(async () => (await fetch("/api/auth/me")).status)).toBe(401);
});

test("desktop settings navigation opens on hover, preserves site scope, and exposes admin links", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installSettingsApiRoutes(page, "admin");
  await page.goto("/monitoring?siteId=site-1");

  const settings = page.getByRole("link", { name: "설정", exact: true });
  await settings.hover();
  await expect(settings).toHaveAttribute("aria-expanded", "true");
  await expect(settings).toHaveAttribute("aria-haspopup", "menu");
  await expect(settings).toHaveAttribute("aria-controls", "settings-navigation-popup");
  await expect(page.getByRole("menu", { name: "설정 메뉴" })).toHaveAttribute("id", "settings-navigation-popup");
  await expect(page.getByRole("menuitem", { name: "비밀번호 변경" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "설정 메뉴" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "도면 관리" }).click();

  await expect(page).toHaveURL(/\/settings\/floor-plans\?siteId=site-1$/);
  await expect(page.getByRole("heading", { name: "도면 관리" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("desktop settings navigation opens on focus and Escape restores focus", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await installSettingsApiRoutes(page, "viewer");
  await page.goto("/monitoring?siteId=site-1");

  const settings = page.getByRole("link", { name: "설정", exact: true });
  await settings.focus();
  await expect(settings).toHaveAttribute("aria-expanded", "true");
  await expect(settings).toHaveAttribute("aria-haspopup", "menu");
  await expect(page.getByRole("menuitem", { name: "도면 관리" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "비밀번호 변경" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await expect(settings).toHaveAttribute("aria-expanded", "false");
  await expect(settings).toBeFocused();
  await expectNoHorizontalOverflow(page);
});

for (const viewport of responsiveViewports.filter(({ width }) => width <= 760)) {
  test(`coarse ${viewport.width}px settings navigation uses an accessible bottom sheet`, async ({ browser, baseURL }) => {
    const page = await browser.newPage({ baseURL, viewport, hasTouch: true, isMobile: true });
    try {
      await installSettingsApiRoutes(page, "admin");
      await page.goto("/monitoring?siteId=site-1");
      const settings = page.getByRole("link", { name: "설정", exact: true });
      await settings.click();

      const menu = page.getByRole("dialog", { name: "설정 메뉴" });
      await expect(menu).toBeVisible();
      await expect(settings).toHaveAttribute("aria-haspopup", "dialog");
      await expect(settings).toHaveAttribute("aria-controls", "settings-navigation-popup");
      await expect(menu).toHaveAttribute("id", "settings-navigation-popup");
      await expect(page).toHaveURL(/\/monitoring\?siteId=site-1$/);
      await expectMinimumTouchTargets(page, ".app-shell", { excludeSpatialMapMarkers: true });
      await expectNoHorizontalOverflow(page);

      await menu.getByRole("link", { name: "도면 관리" }).click();
      await expect(page).toHaveURL(/\/settings\/floor-plans\?siteId=site-1$/);
      await expect(page.getByRole("heading", { name: "도면 관리" })).toBeVisible();
      await expectMinimumTouchTargets(page, ".app-shell");
      await expectNoHorizontalOverflow(page);
    } finally {
      await page.close();
    }
  });
}

for (const viewport of responsiveViewports) {
  test(`floor editor keeps its workspace contract at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const api = await installSettingsApiRoutes(page, "admin");
    await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
    await expect(page.getByRole("heading", { name: "B2 도면 편집" })).toBeVisible();
    await expect.poll(() => {
      const latestLease = [...api.editorRequests].reverse().find((request) => request.type === "lease-acquire");
      return latestLease?.type === "lease-acquire" && latestLease.result.editable;
    }).toBe(true);
    await expect(page.getByRole("button", { name: "리비전 7 복구" })).toBeVisible();
    const editorCanvas = page.locator(".floor-editor-konva-stage canvas").first();
    const editorCanvasBox = await editorCanvas.boundingBox();
    expect(editorCanvasBox).not.toBeNull();
    if (editorCanvasBox) await page.mouse.click(editorCanvasBox.x + 120, editorCanvasBox.y + 140);
    await expect(page.getByRole("complementary", { name: "속성 패널" }).getByRole("heading", { name: "B2-L01" })).toBeVisible();

    const [toolbar, stage, sidePanel] = await Promise.all([
      page.locator(".floor-editor-toolbar").boundingBox(),
      page.locator(".floor-editor-stage").boundingBox(),
      page.locator(".floor-editor-side-panel").boundingBox()
    ]);
    expect(toolbar).not.toBeNull();
    expect(stage).not.toBeNull();
    expect(sidePanel).not.toBeNull();
    if (toolbar && stage && sidePanel) {
      if (viewport.width <= 760) {
        expect(stage.y).toBeGreaterThanOrEqual(toolbar.y + toolbar.height - 1);
        expect(sidePanel.y).toBeGreaterThanOrEqual(stage.y + stage.height - 1);
      } else {
        expect(stage.x).toBeGreaterThanOrEqual(toolbar.x + toolbar.width - 1);
        expect(sidePanel.x).toBeGreaterThanOrEqual(stage.x + stage.width - 1);
      }
    }

    await expectNoHorizontalOverflow(page);
    if (viewport.width <= 760) {
      await expectMinimumTouchTargets(page, ".app-shell");
    }
  });
}

for (const viewport of responsiveViewports.filter(({ width }) => width === 1024 || width <= 760)) {
  test(`settings overview and password form keep their interactive contract at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installSettingsApiRoutes(page, "admin");

    await page.goto("/settings?siteId=site-1");
    await expect(page.getByRole("heading", { name: "설정 개요" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    if (viewport.width <= 760) await expectMinimumTouchTargets(page, ".app-shell");

    await page.goto("/settings/security?siteId=site-1");
    await expect(page.getByRole("form", { name: "비밀번호 변경" })).toBeVisible();
    await expect(page.getByLabel("현재 비밀번호")).toBeVisible();
    await expect(page.getByLabel("새 비밀번호", { exact: true })).toBeVisible();
    await expect(page.getByLabel("새 비밀번호 확인")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    if (viewport.width <= 760) await expectMinimumTouchTargets(page, ".app-shell");
  });
}

test("viewer cannot enter admin password settings", async ({ page }) => {
  await installSettingsApiRoutes(page, "viewer");
  await page.goto("/settings/security?siteId=site-1");

  await expect(page).toHaveURL(/\/settings\?siteId=site-1$/);
  await expect(page.getByRole("heading", { name: "설정 개요" })).toBeVisible();
  await expect(page.getByRole("form", { name: "비밀번호 변경" })).toHaveCount(0);
});
