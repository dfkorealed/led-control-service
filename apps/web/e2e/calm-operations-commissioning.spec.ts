import { expect, test, type Browser, type Page } from "@playwright/test";
import { expectMinimumTouchTargetsAfterScrolling, expectNoHorizontalOverflow } from "./support/layout-assertions";
import { installSettingsApiRoutes } from "./support/settings-api";
import type { RegistrationSession } from "../src/api/registration";

const viewports = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 320, height: 740 }
] as const;

const ids = {
  site: "22222222-2222-4222-8222-222222222222",
  floor: "44444444-4444-4444-8444-444444444444",
  gateway: "77777777-7777-4777-8777-777777777771"
} as const;

const scanTimeline = {
  sessionStartedAt: "2026-08-26T00:00:00.000Z",
  firstScanStartedAt: "2026-08-26T00:00:10.000Z",
  firstNodeDiscoveredAt: "2026-08-26T00:00:20.000Z",
  firstScanCompletedAt: "2026-08-26T00:00:30.000Z",
  retryScanStartedAt: "2026-08-26T00:00:40.000Z",
  retryScanCompletedAt: "2026-08-26T00:00:50.000Z"
} as const;

const discoveredNode = {
  id: "66666666-6666-4666-8666-666666666666",
  sessionId: "88888888-8888-4888-8888-888888888888",
  deviceUuid: "44464b4c454401010101aabbccddeeff",
  serialNumber: "LC-B2-001",
  rssi: -54,
  oobCapability: "static-oob",
  firmwareVersion: "1.0.0",
  status: "discovered" as const,
  identifyState: "idle",
  meshAddress: null,
  errorMessage: null,
  scanCorrelationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  scanAttempt: 1,
  discoveredAt: scanTimeline.firstNodeDiscoveredAt
};

function registrationSession(
  scanStatus: RegistrationSession["scanStatus"],
  nodes: RegistrationSession["discoveredNodes"],
  scanAttempt = 1
): RegistrationSession {
  const isRetry = scanAttempt > 1;
  const scanStartedAt = scanStatus === "pending"
    ? null
    : isRetry ? scanTimeline.retryScanStartedAt : scanTimeline.firstScanStartedAt;
  const scanCompletedAt = scanStatus === "completed"
    ? isRetry ? scanTimeline.retryScanCompletedAt : scanTimeline.firstScanCompletedAt
    : null;
  return {
    id: discoveredNode.sessionId,
    siteId: ids.site,
    floorId: ids.floor,
    gatewayId: ids.gateway,
    requestedBy: "99999999-9999-4999-8999-999999999999",
    status: "active",
    scanStatus,
    scanCorrelationId: discoveredNode.scanCorrelationId,
    scanAttempt,
    scanStartedAt,
    scanCompletedAt,
    scanFailureCode: null,
    scanFailureMessage: null,
    startedAt: scanTimeline.sessionStartedAt,
    completedAt: null,
    discoveredNodes: nodes
  };
}

