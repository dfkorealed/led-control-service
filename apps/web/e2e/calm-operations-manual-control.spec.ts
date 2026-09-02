import { expect, test, type Page } from "@playwright/test";
import type { FixtureGroupMetadata } from "@led-control/shared";
import { expectMinimumTouchTargets, expectMinimumTouchTargetsAfterScrolling, expectNoHorizontalOverflow } from "./support/layout-assertions";
import { installSettingsApiRoutes, type SettingsFixture } from "./support/settings-api";

test.use({ timezoneId: "Asia/Seoul" });

const ids = {
  site: "77777777-7777-4777-8777-777777777701",
  floor: "77777777-7777-4777-8777-777777777702",
  gateway: "77777777-7777-4777-8777-777777777703",
  fixture: "77777777-7777-4777-8777-777777777704",
  faultFixture: "77777777-7777-4777-8777-777777777705",
  offlineFixture: "77777777-7777-4777-8777-777777777706",
  group: "77777777-7777-4777-8777-777777777707"
};

const fixtures: SettingsFixture[] = [
  fixture(ids.fixture, "B2-L01", { brightness: 70, status: "online", health: { faultCodes: [], observedAt: "2026-09-02T00:00:00.000Z" }, controllable: true, controlBlockReason: null }),
  fixture(ids.faultFixture, "B2-L02", { brightness: 40, status: "fault", health: { faultCodes: [1], observedAt: "2026-09-02T00:00:00.000Z" }, controllable: false, controlBlockReason: "fixture_fault" }),
  fixture(ids.offlineFixture, "B2-L03", { brightness: 0, status: "offline", health: null, controllable: false, controlBlockReason: "fixture_offline" })
];

const savedZone: FixtureGroupMetadata = {
  id: ids.group,
  name: "B2 입구",
  floorId: ids.floor,
  gatewayId: ids.gateway,
  lifecycleStatus: "active",
  fixtureCount: 1,
  meshControlGroup: { status: "ready", version: 2, error: null }
};

const viewports = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 320, height: 740 }
] as const;

