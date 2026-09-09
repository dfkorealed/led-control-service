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

  await expect(adminPage).toHaveURL(/\/settings\/floor-plans\/floor-1\/edit\?siteId=site-1$/);
  await expect(adminPage.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
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

  await adminPage.getByRole("link", { name: "모니터링", exact: true }).click();
  await expect(adminPage).toHaveURL(/\/monitoring\?siteId=site-1$/);
  await expect.poll(() => adminApi.editorRequests.some((request) => (
    request.type === "lease-release"
    && request.sequence > saveSequence
    && request.payload.token === acquireBeforeSave.result.token
    && request.released
  ))).toBe(true);

  expect(adminApi.fixtureUpdates).toEqual([{ id: "fixture-1", x: 240 }]);

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

  await page.getByLabel("B2 편집 캔버스").click({ position: { x: 120, y: 140 } });
  const xInput = page.getByRole("complementary", { name: "속성 패널" }).getByLabel("X");
  await xInput.fill("260");
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeEnabled();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("저장하지 않은 변경사항");
    await dialog.dismiss();
  });
  await page.getByRole("button", { name: "로그아웃" }).click();

  await expect(page).toHaveURL(/\/settings\/floor-plans\/floor-1\/edit\?siteId=site-1$/);
  await expect(xInput).toHaveValue("260");
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

