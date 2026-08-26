import { expect, test, type Page } from "@playwright/test";
import type { CreateFixtureGroupInput, FixtureGroupMetadata } from "@led-control/shared";
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
  command: "11111111-1111-4111-8111-111111111111",
  secondCommand: "11111111-1111-4111-8111-111111111112",
  group: "55555555-5555-4555-8555-555555555551",
  createdGroup: "55555555-5555-4555-8555-555555555552"
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

const discoveredNode = {
  id: "66666666-6666-4666-8666-666666666666",
  sessionId: "88888888-8888-4888-8888-888888888888",
  deviceUuid: "esp32h2-b2-001",
  serialNumber: "LC-B2-001",
  rssi: -54,
  oobCapability: "static-oob",
  firmwareVersion: "1.0.0",
  status: "discovered" as const,
  identifyState: "idle",
  meshAddress: null,
  errorMessage: null,
  scanCorrelationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  scanAttempt: 2,
  discoveredAt: "2026-08-26T00:01:59.000Z"
};

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

  test("0건 완료 후 relation 없는 응답에서도 polling으로 다시 검색을 완료한다", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-08-26T00:00:00.000Z") });
    const initial = registrationSession("completed", null);
    const pending = {
      ...registrationSession("pending", null),
      scanCorrelationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      scanAttempt: 2,
      scanStartedAt: null,
      scanCompletedAt: null,
      discoveredNodes: []
    };
    const scanning = {
      ...pending,
      scanStatus: "scanning" as const,
      scanStartedAt: "2026-08-26T00:02:00.000Z"
    };
    const completed = {
      ...scanning,
      scanStatus: "completed" as const,
      scanCompletedAt: "2026-08-26T00:02:10.000Z",
      discoveredNodes: [discoveredNode]
    };
    const { discoveredNodes: _omitted, ...retryResponse } = pending;
    const api = await installSettingsApiRoutes(page, "operator", {
      fixtures: [],
      ids: { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway },
      registrationSession: initial,
      registrationRetrySession: retryResponse,
      registrationPollingSessions: [pending, scanning, completed]
    });
    await page.goto(`/monitoring?siteId=${ids.site}`);
    await page.getByLabel("등록 층").selectOption(ids.floor);
    await page.getByLabel("등록 게이트웨이").selectOption(ids.gateway);
    await page.getByRole("button", { name: "조명 검색 시작" }).click();

    await expect(page.getByText("검색된 미등록 조명이 없습니다.")).toBeVisible();
    await page.getByRole("button", { name: "다시 검색" }).click();
    await expect.poll(() => api.registrationScanRetryRequests).toBe(1);
    await expect(page.getByText("게이트웨이가 미등록 조명을 검색하는 중입니다.")).toBeVisible();
    await expect(page.getByRole("button", { name: "선택 조명 등록" })).toHaveCount(0);

    await page.clock.fastForward(1_500);
    await expect(page.getByText("게이트웨이가 미등록 조명을 검색하는 중입니다.")).toBeVisible();
    await page.clock.fastForward(1_500);
    await expect(page.getByText(discoveredNode.serialNumber)).toBeVisible();
    await expect(page.getByLabel("조명 1 선택")).toBeEnabled();

    const terminalRequestCount = api.registrationSessionRequests;
    await page.clock.fastForward(4_500);
    expect(api.registrationSessionRequests).toBe(terminalRequestCount);
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

  test("관리자가 저장 구역을 생성·수정·삭제하고 실패한 Mesh 설정을 재동기화한다", async ({ page }) => {
    await installBrowserContractFixture(page);
    const groupApi = await installFixtureGroupContractRoutes(page, [{
      id: ids.group,
      name: "B2 입구",
      floorId: ids.floor,
      gatewayId: ids.gateway,
      lifecycleStatus: "active",
      fixtureCount: 1,
      meshControlGroup: { status: "failed", version: 2, error: "구독 설정 응답 시간 초과" }
    }]);
    await page.goto(`/control?siteId=${ids.site}`);

    await page.getByRole("button", { name: "구역 관리" }).click();
    await expect(page.getByRole("dialog", { name: "구역 관리" })).toBeVisible();
    await expect(page.getByText("Mesh 설정 실패")).toBeVisible();
    await page.getByRole("button", { name: "B2 입구 재동기화" }).click();
    await expect.poll(() => groupApi.resyncRequests).toEqual([ids.group]);
    await expect(page.getByText("Mesh 설정 중")).toBeVisible();

    await page.getByRole("button", { name: "새 구역" }).click();
    await page.getByLabel("구역 이름").fill("B2 출구");
    await page.getByLabel("층", { exact: true }).selectOption(ids.floor);
    await page.getByLabel("게이트웨이", { exact: true }).selectOption(ids.gateway);
    await page.getByLabel("B2-L001 포함").check();
    await page.getByLabel("B2-L002 포함").check();
    await page.getByRole("button", { name: "구역 만들기" }).click();

    await expect.poll(() => groupApi.createRequests).toEqual([{
      name: "B2 출구",
      floorId: ids.floor,
      gatewayId: ids.gateway,
      fixtureIds: [ids.fixture1, ids.fixture2]
    }]);
    await page.getByRole("button", { name: "B2 출구 수정" }).click();
    await page.getByLabel("구역 이름").fill("B2 출구 통로");
    await page.getByRole("button", { name: "변경 저장" }).click();
    await expect.poll(() => groupApi.updateRequests).toEqual([expect.objectContaining({
      groupId: ids.createdGroup,
      name: "B2 출구 통로",
      fixtureIds: [ids.fixture1, ids.fixture2]
    })]);

    await page.getByRole("button", { name: "B2 출구 통로 삭제" }).click();
    await page.getByRole("alert", { name: "구역 삭제 확인" }).getByRole("button", { name: "삭제 확인" }).click();
    await expect.poll(() => groupApi.deleteRequests).toEqual([ids.createdGroup]);
    await expect(page.getByText("삭제 중")).toBeVisible();
  });

  test("viewer는 저장 구역 상태만 조회하고 관리 동작을 사용할 수 없다", async ({ page }) => {
    await installSettingsApiRoutes(page, "viewer", {
      fixtures,
      ids: { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway }
    });
    await installFixtureGroupContractRoutes(page, [{
      id: ids.group,
      name: "B2 입구",
      floorId: ids.floor,
      gatewayId: ids.gateway,
      lifecycleStatus: "active",
      fixtureCount: 1,
      meshControlGroup: { status: "failed", version: 2, error: "구독 설정 응답 시간 초과" }
    }]);
    await page.goto(`/control?siteId=${ids.site}`);

    await page.getByRole("button", { name: "구역 현황" }).click();
    await expect(page.getByText("Mesh 설정 실패")).toBeVisible();
    await expect(page.getByRole("button", { name: "새 구역" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "B2 입구 수정" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "B2 입구 재동기화" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "B2 입구 삭제" })).toHaveCount(0);
  });

  test("준비 완료된 층과 저장 구역을 BLE Mesh 대상으로 동기 제어한다", async ({ page }) => {
    await installBrowserContractFixture(page);
    const controlApi = await installReadyMeshControlRoutes(page);
    await page.goto(`/control?siteId=${ids.site}`);

    await page.getByRole("button", { name: "층" }).click();
    await expect(page.getByText(/Gateway 1\/1 준비 완료/)).toBeVisible();
    await page.getByRole("button", { name: "B2" }).click();
    await page.getByRole("button", { name: "밝기 적용" }).click();
    await expect(page.getByText("조명 적용 완료")).toBeVisible();
    await expect.poll(() => controlApi.dimmingRequests[0]?.target).toEqual({ type: "floor", floorId: ids.floor });

    await page.getByRole("button", { name: "구역", exact: true }).click();
    await expect(page.getByText(/저장된 구역 · 제어 준비 완료/)).toBeVisible();
    await page.getByRole("button", { name: "B2 입구 선택" }).click();
    await page.getByRole("button", { name: "밝기 적용" }).click();
    await expect.poll(() => controlApi.dimmingRequests[1]?.target).toEqual({ type: "group", groupId: ids.group });
    await expect(page.getByText("조명 적용 완료")).toBeVisible();
  });
});

