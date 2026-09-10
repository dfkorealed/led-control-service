import { expect, test, type APIResponse, type Page } from "@playwright/test";
import type { EnergySummary, SaveEditorStateInput } from "@led-control/shared";
import type { Dashboard } from "../src/api/queries";
import type { RegistrationSession, RegisterFixtureBatchResult } from "../src/api/registration";
import type { FloorEditorState } from "../src/features/floor-editor/editor-types";
import { RealBackendLab } from "./support/real-backend-lab";

// Software E2E only: real API/Postgres/Redis/MQTT, with the existing test-only RF
// simulator. This does not demonstrate physical BLE Mesh or hardware behavior.
test.skip(process.env.E2E_REAL_BACKEND_LAB !== "1", "Requires the isolated RealBackendLab.");
test.use({ trace: "off", screenshot: "off", viewport: { width: 1600, height: 1100 } });

const lab = new RealBackendLab();
type Floor = Pick<Dashboard["floors"][number], "id" | "name">;
type Placement = { x: number; y: number; placementStatus: "unplaced" | "placed"; positionVerifiedAt: string | null };
type PlacementState = Omit<FloorEditorState, "fixtures"> & {
  fixtures: Array<FloorEditorState["fixtures"][number] & Placement>;
};

test.beforeAll(async () => {
  test.setTimeout(180_000);
  await lab.start();
});

test.afterAll(async () => {
  await lab.stop();
});

test.afterEach(async ({}, testInfo) => {
  await lab.writeEvidence(testInfo);
});

