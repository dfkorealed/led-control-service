import { expect, test } from "@playwright/test";
import {
  expectMinimumTouchTargets,
  expectMinimumTouchTargetsAfterScrolling,
  expectNoHorizontalOverflow
} from "./support/layout-assertions";
import { installSettingsApiRoutes } from "./support/settings-api";

const responsiveViewports = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 320, height: 740 }
] as const;

async function expectSettingsContentTopAligned(page: import("@playwright/test").Page) {
  await expect(page.getByRole("button", { name: /현장 선택/ })).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "설정 메뉴" });
  const contextBox = await tabs.locator("xpath=preceding-sibling::*[1]").boundingBox();
  const tabsBox = await tabs.boundingBox();
  const contentBox = await tabs.locator("xpath=following-sibling::*[1]").boundingBox();
  expect(contextBox).not.toBeNull();
  expect(tabsBox).not.toBeNull();
  expect(contentBox).not.toBeNull();
  if (!contextBox || !tabsBox || !contentBox) return;

  const contextGap = tabsBox.y - (contextBox.y + contextBox.height);
  const contentGap = contentBox.y - (tabsBox.y + tabsBox.height);
  expect(contextGap).toBeGreaterThanOrEqual(0);
  expect(contextGap).toBeLessThanOrEqual(20);
  expect(contentGap).toBeGreaterThanOrEqual(0);
  expect(contentGap).toBeLessThanOrEqual(20);
}

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
  await expect(adminPage.getByRole("heading", { name: "B2 맵 편집" })).toBeVisible();
  await expect.poll(() => {
    const latestLease = [...adminApi.editorRequests].reverse().find((request) => request.type === "lease-acquire");
    return latestLease?.type === "lease-acquire" && latestLease.result.editable;
  }).toBe(true);

  await adminPage.getByLabel("B2 편집 캔버스").click({ position: { x: 120, y: 140 } });
  await expect(adminPage.getByRole("complementary", { name: "속성 패널" }).getByRole("heading", { name: "B2-L01" })).toBeVisible();
  await changeSelectedFixtureX(adminPage, "240");
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

