import { expect, test } from "@playwright/test";
import { installSettingsApiRoutes } from "./support/settings-api";
import { expectNoHorizontalOverflow } from "./support/layout-assertions";

for (const width of [320, 390, 430, 1280]) test(`common header and eager account at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 320 ? 568 : width === 390 ? 844 : 932 });
  await installSettingsApiRoutes(page, "viewer", { readyMapDocument: true });
  await page.goto("/settings?siteId=site-1");
  const header = page.locator("[data-shell-topbar]");
  const site = header.locator("[data-shell-context] button");
  const bell = header.getByRole("button", { name: /^알람센터/ });
  await expect(site).toBeVisible(); await expect(bell).toBeVisible();
  if (width < 760) {
    const siteBox = (await site.boundingBox())!; const bellBox = (await bell.boundingBox())!;
    expect(Math.abs(siteBox.y + siteBox.height / 2 - bellBox.y - bellBox.height / 2)).toBeLessThan(3);
    expect(siteBox.height).toBeGreaterThanOrEqual(44); expect(bellBox.height).toBeGreaterThanOrEqual(44);
  }
  await expect(page.getByRole("button", { name: "로그아웃", exact: true })).toBeVisible();
  await bell.click();
  await expect(page.getByRole("dialog", { name: "알람센터" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "최근 알림" })).toBeVisible();
  await page.getByRole("button", { name: "알람센터 닫기", exact: true }).click();
  await expectNoHorizontalOverflow(page);
});

test("monitoring compact disclosure and single center during full view", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installSettingsApiRoutes(page, "admin", { readyMapDocument: true });
  await page.goto("/monitoring?siteId=site-1");
  const disclosure = page.getByRole("button", { name: "현장 전체 보기", exact: true });
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await disclosure.click(); await expect(page.getByRole("button", { name: "현장 전체 접기", exact: true })).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "현장 전체 접기", exact: true }).click();
  await page.getByRole("button", { name: "지도 전체 보기", exact: true }).click();
  await expect(page.locator("[data-shell-topbar]")).toBeHidden();
  await expect(page.getByRole("button", { name: "전체 보기 종료", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "알람센터", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "알람센터" })).toHaveCount(1);
  await page.getByRole("button", { name: "알람센터 닫기", exact: true }).click();
  await page.getByRole("button", { name: "전체 보기 종료", exact: true }).click();
  await expect(page.locator("[data-shell-topbar]")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

for (const [width, height] of [[320, 568], [390, 844], [430, 932], [1280, 900]]) {
  for (const menu of ["monitoring", "control"]) test(`${menu} actual map first screen at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await installSettingsApiRoutes(page, "admin", { readyMapDocument: true });
    await page.goto(`/${menu}?siteId=site-1`);
    const map = page.getByTestId(menu === "monitoring" ? "monitoring-map-viewport" : "target-selection-map-viewport");
    await expect(map).toBeVisible();
    const viewport = (await map.boundingBox())!;
    await expect(map.locator("[data-floor-map-surface]")).toBeVisible();
    const bounds = (await map.locator("[data-floor-map-surface]").boundingBox())!;
    const nav = width < 760 ? await page.locator('[data-shell-navigation="compact"]').boundingBox() : null;
    const header = (await page.locator("[data-shell-topbar]").boundingBox())!;
    const visible = Math.max(0, Math.min(viewport.y + viewport.height, nav?.y ?? height) - Math.max(header.y + header.height, viewport.y));
    console.log(JSON.stringify({ menu, width, height, header, viewport, surface: bounds, nav, visible, surfaceVisible: Math.max(0, Math.min(bounds.y + bounds.height, viewport.y + viewport.height, (nav?.y ?? height)) - Math.max(0, bounds.y, viewport.y)) }));
    if (width < 760) {
      expect((await page.getByRole("button", { name: /^알람센터/ }).boundingBox())!.height).toBeGreaterThanOrEqual(52);
      const marker = map.locator("[data-spatial-map-marker]").first();
      expect((await marker.boundingBox())!.height).toBeGreaterThanOrEqual(48);
      if (menu === "control") {
        const tab = page.getByRole("tab", { name: "수동 제어" });
        expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        expect((await tab.boundingBox())!.width).toBeGreaterThanOrEqual(112);
      }
    }
    expect(visible).toBeGreaterThanOrEqual(width === 320 ? 120 : 240);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: `../../.superpowers/sdd/2026-10-06-mobile-first-screen/task-2-${menu}-${width}.png` });
  });
}


test("compact selection/execution disclosure and resize preserve pending command UUID without replay", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const posts: string[] = [];
  page.on("request", request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
  const api = await installSettingsApiRoutes(page, "admin", { readyMapDocument: true,
    ids: { siteId: "99999999-9999-4999-8999-999999999901", floorId: "99999999-9999-4999-8999-999999999902", gatewayId: "99999999-9999-4999-8999-999999999903" },
    fixtures: [{ id: "99999999-9999-4999-8999-999999999904", name: "선택 조명", x: 120, y: 140, ratedWatt: 40, brightness: 70,
      status: "online", statusReason: "reported", health: null, rssi: -60, hopCount: 1, commandSuccessRate: 1,
      lastSeenAt: "2026-10-06T00:00:00.000Z", gateway: { id: "99999999-9999-4999-8999-999999999903", name: "Gateway", connectionStatus: "online" },
      controllable: true, controlBlockReason: null }] });
  await page.goto("/control?siteId=99999999-9999-4999-8999-999999999901");
  await page.getByRole("button", { name: "선택 도구 열기" }).click();
  await page.getByRole("button", { name: "조명 목록 열기" }).click();
  const drawer = page.getByRole("dialog", { name: "조명 목록" });
  const choice = drawer.getByRole("checkbox").first();
  await choice.locator("xpath=ancestor::label[1]").click();
  await expect(choice).toBeChecked();
  await drawer.getByRole("button", { name: "조명 목록 닫기" }).click();
  await expect(page.getByRole("button", { name: "조명 목록 열기" })).toBeFocused();
  await page.getByRole("button", { name: "선택 도구 접기" }).click();
  await page.getByRole("button", { name: "밝기 실행 설정 열기" }).click();
  await page.locator("[data-control-submit]").click();
  await expect.poll(() => api.dimmingRequests.length).toBe(1);
  const uuid = api.dimmingRequests[0].clientRequestId;
  await page.getByRole("button", { name: "밝기 실행 설정 접기" }).click();
  await expect(page.getByRole("status", { name: "명령 진행 상태" })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole("textbox", { name: "밝기 수치" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "밝기 실행 설정 열기" })).toHaveAttribute("aria-expanded", "false");
  expect(api.dimmingRequests).toHaveLength(1);
  expect(api.dimmingRequests[0].clientRequestId).toBe(uuid);
  expect(posts).toEqual(["/api/commands/dimming"]);
});
