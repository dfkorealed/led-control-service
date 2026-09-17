import { expect, test, type Page } from "@playwright/test";
import { expectMinimumTouchTargetsAfterScrolling, expectNoHorizontalOverflow } from "./support/layout-assertions";
import { installSettingsApiRoutes, type SettingsFixture, type SettingsRole } from "./support/settings-api";

const ids = {
  site: "99999999-9999-4999-8999-999999999901",
  floor: "99999999-9999-4999-8999-999999999902",
  gateway: "99999999-9999-4999-8999-999999999903",
  fixture: "99999999-9999-4999-8999-999999999904",
  fixtureTwo: "99999999-9999-4999-8999-999999999905",
  sensor: "99999999-9999-4999-8999-999999999906",
  group: "99999999-9999-4999-8999-999999999907",
  createdGroup: "99999999-9999-4999-8999-999999999908"
} as const;

const fixtures: SettingsFixture[] = [
  fixture(ids.fixture, "B2-L001", 120, 120),
  fixture(ids.fixtureTwo, "B2-L002", 600, 360),
  fixture(ids.sensor, "B2-SENSOR-001", 1_000, 300, {
    vehicleSensorCapabilityStatus: "supported",
    vehicleSensorCapabilityVerifiedAt: "2026-09-01T00:00:00.000Z"
  })
];

test.use({ timezoneId: "Asia/Seoul" });

test("manual map selection stays synchronized with the list and command payload", async ({ page }) => {
  let commandBody: Record<string, unknown> | null = null;
  await installControlMapRoutes(page, { onDimmingCommand: (body) => { commandBody = body; } });
  await page.goto(`/control?siteId=${ids.site}`);

  await marker(page, "B2-L001").click();
  await expect(marker(page, "B2-L001")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "조명 목록 열기" }).click();
  await expect(page.getByRole("checkbox", { name: "B2-L001 선택" })).toBeChecked();
  await page.getByRole("button", { name: "조명 목록 닫기" }).click();
  await page.getByRole("button", { name: "1개 조명에 밝기 적용" }).click();

  expect(commandBody).toMatchObject({
    target: { type: "fixture", fixtureId: ids.fixture },
    brightness: 70
  });
});

test("schedule group authoring stores the current group fixture snapshot in its request", async ({ page }) => {
  const api = await installControlMapRoutes(page);
  await page.goto(`/control?siteId=${ids.site}&mode=schedule`);
  await page.getByRole("button", { name: "스케줄 추가" }).click();
  const dialog = page.getByRole("dialog", { name: "스케줄 추가" });
  await dialog.getByRole("button", { name: "제어 대상 선택" }).click();
  await page.getByRole("button", { name: "저장된 구역" }).click();
  await page.getByRole("button", { name: "B2 입구" }).click();
  await page.getByRole("button", { name: "2개 조명 선택 완료" }).click();
  await dialog.getByRole("button", { name: "스케줄 만들기" }).click();

  expect(api.scheduleRequests).toHaveLength(1);
  // A group is an authoring shortcut; the persisted automation contract is an immutable fixture snapshot.
  expect(api.scheduleRequests[0]).toMatchObject({
    target: { type: "fixtures", fixtureIds: [ids.fixture, ids.fixtureTwo] }
  });
});

test("event group target authoring sends sorted current target fixture IDs", async ({ page }) => {
  const api = await installControlMapRoutes(page);
  await page.goto(`/control?siteId=${ids.site}&mode=schedule`);
  await page.getByRole("tab", { name: "이벤트 제어" }).click();
  await page.getByRole("button", { name: "이벤트 추가" }).click();
  const dialog = page.getByRole("dialog", { name: "이벤트 추가" });
  await dialog.getByRole("button", { name: "감지 센서 선택" }).click();
  await page.getByRole("button", { name: "조명 목록 열기" }).click();
  await page.getByRole("checkbox", { name: "B2-SENSOR-001 선택" }).locator("xpath=ancestor::label").click();
  await page.getByRole("button", { name: "선택 완료", exact: true }).click();
  await page.getByRole("button", { name: "1개 조명 선택 완료" }).click();
  await dialog.getByRole("button", { name: "실행할 조명 선택" }).click();
  await page.getByRole("button", { name: "저장된 구역" }).click();
  await page.getByRole("button", { name: "B2 입구" }).click();
  await page.getByRole("button", { name: "2개 조명 선택 완료" }).click();
  await dialog.getByRole("button", { name: "저장" }).click();

  expect(api.eventRequests).toHaveLength(1);
  expect(api.eventRequests[0]).toMatchObject({
    sourceFixtureIds: [ids.sensor],
    targetFixtureIds: [ids.fixture, ids.fixtureTwo]
  });
});