test("software E2E: floor placement, unplace confirmation/undo, persistence and operational isolation", async ({ browser, page }, testInfo) => {
  test.setTimeout(300_000);
  const operator = await browser.newPage();
  let siteId: string;
  try {
    lab.captureNetwork(operator, "operator");
    await operator.goto("/monitoring");
    await login(operator, lab.operator);
    await expect(operator).toHaveURL(/\/operator\/site-admins$/);
    const created = await postJson<{ siteId: string; installationStatus: string }>(operator, "/operator/site-admins", {
      customerName: "Floor placement software E2E",
      siteName: "Two-floor placement lab",
      adminName: lab.admin.name,
      loginId: lab.admin.loginId,
      initialPassword: lab.admin.password
    });
    expect(created.installationStatus).toBe("pending");
    siteId = created.siteId;
    lab.assertOperatorNetworkIsolation();
  } finally {
    await operator.close();
  }

  lab.captureNetwork(page, "admin");
  await page.goto(`/monitoring?siteId=${siteId}`);
  await login(page, lab.admin);
  const setup = await postJson<Dashboard>(page, "/setup/initial-site", {
    siteId,
    address: "Software-only test site",
    tariffKwhRate: 160,
    timeZone: "Asia/Seoul",
    floors: [{ name: "B1", level: -1 }, { name: "B2", level: -2 }]
  });
  expect(setup.floors).toHaveLength(2);
  const first = setup.floors.find((floor) => floor.name === "B1")!;
  const second = setup.floors.find((floor) => floor.name === "B2")!;
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  expect((await lab.readInstallation()).siteId).toBe(siteId);
  await lab.seedGatewayInventory();
  const gateway = await postJson<{ status: string; gatewayId: string }>(page, "/gateways/claim", {
    siteId,
    name: "Placement test gateway",
    serialNumber: lab.gateway.serialNumber,
    claimCode: lab.gateway.claimCode
  });
  expect(gateway.status).toBe("claimed");
  await lab.attachGatewayPublisher();
  expect(lab.gateway.id).toBe(gateway.gatewayId);
  await expect.poll(async () => {
    const dashboard = await getJson<Dashboard>(page, `/sites/${siteId}/dashboard`);
    return dashboard.gateways.find((item) => item.id === lab.gateway.id)?.connectionStatus;
  }).toBe("online");

  await test.step("Provision one real backend fixture per floor through the lab RF workflow", async () => {
    await registerFixture(page, siteId, first, lab.fixtures[0].serialNumber, true);
    await registerFixture(page, siteId, second, lab.fixtures[1].serialNumber, false);
    await expect.poll(async () => {
      const dashboard = await getJson<Dashboard>(page, `/sites/${siteId}/dashboard?includeFixtures=true`);
      return dashboard.floors.flatMap((floor) => floor.fixtures).filter((fixture) => fixture.controllable).length;
    }).toBe(2);
  });

  const initialFirst = await readEditor(page, first);
  const initialSecond = await readEditor(page, second);
  expect(initialFirst.fixtures).toHaveLength(1);
  expect(initialSecond.fixtures).toHaveLength(1);
  const fixtureA = initialFirst.fixtures[0];
  const fixtureB = initialSecond.fixtures[0];
  expect(fixtureA.id).not.toBe(fixtureB.id);
  for (const fixture of [fixtureA, fixtureB]) {
    expect(fixture).toMatchObject({ placementStatus: "unplaced", positionVerifiedAt: null });
  }

  await lab.publishEnergyHistory("available");
  const energyBefore = await getJson<EnergySummary>(page, `/energy/sites/${siteId}/summary`);
  expect(energyBefore.baseline24Hours.fixtureCount).toBe(2);
  expect(energyBefore.baseline24Hours.estimatedKwh).toBeGreaterThan(0);
  expect(energyBefore.today.knownSeconds + energyBefore.monthToDate.knownSeconds).toBeGreaterThan(0);

  const positionA = { x: 240, y: 200 };
  const positionB = { x: 420, y: 280 };
  let placedFirst: PlacementState;
  let placedSecond: PlacementState;

  await test.step("Drag a newly registered unplaced fixture onto B1 and persist it", async () => {
    await page.goto(editorUrl(siteId, first));
    await expectEditor(page, first);
    await expect(unplacedRow(page, fixtureA.name)).toBeVisible();
    await expect(unplacedRow(page, fixtureB.name)).toHaveCount(0);
    await dragFixture(page, first, fixtureA.name, positionA);
    await expect(unplacedRow(page, fixtureA.name)).toHaveCount(0);
    await expectProperties(page, fixtureA.name, positionA);
    expect((await readEditor(page, first)).fixtures[0]).toMatchObject({ placementStatus: "unplaced", positionVerifiedAt: null });
    placedFirst = await saveEditor(page, first, initialFirst.floor.mapRevision, fixtureA.id, "placed");
    expect(placedFirst.fixtures[0]).toMatchObject({ placementStatus: "placed", positionVerifiedAt: null });
    expectDroppedPosition(placedFirst.fixtures[0], positionA);
    await lab.screenshot(page, testInfo, "floor-placement-b1-placed");
    await page.reload();
    await expectEditor(page, first);
    await expect(unplacedRow(page, fixtureA.name)).toHaveCount(0);
    expect(placementOf((await readEditor(page, first)).fixtures[0])).toEqual(placementOf(placedFirst.fixtures[0]));
    await selectPlacedFixture(page, fixtureA.id);
    await expectProperties(page, fixtureA.name, positionA);
  });

  await test.step("Switch floors without leaking placement, selection or unsaved changes", async () => {
    await switchFloor(page, second);
    await expect(unplacedRow(page, fixtureB.name)).toBeVisible();
    await expect(unplacedRow(page, fixtureA.name)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: fixtureA.name, exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
    await dragFixture(page, second, fixtureB.name, positionB);
    const cancelled = page.waitForEvent("dialog");
    page.once("dialog", (dialog) => void dialog.dismiss());
    await floorSelector(page, first).selectOption(first.id);
    expect((await cancelled).type()).toBe("confirm");
    await expect(page.getByLabel(`${second.name} 편집 캔버스`)).toBeVisible();
    await expectProperties(page, fixtureB.name, positionB);

    const discarded = page.waitForEvent("dialog");
    page.once("dialog", (dialog) => void dialog.accept());
    await floorSelector(page, first).selectOption(first.id);
    expect((await discarded).type()).toBe("confirm");
    await expectEditor(page, first);
    await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
    expect((await readEditor(page, second)).fixtures[0]).toMatchObject({ placementStatus: "unplaced", positionVerifiedAt: null });
    await switchFloor(page, second);
    await expect(unplacedRow(page, fixtureB.name)).toBeVisible();
    await dragFixture(page, second, fixtureB.name, positionB);
    placedSecond = await saveEditor(page, second, initialSecond.floor.mapRevision, fixtureB.id, "placed");
    expect(placedSecond.fixtures[0]).toMatchObject({ placementStatus: "placed", positionVerifiedAt: null });
    expectDroppedPosition(placedSecond.fixtures[0], positionB);
    await switchFloor(page, first);
    await selectPlacedFixture(page, fixtureA.id);
    await expectProperties(page, fixtureA.name, positionA);
  });

  await test.step("Unplace requires confirmation; cancel and undo preserve the saved placement", async () => {
    await page.getByRole("button", { name: "배치 해제", exact: true }).click();
    const confirmation = unplaceDialog(page);
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "취소", exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(unplacedRow(page, fixtureA.name)).toHaveCount(0);
    await expectProperties(page, fixtureA.name, positionA);
    await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();

    await confirmUnplace(page);
    await expect(unplacedRow(page, fixtureA.name)).toBeVisible();
    expect(placementOf((await readEditor(page, first)).fixtures[0])).toEqual(placementOf(placedFirst!.fixtures[0]));
    await page.getByRole("button", { name: "실행 취소", exact: true }).click();
    await expect(unplacedRow(page, fixtureA.name)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
    await selectPlacedFixture(page, fixtureA.id);
    await expectProperties(page, fixtureA.name, positionA);
    await confirmUnplace(page);
    const unplaced = await saveEditor(page, first, placedFirst!.floor.mapRevision, fixtureA.id, "unplaced");
    expect(unplaced.fixtures[0]).toMatchObject({ id: fixtureA.id, placementStatus: "unplaced", positionVerifiedAt: null });
    await lab.screenshot(page, testInfo, "floor-placement-b1-unplaced");
    await page.reload();
    await expectEditor(page, first);
    await expect(unplacedRow(page, fixtureA.name)).toBeVisible();
    expect((await readEditor(page, first)).fixtures[0]).toMatchObject({ id: fixtureA.id, placementStatus: "unplaced", positionVerifiedAt: null });
    await switchFloor(page, second);
    await expect(unplacedRow(page, fixtureB.name)).toHaveCount(0);
    expect(placementOf((await readEditor(page, second)).fixtures[0])).toEqual(placementOf(placedSecond!.fixtures[0]));
    await selectPlacedFixture(page, fixtureB.id);
    await expectProperties(page, fixtureB.name, positionB);
    await lab.screenshot(page, testInfo, "floor-placement-b2-persisted");
  });

  await test.step("Unplaced fixtures lose only their map marker, not control or energy participation", async () => {
    await page.getByRole("link", { name: "모니터링", exact: true }).click();
    await page.getByRole("button", { name: "B1", exact: true }).click();
    await expect(page.getByRole("heading", { name: "운영 현황", exact: true })).toBeVisible();
    const map = page.getByRole("region", { name: "층 도면", exact: true });
    await expect(map).toBeVisible();
    await expect(map.getByText("B1", { exact: true })).toBeVisible();
    await expect(map.getByRole("button", { name: new RegExp(fixtureA.name) })).toHaveCount(0);
    await expect(map.getByRole("button", { name: new RegExp(fixtureB.name) })).toHaveCount(0);
    await page.getByRole("button", { name: "B2", exact: true }).click();
    await expect(map.getByRole("button", { name: new RegExp(fixtureB.name) })).toBeVisible();
    await expect(map.getByRole("button", { name: new RegExp(fixtureA.name) })).toHaveCount(0);

    await page.getByRole("link", { name: "제어", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: `${fixtureA.name} 선택`, exact: true })).toBeEnabled();
    await expect(page.getByRole("checkbox", { name: `${fixtureB.name} 선택`, exact: true })).toBeEnabled();
    const dashboard = await getJson<Dashboard>(page, `/sites/${siteId}/dashboard?includeFixtures=true`);
    expect(dashboard.summary.totalFixtures).toBe(2);
    expect(dashboard.floors.flatMap((floor) => floor.fixtures).map((fixture) => fixture.id).sort()).toEqual([fixtureA.id, fixtureB.id].sort());
    expect(dashboard.floors.flatMap((floor) => floor.fixtures).every((fixture) => fixture.controllable)).toBe(true);

    await page.getByRole("checkbox", { name: `${fixtureA.name} 선택`, exact: true }).check();
    await page.getByRole("button", { name: "70%", exact: true }).click();
    const expectedCommandCount = lab.dimmingCommandCount() + 1;
    const commandResponsePromise = page.waitForResponse((response) => (
      new URL(response.url()).pathname === "/api/commands/dimming" && response.request().method() === "POST"
    ));
    await page.getByRole("button", { name: "밝기 적용", exact: true }).click();
    const commandResponse = await commandResponsePromise;
    expect(commandResponse.status(), await commandResponse.text()).toBe(201);
    expect(commandResponse.request().postDataJSON()).toMatchObject({
      siteId, brightness: 70, target: { type: "fixture", fixtureId: fixtureA.id }
    });
    await lab.waitForDimmingCommandCount(expectedCommandCount);
    await expect(page.getByText("조명 적용 완료", { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const current = await getJson<Dashboard>(page, `/sites/${siteId}/dashboard?includeFixtures=true`);
      return current.floors.flatMap((floor) => floor.fixtures).find((fixture) => fixture.id === fixtureA.id)?.brightness;
    }).toBe(70);
    expect((await readEditor(page, first)).fixtures[0]).toMatchObject({ id: fixtureA.id, placementStatus: "unplaced" });

    await page.getByRole("link", { name: "통계", exact: true }).click();
    await expect(page.getByRole("heading", { name: "에너지 리포트", exact: true })).toBeVisible();
    await expect(page.getByText(/현재 등록 조명 2개 .* 24시간 .* 100% 밝기/)).toBeVisible();
    const energyAfter = await getJson<EnergySummary>(page, `/energy/sites/${siteId}/summary`);
    expect(energyAfter.baseline24Hours).toEqual(energyBefore.baseline24Hours);
    // The registration baseline is stable; rolling estimates may grow with time.
    expect(energyAfter.monthToDate.knownSeconds).toBeGreaterThanOrEqual(energyBefore.monthToDate.knownSeconds);
    expect(energyAfter.monthToDate.estimatedKwh).toBeGreaterThanOrEqual(energyBefore.monthToDate.estimatedKwh);
    await lab.assertProductionBundleIsolation();
  });

  await test.step("Re-place the same registered fixture after unplacement and persist its identity", async () => {
    const baseline = await readEditor(page, first);
    await page.goto(editorUrl(siteId, first));
    await expectEditor(page, first);
    const position = { x: 320, y: 260 };
    await dragFixture(page, first, fixtureA.name, position);
    await expectProperties(page, fixtureA.name, position);
    const replaced = await saveEditor(page, first, baseline.floor.mapRevision, fixtureA.id, "placed");
    expect(replaced.fixtures).toHaveLength(1);
    expect(replaced.fixtures[0]).toMatchObject({ id: fixtureA.id, placementStatus: "placed", positionVerifiedAt: null });
    expectDroppedPosition(replaced.fixtures[0], position);
    await page.reload();
    await expectEditor(page, first);
    expect(placementOf((await readEditor(page, first)).fixtures[0])).toEqual(placementOf(replaced.fixtures[0]));
    expect(placementOf((await readEditor(page, second)).fixtures[0])).toEqual(placementOf(placedSecond!.fixtures[0]));
    await lab.screenshot(page, testInfo, "floor-placement-b1-replaced");
  });
});

async function login(page: Page, credentials: { loginId: string; password: string }) {
  await page.getByLabel("아이디").fill(credentials.loginId);
  await page.getByLabel("비밀번호").fill(credentials.password);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("button", { name: "로그아웃", exact: true })).toBeVisible();
}

async function responseJson<T>(response: APIResponse, expectedStatus: number): Promise<T> {
  expect(response.status(), `${response.url()} returned ${await response.text()}`).toBe(expectedStatus);
  return response.json() as Promise<T>;
}

function getJson<T>(page: Page, path: string): Promise<T> {
  return page.request.get(`/api${path}`).then((response) => responseJson<T>(response, 200));
}

function postJson<T>(page: Page, path: string, data: unknown): Promise<T> {
  return page.request.post(`/api${path}`, { data, headers: { Origin: new URL(page.url()).origin } })
    .then((response) => responseJson<T>(response, 201));
}

function readEditor(page: Page, floor: Floor) {
  return getJson<PlacementState>(page, `/floors/${floor.id}/editor-state`);
}

async function registerFixture(page: Page, siteId: string, floor: Floor, serialNumber: string, firstScan: boolean) {
  const session = await postJson<RegistrationSession>(page, "/registration-sessions", { siteId, floorId: floor.id, gatewayId: lab.gateway.id });
  const sessionPath = `/registration-sessions/${session.id}`;
  const readSession = () => getJson<RegistrationSession>(page, sessionPath);
  await expect.poll(async () => (await readSession()).scanStatus).toBe("completed");
  // The support harness deliberately emits an empty first scan. Retry the actual
  // registration session instead of inserting fixtures or intercepting API routes.
  if (firstScan) {
    expect((await readSession()).discoveredNodes).toHaveLength(0);
    await postJson(page, `${sessionPath}/scan/retry`, {});
    await expect.poll(async () => (await readSession()).scanStatus).toBe("completed");
  }
  const node = (await readSession()).discoveredNodes.find((candidate) => candidate.serialNumber === serialNumber);
  expect(node, `RF discovery should contain ${serialNumber} on ${floor.name}`).toBeDefined();
  const batch = await postJson<RegisterFixtureBatchResult>(page, `${sessionPath}/nodes/register-batch`, {
    mode: "batch",
    defaults: { namePrefix: `${floor.name}-Placement-`, startNumber: 1, digits: 3, ratedWatt: "40.00", size: 20 },
    nodes: [{ nodeId: node!.id }]
  });
  expect(batch.items).toHaveLength(1);
  expect(batch.items[0]).toMatchObject({ nodeId: node!.id, status: "accepted" });
  await expect.poll(async () => (await readSession()).discoveredNodes.find((candidate) => candidate.id === node!.id)?.status).toBe("provisioned");
  expect((await postJson<RegistrationSession>(page, `${sessionPath}/complete`, {})).status).toBe("completed");
}

function editorUrl(siteId: string, floor: Floor) {
  return `/settings/floor-plans/${floor.id}/edit?siteId=${siteId}`;
}

function unplacedRow(page: Page, fixtureName: string) {
  return page.locator('[draggable="true"]').filter({ hasText: fixtureName });
}

function floorSelector(page: Page, floor: Floor) {
  return page.getByRole("combobox", { name: "층 선택", exact: true })
    .filter({ has: page.locator(`option[value="${floor.id}"]`) });
}

async function expectEditor(page: Page, floor: Floor) {
  await expect(page.getByRole("heading", { name: `${floor.name} 맵 편집`, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "선택", exact: true })).toBeEnabled();
  await expect(page.getByLabel(`${floor.name} 편집 캔버스`)).toHaveAttribute("aria-disabled", "false");
}

async function switchFloor(page: Page, floor: Floor) {
  await floorSelector(page, floor).selectOption(floor.id);
  await expectEditor(page, floor);
  await expect(floorSelector(page, floor)).toHaveValue(floor.id);
}

async function dragFixture(page: Page, floor: Floor, fixtureName: string, position: { x: number; y: number }) {
  const canvas = page.getByLabel(`${floor.name} 편집 캔버스`);
  const targetPosition = await canvas.evaluate((element, world) => {
    const zoom = Number(element.getAttribute("data-zoom"));
    const panX = Number(element.getAttribute("data-pan-x"));
    const panY = Number(element.getAttribute("data-pan-y"));
    // Playwright targets the padding box; the editor converts client coordinates
    // from the outer bounding box. Account for borders without injecting a drop.
    return { x: world.x * zoom + panX - element.clientLeft, y: world.y * zoom + panY - element.clientTop };
  }, position);
  await unplacedRow(page, fixtureName).dragTo(canvas, { targetPosition });
}

async function selectPlacedFixture(page: Page, fixtureId: string) {
  const list = page.getByRole("complementary", { name: "조명 목록", exact: true });
  await list.getByRole("tab", { name: "배치", exact: true }).click();
  await list.getByTestId(`placement-fixture-${fixtureId}`).click();
  await list.getByRole("tab", { name: "미배치", exact: true }).click();
}

async function expectProperties(page: Page, fixtureName: string, position: { x: number; y: number }) {
  const properties = page.getByRole("complementary", { name: "속성 패널" });
  await expect(properties.getByRole("heading", { name: fixtureName, exact: true })).toBeVisible();
  await expect(properties.getByLabel("X", { exact: true })).toHaveValue(String(position.x));
  await expect(properties.getByLabel("Y", { exact: true })).toHaveValue(String(position.y));
}

async function confirmUnplace(page: Page) {
  await page.getByRole("button", { name: "배치 해제", exact: true }).click();
  await unplaceDialog(page).getByRole("button", { name: "배치 해제", exact: true }).click();
  await expect(unplaceDialog(page)).toHaveCount(0);
}

function unplaceDialog(page: Page) {
  return page.getByRole("dialog", { name: "이 조명을 맵에서 제거할까요?", exact: true });
}

async function saveEditor(page: Page, floor: Floor, revision: number, fixtureId: string, placementStatus: Placement["placementStatus"]) {
  const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/floors/${floor.id}/editor-state` && response.request().method() === "PUT");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBe(200);
  const payload = response.request().postDataJSON() as SaveEditorStateInput;
  expect(payload.expectedRevision).toBe(revision);
  expect(payload.leaseToken).toEqual(expect.any(String));
  expect(payload.leaseToken.length).toBeGreaterThan(0);
  expect(payload.leaseFence).toBeGreaterThan(0);
  expect(payload.fixtureUpdates).toHaveLength(1);
  expect(payload.fixtureUpdates[0]).toMatchObject({ id: fixtureId, placementStatus });
  expect(payload.objectCreates).toEqual([]);
  expect(payload.objectUpdates).toEqual([]);
  expect(payload.objectDeletes).toEqual([]);
  const state = await response.json() as PlacementState;
  expect(state.floor.id).toBe(floor.id);
  expect(state.floor.mapRevision).toBe(revision + 1);
  await expect(page).toHaveURL(new RegExp(`/floor-plans/${floor.id}/edit\\?`));
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  return state;
}

function placementOf(fixture: Placement) {
  return { x: fixture.x, y: fixture.y, placementStatus: fixture.placementStatus, positionVerifiedAt: fixture.positionVerifiedAt };
}

function expectDroppedPosition(actual: Placement, target: { x: number; y: number }) {
  // Native pointer coordinates are integer pixels while layout can be fractional.
  // Only the initial pointer target uses tolerance; persisted snapshots compare exactly.
  expect(actual.x).toBeCloseTo(target.x, 0);
  expect(actual.y).toBeCloseTo(target.y, 0);
}