test("a map object saved in settings is rendered immediately in monitoring", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installSettingsApiRoutes(page, "admin");
  await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
  await expect(page.getByRole("heading", { name: "B2 맵 편집" })).toBeVisible();
  await expect.poll(() => {
    const latestLease = [...api.editorRequests].reverse().find((request) => request.type === "lease-acquire");
    return latestLease?.type === "lease-acquire" && latestLease.result.editable;
  }).toBe(true);

  const canvas = page.getByLabel("B2 편집 캔버스");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("editor canvas has no layout box");
  await page.getByRole("button", { name: "사각형" }).click();
  await page.mouse.move(box.x + 320, box.y + 220);
  await page.mouse.down();
  await page.mouse.move(box.x + 460, box.y + 300);
  await page.mouse.up();
  await expect(page.getByRole("complementary", { name: "속성 패널" }).getByRole("heading", { name: "네모" })).toBeVisible();

  for (const shape of [
    { tool: "삼각형", start: [520, 220], end: [640, 320] },
    { tool: "선", start: [320, 380], end: [480, 380] },
    { tool: "텍스트", start: [520, 380], end: [680, 440] }
  ] as const) {
    await page.getByRole("button", { name: shape.tool, exact: true }).click();
    await page.mouse.move(box.x + shape.start[0], box.y + shape.start[1]);
    await page.mouse.down();
    await page.mouse.move(box.x + shape.end[0], box.y + shape.end[1]);
    await page.mouse.up();
  }

  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  await expect.poll(() => api.atomicSavePayloads).toHaveLength(1);
  const savedObjects = api.atomicSavePayloads[0].objectCreates;
  expect(savedObjects).toHaveLength(4);
  const rectangle = savedObjects.find((object) => object.type === "rectangle");
  const triangle = savedObjects.find((object) => object.type === "triangle");
  const line = savedObjects.find((object) => object.type === "line");
  const text = savedObjects.find((object) => object.type === "text");
  if (!rectangle || !triangle || !line || !text) throw new Error("saved map object payload is incomplete");
  const samples = {
    rectangle: { x: Math.round(rectangle.x + rectangle.width / 2), y: Math.round(rectangle.y + rectangle.height / 2) },
    triangle: { x: Math.round(triangle.x + triangle.width / 2), y: Math.round(triangle.y + triangle.height / 2) },
    line: { x: Math.round(line.x + line.width / 2), y: Math.round(line.y) },
    text: {
      x: Math.round(text.x + 8),
      y: Math.round(text.y + 8),
      width: Math.max(Math.round(text.width - 16), 1),
      height: Math.max(Math.round(text.height - 16), 1)
    }
  };

  await page.getByRole("link", { name: "모니터링", exact: true }).click();

  await expect(page).toHaveURL(/\/monitoring\?siteId=site-1$/);
  for (const index of [1, 2, 3, 4]) {
    await expect(page.getByTestId(`map-object-saved-map-object-8-${index}`)).toHaveCount(1);
  }
  const monitoringMap = page.getByRole("region", { name: "층 도면" });
  const monitoringSceneCanvas = monitoringMap.locator(".floor-scene-canvas");
  const monitoringCanvas = monitoringSceneCanvas.locator("canvas");
  let layout: {
    sceneCanvas: { width: number; height: number };
    konvaContent: { width: number; height: number };
    canvas: { width: number; height: number };
  } | null = null;
  await expect.poll(async () => {
    layout = await monitoringMap.evaluate((floorMap) => {
      const sceneCanvas = floorMap.querySelector<HTMLElement>(".floor-scene-canvas");
      const konvaContent = sceneCanvas?.querySelector<HTMLElement>(".konvajs-content");
      const canvas = konvaContent?.querySelector<HTMLCanvasElement>("canvas");
      if (!sceneCanvas || !konvaContent || !canvas) return null;
      const toSize = (element: Element) => {
        const { width, height } = element.getBoundingClientRect();
        return { width, height };
      };
      return {
        sceneCanvas: toSize(sceneCanvas),
        konvaContent: toSize(konvaContent),
        canvas: toSize(canvas)
      };
    });
    return layout?.sceneCanvas.height ?? 0;
  }).toBeGreaterThan(0);
  if (!layout) throw new Error("monitoring map layout was not rendered");
  for (const [name, size] of Object.entries({
    sceneCanvas: layout.sceneCanvas,
    konvaContent: layout.konvaContent,
    canvas: layout.canvas
  })) {
    expect(size.height, `${name} height`).toBeGreaterThan(0);
    expect(size.width, `${name} width`).toBeGreaterThan(0);
    expect(size.height, `${name} height matches scene`).toBeCloseTo(layout.sceneCanvas.height, 0);
    expect(size.width, `${name} width matches scene`).toBeCloseTo(layout.sceneCanvas.width, 0);
  }
  await expect.poll(async () => monitoringCanvas.evaluate((canvas: HTMLCanvasElement, sampleRegions) => {
    const context = canvas.getContext("2d");
    if (!context) return null;
    const textPixels = context.getImageData(
      sampleRegions.text.x,
      sampleRegions.text.y,
      sampleRegions.text.width,
      sampleRegions.text.height
    ).data;
    let textUsesDefaultBlue = false;
    for (let index = 3; index < textPixels.length; index += 4) {
      if (
        textPixels[index] === 255
        && textPixels[index - 3] === 37
        && textPixels[index - 2] === 99
        && textPixels[index - 1] === 235
      ) {
        textUsesDefaultBlue = true;
        break;
      }
    }
    return [
      Array.from(context.getImageData(sampleRegions.rectangle.x, sampleRegions.rectangle.y, 1, 1).data.slice(0, 3)),
      Array.from(context.getImageData(sampleRegions.triangle.x, sampleRegions.triangle.y, 1, 1).data.slice(0, 3)),
      Array.from(context.getImageData(sampleRegions.line.x, sampleRegions.line.y, 1, 1).data.slice(0, 3)),
      textUsesDefaultBlue
    ];
  }, samples)).toEqual([
    [219, 234, 254],
    [219, 234, 254],
    [37, 99, 235],
    true
  ]);
});

