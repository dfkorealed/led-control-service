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
  discoveredAt: scanTimeline.firstNodeDiscoveredAt,
  registrationEligibility: "available" as const,
  existingRegistration: null
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
      await expectCommissioningActionsReachable(page, ["주소 미입력", "맵 생성"], viewport.width);
      await expectMobileRegionTargetsReachable(page, '[data-testid="site-setup-flow"]', viewport.width);
      await page.getByRole("button", { name: "맵 생성", exact: true }).click();
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
      await expectMobileRegionTargetsReachable(page, '[data-shell-navigation="compact"]', viewport.width);
    });

    await withFixturePage(browser, baseURL, viewport, async (page) => {
      await installSettingsApiRoutes(page, "admin", { fixtures: [], includeGateway: false, ids: fixtureIds() });
      await page.goto(`/settings/registration?siteId=${ids.site}`);
      await expect(page.getByRole("region", { name: "Gateway 연결" })).toBeVisible();
      await page.getByLabel("제품 시리얼").fill("GW-E2E-NEW");
      await page.getByLabel("일회성 등록 코드").fill("claim-code");
      await expect(page.getByRole("button", { name: "게이트웨이 등록" })).toBeEnabled();
      await expectNoHorizontalOverflow(page);
      await expectCommissioningActionsReachable(page, ["게이트웨이 등록"], viewport.width);
      await expectMobileRegionTargetsReachable(page, '[data-testid="gateway-claim-form"]', viewport.width);
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
      await page.goto(`/settings/registration?siteId=${ids.site}`);
      await selectRegistrationTargets(page);
      await expectCommissioningActionsReachable(page, ["조명 검색 시작"], viewport.width);
      await startSearch(page);
      await expect(page.getByRole("status", { name: "조명 검색 상태" })).toHaveText("검색 중");
      await expectRegistrationStepStates(page, ["current", "pending", "pending", "pending"]);
      await expect(page.getByText("검색된 미등록 조명이 없습니다.")).toHaveCount(0);
      await page.clock.fastForward(1500);
      await expect(page.getByText("검색된 미등록 조명이 없습니다.")).toBeVisible();
      await expectRegistrationStepStates(page, ["complete", "current", "pending", "pending"]);
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
      await page.goto(`/settings/registration?siteId=${ids.site}`);
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
      await page.goto(`/settings/registration?siteId=${ids.site}`);
      await expect(page.getByLabel("조명 1 선택")).toBeVisible();
      await clickChoice(page, "checkbox", "조명 1 선택");
      await expectRegistrationStepStates(page, ["complete", "current", "pending", "pending"]);
      await expect(page.getByRole("button", { name: "선택 조명 등록" })).toBeEnabled();
      await expectCommissioningActionsReachable(page, ["선택 조명 등록"], viewport.width);
      await expectMobileRegionTargetsReachable(page, '[data-testid="fixture-config-form"]', viewport.width);
      await clickChoice(page, "radio", "개별 설정");
      await page.getByLabel("조명 1 이름").fill("입구 조명");
      await expect(page.getByLabel("조명 1 이름")).toHaveValue("입구 조명");
      await expectNoHorizontalOverflow(page);
      await expectCommissioningActionsReachable(page, ["선택 조명 등록"], viewport.width);
      await expectMobileRegionTargetsReachable(page, '[data-testid="commissioning-registration"]', viewport.width);
    });

    await withFixturePage(browser, baseURL, viewport, async (page) => {
      const reconcile = registrationSession("completed", [{ ...discoveredNode, status: "reconcile_required", errorMessage: "Gateway ACK 확인 필요" }]);
      await installSettingsApiRoutes(page, "admin", { fixtures: [], ids: fixtureIds(), activeRegistrationSessions: [reconcile] });
      await page.goto(`/settings/registration?siteId=${ids.site}`);
      await expectRegistrationStepStates(page, ["complete", "complete", "complete", "current"]);
      await expect(page.getByText("게이트웨이 장비 응답 확인 필요")).toBeVisible();
      await expect(page.getByText("Gateway ACK 확인 필요")).toHaveCount(0);
      await expectCommissioningActionsReachable(page, ["상태 다시 확인"], viewport.width);
      await clickChoice(page, "checkbox", "장비가 등록되지 않았거나 초기화된 상태임을 확인");
      await expect(page.getByRole("button", { name: "현재 세션에서 제외" })).toBeEnabled();
      await expectNoHorizontalOverflow(page);
      await expectCommissioningActionsReachable(page, ["현재 세션에서 제외"], viewport.width);
      await expectMobileRegionTargetsReachable(page, '[data-testid="commissioning-registration"]', viewport.width);
    });
  });
}

