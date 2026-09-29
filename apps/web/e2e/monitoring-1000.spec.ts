import { expect, test } from "@playwright/test";
import { installSettingsApiRoutes, type SettingsFixture } from "./support/settings-api";

const ids = {
  site: "22222222-2222-4222-8222-222222222222",
  floor: "44444444-4444-4444-8444-444444444444",
  gateway: "77777777-7777-4777-8777-777777777771"
} as const;

const fixtures = Array.from({ length: 1000 }, (_, index) => ({
  id: `33333333-3333-4333-8333-${String(index + 1).padStart(12, "0")}`,
  name: `B2-L${String(index + 1).padStart(4, "0")}`,
  x: 20 + (index % 40) * 29,
  y: 20 + Math.floor(index / 40) * 30,
  size: 20,
  ratedWatt: 40,
  brightness: 70,
  status: "online",
  statusReason: "reported",
  health: { faultCodes: [], observedAt: "2026-07-12T00:00:00.000Z" },
  rssi: -60,
  hopCount: 2,
  commandSuccessRate: 0.99,
  lastSeenAt: "2026-07-12T00:00:00.000Z",
  gateway: { id: ids.gateway, name: "Gateway B2", connectionStatus: "online" },
  controllable: true,
  controlBlockReason: null
} satisfies SettingsFixture));

const mapObjects = [{
  id: "99999999-9999-4999-8999-999999999999",
  type: "rectangle" as const,
  x: 80,
  y: 80,
  width: 1040,
  height: 640,
  points: null,
  rotation: 0,
  strokeColor: "#2563eb",
  fillColor: "#eff6ff",
  strokeWidth: 2,
  text: null,
  fontSize: null,
  zIndex: 0,
  locked: true,
  visible: true
}];

const editorReadinessBudgetMs = 8_000;

function remainingEditorBudget(startedAt: number) {
  return Math.max(1, editorReadinessBudgetMs - (Date.now() - startedAt));
}

test("브라우저 fixture로 1,000개 조명과 지도 객체를 렌더링하고 10분 갱신 경계를 지킨다 (실제 하드웨어 E2E 아님)", async ({ page }) => {
  test.setTimeout(45_000);
  await page.clock.install({ time: new Date("2026-07-12T09:00:00+09:00") });
  const api = await installSettingsApiRoutes(page, "admin", {
    fixtures,
    mapObjects,
    ids: { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway }
  });

  const startedAt = Date.now();
  await page.goto(`/monitoring?siteId=${ids.site}`);
  await expect(page.locator('[data-spatial-map-marker="true"]')).toHaveCount(1000, { timeout: 10_000 });
  expect(Date.now() - startedAt).toBeLessThan(10_000);
  await expect(page.getByRole("button", { name: "B2-L1000 정상 70%" })).toBeVisible();
  const monitoringCanvas = page.getByRole("region", { name: "층 도면" }).locator("canvas");
  await expect.poll(async () => monitoringCanvas.evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext("2d");
    if (!context) return [];
    const scaleX = canvas.width / 1200;
    const scaleY = canvas.height / 800;
    return Array.from(context.getImageData(Math.round(100 * scaleX), Math.round(100 * scaleY), 1, 1).data);
  })).toEqual([239, 246, 255, 255]);

  const requestsBeforeRefreshBoundary = {
    dashboard: api.dashboardRequests,
    fixtures: api.fixturePageRequests,
    map: api.mapSnapshotRequests
  };
  const fixtureCursorRequestsBeforeBoundary = api.fixturePageCursors.length;
  api.updateFixture(fixtures[999].id, { status: "fault", brightness: 15 });
  await page.clock.fastForward(9 * 60 * 1000);
  expect({
    dashboard: api.dashboardRequests,
    fixtures: api.fixturePageRequests,
    map: api.mapSnapshotRequests
  }).toEqual(requestsBeforeRefreshBoundary);
  await expect(page.getByRole("button", { name: "B2-L1000 정상 70%" })).toBeVisible();

  await page.clock.fastForward(61 * 1000);
  await expect.poll(() => api.dashboardRequests).toBe(requestsBeforeRefreshBoundary.dashboard + 1);
  await expect.poll(() => api.fixturePageRequests).toBe(requestsBeforeRefreshBoundary.fixtures + 5);
  await expect.poll(() => api.mapSnapshotRequests).toBe(requestsBeforeRefreshBoundary.map + 1);
  expect(api.fixturePageCursors.slice(fixtureCursorRequestsBeforeBoundary)).toEqual([
    null,
    fixtures[199].id,
    fixtures[399].id,
    fixtures[599].id,
    fixtures[799].id
  ]);
  await expect(page.getByRole("button", { name: "B2-L1000 장애 15%" })).toBeVisible();
});

