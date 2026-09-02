import { expect, test, type Page } from "@playwright/test";
import { expectMinimumTouchTargetsAfterScrolling, expectNoHorizontalOverflow } from "./support/layout-assertions";
import { installSettingsApiRoutes, type SettingsFixture } from "./support/settings-api";

const ids = {
  site: "66666666-6666-4666-8666-666666666601",
  floor: "66666666-6666-4666-8666-666666666602",
  gateway: "66666666-6666-4666-8666-666666666603",
  fixture: "66666666-6666-4666-8666-666666666604"
} as const;

const scheduleIds = {
  APPLIED: "66666666-6666-4666-8666-666666666611",
  REJECTED: "66666666-6666-4666-8666-666666666612"
} as const;

const eventIds = {
  enabled: "66666666-6666-4666-8666-666666666621",
  disabled: "66666666-6666-4666-8666-666666666622"
} as const;

const viewports = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 320, height: 740 }
] as const;

for (const viewport of viewports) {
  test(`${viewport.width}px 자동화 목록과 편집기는 상태와 스크롤 계약을 유지한다`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installAutomationFixture(page);

    await page.goto(`/control?siteId=${ids.site}&mode=schedule`);
    await expect(page.getByRole("table", { name: "스케줄 목록" })).toBeVisible();
    await expect(page.getByText("적용됨")).toBeVisible();
    await expect(page.getByText("적용 실패")).toBeVisible();
    await expect(page.getByText("모두 성공 · 성공 1개").first()).toBeVisible();
    await expectReachableColumns(page, ".automation-table-wrap");
    await expectNoHorizontalOverflow(page);

    await page.getByRole("button", { name: "스케줄 추가" }).click();
    const scheduleDialog = page.getByRole("dialog", { name: "스케줄 추가" });
    await expect(scheduleDialog.getByRole("group", { name: "운영 기간과 시간" })).toBeVisible();
    await expect(scheduleDialog.getByRole("group", { name: "제어 대상", exact: true })).toBeVisible();
    await expectDialogInsideViewport(scheduleDialog, viewport);
    if (viewport.width <= 760) await expectMinimumTouchTargetsAfterScrolling(page, ".schedule-dialog");
    await scheduleDialog.getByRole("button", { name: "스케줄 추가 닫기" }).click();

    await page.getByRole("tab", { name: "이벤트 제어" }).click();
    await expect(page.getByRole("table", { name: "차량 이벤트 목록" })).toBeVisible();
    await expect(page.getByText("최근 감지 없음").first()).toBeVisible();
    await expect(page.getByText("비활성")).toBeVisible();
    await expectReachableColumns(page, ".automation-table-wrap");
    await expectNoHorizontalOverflow(page);

    await page.getByRole("button", { name: "이벤트 추가" }).click();
    const eventDialog = page.getByRole("dialog", { name: "이벤트 추가" });
    await expect(eventDialog.getByRole("group", { name: "감지 센서" })).toBeVisible();
    await expect(eventDialog.getByRole("group", { name: "제어 조명" })).toBeVisible();
    await expect(eventDialog.getByRole("group", { name: "행동" })).toBeVisible();
    await expectDialogInsideViewport(eventDialog, viewport);
    if (viewport.width <= 760) await expectMinimumTouchTargetsAfterScrolling(page, ".schedule-dialog");
  });
}

