import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { installSettingsApiRoutes, type SettingsFixture } from "./support/settings-api";
import { expectNoHorizontalOverflow, expectMinimumTouchTargetsAfterScrolling } from "./support/layout-assertions";

const ids = { siteId: "22222222-2222-4222-8222-222222222222", floorId: "44444444-4444-4444-8444-444444444444", gatewayId: "77777777-7777-4777-8777-777777777771" };
const row = (index: number): SettingsFixture => ({
  id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`, name: `B2-L${index}`,
  x: index === 1 ? 300 : 900, y: 320, size: 20, ratedWatt: 40, brightness: 70,
  status: index === 2 ? "fault" : "online", statusReason: index === 2 ? "command_failed" : "reported",
  health: null, rssi: -60, hopCount: 2, commandSuccessRate: .99,
  lastSeenAt: "2026-09-29T01:00:00.000Z", gateway: null, controllable: false, controlBlockReason: "fixture_unmapped"
});
async function setup(page: Page, fixtures = [row(1), row(2)]) {
  await installSettingsApiRoutes(page, "admin", { fixtures, ids });
  await page.route(`**/api/sites/${ids.siteId}/floors/${ids.floorId}/monitoring-activity?*`, route =>
    route.fulfill({ json: { generatedAt: new Date().toISOString(), retainedFrom: "2026-06-29T01:00:00.000Z", items: [], nextCursor: null } }));
  await page.goto(`/monitoring?siteId=${ids.siteId}`);
  await expect(page.locator("[data-spatial-map-marker]").first()).toBeVisible();
}
async function geometry(page: Page) {
  return page.getByTestId("monitoring-map-viewport").evaluate(viewport => {
    const shell = viewport.closest("[data-monitoring-map-shell]")!;
    const surface = viewport.querySelector("[data-floor-map-surface]")!;
    const s = surface.getBoundingClientRect(), v = viewport.getBoundingClientRect();
    return { height: shell.getBoundingClientRect().height, scrollX: viewport.scrollLeft, scrollY: viewport.scrollTop,
      bodyX: window.scrollX, bodyY: window.scrollY, zoom: viewport.getAttribute("data-zoom"),
      centerX: (v.left + v.width / 2 - s.left) / s.width, centerY: (v.top + v.height / 2 - s.top) / s.height };
  });
}
for (const width of [1440, 1024, 390, 320]) {
  test(`${width}px 사용자 정보·닫기 안정성·아이콘 전체 보기`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 320 ? 740 : 900 });
    await setup(page);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const full = page.getByRole("button", { name: "지도 전체 보기", exact: true });
    await expect(full).toHaveText("");
    await expect(page.getByRole("button", { name: /상태 확인 결과|기술 정보|집중/ })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    const marker = page.getByRole("button", { name: "B2-L1 정상 70%", exact: true });
    await page.getByTestId("monitoring-map-viewport").evaluate(node => node.scrollIntoView({ block: "center" }));
    await marker.click();
    const pin = page.getByRole("dialog", { name: "B2-L1 조명 정보", exact: true });
    await expect(pin).toBeVisible();
    const initialBounds = await pin.boundingBox();
    expect(initialBounds!.x).toBeGreaterThanOrEqual(0);
    expect(initialBounds!.x + initialBounds!.width).toBeLessThanOrEqual(width);
    const before = await geometry(page);
    await expect(pin.getByRole("button", { name: "조명 정보 닫기" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(pin).toHaveCount(0);
    await expect.poll(() => geometry(page)).toEqual(before);
    await expect(marker).toBeFocused();
    const mapNode = await page.getByTestId("monitoring-map-viewport").elementHandle();
    await full.click();
    await expect(page.getByRole("button", { name: "전체 보기 종료", exact: true })).toBeVisible();
    expect(await mapNode!.evaluate(node => node.isConnected)).toBe(true);
    await expect(page.locator("[data-shell-topbar]")).toBeHidden();
    await expect(page.getByRole("button", { name: "새로고침", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "맵 선택", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "지도 확대", exact: true }).click();
    await expect(page.getByTestId("monitoring-map-viewport")).toHaveAttribute("data-zoom", "1.1");
    await marker.click();
    await expect(pin).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(pin).toHaveCount(0);
    await expect(marker).toBeFocused();
    await expect(page.getByRole("button", { name: "전체 보기 종료", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(full).toBeVisible();
    await expect(full).toBeFocused();
    await expect(page.getByTestId("monitoring-map-viewport")).toHaveAttribute("data-zoom", "1.1");
    await page.getByRole("button", { name: "점검 필요", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "조명 검색·상세", exact: true });
    await expect(drawer.getByRole("list", { name: "조명 목록" }).getByRole("button", { name: /B2-L2/ })).toBeVisible();
    await expect(drawer.getByRole("list", { name: "조명 목록" }).getByRole("button", { name: /B2-L1/ })).toHaveCount(0);
    await drawer.getByRole("list", { name: "조명 목록" }).getByRole("button", { name: /B2-L2/ }).click();
    await expect(drawer).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "B2-L2 조명 정보", exact: true })).toBeVisible();
    const focusedPin = page.getByRole("dialog", { name: "B2-L2 조명 정보", exact: true });
    const focusedBounds = await focusedPin.boundingBox();
    expect(focusedBounds!.x).toBeGreaterThanOrEqual(0);
    expect(focusedBounds!.x + focusedBounds!.width).toBeLessThanOrEqual(width);
    await page.getByRole("button", { name: "상세 보기", exact: true }).click();
    const surface = width >= 1024 ? page.getByRole("complementary", { name: "조명 상세", exact: true }) : page.getByRole("dialog", { name: "조명 상세", exact: true });
    await expect(surface).toBeVisible();
    await expect(focusedPin).toHaveCount(0);
    const detail = surface.getByRole("complementary", { name: "선택 조명 상세" });
    await expect(detail).toContainText("B2-L2");
    await expect(detail).not.toContainText(/RSSI|Hop|Health|정격 전력|지도 좌표|명령 성공률/);
    if (width >= 1024) {
      const close = surface.getByRole("button", { name: "조명 상세 닫기" });
      const boundary = await close.evaluate(button => ({
        closeBottom: button.getBoundingClientRect().bottom,
        bodyTop: button.parentElement!.nextElementSibling!.getBoundingClientRect().top
      }));
      expect(boundary.bodyTop).toBeGreaterThanOrEqual(boundary.closeBottom);
    }
    await expectMinimumTouchTargetsAfterScrolling(page, width >= 1024 ? "aside[aria-label='조명 상세']" : "[data-dialog-variant='sheet']");
    await surface.getByRole("button", { name: "조명 상세 닫기" }).click();
    await expect(focusedPin).toHaveCount(0);
    const returnedMarker = page.getByRole("button", { name: "B2-L2 명령 처리 실패 70%", exact: true });
    await expect(returnedMarker).toBeFocused();
    const returnedBounds = await returnedMarker.boundingBox();
    expect(returnedBounds!.x).toBeGreaterThanOrEqual(0);
    expect(returnedBounds!.x + returnedBounds!.width).toBeLessThanOrEqual(width);
    if (width === 320) {
      const markerBounds = await returnedMarker.boundingBox();
      const navigationBounds = await page.locator('[data-shell-navigation="compact"]').boundingBox();
      expect(markerBounds!.y + markerBounds!.height).toBeLessThan(navigationBounds!.y - 8);
      expect(returnedBounds!.y + returnedBounds!.height).toBeLessThan(navigationBounds!.y - 8);
    }
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: resolve("../..", `.superpowers/sdd/2026-09-29-monitoring-navigation-and-confidence/monitoring-${width}.png`), fullPage: true });
    expect(errors).toEqual([]);
  });
}

test("맵 안의 일반 휠은 포인터 기준으로 확대하고 수평 휠 이동은 무시한다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setup(page);
  const viewport = page.getByTestId("monitoring-map-viewport");
  const box = await viewport.boundingBox();
  const pointer = { x: box!.x + box!.width * .37, y: box!.y + box!.height * .43 };
  const mapPoint = () => viewport.evaluate((node, point) => {
    const surface = node.querySelector<HTMLElement>("[data-floor-map-surface]")!;
    const rect = surface.getBoundingClientRect();
    return { x: (point.x - rect.left) / rect.width, y: (point.y - rect.top) / rect.height };
  }, pointer);
  const before = await mapPoint();
  await page.mouse.move(pointer.x, pointer.y);
  await page.mouse.wheel(0, -120);
  await expect(viewport).toHaveAttribute("data-zoom", "1.1");
  await expect.poll(async () => {
    const after = await mapPoint();
    return Math.abs(after.x - before.x) + Math.abs(after.y - before.y);
  }).toBeLessThan(.04);
  const horizontal = await viewport.evaluate(node => {
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 120, deltaY: 0 });
    return { canceled: !node.dispatchEvent(event), zoom: node.getAttribute("data-zoom") };
  });
  expect(horizontal).toEqual({ canceled: true, zoom: "1.1" });
  await expect(page.getByText("드래그로 이동 · 휠로 확대/축소")).toHaveCount(0);
  await expect(page.getByRole("list", { name: "조명 상태 범례" })).toContainText("장애");
});
test("0개 상태 KPI는 이전 조명의 선택·상세를 보여주지 않는다", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "오프라인", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "조명 검색·상세", exact: true });
  await expect(drawer.getByText("오프라인 조명이 없습니다.")).toBeVisible();
  await expect(drawer.getByRole("button", { name: "상세 조명 선택" })).toHaveCount(0);
  await expect(drawer.getByRole("complementary", { name: "선택 조명 상세" })).toHaveCount(0);
  await drawer.getByRole("button", { name: "전체 조명 보기" }).click();
  await expect(drawer.getByRole("button", { name: "상세 조명 선택" })).toBeVisible();
});
test("상세에서 다른 조명을 선택하면 원래 핀 정보로 돌아가지 않는다", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "B2-L2 명령 처리 실패 70%", exact: true }).click();
  await page.getByRole("dialog", { name: "B2-L2 조명 정보" }).getByRole("button", { name: "상세 보기" }).click();
  await page.getByRole("button", { name: "조명 상세 닫기" }).click();
  await page.getByRole("button", { name: "조명 검색·상세", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "조명 검색·상세", exact: true });
  await drawer.getByRole("button", { name: "상세 조명 선택" }).click();
  await page.getByRole("option", { name: "B2-L1 · 정상" }).click();
  await drawer.getByRole("button", { name: "조명 검색·상세 닫기" }).click();
  await expect(page.getByRole("button", { name: "B2-L1 정상 70%", exact: true })).toHaveAttribute("aria-current", "true");
  await expect(page.getByRole("dialog", { name: "B2-L2 조명 정보" })).toHaveCount(0);
});
test("camera restores on reload without saving fixture or selection data", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "지도 확대", exact: true }).click();
  await expect(page.getByTestId("monitoring-map-viewport")).toHaveAttribute("data-zoom", "1.1");
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("led-monitoring-camera:")).length)).toBe(1);
  await page.reload();
  await expect(page.getByTestId("monitoring-map-viewport")).toHaveAttribute("data-zoom", "1.1");
});
test("common map full view retains the native renderer canvas and zoom", async ({ page }) => {
  await installSettingsApiRoutes(page, "admin", { fixtures: [row(1), row(2)], ids, readyMapDocument: true });
  await page.goto(`/monitoring?siteId=${ids.siteId}`);
  // Canvas는 접근성에서 숨긴 overlay 안에 있고 별도 HTML 마커가 읽기 입력을 제공한다.
  const canvas = page.getByRole("img", { name: "맵 도형", exact: true, includeHidden: true }).locator("canvas");
  await expect(canvas).toBeVisible();
  const nativeCanvas = await canvas.elementHandle();
  await page.getByRole("button", { name: "지도 확대", exact: true }).click();
  await page.getByRole("button", { name: "지도 전체 보기", exact: true }).click();
  await expect(page.getByRole("button", { name: "전체 보기 종료", exact: true })).toBeVisible();
  expect(await nativeCanvas!.evaluate(node => node.isConnected)).toBe(true);
  await expect(page.getByTestId("monitoring-map-viewport")).toHaveAttribute("data-zoom", "1.1");
  await page.getByRole("button", { name: "전체 보기 종료", exact: true }).click();
  await expect(page.getByRole("button", { name: "지도 전체 보기", exact: true })).toBeVisible();
  expect(await nativeCanvas!.evaluate(node => node.isConnected)).toBe(true);
  await expect(page.getByTestId("monitoring-map-viewport")).toHaveAttribute("data-zoom", "1.1");
});
test("a fault on the last cursor page can be located from its KPI", async ({ page }) => {
  const fixtures = Array.from({ length: 1000 }, (_, index) => ({ ...row(index + 1), status: index === 999 ? "fault" as const : "online" as const, statusReason: "reported" as const }));
  await setup(page, fixtures);
  await expect(page.locator("[data-spatial-map-marker]")).toHaveCount(1000);
  await page.getByRole("button", { name: "점검 필요", exact: true }).click();
  const list = page.getByRole("list", { name: "조명 목록" });
  await expect(list.getByRole("button")).toHaveCount(1);
  await list.getByRole("button", { name: /B2-L1000/ }).click();
  await expect(page.getByRole("dialog", { name: "B2-L1000 조명 정보", exact: true })).toBeVisible();
});
test("next-page failure stops automatic loops, preserves the KPI, and offers manual retry", async ({ page }) => {
  const fixtures = Array.from({ length: 401 }, (_, index) => ({ ...row(index + 1), status: index === 400 ? "fault" as const : "online" as const, statusReason: "reported" as const }));
  await installSettingsApiRoutes(page, "admin", { fixtures, ids });
  let blocked = true, failures = 0;
  await page.route(`**/api/sites/${ids.siteId}/floors/${ids.floorId}/fixtures?*`, route => {
    if (blocked && new URL(route.request().url()).searchParams.has("cursor")) {
      failures++; return route.fulfill({ status: 503, json: { message: "unavailable" } });
    }
    return route.fallback();
  });
  await page.goto(`/monitoring?siteId=${ids.siteId}`);
  await page.getByRole("button", { name: "점검 필요", exact: true }).click();
  await expect(page.getByText("일부 조명만 표시 중입니다. 다음 조명 보기를 눌러 다시 시도해 주세요.")).toBeVisible();
  await expect(page.getByText("검색 결과가 없습니다.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "점검 필요", exact: true })).toContainText("1");
  expect(failures).toBe(3); // Existing query policy retries twice, then pagination must stop.
  blocked = false;
  await page.getByRole("button", { name: "다음 조명 보기", exact: true }).click();
  await expect(page.getByRole("list", { name: "조명 목록" }).getByRole("button", { name: /B2-L401/ })).toBeVisible();
  expect(failures).toBe(3);
});