test("creating a group renders its configuring Mesh lifecycle", async ({ page }) => {
  await installControlMapRoutes(page);
  await page.goto(`/control?siteId=${ids.site}`);
  await page.getByRole("button", { name: "구역 관리" }).click();
  await page.getByRole("button", { name: "새 구역" }).click();
  const dialog = page.getByRole("dialog", { name: "구역 생성" });
  await dialog.getByLabel("구역 이름").fill("야간 동선");
  const editor = dialog.getByTestId("fixture-group-map-editor");
  await editor.getByRole("button", { name: "층", exact: true }).click();
  await page.getByRole("option", { name: "B2" }).click();
  await editor.getByRole("button", { name: "게이트웨이", exact: true }).click();
  await page.getByRole("option", { name: "Gateway B2" }).click();
  await editor.getByRole("button", { name: "조명 목록 열기" }).click();
  await page.getByRole("checkbox", { name: "B2-L001 선택" }).locator("xpath=ancestor::label").click();
  await page.getByRole("button", { name: "선택 완료" }).click();
  await dialog.getByRole("button", { name: "구역 만들기" }).click();
  await expect(page.getByText("Mesh 설정 중", { exact: true })).toBeVisible();
});

test("a 404 floor map opens the list fallback", async ({ page }) => {
  await installControlMapRoutes(page, { mapStatus: 404 });
  await page.goto(`/control?siteId=${ids.site}`);

  await expect(page.getByRole("heading", { name: "조명 밝기 제어", exact: true })).toBeVisible();
  await expect(page.getByText("등록된 도면이 없어 목록으로 선택합니다.")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "조명 목록" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "B2-L001 선택" })).toBeVisible();
});

test("viewer control redirect issues no mutating request", async ({ page }) => {
  const api = await installControlMapRoutes(page, { role: "viewer" });
  await page.goto(`/control?siteId=${ids.site}`);

  await expect(page).toHaveURL(new RegExp(`/monitoring\\?siteId=${ids.site}$`));
  expect(api.postRequests).toEqual([]);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }] as const) {
  test(`desktop control at ${viewport.width}x${viewport.height} keeps page fixed while map, history, and detail scroll internally`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installControlMapRoutes(page, { fixtureCount: 80 });
    await page.goto(`/control?siteId=${ids.site}`);
    await expect(page.getByRole("heading", { name: "조명 밝기 제어", exact: true })).toBeVisible();

    const dimensions = (selector: string) => page.locator(selector).evaluate((element: HTMLElement) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY
    }));
    const [documentMetrics, map, history, detail] = await Promise.all([
      page.evaluate(() => ({ clientHeight: document.documentElement.clientHeight, scrollHeight: document.documentElement.scrollHeight })),
      page.getByRole("region", { name: "B2 도면" }).evaluate((element: HTMLElement) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        overflowY: getComputedStyle(element).overflowY
      })),
      dimensions("[data-command-history-list]"),
      dimensions("[data-target-selection-detail-panel]")
    ]);
    const metrics = { document: documentMetrics, map, history, detail };
    expect(metrics.document.scrollHeight).toBeLessThanOrEqual(metrics.document.clientHeight + 1);
    expect(metrics.map.overflowY).toMatch(/auto|scroll/);
    expect(metrics.history.overflowY).toBe("auto");
    expect(metrics.detail.overflowY).toBe("auto");
  });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 740 }] as const) {
  test(`mobile control fits ${viewport.width}x${viewport.height} with map marker touch targets and action above compact navigation`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installControlMapRoutes(page);
    await page.goto(`/control?siteId=${ids.site}`);
    await expect(page.getByRole("heading", { name: "조명 밝기 제어", exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const moveControl = page.getByRole("button", { name: "지도 이동" });
    await moveControl.scrollIntoViewIfNeeded();
    const moveControlOwnsCenter = await moveControl.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      return hit === element || Boolean(hit && element.contains(hit));
    });
    expect(moveControlOwnsCenter).toBe(true);
    await expectMinimumTouchTargetsAfterScrolling(page, "[data-control-screen]");

    await page.getByRole("button", { name: "선택 대상 펼치기" }).click();
    const action = page.getByRole("button", { name: /밝기 적용/ });
    const navigation = page.locator('[data-shell-navigation="compact"]');
    await action.scrollIntoViewIfNeeded();
    const [actionBox, navigationBox] = await Promise.all([action.boundingBox(), navigation.boundingBox()]);
    expect(actionBox).not.toBeNull();
    expect(navigationBox).not.toBeNull();
    if (!actionBox || !navigationBox) return;
    expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(navigationBox.y);
  });
}