for (const viewport of responsiveViewports.filter(({ width }) => width <= 390)) {
  test(`dirty editor keeps the coarse ${viewport.width}px settings sheet on cancel and clears its sentinel on confirm`, async ({ browser, baseURL }) => {
    const page = await browser.newPage({ baseURL, viewport, hasTouch: true, isMobile: true });
    try {
      const api = await installSettingsApiRoutes(page, "admin");
      await page.goto("/settings?siteId=site-1#fragment");
      await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1#fragment");
      await expect(page.getByRole("heading", { name: "B2 도면 편집" })).toBeVisible();
      await expect.poll(() => {
        const latestLease = [...api.editorRequests].reverse().find((request) => request.type === "lease-acquire");
        return latestLease?.type === "lease-acquire" && latestLease.result.editable;
      }).toBe(true);

      await page.getByLabel("B2 편집 캔버스").click({ position: { x: 120, y: 140 } });
      const xInput = page.getByRole("complementary", { name: "속성 패널" }).getByLabel("X");
      await xInput.fill("260");
      await expect(page.getByRole("button", { name: "저장", exact: true })).toBeEnabled();

      await page.getByRole("button", { name: "설정", exact: true }).click();
      const menu = page.getByRole("navigation", { name: "설정 메뉴" });
      const securityLink = menu.getByRole("link", { name: "비밀번호 변경" });
      await expect(securityLink).toHaveAttribute("href", "/settings/security?siteId=site-1#fragment");

      page.once("dialog", async (dialog) => {
        expect(dialog.message()).toContain("저장하지 않은 변경사항");
        await dialog.dismiss();
      });
      await securityLink.click();

      await expect(page).toHaveURL(/\/settings\/floor-plans\/floor-1\/edit\?siteId=site-1#fragment$/);
      await expect(page.getByRole("heading", { name: "B2 도면 편집" })).toBeVisible();
      await expect(xInput).toHaveValue("260");
      await expect(menu).toBeVisible();
      await expect(securityLink).toBeFocused();

      page.once("dialog", async (dialog) => {
        expect(dialog.message()).toContain("저장하지 않은 변경사항");
        await dialog.accept();
      });
      await securityLink.click();

      await expect(page).toHaveURL(/\/settings\/security\?siteId=site-1#fragment$/);
      await expect(page.getByRole("form", { name: "비밀번호 변경" })).toBeVisible();
      await expect.poll(() => page.evaluate(() => Boolean(window.history.state?.__floorEditorDirtySentinel))).toBe(false);
      await page.goBack();
      await expect(page).toHaveURL(/\/settings\/floor-plans\/floor-1\/edit\?siteId=site-1#fragment$/);
      await expect(page.getByRole("heading", { name: "B2 도면 편집" })).toBeVisible();
      await expect.poll(() => page.evaluate(() => Boolean(window.history.state?.__floorEditorDirtySentinel))).toBe(false);
      await page.goForward();
      await expect(page).toHaveURL(/\/settings\/security\?siteId=site-1#fragment$/);
      await expect(page.getByRole("form", { name: "비밀번호 변경" })).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(/\/settings\/floor-plans\/floor-1\/edit\?siteId=site-1#fragment$/);
      await expect(page.getByRole("heading", { name: "B2 도면 편집" })).toBeVisible();

      const unexpectedDialogs: string[] = [];
      page.on("dialog", async (dialog) => {
        unexpectedDialogs.push(dialog.message());
        await dialog.dismiss();
      });
      await page.getByRole("button", { name: "로그아웃" }).click();
      await expect(page.getByRole("heading", { name: "LED Control 로그인" })).toBeVisible();
      expect(unexpectedDialogs).toEqual([]);
      expect(api.logoutRequests).toBe(1);
    } finally {
      await page.close();
    }
  });
}

test("desktop settings navigation opens on hover, preserves site scope, and exposes admin links", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installSettingsApiRoutes(page, "admin");
  await page.goto("/monitoring?siteId=site-1");

  const settings = page.getByRole("link", { name: "설정", exact: true });
  await settings.hover();
  await expect(settings).toHaveAttribute("aria-expanded", "true");
  await expect(settings).not.toHaveAttribute("aria-haspopup");
  await expect(settings).toHaveAttribute("aria-controls", "settings-navigation-popup");
  const navigation = page.getByRole("navigation", { name: "설정 메뉴" });
  await expect(navigation).toHaveAttribute("id", "settings-navigation-popup");
  const settingsBox = await settings.boundingBox();
  const navigationBox = await navigation.boundingBox();
  expect(settingsBox).not.toBeNull();
  expect(navigationBox).not.toBeNull();
  if (settingsBox && navigationBox) expect(navigationBox.x).toBeGreaterThanOrEqual(settingsBox.x + settingsBox.width - 1);
  await expect(navigation.getByRole("link", { name: "비밀번호 변경" })).toBeVisible();
  await navigation.getByRole("link", { name: "도면 관리" }).click();

  await expect(page).toHaveURL(/\/settings\/floor-plans\?siteId=site-1$/);
  await expect(page.getByRole("heading", { name: "도면 관리" })).toBeVisible();
  await settings.hover();
  await expect(settings).not.toHaveAttribute("aria-current");
  await expect(page.getByRole("link", { name: "설정 개요" })).not.toHaveAttribute("aria-current");
  await expect(page.getByRole("link", { name: "도면 관리" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: "비밀번호 변경" })).not.toHaveAttribute("aria-current");
  await expectNoHorizontalOverflow(page);
});

test("desktop settings navigation follows natural Tab and Shift+Tab order before Escape restores focus", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await installSettingsApiRoutes(page, "viewer");
  await page.goto("/monitoring?siteId=site-1");

  const settings = page.getByRole("link", { name: "설정", exact: true });
  await settings.focus();
  await expect(settings).toHaveAttribute("aria-expanded", "true");
  await expect(settings).not.toHaveAttribute("aria-haspopup");
  const navigation = page.getByRole("navigation", { name: "설정 메뉴" });
  const overview = navigation.getByRole("link", { name: "설정 개요" });
  const floorPlans = navigation.getByRole("link", { name: "도면 관리" });
  await expect(floorPlans).toBeVisible();
  await expect(navigation.getByRole("link", { name: "비밀번호 변경" })).toHaveCount(0);

  await page.keyboard.press("Tab");
  await expect(overview).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(floorPlans).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(overview).toBeFocused();
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
      const settings = page.getByRole("button", { name: "설정", exact: true });
      await settings.click();

      const menu = page.getByRole("navigation", { name: "설정 메뉴" });
      await expect(menu).toBeVisible();
      await expect(page.getByRole("button", { name: "설정 메뉴 닫기" })).toBeVisible();
      await expect(menu.getByRole("heading", { name: "설정 메뉴" })).toBeVisible();
      await expect(menu.locator(".settings-submenu-grabber")).toBeVisible();
      await expect(menu.getByRole("link", { name: "설정 개요" })).toBeFocused();
      await expect(menu).toHaveCSS("overflow-y", "auto");
      await expect(settings).not.toHaveAttribute("aria-current");
      await expect(settings).not.toHaveAttribute("aria-haspopup");
      await expect(settings).toHaveAttribute("aria-controls", "settings-navigation-popup");
      await expect(menu).toHaveAttribute("id", "settings-navigation-popup");
      await expect(page).toHaveURL(/\/monitoring\?siteId=site-1$/);
      await expectMinimumTouchTargets(page, ".settings-submenu");
      await expectNoHorizontalOverflow(page);
      const sheetBox = await menu.boundingBox();
      expect(sheetBox).not.toBeNull();
      if (sheetBox) expect(Math.abs(sheetBox.y + sheetBox.height - viewport.height)).toBeLessThanOrEqual(1);

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
    await editorCanvas.evaluate((element) => element.scrollIntoView({ block: "center" }));
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
      // Validate complete touch areas, not the slice of a toolbar clipped by
      // the viewport after centering the canvas on this vertically stacked page.
      await page.locator(".floor-editor-toolbar").scrollIntoViewIfNeeded();
      await expectMinimumTouchTargets(page, ".floor-editor-toolbar");
      await expectMinimumTouchTargets(page, ".editor-snap");
      await page.getByRole("button", { name: "배치 해제", exact: true }).scrollIntoViewIfNeeded();
      await expectMinimumTouchTargets(page, ".fixture-placement-action");
      await page.evaluate(() => window.scrollTo(0, 0));
      await expectMinimumTouchTargets(page, ".app-shell");
    }
  });
}

for (const viewport of responsiveViewports) {
  test(`settings overview and password form keep their interactive contract at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installSettingsApiRoutes(page, "admin");

    await page.goto("/settings?siteId=site-1");
    await expect(page.getByRole("heading", { name: "설정 개요" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    if (viewport.width <= 760) {
      const registrationTargets = page.locator(".registration-targets");
      await registrationTargets.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await expect(page.getByLabel("등록 층")).toBeInViewport();
      await expect(page.getByLabel("등록 게이트웨이")).toBeInViewport();
      await expectMinimumTouchTargets(page, ".app-shell");
    }

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
