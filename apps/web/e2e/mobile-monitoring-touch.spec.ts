import { expect, test, type CDPSession, type Locator, type Page, type TestInfo } from "@playwright/test";
import { installSettingsApiRoutes, type SettingsFixture } from "./support/settings-api";
import { expectNoHorizontalOverflow } from "./support/layout-assertions";

const ids = { siteId: "99999999-9999-4999-8999-000000000001", floorId: "99999999-9999-4999-8999-000000000002", gatewayId: "99999999-9999-4999-8999-000000000003" };
const fixture: SettingsFixture = {
  id: "99999999-9999-4999-8999-000000000101", name: "모바일 입구 조명", x: 350, y: 250, size: 20,
  ratedWatt: 40, brightness: 70, status: "online", statusReason: "reported", health: null,
  rssi: -60, hopCount: 1, commandSuccessRate: 1, lastSeenAt: "2026-10-03T01:00:00.000Z",
  gateway: { id: ids.gatewayId, name: "모바일 게이트웨이", connectionStatus: "online" },
  controllable: true, controlBlockReason: null
};

async function setup(page: Page) {
  const api = await installSettingsApiRoutes(page, "admin", { ids, fixtures: [fixture] });
  await page.route("**/api/**/monitoring-activity?*", route => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    return route.fulfill({ json: {
      generatedAt: "2026-10-03T01:00:00.000Z", retainedFrom: "2026-07-03T01:00:00.000Z",
      items: Array.from({ length: 5 }, (_, index) => ({
        id: `99999999-9999-4999-8999-${String(200 + index + (cursor ? 5 : 0)).padStart(12, "0")}`,
        kind: "fixture_online", recordedAt: "2026-10-03T01:00:00.000Z",
        displayName: `모바일 운영 기록 ${index + 1 + (cursor ? 5 : 0)}`
      })), nextCursor: cursor ? null : "mobile-page-2"
    } });
  });
  await page.goto(`/monitoring?siteId=${ids.siteId}`);
  return api;
}

async function frame(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function capture(page: Page, info: TestInfo, label: string) {
  const path = info.outputPath(`${label}-${page.viewportSize()!.width}.png`);
  await page.screenshot({ path });
  await info.attach(label, { path, contentType: "image/png" });
}

// CDP dispatches browser touch input (including its default scroll behavior).
// No DOM scrollTop/focus/style writes or synthetic dispatchEvent can stand in
// for the nested-scroll defect this regression is meant to detect.
async function swipe(cdp: CDPSession, page: Page, x: number, fromY: number, toY: number) {
  const point = (y: number) => ({ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(fromY)] });
  for (let step = 1; step <= 8; step++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(fromY + (toY - fromY) * step / 8)] });
    await frame(page);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await frame(page);
}

async function scrollState(dialog: Locator) {
  return dialog.evaluate(node => ({ top: node.scrollTop, client: node.clientHeight, total: node.scrollHeight,
    overflow: getComputedStyle(node).overflowY,
    panels: [...node.querySelectorAll('[data-monitoring-detail-panel]')].map(panel => ({
      top: panel.scrollTop, client: panel.clientHeight, total: panel.scrollHeight,
      overflow: getComputedStyle(panel).overflowY, overscroll: getComputedStyle(panel).overscrollBehaviorY
    })) }));
}

async function visibleHit(target: Locator, port: Locator) {
  const clip = (await port.boundingBox())!;
  return target.evaluate((node, clip) => {
    const r = node.getBoundingClientRect();
    const left = Math.max(0, r.left, clip.x), right = Math.min(innerWidth, r.right, clip.x + clip.width);
    const top = Math.max(0, r.top, clip.y), bottom = Math.min(innerHeight, r.bottom, clip.y + clip.height);
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    return bottom > top && right > left && (node === hit || node.contains(hit));
  }, clip);
}

test.use({ hasTouch: true, isMobile: true });

