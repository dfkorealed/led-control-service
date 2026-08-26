import { expect, test } from "@playwright/test";
import {
  installSettingsApiRoutes,
  type SettingsFixture
} from "./support/settings-api";
import type { RegistrationSession } from "../src/api/registration";

const ids = {
  site: "22222222-2222-4222-8222-222222222222",
  floor: "44444444-4444-4444-8444-444444444444",
  gateway: "77777777-7777-4777-8777-777777777771",
  fixture1: "33333333-3333-4333-8333-333333333331",
  fixture2: "33333333-3333-4333-8333-333333333332",
  command: "11111111-1111-4111-8111-111111111111"
} as const;

const fixtures: SettingsFixture[] = [
  {
    id: ids.fixture1,
    name: "B2-L001",
    x: 120,
    y: 140,
    size: 20,
    ratedWatt: 40,
    brightness: 70,
    status: "online",
    statusReason: "reported",
    health: { faultCodes: [], observedAt: "2026-07-12T00:00:00.000Z" },
    rssi: -58,
    hopCount: 1,
    commandSuccessRate: 0.99,
    lastSeenAt: "2026-07-12T00:00:00.000Z",
    gateway: { id: ids.gateway, name: "Gateway B2", connectionStatus: "online" },
    controllable: true,
    controlBlockReason: null
  },
  {
    id: ids.fixture2,
    name: "B2-L002",
    x: 180,
    y: 140,
    size: 20,
    ratedWatt: 40,
    brightness: 70,
    status: "online",
    statusReason: "reported",
    health: { faultCodes: [], observedAt: "2026-07-12T00:00:00.000Z" },
    rssi: -61,
    hopCount: 2,
    commandSuccessRate: 0.98,
    lastSeenAt: "2026-07-12T00:00:00.000Z",
    gateway: { id: ids.gateway, name: "Gateway B2", connectionStatus: "online" },
    controllable: true,
    controlBlockReason: null
  }
];

function registrationSession(scanStatus: RegistrationSession["scanStatus"], scanFailureMessage: string | null): RegistrationSession {
  return {
    id: "88888888-8888-4888-8888-888888888888",
    siteId: ids.site,
    floorId: ids.floor,
    gatewayId: ids.gateway,
    requestedBy: "99999999-9999-4999-8999-999999999999",
    status: "active",
    scanStatus,
    scanCorrelationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    scanAttempt: 1,
    scanStartedAt: "2026-08-26T00:00:00.000Z",
    scanCompletedAt: scanStatus === "completed" || scanStatus === "failed" ? "2026-08-26T00:01:00.000Z" : null,
    scanFailureCode: scanStatus === "failed" ? "bluetooth_unavailable" : null,
    scanFailureMessage,
    startedAt: "2026-08-26T00:00:00.000Z",
    completedAt: null,
    discoveredNodes: []
  };
}

async function installBrowserContractFixture(page: Parameters<typeof installSettingsApiRoutes>[0]) {
  return installSettingsApiRoutes(page, "admin", {
    fixtures,
    commandId: ids.command,
    ids: { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway }
  });
}