test("registration separates available and existing devices and submits only the available node", async ({ page }) => {
  const availableNode = {
    ...discoveredNode,
    serialNumber: "AVAILABLE-SERIAL-001",
    deviceUuid: "available-device-uuid"
  };
  const registeredInSiteNode = {
    ...discoveredNode,
    id: "66666666-6666-4666-8666-666666666667",
    serialNumber: "SAME-SITE-SERIAL-002",
    deviceUuid: "same-site-device-uuid",
    registrationEligibility: "registered_in_site" as const,
    existingRegistration: {
      fixtureId: "fixture-existing",
      fixtureName: "기존 복도등",
      floorId: "floor-existing",
      floorName: "지하 1층"
    }
  };
  const registeredElsewhereNode = {
    ...discoveredNode,
    id: "66666666-6666-4666-8666-666666666668",
    serialNumber: "FOREIGN-SERIAL-MUST-NOT-RENDER",
    deviceUuid: "foreign-device-uuid-must-not-render",
    registrationEligibility: "registered_elsewhere" as const,
    existingRegistration: null
  };
  const session = registrationSession("completed", [
    availableNode,
    registeredInSiteNode,
    registeredElsewhereNode
  ]);
  const api = await installSettingsApiRoutes(page, "admin", {
    fixtures: [],
    ids: fixtureIds(),
    activeRegistrationSessions: [session]
  });

  await page.goto(`/settings/registration?siteId=${ids.site}`);

  const availableSelection = page.getByLabel("조명 1 선택");
  const nodeSelectionControls = page.getByLabel(/^조명 \d+ 선택$/);
  await expect(page.getByText(availableNode.serialNumber)).toBeVisible();
  await expect(availableSelection).toBeEnabled();
  await expect(nodeSelectionControls).toHaveCount(1);
  await expect(page.getByText(registeredInSiteNode.serialNumber)).not.toBeVisible();
  await expect(page.getByText(registeredInSiteNode.existingRegistration.fixtureName)).not.toBeVisible();
  await expect(page.getByText(registeredInSiteNode.existingRegistration.floorName)).not.toBeVisible();
  await expect(page.getByText(registeredElsewhereNode.serialNumber)).toHaveCount(0);
  await expect(page.getByText(registeredElsewhereNode.deviceUuid)).toHaveCount(0);

  await page.getByText("기존 등록 조명 2개 제외됨").click();
  await expect(page.getByText(registeredInSiteNode.serialNumber)).toBeVisible();
  await expect(page.getByText(registeredInSiteNode.existingRegistration.fixtureName)).toBeVisible();
  await expect(page.getByText(registeredInSiteNode.existingRegistration.floorName)).toBeVisible();
  await expect(page.getByText(registeredElsewhereNode.serialNumber)).toHaveCount(0);
  await expect(page.getByText(registeredElsewhereNode.deviceUuid)).toHaveCount(0);
  await expect(page.getByTestId("existing-fixture-details").locator("input[type='checkbox']")).toHaveCount(0);

  await clickChoice(page, "checkbox", "등록 가능 조명 전체 선택");
  await expect(availableSelection).toBeChecked();
  await expect(nodeSelectionControls).toHaveCount(1);
  await page.getByRole("button", { name: "선택 조명 등록" }).click();
  await expect.poll(() => api.registrationBatchRequests).toEqual([{
    mode: "batch",
    defaults: {
      namePrefix: "B2-L",
      startNumber: 1,
      digits: 3,
      ratedWatt: "40.00",
      size: 20
    },
    nodes: [{ nodeId: availableNode.id }]
  }]);

  const capturedRequest = JSON.stringify(api.registrationBatchRequests[0]);
  const protectedRegistrationValues = [
    registeredInSiteNode.id,
    registeredInSiteNode.serialNumber,
    registeredInSiteNode.deviceUuid,
    registeredInSiteNode.existingRegistration.fixtureId,
    registeredInSiteNode.existingRegistration.fixtureName,
    registeredInSiteNode.existingRegistration.floorId,
    registeredInSiteNode.existingRegistration.floorName,
    registeredElsewhereNode.id,
    registeredElsewhereNode.serialNumber,
    registeredElsewhereNode.deviceUuid
  ];
  for (const protectedValue of protectedRegistrationValues) {
    expect(capturedRequest).not.toContain(protectedValue);
  }
});