async function installFixtureGroupContractRoutes(page: Page, initialGroups: FixtureGroupMetadata[]) {
  const groups = structuredClone(initialGroups);
  const state = {
    createRequests: [] as CreateFixtureGroupInput[],
    updateRequests: [] as Array<CreateFixtureGroupInput & { groupId: string }>,
    deleteRequests: [] as string[],
    resyncRequests: [] as string[]
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const root = `/api/sites/${ids.site}/fixture-groups`;
    if (url.pathname === root && request.method() === "GET") {
      return route.fulfill({ json: groups });
    }
    if (url.pathname === root && request.method() === "POST") {
      const input = request.postDataJSON() as CreateFixtureGroupInput;
      state.createRequests.push(input);
      const created: FixtureGroupMetadata = {
        id: ids.createdGroup,
        name: input.name,
        floorId: input.floorId,
        gatewayId: input.gatewayId,
        lifecycleStatus: "active",
        fixtureCount: input.fixtureIds.length,
        meshControlGroup: { status: "configuring", version: 1, error: null }
      };
      groups.push(created);
      return route.fulfill({ status: 201, json: created });
    }
    const match = url.pathname.match(new RegExp(`^${root}/([^/]+)(/resync)?$`));
    if (!match) return route.fallback();
    const groupId = decodeURIComponent(match[1]);
    const index = groups.findIndex((group) => group.id === groupId);
    if (index < 0) return route.fulfill({ status: 404, json: { message: "fixture group not found" } });
    if (match[2] && request.method() === "POST") {
      state.resyncRequests.push(groupId);
      groups[index] = {
        ...groups[index],
        meshControlGroup: { status: "configuring", version: (groups[index].meshControlGroup?.version ?? 0) + 1, error: null }
      };
      return route.fulfill({ status: 202, json: groups[index] });
    }
    if (request.method() === "PATCH") {
      const input = request.postDataJSON() as CreateFixtureGroupInput;
      state.updateRequests.push({ groupId, ...input });
      groups[index] = {
        ...groups[index],
        ...input,
        fixtureCount: input.fixtureIds.length,
        meshControlGroup: { status: "configuring", version: (groups[index].meshControlGroup?.version ?? 0) + 1, error: null }
      };
      return route.fulfill({ json: groups[index] });
    }
    if (request.method() === "DELETE") {
      state.deleteRequests.push(groupId);
      groups[index] = {
        ...groups[index],
        lifecycleStatus: "retiring",
        meshControlGroup: { status: "retiring", version: (groups[index].meshControlGroup?.version ?? 0) + 1, error: null }
      };
      return route.fulfill({ status: 202, json: {
        id: groupId,
        lifecycleStatus: "retiring",
        meshControlGroup: groups[index].meshControlGroup
      } });
    }
    return route.fallback();
  });
  return state;
}