test("자동화 빈 목록과 조회 실패는 실제 추가와 재시도 동작을 제공한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // React Query retries initial requests three times; the fourth failure reaches the visible retry state.
  await installAutomationFixture(page, { schedules: [], events: [], scheduleFailures: 4, eventFailures: 4 });

  await page.goto(`/control?siteId=${ids.site}&mode=schedule`);
  await expect(page.getByRole("alert")).toContainText("스케줄 목록을 불러오지 못했습니다.", { timeout: 12_000 });
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByText("등록된 스케줄이 없습니다.")).toBeVisible();
  await expect(page.getByRole("button", { name: "스케줄 추가" })).toBeVisible();

  await page.getByRole("tab", { name: "이벤트 제어" }).click();
  await expect(page.getByRole("alert")).toContainText("이벤트 규칙 목록을 불러오지 못했습니다.", { timeout: 12_000 });
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByText("등록된 이벤트 규칙이 없습니다.")).toBeVisible();
  await expect(page.getByRole("button", { name: "이벤트 추가" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

async function installAutomationFixture(
  page: Page,
  options: { schedules?: unknown[]; events?: unknown[]; scheduleFailures?: number; eventFailures?: number } = {}
) {
  await installSettingsApiRoutes(page, "admin", {
    ids: { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway },
    fixtures: [fixture()]
  });
  const schedules = options.schedules ?? [schedule("적용 스케줄", "APPLIED"), schedule("실패 스케줄", "REJECTED")];
  const events = options.events ?? [eventRule("입구 차량 감지", "enabled"), eventRule("야간 차량 감지", "disabled")];
  let scheduleFailures = options.scheduleFailures ?? 0;
  let eventFailures = options.eventFailures ?? 0;

  await page.route("**/api/sites/*/automation/schedules**", async (route) => {
    if (scheduleFailures > 0) {
      scheduleFailures -= 1;
      return route.fulfill({ status: 503, json: { message: "schedule unavailable" } });
    }
    return route.fulfill({ json: { items: schedules, total: schedules.length, nextCursor: null } });
  });
  await page.route("**/api/sites/*/automation/vehicle-event-rules**", async (route) => {
    if (eventFailures > 0) {
      eventFailures -= 1;
      return route.fulfill({ status: 503, json: { message: "event unavailable" } });
    }
    return route.fulfill({ json: { items: events, total: events.length, nextCursor: null } });
  });
}

function fixture(): SettingsFixture {
  return {
    id: ids.fixture,
    name: "B1-L001",
    x: 100,
    y: 100,
    ratedWatt: 40,
    brightness: 70,
    status: "online",
    health: { faultCodes: [], observedAt: "2026-09-01T00:00:00.000Z" },
    rssi: -55,
    hopCount: 1,
    commandSuccessRate: 1,
    lastSeenAt: "2026-09-01T00:00:00.000Z",
    gateway: { id: ids.gateway, name: "GW-B1", connectionStatus: "online" },
    controllable: true,
    controlBlockReason: null
  };
}

function schedule(name: string, syncStatus: "APPLIED" | "REJECTED") {
  return {
    id: scheduleIds[syncStatus],
    name,
    status: "enabled",
    activeFrom: "2026-09-01T03:00:00.000Z",
    activeUntil: "2026-09-30T03:00:00.000Z",
    localStartTime: "18:00",
    localEndTime: "23:00",
    recurrence: { kind: "daily", weeklyDays: [], monthlyDay: null, yearlyMonth: null, yearlyDay: null },
    action: { dimmingEnabled: true, brightnessPercent: 70 },
    fixtureIds: [ids.fixture],
    gatewayId: ids.gateway,
    targets: [{ fixtureId: ids.fixture }],
    targetCount: 1,
    desiredRevision: 2,
    appliedRevision: syncStatus === "APPLIED" ? 2 : 1,
    syncStatus,
    nextOccurrence: null,
    lastExecution: {
      id: `execution-${syncStatus}`,
      eventId: `event-${syncStatus}`,
      sequence: "1",
      revision: 2,
      occurrenceKey: "2026-09-01",
      kind: "action_result",
      occurredAt: "2026-09-01T10:00:00.000Z",
      payload: { sourceType: "schedule", sourceId: scheduleIds[syncStatus], results: [{ fixtureId: ids.fixture, status: "succeeded", brightnessPercent: 70, faultCode: null, errorCode: null, occurredAt: "2026-09-01T10:00:00.000Z" }] }
    },
    createdById: "user-1",
    updatedById: "user-1",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z"
  };
}

function eventRule(name: string, status: "enabled" | "disabled") {
  return {
    id: eventIds[status],
    name,
    status,
    sourceFixtureIds: [ids.fixture],
    targetFixtureIds: [ids.fixture],
    action: { dimmingEnabled: true, brightnessPercent: 80 },
    holdSeconds: 60,
    gatewayId: ids.gateway,
    sources: [{ fixtureId: ids.fixture }],
    targets: [{ fixtureId: ids.fixture }],
    sourceCount: 1,
    targetCount: 1,
    desiredRevision: 2,
    appliedRevision: 2,
    syncStatus: "APPLIED",
    lastDetection: null,
    lastExecution: null,
    createdById: "user-1",
    updatedById: "user-1",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z"
  };
}

async function expectReachableColumns(page: Page, selector: string) {
  const tableWrap = page.locator(selector).last();
  await tableWrap.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  const scroll = await tableWrap.evaluate((element) => ({ left: element.scrollLeft, width: element.scrollWidth, clientWidth: element.clientWidth }));
  if (scroll.width > scroll.clientWidth) expect(scroll.left).toBeGreaterThan(0);
}

async function expectDialogInsideViewport(dialog: ReturnType<Page["getByRole"]>, viewport: { width: number; height: number }) {
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
}
