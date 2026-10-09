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
  // mouse.click은 locator처럼 자동 스크롤하지 않는다. 공통 헤더가 늘어난
  // 문서 흐름에서는 full canvas의 안정된 크기만으로 조명이 화면 안에 있지 않다.
  // 캔버스 휠은 카메라를 확대하므로 실제 문서 소유 헤더에서 한 번만 도달한다.
  const documentReach = await canvas.evaluate(node => {
    const bounds = node.getBoundingClientRect();
    const header = document.querySelector<HTMLElement>("[data-shell-topbar]");
    if (!header) return null;
    const headerBounds = header.getBoundingClientRect();
    const point = { x: headerBounds.left + 4, y: headerBounds.top + 12 };
    const hit = document.elementFromPoint(point.x, point.y);
    const owner = document.scrollingElement;
    const outsideCanvas = point.x < bounds.left || point.x >= bounds.right || point.y < bounds.top || point.y >= bounds.bottom;
    const documentOwned = owner === document.documentElement || owner === document.body;
    const hitHeader = hit === header || Boolean(hit && header.contains(hit));
    return { point, outsideCanvas, documentOwned, hitHeader, documentY: scrollY, deltaY: Math.max(0, bounds.top) };
  });
  expect(documentReach).not.toBeNull();
  expect(documentReach!.outsideCanvas && documentReach!.documentOwned && documentReach!.hitHeader).toBe(true);
  expect(Number.isFinite(documentReach!.deltaY)).toBe(true);
  if (documentReach!.deltaY > 0) {
    await page.mouse.move(documentReach!.point.x, documentReach!.point.y);
    await page.mouse.wheel(0, documentReach!.deltaY);
    await expect.poll(() => page.evaluate(() => scrollY), { timeout: remainingEditorBudget(editorStartedAt) }).toBeGreaterThan(documentReach!.documentY);
  }
  // 편집기는 최초 화면 맞춤을 수행하므로 지도 좌표를 실제 카메라 좌표로 변환한다.
  // 고정 (20,20) 픽셀은 조명이 아니라 화면 맞춤으로 생긴 빈 여백을 검사한다.
  // Lease 응답은 ResizeObserver와 맞춤 카메라의 commit 완료를 뜻하지 않는다.
  // 새 DOM 원점과 이전 카메라를 섞지 않도록 실제 두 연속 프레임의 일치를
  // 원래 8초 예산 안에서 확인한다. 선택이나 카메라는 테스트에서 변경하지 않는다.
  const markerPointHandle = await page.waitForFunction(async () => {
    const readFittedFrame = () => {
      const element = document.querySelector<HTMLElement>("[data-testid='floor-editor-canvas']");
      if (!element || element.getAttribute("aria-disabled") !== "false") return null;
      const bounds = element.getBoundingClientRect();
      const zoom = Number(element.dataset.zoom), panX = Number(element.dataset.panX), panY = Number(element.dataset.panY);
      const mapWidth = Number(element.dataset.mapWidth), mapHeight = Number(element.dataset.mapHeight);
      if (![bounds.width, bounds.height, zoom, panX, panY, mapWidth, mapHeight].every(Number.isFinite)
        || bounds.width <= 0 || bounds.height <= 0 || zoom <= 0 || mapWidth <= 0 || mapHeight <= 0) return null;
      const content = element.querySelector<HTMLElement>(".konvajs-content");
      const layers = [...element.querySelectorAll<HTMLCanvasElement>(".konvajs-content canvas")];
      // CSS subpixel/backing-store rounding may differ by at most one CSS pixel.
      const matchesBounds = (rect: DOMRect) => [rect.left - bounds.left, rect.top - bounds.top,
        rect.width - bounds.width, rect.height - bounds.height].every(delta => Math.abs(delta) < 0.5);
      if (!content || !matchesBounds(content.getBoundingClientRect()) || !layers.length
        || layers.some(layer => !matchesBounds(layer.getBoundingClientRect())
          || Math.abs(layer.width / devicePixelRatio - bounds.width) > 1
          || Math.abs(layer.height / devicePixelRatio - bounds.height) > 1)) return null;
      // Initial fit's existing 48px margin/zoom limits, using current map bounds.
      // Stage dimensions alone can commit before the separate camera-fit effect.
      const fittedZoom = Math.min(2, Math.max(0.001, Math.min((bounds.width - 48) / mapWidth, (bounds.height - 48) / mapHeight)));
      const fittedPanX = (bounds.width - mapWidth * fittedZoom) / 2;
      const fittedPanY = (bounds.height - mapHeight * fittedZoom) / 2;
      if (Math.abs(zoom - fittedZoom) > 0.000001 || Math.abs(panX - fittedPanX) > 0.000001
        || Math.abs(panY - fittedPanY) > 0.000001) return null;
      return { tuple: [bounds.left, bounds.top, bounds.width, bounds.height, zoom, panX, panY, mapWidth, mapHeight],
        point: { x: bounds.left + 20 * zoom + panX, y: bounds.top + 20 * zoom + panY } };
    };
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const first = readFittedFrame();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const second = readFittedFrame();
    return first && second && first.tuple.every((value, index) => value === second.tuple[index]) ? second.point : false;
  }, undefined, { polling: "raf", timeout: remainingEditorBudget(editorStartedAt) });
  const markerPoint = await markerPointHandle.jsonValue() as { x: number; y: number };
  await markerPointHandle.dispose();
  const acquiredTarget = await canvas.evaluate((node, point) => {
    const bounds = node.getBoundingClientRect(), hit = document.elementFromPoint(point.x, point.y);
    return { point, documentY: scrollY, zoom: (node as HTMLElement).dataset.zoom,
      inViewport: point.x >= 0 && point.x < innerWidth && point.y >= 0 && point.y < innerHeight,
      inHost: point.x >= bounds.left && point.x < bounds.right && point.y >= bounds.top && point.y < bounds.bottom,
      hitHost: hit === node || Boolean(hit && node.contains(hit)) };
  }, markerPoint);
  expect(acquiredTarget.inViewport && acquiredTarget.inHost && acquiredTarget.hitHost).toBe(true);
  console.log("MONITORING_1000_NATIVE_DOCUMENT_REACH", JSON.stringify({ documentReach, acquiredTarget }));
  await page.mouse.click(markerPoint.x, markerPoint.y);
  const properties = page.getByRole("complementary", { name: "속성 패널" });
  await expect(properties.getByRole("heading", { name: "B2-L0001" })).toBeVisible({ timeout: remainingEditorBudget(editorStartedAt) });
  expect(Date.now() - editorStartedAt).toBeLessThan(editorReadinessBudgetMs);
  // 기본 연결 색은 #159f81로 유지되지만 고객 shell은 승인된 상태 역할을 alias한다.
  // 캔버스에서 기대값을 만들지 않고 실제 root 역할과 고정 고객 RGBA를 각각 검증한다.
  const customerConnectedRole = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute("data-customer-theme"),
    role: getComputedStyle(document.documentElement).getPropertyValue("--color-fixture-editor-connected").trim()
  }));
  expect(customerConnectedRole.theme).toBe("light");
  expect(customerConnectedRole.role.toLowerCase()).toBe("#187445");
  console.log("MONITORING_1000_CUSTOMER_CONNECTED_ROLE", JSON.stringify({ ...customerConnectedRole, approvedRgba: [24, 116, 69, 255] }));
  // 8초 내 실제 선택 가능 여부를 먼저 검사하고 별도로 렌더링 픽셀을 확인한다.
  const pixels = await canvas.locator(".konvajs-content canvas").evaluateAll(nodes => nodes.map(node => {
    const element = node as HTMLCanvasElement;
    const host = element.closest("[data-testid='floor-editor-canvas']")!;
    const zoom = Number(host.getAttribute("data-zoom"));
    const point = { x: 20 * zoom + Number(host.getAttribute("data-pan-x")), y: 20 * zoom + Number(host.getAttribute("data-pan-y")) };
    const context = element.getContext("2d");
    return context ? Array.from(context.getImageData(Math.round(point.x), Math.round(point.y), 1, 1).data) : [];
  }));
  expect(pixels).toContainEqual([24, 116, 69, 255]);
  await properties.getByLabel("X").fill("50");
  await properties.getByLabel("X").press("Tab");
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "저장", exact: true }).click();

  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  expect(api.fixtureUpdates).toHaveLength(1);
  expect(api.fixtureUpdates[0]).toMatchObject({ id: fixtures[0].id, x: 50 });
});
