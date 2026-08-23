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
  await page.goto("/");
  await expect(page.locator(".fixture-dot")).toHaveCount(1000, { timeout: 10_000 });
  expect(Date.now() - startedAt).toBeLessThan(10_000);
  await expect(page.getByRole("button", { name: "B2-L1000 정상 70%" })).toBeVisible();
  const monitoringCanvas = page.getByRole("region", { name: "층 도면" }).locator(".floor-scene-canvas canvas");
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

  const editorStartedAt = Date.now();
  await page.goto(`/settings/floor-plans/${ids.floor}/edit?siteId=${ids.site}`);
  await expect(page.getByRole("heading", { name: "B2 도면 편집" })).toBeVisible({ timeout: remainingEditorBudget(editorStartedAt) });
  await expect.poll(() => {
    const latestLease = [...api.editorRequests].reverse().find((request) => request.type === "lease-acquire");
    return latestLease?.type === "lease-acquire" && latestLease.result.editable;
  }, { timeout: remainingEditorBudget(editorStartedAt) }).toBe(true);
  const canvas = page.getByLabel("B2 편집 캔버스");
  await expect.poll(async () => canvas.locator("canvas").first().evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext("2d");
    return context ? Array.from(context.getImageData(20, 20, 1, 1).data) : [];
  }), { timeout: remainingEditorBudget(editorStartedAt) }).toEqual([32, 201, 151, 255]);
  await canvas.click({ position: { x: 20, y: 20 }, force: true, timeout: remainingEditorBudget(editorStartedAt) });
  const properties = page.getByRole("complementary", { name: "속성 패널" });
  await expect(properties.getByRole("heading", { name: "B2-L0001" })).toBeVisible({ timeout: remainingEditorBudget(editorStartedAt) });
  expect(Date.now() - editorStartedAt).toBeLessThan(editorReadinessBudgetMs);
  await properties.getByLabel("X").fill("50");
  await page.getByRole("button", { name: "저장", exact: true }).click();

  await expect(page).toHaveURL(`/settings/floor-plans?siteId=${ids.site}`);
  expect(api.fixtureUpdates).toHaveLength(1);
  expect(api.fixtureUpdates[0]).toMatchObject({ id: fixtures[0].id, x: 50 });
});