async function installReadyMeshControlRoutes(page: Page) {
  const dimmingRequests: Array<{ target: unknown; brightness: number }> = [];
  const commandIds = [ids.command, ids.secondCommand];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === `/api/sites/${ids.site}/dashboard`) {
      return route.fulfill({ json: {
        site: { id: ids.site, name: "고객사 B2 현장" },
        summary: { totalFixtures: 2, onlineFixtures: 2, faultFixtures: 0, averageBrightness: 70 },
        floors: [{
          id: ids.floor,
          name: "B2",
          level: -2,
          floorPlan: null,
          meshControlGroups: [{ gatewayId: ids.gateway, status: "ready", version: 1, error: null }],
          fixtures
        }],
        groups: [{
          id: ids.group,
          name: "B2 입구",
          floorId: ids.floor,
          gatewayId: ids.gateway,
          lifecycleStatus: "active",
          fixtureCount: 2,
          meshControlGroup: { status: "ready", version: 1, error: null },
          fixtureIds: [ids.fixture1, ids.fixture2]
        }],
        gateways: [{
          id: ids.gateway,
          name: "Gateway B2",
          serialNumber: "GW-E2E-001",
          firmwareVersion: "e2e-1.0.0",
          lastHeartbeatAt: "2026-07-12T00:00:00.000Z",
          connectionStatus: "online"
        }]
      } });
    }
    if (url.pathname === "/api/commands/dimming" && request.method() === "POST") {
      const payload = request.postDataJSON() as { target: unknown; brightness: number };
      dimmingRequests.push(payload);
      const commandId = commandIds[dimmingRequests.length - 1];
      return route.fulfill({ json: {
        id: commandId,
        dispatchCount: 1,
        selectedTargetCount: 2,
        transmissionCount: 1,
        deliveryMode: "mesh_group",
        terminalStatusUrl: `/commands/${commandId}`
      } });
    }
    const commandMatch = url.pathname.match(/^\/api\/commands\/([^/]+)$/);
    if (commandMatch && request.method() === "GET") {
      const commandId = decodeURIComponent(commandMatch[1]);
      return route.fulfill({ json: {
        id: commandId,
        stage: "completed",
        dispatchCount: 1,
        completedFixtureCount: 2,
        totalFixtureCount: 2,
        errorMessage: null,
        dispatches: [{
          id: `dispatch-${commandId}`,
          status: "succeeded",
          gateway: { id: ids.gateway, name: "Gateway B2" },
          errorMessage: null,
          results: fixtures.map((fixture) => ({
            fixtureId: fixture.id,
            fixtureName: fixture.name,
            status: "succeeded",
            errorMessage: null
          }))
        }]
      } });
    }
    return route.fallback();
  });
  return { dimmingRequests };
}
