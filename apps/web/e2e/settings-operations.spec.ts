import { expect, test, type Page, type Route } from "@playwright/test";
import { expectMinimumTouchTargetsAfterScrolling, expectNoHorizontalOverflow } from "./support/layout-assertions";

test.describe.configure({ mode: "serial" });

const siteId = "11111111-1111-4111-8111-111111111111";
const floorId = "22222222-2222-4222-8222-222222222222";
const emptyFloorId = "22222222-2222-4222-8222-222222222223";
const fixtureId = "33333333-3333-4333-8333-333333333333";
const groupId = "44444444-4444-4444-8444-444444444444";

test("admin이 현장, 층, 조명, 구역 운영 흐름을 완료한다", async ({ page }) => {
  const api = await installOperationsApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/settings/site?siteId=${siteId}`);

  const siteForm = page.getByRole("form", { name: "현장 정보" });
  await expect(siteForm).toBeVisible();
  await siteForm.getByLabel("현장명").fill("서울 본사 주차장");
  await siteForm.getByRole("button", { name: "현장 정보 저장" }).click();
  await expect(page.getByText("현장 정보를 저장했습니다.")).toBeVisible();

  await page.getByRole("button", { name: "B1 보관" }).click();
  const floorDialog = page.getByRole("alertdialog", { name: "B1 층 보관" });
  await expect(floorDialog).toContainText("조명과 활성 구역이 없는지 다시 확인");
  await floorDialog.getByRole("button", { name: "층 보관" }).click();
  await expect(page.getByRole("button", { name: "B1 복구" })).toBeVisible();

  const fixtureForm = page.getByRole("form", { name: "B2-L01 조명 정보 수정" });
  await fixtureForm.getByLabel("이름", { exact: true }).fill("B2 출입구 조명");
  await fixtureForm.getByLabel("정격전력 (W)", { exact: true }).fill("42.5");
  await fixtureForm.getByRole("button", { name: "B2-L01 조명 정보 저장" }).click();
  await expect(page.getByRole("form", { name: "B2 출입구 조명 조명 정보 수정" })).toBeVisible();
  await page.getByRole("button", { name: "다음 200개 불러오기" }).click();
  await expect(page.getByRole("form", { name: "B2-L02 조명 정보 수정" })).toBeVisible();

  await page.getByRole("button", { name: "B2 입구 보관" }).click();
  const groupDialog = page.getByRole("alertdialog", { name: "B2 입구 구역 보관" });
  await groupDialog.getByRole("button", { name: "구역 보관" }).click();
  await expect(page.getByText("보관 중", { exact: true })).toBeVisible();

  expect(api.siteUpdates.at(-1)).toMatchObject({ name: "서울 본사 주차장" });
  expect(api.archivedFloors).toEqual([emptyFloorId]);
  expect(api.fixtureUpdates.at(-1)).toMatchObject({
    expectedUpdatedAt: "2026-09-12T00:00:00.000Z",
    name: "B2 출입구 조명",
    ratedWatt: 42.5
  });
  expect(api.fixtureCursors).toContain(fixtureId);
  expect(api.archivedGroups).toEqual([groupId]);
  await expectNoHorizontalOverflow(page);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 740 }
]) {
  test(`${viewport.width}px에서 운영 설정이 흐름과 overflow 계약을 지킨다`, async ({ page }) => {
    await installOperationsApi(page);
    await page.setViewportSize(viewport);
    await page.goto(`/settings/site?siteId=${siteId}`);

    await expect(page.getByRole("heading", { name: "현장 관리" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "현장 정보" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "층 관리" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "조명 관리" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "구역 관리" })).toBeVisible();
    await expect(page.getByText("LC-E2E-0001")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    if (viewport.width <= 760) {
      await expectMinimumTouchTargetsAfterScrolling(page, "section[aria-label='현장 관리']");
      await expectNoHorizontalOverflow(page);
    }
  });
}

interface OperationsApiState {
  siteUpdates: Array<Record<string, unknown>>;
  archivedFloors: string[];
  fixtureUpdates: Array<Record<string, unknown>>;
  fixtureCursors: Array<string | null>;
  archivedGroups: string[];
}

async function installOperationsApi(page: Page): Promise<OperationsApiState> {
  let site = {
    id: siteId,
    name: "본사 주차장",
    address: "서울시 중구 세종대로 1",
    timeZone: "Asia/Seoul",
    currency: "KRW",
    tariffKwhRate: 158.75,
    updatedAt: "2026-09-12T00:00:00.000Z"
  };
  const floors = [
    { id: floorId, name: "B2", level: -2, displayOrder: 1, status: "active", fixtureCount: 1, activeGroupCount: 1, updatedAt: "2026-09-12T00:00:00.000Z" },
    { id: emptyFloorId, name: "B1", level: -1, displayOrder: 2, status: "active", fixtureCount: 0, activeGroupCount: 0, updatedAt: "2026-09-12T00:00:00.000Z" }
  ];
  const fixtures = [
    fixture("fixture-page-1", "B2-L01", "LC-E2E-0001"),
    fixture("fixture-page-2", "B2-L02", null)
  ];
  fixtures[0].id = fixtureId;
  const groups = [{
    id: groupId,
    name: "B2 입구",
    floorId,
    gatewayId: "55555555-5555-4555-8555-555555555555",
    lifecycleStatus: "active",
    fixtureCount: 1,
    meshControlGroup: { status: "ready", version: 1, error: null }
  }];
  const state: OperationsApiState = {
    siteUpdates: [],
    archivedFloors: [],
    fixtureUpdates: [],
    fixtureCursors: [],
    archivedGroups: []
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname.replace(/^\/api/, "");
    const method = request.method();

    if (path === "/auth/me") return respond(route, { user: adminUser() });
    if (path === "/sites") return respond(route, [{ id: siteId, name: site.name, customerName: "테스트 고객사" }]);
    if (path === `/sites/${siteId}/dashboard`) return respond(route, dashboard(site, floors));
    if (path === `/sites/${siteId}/settings` && method === "GET") {
      return respond(route, { site, floors });
    }
    if (path === `/sites/${siteId}/settings` && method === "PATCH") {
      const body = request.postDataJSON() as Record<string, unknown>;
      if (body.expectedUpdatedAt !== site.updatedAt) {
        return respond(route, { code: "settings_version_conflict" }, 409);
      }
      state.siteUpdates.push(body);
      const { expectedUpdatedAt: _expectedUpdatedAt, ...changes } = body;
      site = { ...site, ...changes, updatedAt: "2026-09-12T00:01:00.000Z" };
      return respond(route, site);
    }
    if (path === `/sites/${siteId}/floors` && method === "POST") {
      const body = request.postDataJSON() as { name: string; level: number; displayOrder: number };
      const created = { id: "22222222-2222-4222-8222-222222222224", ...body, status: "active", fixtureCount: 0, activeGroupCount: 0, updatedAt: "2026-09-12T00:00:00.000Z" };
      floors.push(created);
      return respond(route, created, 201);
    }
    const floorMatch = path.match(new RegExp(`^/sites/${siteId}/floors/([^/]+)$`));
    if (floorMatch && method === "PATCH") {
      const floor = floors.find((candidate) => candidate.id === floorMatch[1]);
      if (!floor) return respond(route, { message: "floor not found" }, 404);
      const body = request.postDataJSON() as Record<string, unknown>;
      if (body.expectedUpdatedAt !== floor.updatedAt) {
        return respond(route, { code: "settings_version_conflict" }, 409);
      }
      const { expectedUpdatedAt: _expectedUpdatedAt, ...changes } = body;
      Object.assign(floor, changes, { updatedAt: "2026-09-12T00:02:00.000Z" });
      return respond(route, floor);
    }
    const archiveMatch = path.match(new RegExp(`^/sites/${siteId}/floors/([^/]+)/archive$`));
    if (archiveMatch && method === "POST") {
      const floor = floors.find((candidate) => candidate.id === archiveMatch[1]);
      if (!floor) return respond(route, { message: "floor not found" }, 404);
      const body = request.postDataJSON() as Record<string, unknown>;
      if (body.expectedUpdatedAt !== floor.updatedAt) {
        return respond(route, { code: "settings_version_conflict" }, 409);
      }
      floor.status = "archived";
      floor.updatedAt = "2026-09-12T00:03:00.000Z";
      state.archivedFloors.push(floor.id);
      return respond(route, floor);
    }
    if (path === `/sites/${siteId}/floors/${floorId}/fixtures/settings` && method === "GET") {
      const cursor = url.searchParams.get("cursor");
      state.fixtureCursors.push(cursor);
      const page = cursor ? [fixtures[1]] : [fixtures[0]];
      return respond(route, {
        items: page.map(({ id, name, ratedWatt, updatedAt, serialNumber, meshAddress, firmwareVersion }) => ({
          id,
          name,
          ratedWatt,
          updatedAt,
          serialNumber,
          deviceUuid: serialNumber ? "device-uuid-e2e" : null,
          meshAddress,
          firmwareVersion
        })),
        nextCursor: cursor ? null : fixtureId
      });
    }
    const fixtureMatch = path.match(new RegExp(`^/sites/${siteId}/floors/${floorId}/fixtures/([^/]+)$`));
    if (fixtureMatch && method === "PATCH") {
      const body = request.postDataJSON() as Record<string, unknown>;
      if (body.expectedUpdatedAt !== fixtures[0].updatedAt) {
        return respond(route, { code: "settings_version_conflict" }, 409);
      }
      state.fixtureUpdates.push(body);
      const { expectedUpdatedAt: _expectedUpdatedAt, ...changes } = body;
      Object.assign(fixtures[0], changes, { updatedAt: "2026-09-12T00:01:00.000Z" });
      return respond(route, { id: fixtureId, floorId, ...changes, updatedAt: fixtures[0].updatedAt });
    }
    if (path === `/sites/${siteId}/fixture-groups` && method === "GET") return respond(route, groups);
    const groupMatch = path.match(new RegExp(`^/sites/${siteId}/fixture-groups/([^/]+)$`));
    if (groupMatch && method === "DELETE") {
      const group = groups.find((candidate) => candidate.id === groupMatch[1]);
      if (!group) return respond(route, { message: "group not found" }, 404);
      group.lifecycleStatus = "retiring";
      group.meshControlGroup.status = "retiring";
      state.archivedGroups.push(group.id);
      return respond(route, { id: group.id, lifecycleStatus: group.lifecycleStatus, meshControlGroup: group.meshControlGroup }, 202);
    }
    return respond(route, { message: `unhandled ${method} ${path}` }, 404);
  });

  return state;
}

function fixture(id: string, name: string, serialNumber: string | null) {
  return {
    id,
    name,
    x: 100,
    y: 100,
    ratedWatt: 40,
    updatedAt: "2026-09-12T00:00:00.000Z",
    brightness: 70,
    status: "online",
    health: null,
    rssi: -60,
    hopCount: 2,
    commandSuccessRate: 0.99,
    lastSeenAt: "2026-09-12T00:00:00.000Z",
    gateway: { id: "55555555-5555-4555-8555-555555555555", name: "B2 게이트웨이", connectionStatus: "online" },
    controllable: true,
    controlBlockReason: null,
    serialNumber,
    meshAddress: serialNumber ? "0x012A" : null,
    firmwareVersion: serialNumber ? "1.4.2" : null
  };
}

function adminUser() {
  return {
    id: "admin-user-1",
    organizationId: "customer-org-1",
    organizationType: "customer",
    loginId: "admin",
    name: "고객 관리자",
    role: "admin",
    status: "active"
  };
}

function dashboard(site: { id: string; name: string; address: string; timeZone: string; tariffKwhRate: number }, floors: Array<{ id: string; name: string; level: number; status: string }>) {
  return {
    capabilities: { read: true, control: true, manage: true, commission: true },
    site: { ...site, customerName: "테스트 고객사", installationStatus: "installed" },
    summary: { totalFixtures: 2, onlineFixtures: 2, faultFixtures: 0, averageBrightness: 70 },
    floors: floors.filter((floor) => floor.status === "active").map((floor) => ({ ...floor, floorPlan: null, meshControlGroups: [], fixtures: [] })),
    groups: [],
    gateways: []
  };
}

function respond(route: Route, json: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) });
}