test.describe("모니터링-제어 브라우저 route fixture 계약 (실제 하드웨어 E2E 아님)", () => {
  test("수동 새로고침으로 현황 API를 다시 조회하고 마지막 갱신을 표시한다", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-07-12T09:00:00+09:00") });
    const api = await installBrowserContractFixture(page);
    await page.goto(`/monitoring?siteId=${ids.site}`);

    await expect(page.getByRole("heading", { name: "B2 운영 현황" })).toBeVisible();
    const lastUpdated = page.getByText(/마지막 갱신:/);
    await expect(lastUpdated).toBeVisible();
    const previousLastUpdated = await lastUpdated.textContent();
    const beforeRefresh = {
      dashboard: api.dashboardRequests,
      fixtures: api.fixturePageRequests,
      map: api.mapSnapshotRequests
    };

    await page.clock.setSystemTime(new Date("2026-07-12T09:01:00+09:00"));
    await page.getByRole("button", { name: "새로고침" }).click();
    await expect(page.getByRole("button", { name: "새로고침" })).toBeEnabled();
    await expect(lastUpdated).not.toHaveText(previousLastUpdated ?? "");
    expect(api.dashboardRequests).toBeGreaterThan(beforeRefresh.dashboard);
    expect(api.fixturePageRequests).toBeGreaterThan(beforeRefresh.fixtures);
    expect(api.mapSnapshotRequests).toBeGreaterThan(beforeRefresh.map);
  });

  test("최초 지도 오류를 빈 지도 대신 표시하고 재시도로 복구한다", async ({ page }) => {
    const api = await installSettingsApiRoutes(page, "admin", {
      fixtures,
      ids: { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway },
      mapSnapshotFailuresBeforeSuccess: 4
    });
    await page.goto(`/monitoring?siteId=${ids.site}`);

    await expect(page.getByText("저장된 지도를 불러오지 못했습니다.")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("region", { name: "층 도면" })).toHaveCount(0);
    await page.getByRole("button", { name: "지도 다시 시도" }).click();

    await expect(page.getByRole("region", { name: "층 도면" })).toBeVisible();
    expect(api.mapSnapshotRequests).toBe(5);
  });

  test("0건 완료와 검색 실패에서 명시적으로 다시 검색한다", async ({ page }) => {
    const api = await installSettingsApiRoutes(page, "operator", {
      fixtures: [],
      ids: { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway },
      registrationSession: registrationSession("completed", null),
      registrationRetrySession: registrationSession("scanning", null)
    });
    await page.goto(`/monitoring?siteId=${ids.site}`);
    await page.getByLabel("등록 층").selectOption(ids.floor);
    await page.getByLabel("등록 게이트웨이").selectOption(ids.gateway);
    await page.getByRole("button", { name: "조명 검색 시작" }).click();

    await expect(page.getByText("검색된 미등록 조명이 없습니다.")).toBeVisible();
    await page.getByRole("button", { name: "다시 검색" }).click();
    await expect.poll(() => api.registrationScanRetryRequests).toBe(1);
    await expect(page.getByText("게이트웨이가 미등록 조명을 검색하는 중입니다.")).toBeVisible();
  });

  test("검색 실패 원인은 정제된 메시지만 표시한다", async ({ page }) => {
    await installSettingsApiRoutes(page, "operator", {
      fixtures: [],
      ids: { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway },
      registrationSession: registrationSession("failed", "Bluetooth 어댑터를 사용할 수 없습니다."),
      registrationRetrySession: registrationSession("scanning", null)
    });
    await page.goto(`/monitoring?siteId=${ids.site}`);
    await page.getByLabel("등록 층").selectOption(ids.floor);
    await page.getByLabel("등록 게이트웨이").selectOption(ids.gateway);
    await page.getByRole("button", { name: "조명 검색 시작" }).click();

    await expect(page.getByText("Bluetooth 어댑터를 사용할 수 없습니다.")).toBeVisible();
    await expect(page.getByText("GET /registration-sessions failed")).toHaveCount(0);
  });

  test("개별 조명 명령은 terminal 전까지 입력을 잠그고 장비별 실패를 표시한다", async ({ page }) => {
    const api = await installBrowserContractFixture(page);
    await page.goto(`/control?siteId=${ids.site}`);

    await expect(page.getByText("B2 · 온라인 · Health 정상", { exact: true }).first()).toBeVisible();
    await page.getByRole("checkbox", { name: "B2-L001 선택" }).check();
    const createResponsePromise = page.waitForResponse((response) => response.url().endsWith("/api/commands/dimming"));
    await page.getByRole("button", { name: "밝기 적용" }).click();
    const createResponse = await createResponsePromise;

    await expect(page.getByRole("button", { name: "밝기 적용 중" })).toBeDisabled();
    await expect(page.getByRole("checkbox", { name: "B2-L001 선택" })).toBeDisabled();
    await expect(page.getByRole("slider", { name: "밝기" })).toBeDisabled();
    await expect.poll(() => api.dimmingRequests).toEqual([expect.objectContaining({
      siteId: ids.site,
      target: { type: "fixture", fixtureId: ids.fixture1 },
      brightness: 70,
      clientRequestId: expect.any(String)
    })]);
    await expect(createResponse.json()).resolves.toMatchObject({ terminalStatusUrl: `/commands/${ids.command}` });
    await expect.poll(() => api.commandStatusRequests).toContain(ids.command);

    api.setCommandStatus({
      stage: "failed",
      results: [{
        fixtureId: ids.fixture1,
        fixtureName: "B2-L001",
        status: "failed",
        errorMessage: "장비 응답 오류"
      }]
    });

    await expect(page.getByText("명령 처리 실패")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("B2-L001: 장비 응답 오류")).toBeVisible();
    await expect(page.getByRole("button", { name: "밝기 적용" })).toBeEnabled();
  });

  test("다중 조명 부분 실패에서 성공과 timeout 결과를 장비별로 표시한다", async ({ page }) => {
    const api = await installBrowserContractFixture(page);
    await page.goto(`/control?siteId=${ids.site}`);
    await page.getByRole("checkbox", { name: "B2-L001 선택" }).check();
    await page.getByRole("checkbox", { name: "B2-L002 선택" }).check();
    const createResponsePromise = page.waitForResponse((response) => response.url().endsWith("/api/commands/dimming"));
    await page.getByRole("button", { name: "밝기 적용" }).click();
    const createResponse = await createResponsePromise;
    await expect.poll(() => api.dimmingRequests).toEqual([expect.objectContaining({
      siteId: ids.site,
      target: { type: "fixtures", fixtureIds: [ids.fixture1, ids.fixture2] },
      brightness: 70,
      clientRequestId: expect.any(String)
    })]);
    await expect(createResponse.json()).resolves.toMatchObject({
      selectedTargetCount: 2,
      transmissionCount: 2,
      deliveryMode: "parallel_unicast"
    });
    await expect.poll(() => api.commandStatusRequests).toContain(ids.command);

    api.setCommandStatus({
      stage: "partial_failed",
      results: [
        {
          fixtureId: ids.fixture1,
          fixtureName: "B2-L001",
          status: "succeeded",
          errorMessage: null
        },
        {
          fixtureId: ids.fixture2,
          fixtureName: "B2-L002",
          status: "timed_out",
          errorMessage: "응답 시간 초과"
        }
      ]
    });

    await expect(page.getByText("일부 조명 적용 실패")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("B2-L002: 응답 시간 초과")).toBeVisible();
  });

  test("브라우저 새로고침 후 진행 중 명령을 복구하고 terminal 결과까지 추적한다", async ({ page }) => {
    const api = await installBrowserContractFixture(page);
    await page.goto(`/control?siteId=${ids.site}`);
    await page.getByRole("checkbox", { name: "B2-L001 선택" }).check();
    await page.getByRole("button", { name: "밝기 적용" }).click();
    await expect(page.getByRole("button", { name: "밝기 적용 중" })).toBeDisabled();
    await expect.poll(() => api.dimmingRequests.length).toBe(1);
    await expect.poll(() => api.commandStatusRequests).toContain(ids.command);

    const statusRequestsBeforeReload = api.commandStatusRequests.length;
    await page.reload();

    await expect(page.getByRole("button", { name: "밝기 적용 중" })).toBeDisabled();
    await expect.poll(() => api.commandStatusRequests.length).toBeGreaterThan(statusRequestsBeforeReload);
    expect(api.commandStatusRequests.at(-1)).toBe(ids.command);

    api.setCommandStatus({
      stage: "completed",
      results: [{
        fixtureId: ids.fixture1,
        fixtureName: "B2-L001",
        status: "succeeded",
        errorMessage: null
      }]
    });

    await expect(page.getByText("조명 적용 완료")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("button", { name: "밝기 적용" })).toBeDisabled();
    await page.getByRole("checkbox", { name: "B2-L001 선택" }).check();
    await expect(page.getByRole("button", { name: "밝기 적용" })).toBeEnabled();
  });
});
