import { expect, test, type Page } from "@playwright/test";
import { installSettingsApiRoutes } from "./support/settings-api";
import { expectMinimumTouchTargetsAfterScrolling, expectNoHorizontalOverflow } from "./support/layout-assertions";
import { mockDashboard } from "../src/test/fixtures";

async function worldPoint(page: Page, x: number, y: number) {
  const canvas = page.getByTestId("floor-editor-canvas");
  const box = (await canvas.boundingBox())!;
  const zoom = Number(await canvas.getAttribute("data-zoom"));
  return { x: box.x + Number(await canvas.getAttribute("data-pan-x")) + x * zoom,
    y: box.y + Number(await canvas.getAttribute("data-pan-y")) + y * zoom };
}
async function nativeBack(page: Page, requestId: string) {
  await page.evaluate(requestId => window.dispatchEvent(new CustomEvent("led-control:native-message", { detail: {
    version: 1, type: "navigation.back", documentId: "settings-e2e", requestId
  } })), requestId);
  await expect.poll(() => page.evaluate(requestId => {
    const messages = (window as typeof window & { __settingsMessages: Array<Record<string, unknown>> }).__settingsMessages;
    return messages.find(message => message.type === "navigation.back.result" && message.requestId === requestId);
  }, requestId)).toEqual({ version: 1, type: "navigation.back.result", documentId: "settings-e2e", requestId, handled: true, canGoBack: true });
}