for (const viewport of viewports) {
  test(`${viewport.width}px 수동 제어는 대상·명령 결과·저장 구역 계약을 유지한다`, async ({ page }) => {
    await page.clock.install({ time: new Date("2026-09-01T00:00:00.000Z") });
    await page.setViewportSize(viewport);
    const api = await installManualControlFixture(page, "admin");
    await page.goto(`/control?siteId=${ids.site}`);
    await expect(page.getByRole("heading", { name: "조명 제어" })).toBeVisible();
    if (viewport.width <= 760) await expectMinimumTouchTargetsAfterScrolling(page, ".control-screen");

    await page.getByRole("checkbox", { name: "B2-L02 선택" }).check();
    await expect(page.getByText("1개 선택 · 제어 불가 1개")).toBeVisible();
    await expect(page.getByRole("button", { name: "밝기 적용" })).toBeDisabled();
    await page.getByRole("checkbox", { name: "B2-L02 선택" }).uncheck();
    await page.getByRole("checkbox", { name: "B2-L03 선택" }).check();
    await expect(page.getByText("1개 선택 · 제어 불가 1개")).toBeVisible();
    await page.getByRole("checkbox", { name: "B2-L03 선택" }).uncheck();
    await page.getByRole("button", { name: "층" }).click();
    await page.getByRole("button", { name: "B2" }).click();
    await page.getByRole("button", { name: "구역", exact: true }).click();
    await page.getByRole("button", { name: "B2 입구 선택" }).click();
    await page.getByRole("button", { name: "개별/다중" }).click();

    await page.getByRole("checkbox", { name: "B2-L01 선택" }).check();
    await page.getByRole("button", { name: "30%" }).click();
    await page.getByLabel("수동 override 종료 시각").fill("2026-09-01T10:30");
    await page.getByRole("button", { name: "밝기 적용" }).click();
    await expect.poll(() => api.dimmingRequests.at(-1)).toMatchObject({
      brightness: 30,
      overrideUntil: "2026-09-01T01:30:00.000Z"
    });
    await expect(page.getByRole("list", { name: "명령 진행" })).toContainText("장비 응답");
    await expect(page.getByRole("checkbox", { name: "B2-L01 선택" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "층" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "30%" })).toBeDisabled();
    await expect(page.getByLabel("수동 override 종료 시각")).toBeDisabled();
    await expect(page.getByRole("button", { name: "밝기 적용 중" })).toBeDisabled();

    await page.reload();
    await expect(page.getByRole("list", { name: "명령 진행" })).toBeVisible();
    api.setCommandStatus({ stage: "partial_failed", results: [commandResult("failed", "게이트웨이 ACK를 확인하지 못했습니다.")] });
    await expect(page.getByText("게이트웨이 장비 응답을 확인하지 못했습니다.")).toBeVisible();
    await expect(page.getByText(/ACK/i)).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "B2-L01 선택" })).toBeEnabled();
    await page.getByRole("checkbox", { name: "B2-L01 선택" }).check();
    await expect(page.getByRole("button", { name: "밝기 적용" })).toBeEnabled();

    await expectNoHorizontalOverflow(page);

    await page.getByRole("button", { name: "구역 관리" }).click();
    const dialog = page.getByRole("dialog", { name: "구역 관리" });
    await expect(dialog.getByRole("heading", { name: "현재 저장 구역" })).toBeVisible();
    await expect(dialog.getByText("준비됨")).toBeVisible();
    await page.getByRole("button", { name: "B2 입구 수정" }).click();
    await expect(page.getByRole("heading", { name: "구역 편집" })).toBeVisible();

    if (viewport.width <= 760) {
      await expectMinimumTouchTargets(page, ".fixture-group-dialog-header .icon-button");
      await expectMinimumTouchTargetsAfterScrolling(page, ".fixture-group-editor-card");
    }
  });

  test(`${viewport.width}px Mesh 준비 전 floor와 저장 구역은 제어 대상으로 차단한다`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installManualControlFixture(page, "admin", "blocked");
    await page.goto(`/control?siteId=${ids.site}`);

    await page.getByRole("button", { name: "층" }).click();
    await expect(page.getByRole("button", { name: "B2" })).toBeDisabled();
    await expect(page.getByText(/Mesh 설정 중/)).toBeVisible();

    await page.getByRole("button", { name: "구역", exact: true }).click();
    await expect(page.getByRole("button", { name: "B2 입구 선택" })).toBeDisabled();
    await expect(page.getByText("Gateway 장비 응답을 확인하지 못했습니다.")).toBeVisible();
    await expect(page.getByText(/ACK/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "밝기 적용" })).toBeDisabled();
  });

  test(`${viewport.width}px viewer는 수동 제어와 저장 구역을 읽기 전용으로 유지한다`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installManualControlFixture(page, "viewer");
    await page.goto(`/control?siteId=${ids.site}`);

    await expect(page.getByRole("alert")).toContainText("조회 전용 계정");
    await expect(page.getByRole("button", { name: "밝기 적용" })).toBeDisabled();
    await page.getByRole("button", { name: "구역 현황" }).click();
    const dialog = page.getByRole("dialog", { name: "구역 관리" });
    await expect(dialog.getByText("B2 입구")).toBeVisible();
    await expect(dialog.getByText("준비됨")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "B2 입구 수정" })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "B2 입구 삭제" })).toHaveCount(0);

    await expectNoHorizontalOverflow(page);
    if (viewport.width <= 760) await expectMinimumTouchTargets(page, ".fixture-group-dialog-header .icon-button");
  });

  test(`${viewport.width}px 수동 명령은 success와 timeout terminal을 복구한다`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const successApi = await installManualControlFixture(page, "admin");
    await page.goto(`/control?siteId=${ids.site}`);
    await page.getByRole("checkbox", { name: "B2-L01 선택" }).check();
    await page.getByRole("button", { name: "밝기 적용" }).click();
    successApi.setCommandStatus({ stage: "completed", results: [commandResult("succeeded", null)] });
    await expect(page.getByText("조명 적용 완료")).toBeVisible();

    const timeoutPage = await page.context().newPage({ viewport });
    try {
      const timeoutApi = await installManualControlFixture(timeoutPage, "admin");
      await timeoutPage.goto(`/control?siteId=${ids.site}`);
      await timeoutPage.getByRole("checkbox", { name: "B2-L01 선택" }).check();
      await timeoutPage.getByRole("button", { name: "밝기 적용" }).click();
      timeoutApi.setCommandStatus({ stage: "timed_out", results: [commandResult("timed_out", "Gateway ACK timeout")] });
      await expect(timeoutPage.getByText("Gateway 장비 응답 timeout")).toBeVisible();
      await expect(timeoutPage.getByRole("button", { name: "밝기 적용" })).toBeEnabled();
    } finally {
      await timeoutPage.close();
    }
  });
}