for (const mode of ["pan", "select", "area"] as const) {
  test(`synthetic browser two-pointer pinch in ${mode} mode zooms without an area rectangle or post-lift jump (not native WebView HIL)`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installControlMapRoutes(page);
    await page.goto(`/control?siteId=${ids.site}`);
    await expect(page.getByRole("heading", { name: "조명 밝기 제어", exact: true })).toBeVisible();
    await page.getByRole("button", { name: mode === "pan" ? "지도 이동" : mode === "select" ? "조명 선택" : "영역 선택" }).click();
    const viewport = page.getByRole("region", { name: "B2 도면" });
    await expect(viewport).toBeVisible();

    await dispatchTouchPointer(page, viewport, "pointerdown", { pointerId: 11, pointerType: "touch", button: 0, clientX: 100, clientY: 180 });
    await dispatchTouchPointer(page, viewport, "pointerdown", { pointerId: 12, pointerType: "touch", button: 0, clientX: 180, clientY: 180 });
    await dispatchTouchPointer(page, viewport, "pointermove", { pointerId: 12, pointerType: "touch", button: 0, clientX: 260, clientY: 180 });
    await expect.poll(async () => Number(await viewport.getAttribute("data-zoom"))).toBeGreaterThan(1);
    await expect(page.getByTestId("map-area-selection")).toHaveCount(0);

    const afterPinch = await viewport.evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop }));
    await dispatchTouchPointer(page, viewport, "pointerup", { pointerId: 12, pointerType: "touch", button: 0, clientX: 260, clientY: 180 });
    await dispatchTouchPointer(page, viewport, "pointermove", { pointerId: 11, pointerType: "touch", button: 0, clientX: 110, clientY: 180 });
    await expect.poll(() => viewport.evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop }))).toEqual(afterPinch);
  });
}

type FixtureOptions = Partial<Pick<SettingsFixture, "vehicleSensorCapabilityStatus" | "vehicleSensorCapabilityVerifiedAt">>;

function fixture(id: string, name: string, x: number, y: number, options: FixtureOptions = {}): SettingsFixture {
  return {
    id, name, x, y, size: 20, ratedWatt: 40, brightness: 70, status: "online",
    health: { faultCodes: [], observedAt: "2026-09-01T00:00:00.000Z" }, rssi: -55, hopCount: 1, commandSuccessRate: 1,
    lastSeenAt: "2026-09-01T00:00:00.000Z", gateway: { id: ids.gateway, name: "Gateway B2", connectionStatus: "online" },
    controllable: true, controlBlockReason: null, ...options
  };
}

function marker(root: Page | ReturnType<Page["getByRole"]>, name: string) {
  return root.locator(`[data-spatial-map-marker="true"][aria-label^="${name}"]`);
}

async function dispatchTouchPointer(
  page: Page,
  target: ReturnType<Page["locator"]>,
  type: string,
  init: Record<string, string | number>
) {
  await target.evaluate((element, { eventType, eventInit }) => {
    // Playwright's plain dispatchEvent initializer creates Event, which drops PointerEvent-only IDs.
    element.dispatchEvent(new PointerEvent(eventType, {
      bubbles: true,
      cancelable: true,
      isPrimary: eventInit.pointerId === 11,
      ...eventInit
    }));
  }, { eventType: type, eventInit: init });
}