for (const width of [320, 390]) {
  test(`${width}px touch inspector scroll reaches final fixture information`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 480 }); const api = await setup(page);
    const cdp = await page.context().newCDPSession(page);
    const observations: unknown[] = [];
    try {
      await page.getByRole("button", { name: "조명 검색·상세", exact: true }).tap();
      const dialog = page.getByRole("dialog", { name: "조명 검색·상세", exact: true });
      const panel = dialog.getByRole("complementary", { name: "선택 조명 상세", exact: true });
      await expect(panel).toContainText(fixture.name);
      const box = (await panel.boundingBox())!, screen = page.viewportSize()!;
      const top = Math.max(100, box.y + 16), bottom = Math.min(screen.height - 24, box.y + box.height - 16);
      expect(bottom - top).toBeGreaterThan(44);
      expect(await visibleHit(panel, dialog)).toBe(true);
      const before = await scrollState(dialog);
      expect(before.total).toBeGreaterThan(before.client);
      await swipe(cdp, page, width / 2, bottom, top);
      observations.push({ before, after: await scrollState(dialog) });
      await expect.poll(() => dialog.evaluate(node => node.scrollTop)).toBeGreaterThan(before.top);
      const last = panel.getByText("배치됨", { exact: true });
      for (let step = 0; step < 5 && !await visibleHit(last, dialog); step++) {
        await swipe(cdp, page, width / 2, 420, 130);
        observations.push(await scrollState(dialog));
      }
      expect(await visibleHit(last, dialog)).toBe(true);
      await expectNoHorizontalOverflow(page);
      await capture(page, info, "inspector-touch-screen");
      await dialog.getByRole("button", { name: "조명 검색·상세 닫기", exact: true }).tap();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("button", { name: "조명 검색·상세", exact: true })).toBeFocused();
      expect(api.dimmingRequests).toHaveLength(0);
    } finally {
      await info.attach("inspector-scroll-owners", { body: JSON.stringify(observations), contentType: "application/json" });
      await cdp.detach();
    }
  });

  test(`${width}px touch log reaches last row and cursor controls`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 480 }); const api = await setup(page);
    const cdp = await page.context().newCDPSession(page);
    try {
      await page.getByRole("region", { name: "최근 운영 로그", exact: true }).getByRole("button", { name: "전체 보기", exact: true }).tap();
      const dialog = page.getByRole("dialog", { name: "전체 로그", exact: true });
      await expect(dialog.getByRole("listitem")).toHaveCount(5);
      for (let step = 0; step < 5 && !await visibleHit(dialog.getByRole("button", { name: "다음", exact: true }), dialog); step++) {
        await swipe(cdp, page, width / 2, 410, 120);
      }
      expect(await visibleHit(dialog.getByRole("listitem").last(), dialog)).toBe(true);
      const next = dialog.getByRole("button", { name: "다음", exact: true });
      expect(await visibleHit(next, dialog)).toBe(true);
      const nextBox = (await next.boundingBox())!;
      expect(nextBox.width).toBeGreaterThanOrEqual(44); expect(nextBox.height).toBeGreaterThanOrEqual(44);
      await next.tap(); await expect(dialog.getByRole("listitem").last()).toContainText("모바일 운영 기록 10");
      await dialog.getByRole("button", { name: "이전", exact: true }).tap();
      await expect(dialog.getByRole("listitem").last()).toContainText("모바일 운영 기록 5");
      await expectNoHorizontalOverflow(page);
      await capture(page, info, "log-touch-screen");
      await dialog.getByRole("button", { name: "전체 로그 닫기", exact: true }).tap();
      await expect(dialog).toHaveCount(0);
      expect(api.dimmingRequests).toHaveLength(0);
    } finally { await cdp.detach(); }
  });

  test(`${width}px native touch marker and pinch keep camera inside map`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 720 }); const api = await setup(page);
    const cdp = await page.context().newCDPSession(page);
    try {
      await page.getByRole("button", { name: "지도 전체 보기", exact: true }).tap();
      const viewport = page.getByTestId("monitoring-map-viewport");
      const marker = page.locator('[data-spatial-map-marker][title="모바일 입구 조명"]');
      await marker.tap();
      const pin = page.getByRole("dialog", { name: "모바일 입구 조명 조명 정보", exact: true });
      await expect(pin).toBeVisible();
      // Exercise the touch toggle, not desktop Escape propagation, and wait
      // for the overlay to close before measuring the pinch input coordinates.
      await marker.tap(); await expect(pin).toHaveCount(0);
      await expect(page.getByRole("button", { name: "전체 보기 종료", exact: true })).toBeVisible();
      const box = (await viewport.boundingBox())!;
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      const point = (id: number, offset: number) => ({ id, x: x + offset, y, radiusX: 2, radiusY: 2, force: 1 });
      const before = await viewport.getAttribute("data-zoom");
      const pageY = await page.evaluate(() => scrollY);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(1, -35), point(2, 35)] });
      for (let step = 1; step <= 6; step++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(1, -35 - step * 5), point(2, 35 + step * 5)] });
        await frame(page);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect.poll(async () => Number(await viewport.getAttribute("data-zoom"))).toBeGreaterThan(Number(before));
      await expect(pin).toHaveCount(0);
      expect(await page.evaluate(() => scrollY)).toBe(pageY);
      // A fitted map need not have a pan range. Enlarge through the real UI
      // before asserting native one-finger movement, not by changing CSS bounds.
      for (let step = 0; step < 10; step++) await page.getByRole("button", { name: "지도 확대", exact: true }).tap();
      const panBefore = await viewport.evaluate(node => ({ top: node.scrollTop, range: node.scrollHeight - node.clientHeight }));
      expect(panBefore.range).toBeGreaterThan(0);
      const panBox = (await viewport.boundingBox())!;
      const upper = panBox.y + panBox.height * .3, lower = panBox.y + panBox.height * .7;
      await swipe(cdp, page, panBox.x + panBox.width * .75, panBefore.top > 0 ? upper : lower, panBefore.top > 0 ? lower : upper);
      await expect.poll(() => viewport.evaluate(node => node.scrollTop)).not.toBe(panBefore.top);
      await expect(pin).toHaveCount(0);
      expect(await page.evaluate(() => scrollY)).toBe(pageY);
      await marker.tap(); await expect(pin).toBeVisible();
      await capture(page, info, "map-touch-screen");
      expect(api.dimmingRequests).toHaveLength(0);
    } finally { await cdp.detach(); }
  });
}