for (const width of [320, 390]) for (const theme of ["light", "dark"]) {
  test(`ATLAS settings home and mobile return at ${width}px ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(theme => localStorage.setItem("led-control.customer-theme.v1", theme), theme);
    const api = await installSettingsApiRoutes(page, "admin");
    const longGatewayName = "지하주차장현장관리게이트웨이".repeat(8);
    const longGatewaySerial = "GW-LONG-SERIAL-".repeat(8);
    const dashboard = structuredClone(mockDashboard);
    dashboard.site.id = "site-1";
    dashboard.capabilities = { read: true, control: true, manage: true, commission: true };
    dashboard.gateways = [{ ...dashboard.gateways[0], name: longGatewayName, serialNumber: longGatewaySerial, connectionStatus: "offline" }];
    await page.route("**/api/sites/site-1/dashboard*", route => {
      expect(route.request().method()).toBe("GET");
      api.requests.push("GET /sites/site-1/dashboard");
      return route.fulfill({ json: dashboard });
    });
    let userQueries = 0;
    await page.route("**/api/sites/site-1/users", route => {
      expect(route.request().method()).toBe("GET");
      userQueries++;
      return route.fulfill({ json: { users: [], count: 0, limit: 100 } });
    });
    await page.goto("/settings?siteId=site-1&keep=value#cards");
    await expect(page.locator("html")).toHaveAttribute("data-customer-theme", theme);
    await expect(page.getByRole("heading", { name: "설정", exact: true, level: 2 })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "설정 메뉴" })).toBeHidden();
    await expect(page.getByRole("link", { name: "설정으로 돌아가기" })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "유저 관리", exact: true })).toContainText("사용자 0명");
    expect(userQueries).toBe(1);
    const registrationSummary = page.getByRole("group", { name: "조명 등록", exact: true }).locator("p");
    await expect(registrationSummary).toContainText(longGatewayName);
    await expect(registrationSummary).toContainText(longGatewaySerial);
    await expect(registrationSummary).toContainText("오프라인");
    expect(await registrationSummary.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(element);
      return element.scrollWidth <= element.clientWidth && [...range.getClientRects()].every(rect => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1);
    })).toBe(true);
    for (const label of ["현장 관리", "유저 관리", "조명 등록", "맵 관리", "계정 보안"]) {
      const link = page.getByRole("link", { name: `${label} 열기`, exact: true });
      await expect(link).toHaveAttribute("href", /\?siteId=site-1&keep=value#cards$/);
      await link.scrollIntoViewIfNeeded();
      await expect(link).toBeVisible();
      expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await expectNoHorizontalOverflow(page);
    await page.getByRole("heading", { name: "설정", exact: true, level: 2 }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`settings-home-${theme}-${width}.png`), fullPage: true });
    await page.getByRole("link", { name: "맵 관리 열기", exact: true }).click();
    const back = page.getByRole("link", { name: "설정으로 돌아가기", exact: true });
    await expect(back).toHaveCount(1);
    await expect(back).toHaveAttribute("href", "/settings?siteId=site-1&keep=value#cards");
    await back.click();
    await expect(page).toHaveURL(/\/settings\?siteId=site-1&keep=value#cards$/);
    await expect(page.getByRole("heading", { name: "설정", exact: true, level: 2 })).toBeVisible();
    expect(api.requests.filter(request => /^(POST|PATCH|DELETE) /.test(request))).toEqual([]);
    expect(api.atomicSavePayloads).toEqual([]);
  });
}

for (const width of [320, 390]) test(`settings real touch pan and background draft/lease at ${width}px (HTTP fixture)`, async ({ browser, baseURL }, testInfo) => {
  const context = await browser.newContext({ baseURL, viewport: { width, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.addInitScript(() => {
      const messages: Array<Record<string, unknown>> = [];
      Object.assign(window, { __settingsMessages: messages,
        __LED_CONTROL_NATIVE_DOCUMENT_ID__: "settings-e2e",
        __LED_CONTROL_NATIVE_ENVIRONMENT__: { version: 1, type: "mobile.bootstrap", documentId: "settings-e2e", requestId: "bootstrap", mobile: true, state: "active", online: true },
        ReactNativeWebView: { postMessage: (raw: string) => messages.push(JSON.parse(raw)) }
      });
    });
    const api = await installSettingsApiRoutes(page, "admin", { readyMapDocument: true });
    await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
    const canvas = page.getByTestId("floor-editor-canvas");
    await expect(canvas).toHaveAttribute("data-map-ready", "true");
    await expect(canvas).toHaveAttribute("aria-disabled", "false");
    await page.getByRole("button", { name: "도구 및 조명 패널" }).tap();
    await page.getByRole("button", { name: "이동", exact: true }).tap();
    await expect(page.getByRole("button", { name: "도구 및 조명 패널" })).toHaveAttribute("aria-expanded", "false");
    const box = (await canvas.boundingBox())!;
    const initialX = Number(await canvas.getAttribute("data-pan-x"));
    const initialY = Number(await canvas.getAttribute("data-pan-y"));
    const scroll = await page.evaluate(() => window.scrollY);
    const session = await context.newCDPSession(page);
    // Dispatch browser touch events, not mouse emulation or calls into editor handlers.
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x + box.width / 2 + 40, y: box.y + box.height / 2 + 30 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(async () => Number(await canvas.getAttribute("data-pan-x"))).toBeCloseTo(initialX + 40, 0);
    await expect.poll(async () => Number(await canvas.getAttribute("data-pan-y"))).toBeCloseTo(initialY + 30, 0);
    expect(await page.evaluate(() => window.scrollY)).toBe(scroll);
    expect(api.atomicSavePayloads).toHaveLength(0);

    await page.getByRole("button", { name: "도구 및 조명 패널" }).tap();
    await page.getByRole("button", { name: "선택", exact: true }).tap();
    await expect(page.getByRole("button", { name: "도구 및 조명 패널" })).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "맵 맞춤", exact: true }).tap();
    const fixture = await worldPoint(page, 120, 140);
    await page.touchscreen.tap(fixture.x, fixture.y);
    await page.getByRole("button", { name: "편집 정보 패널" }).tap();
    const name = page.getByLabel("조명명", { exact: true });
    await expect(name).toHaveValue("B2-L01");
    await name.fill("모바일 초안 조명");
    const leaseCount = api.leaseRequests.length;
    const releaseCount = api.editorRequests.filter(request => request.type === "lease-release").length;
    const cameraBeforeTheme = [await canvas.getAttribute("data-pan-x"), await canvas.getAttribute("data-pan-y"), await canvas.getAttribute("data-zoom")];
    const urlBeforeTheme = page.url();
    const historyBeforeTheme = await page.evaluate(() => history.state.idx);
    await page.getByRole("button", { name: "다크 모드로 변경" }).tap();
    await expect(page.locator("html")).toHaveAttribute("data-customer-theme", "dark");
    await expect(name).toHaveValue("모바일 초안 조명");
    expect([await canvas.getAttribute("data-pan-x"), await canvas.getAttribute("data-pan-y"), await canvas.getAttribute("data-zoom")]).toEqual(cameraBeforeTheme);
    expect(page.url()).toBe(urlBeforeTheme);
    expect(await page.evaluate(() => history.state.idx)).toBe(historyBeforeTheme);
    expect(api.leaseRequests).toHaveLength(leaseCount);
    expect(api.editorRequests.filter(request => request.type === "lease-release")).toHaveLength(releaseCount);
    expect(api.atomicSavePayloads).toHaveLength(0);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("led-control:native-message", { detail: {
      version: 1, type: "mobile.lifecycle", documentId: "settings-e2e", requestId: "background", state: "background", online: true
    } })));
    await expect(canvas).toHaveAttribute("aria-disabled", "true");
    await expect(name).toHaveValue("모바일 초안 조명");
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("led-floor-draft:v1:")).map(key => JSON.parse(localStorage.getItem(key)!)))).toEqual([
      expect.objectContaining({ changes: expect.objectContaining({ fixtureUpdates: [{ id: "fixture-1", name: "모바일 초안 조명" }] }) })
    ]);
    expect(api.atomicSavePayloads).toHaveLength(0);
    await expect.poll(() => api.editorRequests.filter(request => request.type === "lease-release").length).toBe(releaseCount + 1);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("led-control:native-message", { detail: {
      version: 1, type: "mobile.lifecycle", documentId: "settings-e2e", requestId: "foreground", state: "active", online: true
    } })));
    await expect(canvas).toHaveAttribute("aria-disabled", "false");
    expect(api.leaseRequests.length).toBe(leaseCount + 1);
    expect(api.leaseRequests.at(-1)).not.toHaveProperty("token");
    await expect(name).toHaveValue("모바일 초안 조명");
    expect(api.atomicSavePayloads).toHaveLength(0);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath("settings-mobile-draft.png") });
    const originalUrl = page.url();
    const historyIndex = await page.evaluate(() => history.state.idx);
    await nativeBack(page, "close-panel");
    await expect(page.getByRole("button", { name: "편집 정보 패널" })).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(page.url()).toBe(originalUrl);
    await nativeBack(page, "ask-dirty");
    await expect(page.getByRole("alertdialog", { name: "맵 편집 종료" })).toBeVisible();
    expect(await page.evaluate(() => history.state.idx)).toBe(historyIndex);
    expect(page.url()).toBe(originalUrl);
    await nativeBack(page, "cancel-dialog");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(await page.evaluate(() => history.state.idx)).toBe(historyIndex);
    await nativeBack(page, "ask-again");
    await page.getByRole("alertdialog", { name: "맵 편집 종료" }).getByRole("button", { name: "이동", exact: true }).tap();
    await expect(page).toHaveURL(/\/settings\/floor-plans\?siteId=site-1$/);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(api.atomicSavePayloads).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

for (const width of [320, 390]) for (const textScale of [1, 2]) {
  test(`settings CAD retry remains readable at ${width}px text ${textScale * 100}%`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const api = await installSettingsApiRoutes(page, "admin");
    let imageRequests = 0;
    await page.route("**/demo/floor-b2.svg*", route => { imageRequests++; return route.fulfill({ status: 404, body: "" }); });
    await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
    const canvas = page.getByTestId("floor-editor-canvas");
    const alert = canvas.getByRole("alert");
    const retry = alert.getByRole("button", { name: "도면 다시 시도" });
    await expect(retry).toBeVisible();
    // Text-only enlargement leaves the fixed canvas warning budget unchanged.
    // This tests web text readability, not native OS font scaling or GPU behavior.
    if (textScale === 2) await alert.evaluate(element => {
      const texts = [...element.querySelectorAll("span,button")].map(node => ({ node, size: parseFloat(getComputedStyle(node).fontSize), line: parseFloat(getComputedStyle(node).lineHeight) }));
      for (const { node, size, line } of texts) {
        (node as HTMLElement).style.fontSize = `${size * 2}px`;
        (node as HTMLElement).style.lineHeight = `${line * 2}px`;
      }
    });
    const lineCount = await retry.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size;
    });
    expect(lineCount).toBe(1);
    const description = alert.locator("span").first();
    expect(await description.evaluate(element => {
      const node = element.firstChild!;
      const text = node.textContent!;
      return text.split(" ").every(word => {
        const start = text.indexOf(word); const range = document.createRange();
        range.setStart(node, start); range.setEnd(node, start + word.length);
        return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size === 1;
      });
    })).toBe(true);
    expect((await alert.boundingBox())!.height).toBeLessThanOrEqual(80);
    expect(await alert.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    for (const panelName of ["편집 정보 패널", "도구 및 조명 패널"]) {
      await page.getByRole("button", { name: panelName }).click();
      const panel = panelName === "편집 정보 패널" ? page.getByRole("complementary", { name: "맵 편집 정보" }) : page.getByLabel("도구 및 조명", { exact: true });
      expect((await panel.boundingBox())!.y).toBeGreaterThanOrEqual((await alert.boundingBox())!.y + (await alert.boundingBox())!.height);
      await expectMinimumTouchTargetsAfterScrolling(page, '[data-testid="floor-editor-canvas"] [role="alert"]');
      await page.getByRole("button", { name: panelName }).click();
    }
    await expectNoHorizontalOverflow(page);
    await expectMinimumTouchTargetsAfterScrolling(page, '[data-testid="floor-editor-canvas"] [role="alert"]');
    expect(await retry.evaluate(element => {
      const warning = element.closest('[role="alert"]')!.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(element);
      return [...range.getClientRects()].every(rect => rect.top >= warning.top && rect.bottom <= warning.bottom);
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`settings-retry-${width}-text-${textScale * 100}.png`) });
    const before = imageRequests;
    const mapSize = [await canvas.getAttribute("data-map-width"), await canvas.getAttribute("data-map-height")];
    await retry.click();
    await expect.poll(() => imageRequests).toBe(before + 1);
    await expect(retry).toBeVisible();
    expect(api.atomicSavePayloads).toHaveLength(0);
    expect([await canvas.getAttribute("data-map-width"), await canvas.getAttribute("data-map-height")]).toEqual(mapSize);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });
}