for (const viewport of viewports) {
  test(`commissioning states stay responsive at ${viewport.width}px`, async ({ browser, baseURL }) => {
    await withFixturePage(browser, baseURL, viewport, async (page) => {
      await installSettingsApiRoutes(page, "admin", { installationStatus: "pending", ids: fixtureIds() });
      await page.goto(`/settings?siteId=${ids.site}`);
      await expect(page.getByRole("heading", { name: "현장 기본 정보를 입력하세요" })).toBeVisible();
      await expect(page.getByRole("list", { name: "현장 설치 진행" })).toContainText("Gateway 연결");
      await page.getByLabel("주소").fill("서울시 강남구");
      await expectNoHorizontalOverflow(page);
      await expectCommissioningActionsReachable(page, ["주소 미입력", "층 자동 생성"], viewport.width);
      await page.getByRole("button", { name: "층 자동 생성" }).click();
      await expectNoHorizontalOverflow(page);
      await expect(page.getByRole("button", { name: "초기 설정 완료" })).toBeEnabled();
      await expectCommissioningActionsReachable(page, ["초기 설정 완료"], viewport.width);
    });

    await withFixturePage(browser, baseURL, viewport, async (page) => {
      await installSettingsApiRoutes(page, "viewer", { installationStatus: "pending", ids: fixtureIds() });
      await page.goto(`/settings?siteId=${ids.site}`);
      await expect(page.getByRole("region", { name: "Viewer 설치 대기" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "게이트웨이 등록" })).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
      await expectMobileRegionTargetsReachable(page, ".bottom-nav", viewport.width);
    });

    await withFixturePage(browser, baseURL, viewport, async (page) => {
      await installSettingsApiRoutes(page, "admin", { fixtures: [], includeGateway: false, ids: fixtureIds() });
      await page.goto(`/settings?siteId=${ids.site}`);
      await expect(page.getByRole("region", { name: "Gateway 연결" })).toBeVisible();
      await page.getByLabel("제품 시리얼").fill("GW-E2E-NEW");
      await page.getByLabel("일회성 등록 코드").fill("claim-code");
      await expect(page.getByRole("button", { name: "게이트웨이 등록" })).toBeEnabled();
      await expectNoHorizontalOverflow(page);
      await expectCommissioningActionsReachable(page, ["게이트웨이 등록"], viewport.width);
    });

    await withFixturePage(browser, baseURL, viewport, async (page) => {
      await page.clock.install({ time: new Date(scanTimeline.sessionStartedAt) });
      const pending = registrationSession("pending", []);
      const scanning = registrationSession("scanning", []);
      const completed = registrationSession("completed", []);
      await installSettingsApiRoutes(page, "admin", {
        fixtures: [],
        ids: fixtureIds(),
        gatewayHeartbeatAt: scanTimeline.sessionStartedAt,
        registrationSession: pending,
        registrationPollingSessions: [scanning, completed]
      });
      await page.goto(`/settings?siteId=${ids.site}`);
      await selectRegistrationTargets(page);
      await expectCommissioningActionsReachable(page, ["조명 검색 시작"], viewport.width);
      await startSearch(page);
      await expect(page.getByRole("status", { name: "조명 검색 상태" })).toHaveText("검색 중");
      await expect(page.getByText("검색된 미등록 조명이 없습니다.")).toHaveCount(0);
      await page.clock.fastForward(1500);
      await expect(page.getByText("검색된 미등록 조명이 없습니다.")).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });

    await withFixturePage(browser, baseURL, viewport, async (page) => {
      await page.clock.install({ time: new Date(scanTimeline.firstScanCompletedAt) });
      const completed = registrationSession("completed", []);
      const retryPending = registrationSession("pending", [], 2);
      const retryScanning = registrationSession("scanning", [], 2);
      const retryCompleted = registrationSession("completed", [], 2);
      await installSettingsApiRoutes(page, "admin", {
        fixtures: [],
        ids: fixtureIds(),
        gatewayHeartbeatAt: scanTimeline.firstScanCompletedAt,
        activeRegistrationSessions: [completed],
        registrationRetrySession: retryPending,
        registrationPollingSessions: [retryScanning, retryCompleted]
      });
      await page.goto(`/settings?siteId=${ids.site}`);
      await expect(page.getByText("검색된 미등록 조명이 없습니다.")).toBeVisible();
      await expectCommissioningActionsReachable(page, ["다시 검색", "등록 세션 취소"], viewport.width);
      await page.getByRole("button", { name: "다시 검색" }).click();
      await expect(page.getByRole("status", { name: "조명 검색 상태" })).toHaveText("검색 중");
      await expect(page.getByText("검색된 미등록 조명이 없습니다.")).toHaveCount(0);
      await page.clock.fastForward(1500);
      await expect(page.getByText("검색된 미등록 조명이 없습니다.")).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });

    await withFixturePage(browser, baseURL, viewport, async (page) => {
      const discovered = registrationSession("completed", [discoveredNode]);
      await installSettingsApiRoutes(page, "admin", { fixtures: [], ids: fixtureIds(), activeRegistrationSessions: [discovered] });
      await page.goto(`/settings?siteId=${ids.site}`);
      await expect(page.getByLabel("조명 1 선택")).toBeVisible();
      await page.getByLabel("조명 1 선택").check();
      await expect(page.getByRole("button", { name: "선택 조명 등록" })).toBeEnabled();
      await expectCommissioningActionsReachable(page, ["선택 조명 등록"], viewport.width);
      await page.getByRole("radio", { name: "개별 설정" }).check();
      await page.getByLabel("조명 1 X 좌표").fill("120");
      await page.getByRole("button", { name: "선택 조명 등록" }).click();
      await expect(page.locator(".individual-error")).toHaveText("X와 Y 좌표를 모두 입력하거나 모두 비워주세요.");
      await expectNoHorizontalOverflow(page);
      await expectCommissioningActionsReachable(page, ["선택 조명 등록"], viewport.width);
    });

    await withFixturePage(browser, baseURL, viewport, async (page) => {
      const reconcile = registrationSession("completed", [{ ...discoveredNode, status: "reconcile_required", errorMessage: "Gateway ACK 확인 필요" }]);
      await installSettingsApiRoutes(page, "admin", { fixtures: [], ids: fixtureIds(), activeRegistrationSessions: [reconcile] });
      await page.goto(`/settings?siteId=${ids.site}`);
      await expect(page.getByRole("list", { name: "조명 등록 진행" })).toContainText("상태 확인");
      await expectCommissioningActionsReachable(page, ["상태 다시 확인"], viewport.width);
      await page.getByLabel("장비 상태를 확인했으며 현재 세션에서 제외").check();
      await expect(page.getByRole("button", { name: "현재 세션에서 제외" })).toBeEnabled();
      await expectNoHorizontalOverflow(page);
      await expectCommissioningActionsReachable(page, ["현재 세션에서 제외"], viewport.width);
    });
  });
}