test("1,000대 편집기는 실제 프레임 시계에서 8초 안에 준비되고 위치 변경을 저장한다", async ({ page }) => {
  // Clock.install은 Date뿐 아니라 RAF/performance와 browser context 전체를 바꾼다.
  // 10분 가상 시간 전진 검증과 실제 렌더링 성능 측정은 별도 context로 격리한다.
  const api = await installSettingsApiRoutes(page, "admin", {
    fixtures, mapObjects, ids: { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway }
  });
  const editorStartedAt = Date.now();
  await page.goto(`/settings/floor-plans/${ids.floor}/edit?siteId=${ids.site}`);
  await expect(page.getByRole("heading", { name: "B2 맵 편집" })).toBeVisible({ timeout: remainingEditorBudget(editorStartedAt) });
  await expect.poll(() => {
    const latestLease = [...api.editorRequests].reverse().find((request) => request.type === "lease-acquire");
    return latestLease?.type === "lease-acquire" && latestLease.result.editable;
  }, { timeout: remainingEditorBudget(editorStartedAt) }).toBe(true);
  const canvas = page.getByTestId("floor-editor-canvas");
  // 편집기는 최초 화면 맞춤을 수행하므로 지도 좌표를 실제 카메라 좌표로 변환한다.
  // 고정 (20,20) 픽셀은 조명이 아니라 화면 맞춤으로 생긴 빈 여백을 검사한다.
  const markerPoint = await page.evaluate(() => {
    const element = document.querySelector("[data-testid='floor-editor-canvas']")!;
    const bounds = element.getBoundingClientRect();
    return { x: bounds.left + 20 * Number(element.getAttribute("data-zoom")) + Number(element.getAttribute("data-pan-x")),
      y: bounds.top + 20 * Number(element.getAttribute("data-zoom")) + Number(element.getAttribute("data-pan-y")) };
  });
  await page.mouse.click(markerPoint.x, markerPoint.y);
  const properties = page.getByRole("complementary", { name: "속성 패널" });
  await expect(properties.getByRole("heading", { name: "B2-L0001" })).toBeVisible({ timeout: remainingEditorBudget(editorStartedAt) });
  expect(Date.now() - editorStartedAt).toBeLessThan(editorReadinessBudgetMs);
  // 8초 내 실제 선택 가능 여부를 먼저 검사하고 별도로 렌더링 픽셀을 확인한다.
  const pixels = await canvas.locator(".konvajs-content canvas").evaluateAll(nodes => nodes.map(node => {
    const element = node as HTMLCanvasElement;
    const host = element.closest("[data-testid='floor-editor-canvas']")!;
    const zoom = Number(host.getAttribute("data-zoom"));
    const point = { x: 20 * zoom + Number(host.getAttribute("data-pan-x")), y: 20 * zoom + Number(host.getAttribute("data-pan-y")) };
    const context = element.getContext("2d");
    return context ? Array.from(context.getImageData(Math.round(point.x), Math.round(point.y), 1, 1).data) : [];
  }));
  expect(pixels).toContainEqual([21, 159, 129, 255]);
  await properties.getByLabel("X").fill("50");
  await properties.getByLabel("X").press("Tab");
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "저장", exact: true }).click();

  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  expect(api.fixtureUpdates).toHaveLength(1);
  expect(api.fixtureUpdates[0]).toMatchObject({ id: fixtures[0].id, x: 50 });
});