async function installControlMapRoutes(page: Page, options: {
  onDimmingCommand?: (body: Record<string, unknown>) => void;
  mapStatus?: number;
  role?: SettingsRole;
  fixtureCount?: number;
} = {}) {
  const fixtureData = options.fixtureCount
    ? Array.from({ length: options.fixtureCount }, (_, index) => fixture(
      `99999999-9999-4999-8999-${String(1000 + index).padStart(12, "0")}`,
      `B2-L${String(index + 1).padStart(3, "0")}`,
      30 + (index % 10) * 100,
      30 + Math.floor(index / 10) * 80
    ))
    : fixtures;
  const api = await installSettingsApiRoutes(page, options.role ?? "admin", {
    fixtures: fixtureData,
    ids: { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway }
  });
  const groups = [{ id: ids.group, name: "B2 입구", floorId: ids.floor, gatewayId: ids.gateway, lifecycleStatus: "active", fixtureCount: 2,
    meshControlGroup: { status: "ready", version: 1, error: null }, fixtureIds: [ids.fixture, ids.fixtureTwo] }];
  const state = { scheduleRequests: [] as Record<string, unknown>[], eventRequests: [] as Record<string, unknown>[], postRequests: [] as string[] };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === "POST") state.postRequests.push(path);
    if (path === `/api/sites/${ids.site}/dashboard`) {
      return route.fulfill({ json: dashboardResponse(fixtureData, groups, options.role ?? "admin") });
    }
    if (path === `/api/sites/${ids.site}/floors/${ids.floor}/map-snapshot` && options.mapStatus) {
      return route.fulfill({ status: options.mapStatus, json: { message: "map unavailable" } });
    }
    if (path === `/api/sites/${ids.site}/fixture-groups`) {
      if (request.method() === "GET") return route.fulfill({ json: groups });
      if (request.method() === "POST") {
        const input = request.postDataJSON() as Record<string, unknown>;
        const created = { ...groups[0], id: ids.createdGroup, name: input.name, fixtureCount: Array.isArray(input.fixtureIds) ? input.fixtureIds.length : 0,
          meshControlGroup: { status: "configuring", version: 1, error: null } };
        groups.push(created);
        return route.fulfill({ status: 201, json: created });
      }
    }
    if (path === `/api/sites/${ids.site}/automation/schedules`) {
      if (request.method() === "GET") return route.fulfill({ json: { items: [], total: 0, nextCursor: null } });
      if (request.method() === "POST") {
        const input = request.postDataJSON() as Record<string, unknown>;
        state.scheduleRequests.push(input);
        return route.fulfill({ status: 201, json: scheduleResponse(input) });
      }
    }
    if (path === `/api/sites/${ids.site}/automation/vehicle-event-rules`) {
      if (request.method() === "GET") return route.fulfill({ json: { items: [], total: 0, nextCursor: null } });
      if (request.method() === "POST") {
        const input = request.postDataJSON() as Record<string, unknown>;
        state.eventRequests.push(input);
        return route.fulfill({ status: 201, json: eventResponse(input) });
      }
    }
    if (path === "/api/commands/dimming" && request.method() === "POST") {
      options.onDimmingCommand?.(request.postDataJSON() as Record<string, unknown>);
    }
    return route.fallback();
  });
  return { ...api, ...state };
}

function scheduleResponse(input: Record<string, unknown>) {
  const fixtureIds = ((input.target as { fixtureIds?: string[] } | undefined)?.fixtureIds ?? []).slice();
  return { id: "99999999-9999-4999-8999-999999999910", ...input, fixtureIds, gatewayId: ids.gateway, targets: fixtureIds.map((fixtureId) => ({ fixtureId })), targetCount: fixtureIds.length,
    desiredRevision: 1, appliedRevision: 0, syncStatus: "PENDING", nextOccurrence: null, lastExecution: null,
    createdById: "admin-user-1", updatedById: "admin-user-1", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };
}

function eventResponse(input: Record<string, unknown>) {
  const sourceFixtureIds = (input.sourceFixtureIds as string[] | undefined) ?? [];
  const targetFixtureIds = (input.targetFixtureIds as string[] | undefined) ?? [];
  return { id: "99999999-9999-4999-8999-999999999911", ...input, gatewayId: ids.gateway,
    sources: sourceFixtureIds.map((fixtureId) => ({ fixtureId })), targets: targetFixtureIds.map((fixtureId) => ({ fixtureId })),
    sourceCount: sourceFixtureIds.length, targetCount: targetFixtureIds.length, desiredRevision: 1, appliedRevision: 0, syncStatus: "PENDING",
    lastDetection: null, lastExecution: null, createdById: "admin-user-1", updatedById: "admin-user-1", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };
}

function dashboardResponse(fixtureData: SettingsFixture[], groups: Array<Record<string, unknown>>, role: SettingsRole) {
  return {
    generatedAt: "2026-09-01T00:00:00.000Z",
    monitoringPolicy: { gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 180 },
    capabilities: role === "admin"
      ? { read: true, control: true, manage: true, commission: true }
      : { read: true, control: false, manage: false, commission: false },
    site: { id: ids.site, name: "고객사 B2 현장", customerName: "고객사", installationStatus: "installed", address: "서울", tariffKwhRate: 160, timeZone: "Asia/Seoul" },
    summary: { totalFixtures: fixtureData.length, onlineFixtures: fixtureData.length, faultFixtures: 0, averageBrightness: 70 },
    floors: [{ id: ids.floor, name: "B2", level: -2, floorPlan: null, meshControlGroups: [{ gatewayId: ids.gateway, status: "ready", version: 1, error: null }], fixtures: fixtureData }],
    groups,
    gateways: [{ id: ids.gateway, name: "Gateway B2", serialNumber: "GW-E2E-001", firmwareVersion: "e2e", lastHeartbeatAt: "2026-09-01T00:00:00.000Z", connectionStatus: "online" }]
  };
}