function fixture(
  id: string,
  name: string,
  state: Pick<SettingsFixture, "brightness" | "status" | "health" | "controllable" | "controlBlockReason">
): SettingsFixture {
  return {
    id,
    name,
    x: 120,
    y: 140,
    ratedWatt: 40,
    rssi: -58,
    hopCount: 1,
    commandSuccessRate: 1,
    lastSeenAt: "2026-09-02T00:00:00.000Z",
    gateway: { id: ids.gateway, name: "Gateway B2", connectionStatus: "online" },
    ...state
  };
}

function commandResult(status: "succeeded" | "failed" | "timed_out", errorMessage: string | null) {
  return { fixtureId: ids.fixture, fixtureName: "B2-L01", status, errorMessage };
}

async function installManualControlFixture(page: Page, role: "admin" | "viewer", meshState: "ready" | "blocked" = "ready") {
  const api = await installSettingsApiRoutes(page, role, {
    ids: { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway },
    fixtures
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === `/api/sites/${ids.site}/fixture-groups` && request.method() === "GET") {
      return route.fulfill({ json: [savedZone] });
    }
    if (url.pathname === `/api/sites/${ids.site}/dashboard`) {
      return route.fulfill({ json: dashboardResponse(meshState) });
    }
    return route.fallback();
  });
  return api;
}

function dashboardResponse(meshState: "ready" | "blocked" = "ready") {
  const floorMeshControlGroup = meshState === "blocked"
    ? { gatewayId: ids.gateway, status: "configuring", version: 1, error: null }
    : { gatewayId: ids.gateway, status: "ready", version: 1, error: null };
  const groupMeshControlGroup = meshState === "blocked"
    ? { status: "failed", version: 2, error: "Gateway ACK를 확인하지 못했습니다." }
    : savedZone.meshControlGroup;
  return {
    site: {
      id: ids.site,
      name: "고객사 B2 현장",
      customerName: "고객사",
      installationStatus: "installed",
      address: "서울시 강남구",
      tariffKwhRate: 160,
      timeZone: "Asia/Seoul"
    },
    summary: { totalFixtures: fixtures.length, onlineFixtures: 1, faultFixtures: 1, averageBrightness: 37 },
    floors: [{
      id: ids.floor,
      name: "B2",
      level: -2,
      floorPlan: null,
      meshControlGroups: [floorMeshControlGroup],
      fixtures
    }],
    groups: [{ ...savedZone, meshControlGroup: groupMeshControlGroup, fixtureIds: [ids.fixture] }],
    gateways: [{
      id: ids.gateway,
      name: "Gateway B2",
      serialNumber: "GW-E2E-001",
      firmwareVersion: "e2e-1.0.0",
      lastHeartbeatAt: "2026-09-02T00:00:00.000Z",
      connectionStatus: "online"
    }]
  };
}