test("accepted identify retry ignores a delayed earlier terminal and keeps polling its own operation", async ({ browser, baseURL }) => {
  await withFixturePage(browser, baseURL, { width: 390, height: 844 }, async (page) => {
    await page.clock.install({ time: new Date(scanTimeline.firstScanCompletedAt) });
    const discovered = registrationSession("completed", [discoveredNode]);
    await installSettingsApiRoutes(page, "admin", { fixtures: [], ids: fixtureIds(), activeRegistrationSessions: [discovered] });
    const retry = { ...discoveredNode, status: "identifying" as const, identifyState: "pending", identifyOperationStartedAt: "2026-08-26T00:00:32Z", updatedAt: "2026-08-26T00:00:32Z" };
    let started = false;
    let terminalAllowed = false;
    let oldPolls = 0;
    await page.route(`**/registration-sessions/${discovered.id}`, async (route) => {
      const node = !started ? discoveredNode : terminalAllowed
        ? { ...discoveredNode, identifyState: "confirmed", identifyOperationId: "op-2", identifyOperationStartedAt: retry.identifyOperationStartedAt, updatedAt: "2026-08-26T00:00:34Z" }
        : { ...discoveredNode, identifyState: "failed", identifyOperationId: "op-1", identifyOperationStartedAt: "2026-08-26T00:00:30Z", updatedAt: "2026-08-26T00:00:31Z" };
      if (started && !terminalAllowed) oldPolls += 1;
      await route.fulfill({ json: registrationSession("completed", [node]) });
    });
    await page.route(`**/registration-sessions/${discovered.id}/nodes/${discoveredNode.id}/identify`, async (route) => {
      started = true;
      await route.fulfill({ status: 202, json: { status: "accepted", operationId: "op-2", node: retry } });
    });
    await page.goto(`/settings/registration?siteId=${ids.site}`);
    await page.getByRole("button", { name: "조명 1 식별" }).click();
    await expect(page.getByRole("button", { name: "조명 1 식별 중" })).toBeDisabled();
    await page.clock.fastForward(1500);
    await expect.poll(() => oldPolls).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: "조명 1 식별 중" })).toBeDisabled();
    terminalAllowed = true;
    await page.clock.fastForward(1500);
    await expect(page.getByText("식별 완료")).toBeVisible();
    await expect(page.getByRole("button", { name: "조명 1 식별" })).toBeEnabled();
  });
});

test("registration progress exposes provisioning, completed, and failed semantics", async ({ browser, baseURL }) => {
  const viewport = { width: 390, height: 844 };
  const cases = [
    {
      session: registrationSession("completed", [{ ...discoveredNode, status: "provisioning" as const }]),
      states: ["complete", "complete", "current", "pending"]
    },
    {
      session: { ...registrationSession("completed", [{ ...discoveredNode, status: "provisioned" as const }]), status: "completed" as const },
      states: ["complete", "complete", "complete", "complete"]
    },
    {
      session: { ...registrationSession("failed", []), scanFailureMessage: "Gateway ACK timeout" },
      states: ["error", "pending", "pending", "pending"]
    }
  ] as const;

  for (const { session, states } of cases) {
    await withFixturePage(browser, baseURL, viewport, async (page) => {
      await installSettingsApiRoutes(page, "admin", { fixtures: [], ids: fixtureIds(), activeRegistrationSessions: [session] });
      await page.goto(`/settings/registration?siteId=${ids.site}`);
      await expectRegistrationStepStates(page, states);
      await expectNoHorizontalOverflow(page);
    });
  }
});

function fixtureIds() {
  return { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway };
}

async function startSearch(page: Page) {
  await page.getByRole("button", { name: "조명 검색 시작" }).click();
}

async function selectRegistrationTargets(page: Page) {
  await page.getByRole("button", { name: "등록 층" }).click();
  await page.getByRole("option", { name: "B2" }).click();
  await page.getByRole("button", { name: "등록 게이트웨이" }).click();
  await page.getByRole("option", { name: "Gateway B2" }).click();
}

async function clickChoice(page: Page, role: "checkbox" | "radio", name: string) {
  await page.getByRole(role, { name }).locator("xpath=ancestor::label[1]").click();
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

async function expectRegistrationStepStates(page: Page, states: readonly string[]) {
  const progress = page.getByRole("list", { name: "조명 등록 진행" });
  await expect(progress.locator(":scope > li")).toHaveCount(states.length);
  await expect.poll(async () => progress.locator(":scope > li").evaluateAll((steps) =>
    steps.map((step) => step.getAttribute("data-state"))
  )).toEqual(states);
  await expect(progress.locator('[aria-current="step"]')).toHaveCount(states.filter((state) => state === "current").length);
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