function fixtureIds() {
  return { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway };
}

async function startSearch(page: Page) {
  await page.getByRole("button", { name: "조명 검색 시작" }).click();
}

async function selectRegistrationTargets(page: Page) {
  await page.getByLabel("등록 층").selectOption(ids.floor);
  await page.getByLabel("등록 게이트웨이").selectOption(ids.gateway);
}

async function expectCommissioningActionsReachable(page: Page, actionNames: readonly string[], width: number) {
  if (width > 760) return;
  for (const [actionIndex, actionName] of actionNames.entries()) {
    const action = page.getByRole("button", { name: actionName });
    await expect(action).toBeEnabled();
    await expectCommissioningActionReachable(page, action, actionIndex);
  }
}

async function expectMobileRegionTargetsReachable(page: Page, selector: string, width: number) {
  if (width <= 760) await expectMinimumTouchTargetsAfterScrolling(page, selector);
}

async function expectCommissioningActionReachable(page: Page, action: ReturnType<Page["getByRole"]>, actionIndex: number) {
  const marker = `commissioning-action-${actionIndex}`;
  await action.evaluate((element, dataMarker) => {
    const wrapper = document.createElement("span");
    wrapper.setAttribute("data-e2e-commissioning-action", dataMarker);
    wrapper.style.display = "contents";
    element.before(wrapper);
    wrapper.append(element);
  }, marker);
  try {
    await expectMinimumTouchTargetsAfterScrolling(page, `[data-e2e-commissioning-action="${marker}"]`);
  } finally {
    await page.locator(`[data-e2e-commissioning-action="${marker}"]`).evaluateAll((wrappers) => {
      wrappers.forEach((wrapper) => wrapper.replaceWith(...wrapper.childNodes));
    });
  }
}

async function withFixturePage(
  browser: Browser,
  baseURL: string | undefined,
  viewport: { width: number; height: number },
  run: (page: Page) => Promise<void>
) {
  const page = await browser.newPage({ baseURL, viewport });
  try {
    await run(page);
  } finally {
    await page.close();
  }
}