test("viewer is redirected before editor state and lease requests while mutation fixtures reject changes", async ({ page }) => {
  const api = await installSettingsApiRoutes(page, "viewer");
  await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");

  await expect(page).toHaveURL(/\/settings\/floor-plans\?siteId=site-1$/);
  const floorRow = page.locator(".floor-plan-card").filter({ hasText: "B2" });
  await expect(floorRow).toContainText("맵 설정됨");
  await expect(floorRow.getByRole("link", { name: "B2 맵 편집" })).toHaveCount(0);
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
  await expect(page.getByRole("heading", { name: "B2 맵 편집" })).toBeVisible();
  await expect.poll(() => {
    const latestLease = [...api.editorRequests].reverse().find((request) => request.type === "lease-acquire");
    return latestLease?.type === "lease-acquire" && latestLease.result.editable;
  }).toBe(true);

  const xInput = await changeSelectedFixtureX(page, "260");

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

  await expect(page.getByRole("heading", { name: "킨다 로그인" })).toBeVisible();
  expect(api.logoutRequests).toBe(1);
  await expect.poll(async () => page.evaluate(async () => (await fetch("/api/auth/me")).status)).toBe(401);
});

for (const viewport of responsiveViewports.filter(({ width }) => width <= 390)) {
  test(`dirty editor keeps the coarse ${viewport.width}px settings tabs on cancel and clears its sentinel on confirm`, async ({ browser, baseURL }) => {
    const page = await browser.newPage({ baseURL, viewport, hasTouch: true, isMobile: true });
    try {
      const api = await installSettingsApiRoutes(page, "admin");
      await page.goto("/settings?siteId=site-1#fragment");
      await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1#fragment");
      await expect(page.getByRole("heading", { name: "B2 맵 편집" })).toBeVisible();
      await expect.poll(() => {
        const latestLease = [...api.editorRequests].reverse().find((request) => request.type === "lease-acquire");
        return latestLease?.type === "lease-acquire" && latestLease.result.editable;
      }).toBe(true);

      const xInput = await changeSelectedFixtureX(page, "260");

      const menu = page.getByRole("navigation", { name: "설정 메뉴" });
      const securityLink = menu.getByRole("link", { name: "계정 보안" });
      await expect(securityLink).toHaveAttribute("href", "/settings/security?siteId=site-1#fragment");

      await securityLink.click();
      const leaveDialog = page.getByRole("alertdialog", { name: "맵 편집 종료" });
      await expect(leaveDialog).toContainText("저장하지 않은 변경사항");
      await leaveDialog.getByRole("button", { name: "취소" }).click();

      await expect(page).toHaveURL(/\/settings\/floor-plans\/floor-1\/edit\?siteId=site-1#fragment$/);
      await expect(page.getByRole("heading", { name: "B2 맵 편집" })).toBeVisible();
      await expect(xInput).toHaveValue("260");
      await expect(menu).toBeVisible();
      await expect(securityLink).toBeFocused();

      await securityLink.click();
      await leaveDialog.getByRole("button", { name: "이동" }).click();

      await expect(page).toHaveURL(/\/settings\/security\?siteId=site-1#fragment$/);
      await expect(page.getByRole("form", { name: "비밀번호 변경" })).toBeVisible();
      await expect.poll(() => page.evaluate(() => Boolean(window.history.state?.__floorEditorDirtySentinel))).toBe(false);
      await page.goBack();
      await expect(page).toHaveURL(/\/settings\/floor-plans\/floor-1\/edit\?siteId=site-1#fragment$/);
      await expect(page.getByRole("heading", { name: "B2 맵 편집" })).toBeVisible();
      await expect.poll(() => page.evaluate(() => Boolean(window.history.state?.__floorEditorDirtySentinel))).toBe(false);
      await page.goForward();
      await expect(page).toHaveURL(/\/settings\/security\?siteId=site-1#fragment$/);
      await expect(page.getByRole("form", { name: "비밀번호 변경" })).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(/\/settings\/floor-plans\/floor-1\/edit\?siteId=site-1#fragment$/);
      await expect(page.getByRole("heading", { name: "B2 맵 편집" })).toBeVisible();

      const unexpectedDialogs: string[] = [];
      page.on("dialog", async (dialog) => {
        unexpectedDialogs.push(dialog.message());
        await dialog.dismiss();
      });
      await page.getByRole("button", { name: "로그아웃" }).click();
      await expect(page.getByRole("heading", { name: "킨다 로그인" })).toBeVisible();
      expect(unexpectedDialogs).toEqual([]);
      expect(api.logoutRequests).toBe(1);
    } finally {
      await page.close();
    }
  });
}

test("desktop settings link opens capability-filtered top tabs and preserves site scope", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installSettingsApiRoutes(page, "admin");
  await page.goto("/monitoring?siteId=site-1#settings");

  const settings = page.getByRole("link", { name: "설정", exact: true });
  await settings.hover();
  await expect(settings).not.toHaveAttribute("aria-expanded");
  await expect(page.getByRole("navigation", { name: "설정 메뉴" })).toHaveCount(0);
  await expect(settings.locator(".settings-nav-chevron")).toHaveCount(0);
  await settings.click();

  await expect(page).toHaveURL(/\/settings\?siteId=site-1#settings$/);
  const navigation = page.getByRole("navigation", { name: "설정 메뉴" });
  await expect(navigation.getByRole("link", { name: "설정 개요" })).toHaveAttribute("aria-current", "page");
  await expect(navigation.getByRole("link", { name: "유저 관리" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "조명 등록" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "계정 보안" })).toBeVisible();
  await navigation.getByRole("link", { name: "맵 관리" }).click();

  await expect(page).toHaveURL(/\/settings\/floor-plans\?siteId=site-1#settings$/);
  await expect(page.getByRole("heading", { name: "맵 관리" })).toBeVisible();
  await expect(settings).toHaveAttribute("aria-current", "page");
  await expect(navigation.getByRole("link", { name: "설정 개요" })).not.toHaveAttribute("aria-current");
  await expect(navigation.getByRole("link", { name: "맵 관리" })).toHaveAttribute("aria-current", "page");
  await expect(navigation.getByRole("link", { name: "계정 보안" })).not.toHaveAttribute("aria-current");
  await expectNoHorizontalOverflow(page);
});

test("desktop viewer settings tabs follow natural keyboard order and hide manage routes", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await installSettingsApiRoutes(page, "viewer");
  await page.goto("/monitoring?siteId=site-1");

  const settings = page.getByRole("link", { name: "설정", exact: true });
  await settings.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/settings\?siteId=site-1$/);
  const navigation = page.getByRole("navigation", { name: "설정 메뉴" });
  const overview = navigation.getByRole("link", { name: "설정 개요" });
  const floorPlans = navigation.getByRole("link", { name: "맵 관리" });
  const security = navigation.getByRole("link", { name: "계정 보안" });
  await expect(floorPlans).toBeVisible();
  await expect(security).toBeVisible();
  await expect(navigation.getByRole("link", { name: "유저 관리" })).toHaveCount(0);
  await expect(navigation.getByRole("link", { name: "조명 등록" })).toHaveCount(0);

  await overview.focus();
  await page.keyboard.press("Tab");
  await expect(floorPlans).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(security).toBeFocused();
  await expectNoHorizontalOverflow(page);
});

for (const viewport of responsiveViewports.filter(({ width }) => width <= 760)) {
  test(`coarse ${viewport.width}px settings navigation uses the same top tabs`, async ({ browser, baseURL }) => {
    const page = await browser.newPage({ baseURL, viewport, hasTouch: true, isMobile: true });
    try {
      await installSettingsApiRoutes(page, "admin");
      await page.goto("/monitoring?siteId=site-1");
      const settings = page.getByRole("link", { name: "설정", exact: true });
      await settings.click();

      await expect(page).toHaveURL(/\/settings\?siteId=site-1$/);
      const menu = page.getByRole("navigation", { name: "설정 메뉴" });
      await expect(menu).toBeVisible();
      await expect(menu).toHaveCSS("overflow-x", "auto");
      await expect(settings).toHaveAttribute("aria-current", "page");
      await expect(menu.getByRole("link", { name: "설정 개요" })).toHaveAttribute("aria-current", "page");
      await expectMinimumTouchTargetsAfterScrolling(page, 'nav[aria-label="설정 메뉴"]');
      await expectNoHorizontalOverflow(page);

      await page.goto("/settings/security?siteId=site-1");
      const activeSecurityTab = page
        .getByRole("navigation", { name: "설정 메뉴" })
        .getByRole("link", { name: "계정 보안" });
      await expect(activeSecurityTab).toHaveAttribute("aria-current", "page");
      await expect(activeSecurityTab).toBeInViewport();

      await menu.getByRole("link", { name: "맵 관리" }).click();
      await expect(page).toHaveURL(/\/settings\/floor-plans\?siteId=site-1$/);
      await expect(page.getByRole("heading", { name: "맵 관리" })).toBeVisible();
      await expectMinimumTouchTargetsAfterScrolling(page, "[data-app-shell]");
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
    await expect(page.getByRole("heading", { name: "B2 맵 편집" })).toBeVisible();
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
      page.getByRole("toolbar", { name: "맵 편집 도구" }).boundingBox(),
      page.getByTestId("floor-editor-canvas").boundingBox(),
      page.getByRole("complementary", { name: "맵 편집 정보" }).boundingBox()
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
      await page.getByRole("toolbar", { name: "맵 편집 도구" }).scrollIntoViewIfNeeded();
      await expectMinimumTouchTargets(page, '[aria-label="맵 편집 도구"]');
      await expectMinimumTouchTargets(page, '[data-field]:has(input[type="checkbox"])');
      await page.getByRole("button", { name: "배치 해제", exact: true }).scrollIntoViewIfNeeded();
      await expectMinimumTouchTargets(page, '[data-testid="floor-editor-canvas"]');
      await page.evaluate(() => window.scrollTo(0, 0));
      await expectMinimumTouchTargets(page, '[data-shell-navigation="compact"]');
      await expectMinimumTouchTargetsAfterScrolling(page, 'nav[aria-label="설정 메뉴"]');
    }
  });
}

for (const viewport of responsiveViewports) {
  test(`settings routes keep their interactive contract at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installSettingsApiRoutes(page, "admin");

    await page.goto("/settings?siteId=site-1");
    await expect(page.getByRole("heading", { name: "설정 개요" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "조명 등록" })).toHaveCount(0);
    await expectSettingsContentTopAligned(page);
    await expectNoHorizontalOverflow(page);

    await page.goto("/settings/registration?siteId=site-1");
    await expect(page.getByRole("heading", { name: "조명 등록" })).toBeVisible();
    await expectSettingsContentTopAligned(page);
    await expectNoHorizontalOverflow(page);
    if (viewport.width <= 760) {
      const registrationTargets = page.locator(".registration-targets");
      await registrationTargets.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await expect(page.getByLabel("등록 층")).toBeInViewport();
      await expect(page.getByLabel("등록 게이트웨이")).toBeInViewport();
      await expectMinimumTouchTargetsAfterScrolling(page, "[data-app-shell]");
    }

    await page.goto("/settings/floor-plans?siteId=site-1");
    await expect(page.getByRole("heading", { name: "맵 관리" })).toBeVisible();
    await expectSettingsContentTopAligned(page);
    await expectNoHorizontalOverflow(page);

    await page.goto("/settings/security?siteId=site-1");
    await expect(page.getByRole("form", { name: "비밀번호 변경" })).toBeVisible();
    await expect(page.getByLabel("현재 비밀번호")).toBeVisible();
    await expect(page.getByLabel("새 비밀번호", { exact: true })).toBeVisible();
    await expect(page.getByLabel("새 비밀번호 확인")).toBeVisible();
    await expectSettingsContentTopAligned(page);
    await expectNoHorizontalOverflow(page);
    if (viewport.width <= 760) await expectMinimumTouchTargetsAfterScrolling(page, "[data-app-shell]");
  });
}

test("viewer can enter personal password settings", async ({ page }) => {
  await installSettingsApiRoutes(page, "viewer");
  await page.goto("/settings/security?siteId=site-1");

  await expect(page).toHaveURL(/\/settings\/security\?siteId=site-1$/);
  await expect(page.getByRole("form", { name: "비밀번호 변경" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "설정 메뉴" }).getByRole("link", { name: "계정 보안" })).toHaveAttribute("aria-current", "page");
});

async function changeSelectedFixtureX(page: import("@playwright/test").Page, value: string) {
  await page.getByLabel("B2 편집 캔버스").click({ position: { x: 120, y: 140 } });
  const properties = page.getByRole("complementary", { name: "속성 패널" });
  await expect(properties.getByRole("heading", { name: "B2-L01" })).toBeVisible();
  const xInput = properties.getByLabel("X");
  await xInput.fill(value);
  await xInput.press("Tab");
  await expect(xInput).toHaveValue(value);
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeEnabled();
  return xInput;
}
