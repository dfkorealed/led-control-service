import { expect, test, type APIResponse, type Locator, type Page, type Response, type TestInfo } from "@playwright/test";
import { floorMapSnapshotSchema, mapDocumentRefSchema, mapElementSchema, type MapDocumentRef, type MapElement, type SaveEditorStateInput } from "@led-control/shared";
import { getMapElementBounds } from "@led-control/shared/map-document-geometry";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Dashboard } from "../src/api/queries";
import type { MapStage } from "../src/api/map-stages";
import type { RegistrationSession, RegisterFixtureBatchResult } from "../src/api/registration";
import type { FloorEditorState } from "../src/features/floor-editor/editor-types";
import { RealBackendLab } from "./support/real-backend-lab";

// 실제 격리 서버 전용이다. route 응답, store 주입, DB geometry seed로 여정을 대체하지 않는다.
test.skip(process.env.E2E_REAL_BACKEND_LAB !== "1", "격리 RealBackendLab 실행 승인이 필요합니다.");
test.use({ trace: "off", screenshot: "off", viewport: { width: 1600, height: 1100 } });

const lab = new RealBackendLab();
const dxfPath = fileURLToPath(new URL("./fixtures/common-map-real.dxf", import.meta.url));
const red = "#e11d48";
type Scope = { siteId: string; floorId: string; floorName: string; fixtureId: string };
type Evidence = { method: string; path: string; status: number; operations?: string[]; stageId?: string };

test.beforeAll(async () => {
  test.setTimeout(180_000);
  // 승인 대기 중인 Lab 확장 관문. 옵션/소유 자원 증거 없이 시작하면 상위 dotenv의
  // 사용자 MinIO에 연결할 수 있으므로 빌드나 서버 시작보다 먼저 명시적으로 실패한다.
  // 총괄이 선택적 CAD Lab 계약을 승인한 뒤 그 소유권 검증으로 이 관문을 연결한다.
  if (!("isolatedCadStorage" in lab) || lab.isolatedCadStorage !== true) {
    throw new Error("U14B_LAB_WIRING_REQUIRED: Lab-owned Object Storage/CAD configuration and cleanup approval are pending.");
  }
  await lab.start();
});

test.afterAll(async () => { await lab.stop(); });
test.afterEach(async ({}, info) => { await lab.writeEvidence(info); });

test("실백엔드: 일반 도형과 DXF 정본을 저장·삭제·복구하고 stage 확정 뒤 모니터링에 표시한다", async ({ browser, page }, info) => {
  test.setTimeout(300_000);
  const pageErrors: string[] = [];
  const serverFailures: Evidence[] = [];
  const mutations: Evidence[] = [];
  const stageIds = new Set<string>();
  const pendingEvidence = new Set<Promise<void>>();
  const evidenceErrors: string[] = [];
  const sourceAtStart = await sourceEvidence();
  const observe = (response: Response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/")) return;
    const method = response.request().method();
    const record: Evidence = { method, path: url.pathname, status: response.status() };
    if (response.status() >= 500) serverFailures.push(record);
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      // lease/token, 비밀번호, 서명 URL은 증거 파일에 보관하지 않는다.
      if (/\/editor-state$/.test(url.pathname) && method === "PUT") {
        try {
          const body = response.request().postDataJSON() as Partial<SaveEditorStateInput> | null;
          if (body?.documentChanges) record.operations = body.documentChanges.operations.map(op => op.kind);
        } catch { evidenceErrors.push(`Invalid editor-state JSON: ${url.pathname}`); }
      }
      mutations.push(record);
    }
    if (method === "POST" && /\/editor-stages$/.test(url.pathname) && response.ok()) {
      const task = response.json().then((stage: MapStage) => { stageIds.add(stage.id); record.stageId = stage.id; })
        .catch(error => { evidenceErrors.push(String(error)); });
      pendingEvidence.add(task);
      void task.finally(() => pendingEvidence.delete(task));
    }
  };
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("response", observe);
  let scope: Scope | undefined;
  try {
    const operator = await browser.newPage();
    let siteId: string;
    try {
      lab.captureNetwork(operator, "operator");
      operator.on("pageerror", error => pageErrors.push(error.message));
      operator.on("response", observe);
      await operator.goto("/monitoring");
      await login(operator, lab.operator);
      const created = await post<{ siteId: string }>(operator, "/operator/site-admins", {
        customerName: "U14b 소프트웨어 검증", siteName: "공통 맵 격리 현장",
        adminName: lab.admin.name, loginId: lab.admin.loginId, initialPassword: lab.admin.password
      });
      siteId = created.siteId;
      lab.assertOperatorNetworkIsolation();
    } finally { await operator.close(); }
    lab.captureNetwork(page, "admin");
    await page.goto(`/monitoring?siteId=${siteId}`);
    await login(page, lab.admin);
    const dashboard = await post<Dashboard>(page, "/setup/initial-site", {
      siteId, address: "격리 E2E", tariffKwhRate: 160, timeZone: "Asia/Seoul", floors: [{ name: "B1", level: -1 }]
    });
    const floor = dashboard.floors[0];
    expect(dashboard.floors).toHaveLength(1);
    expect((await lab.readInstallation()).siteId).toBe(siteId);
    await lab.seedGatewayInventory();
    const gateway = await post<{ gatewayId: string }>(page, "/gateways/claim", {
      siteId, name: "U14b 격리 게이트웨이", serialNumber: lab.gateway.serialNumber, claimCode: lab.gateway.claimCode
    });
    await lab.attachGatewayPublisher();
    expect(lab.gateway.id).toBe(gateway.gatewayId);
    await registerUnplacedFixture(page, siteId, floor.id);
    const initial = await get<FloorEditorState>(page, `/floors/${floor.id}/editor-state`);
    expect(initial.fixtures).toHaveLength(1);
    expect(initial.fixtures[0].placementStatus).toBe("unplaced");
    scope = { siteId, floorId: floor.id, floorName: floor.name, fixtureId: initial.fixtures[0].id };
    const current = scope;
    let ordinary: MapElement[] = [];

    await test.step("실제 lease로 빈 맵 초기화 후 사각형·문자 속성을 일반 저장한다", async () => {
      const reset = waitResponse(page, `/floors/${floor.id}/editor-reset`, "POST");
      await openEditor(page, current);
      const response = await reset;
      expect(response.status(), await response.text()).toBe(201);
      expect(response.request().postDataJSON()).toMatchObject({ baseRevision: initial.floor.mapRevision, leaseToken: expect.any(String), leaseFence: expect.any(Number) });
      expect((await readDocument(page, current)).elementCount).toBe(0);
      await draw(page, "사각형", { x: 100, y: 100 }, { x: 300, y: 220 });
      const properties = page.getByRole("complementary", { name: "도형 속성", exact: true });
      await properties.getByLabel("채우기 색상", { exact: true }).fill(red);
      await fillNumber(properties.getByLabel("너비", { exact: true }), 160);
      await draw(page, "텍스트", { x: 400, y: 150 }, { x: 650, y: 210 });
      await properties.getByLabel("텍스트", { exact: true }).fill("U14b 일반 문자");
      const saved = await saveNormal(page, current);
      expect(saved.floor.mapDocument?.elementCount).toBe(2);
      ordinary = await readElements(page, current);
      expect(ordinary.map(element => element.type).sort()).toEqual(["rectangle", "text"]);
      expect(ordinary.find(element => element.type === "rectangle")).toMatchObject({ geometry: { width: 160 }, style: { fillColor: red }, provenance: null });
      expect(ordinary.find(element => element.type === "text")).toMatchObject({ geometry: { text: "U14b 일반 문자" }, provenance: null });
      await page.reload(); await expectEditor(page);
      expect(await readElements(page, current)).toEqual(ordinary);
      await assertMonitoring(page, current, ordinary, info, "ordinary-reloaded");
    });

    await test.step("작은 실제 DXF를 업로드하고 준비 정본과 교체 적용을 확인한다", async () => {
      await openEditor(page, current);
      const before = await readDocument(page, current);
      const created = page.waitForResponse(response => response.request().method() === "POST"
        && new URL(response.url()).pathname === `/api/floors/${floor.id}/import-jobs`);
      await page.getByLabel("CAD 파일", { exact: true }).setInputFiles(dxfPath);
      await page.getByRole("button", { name: "CAD 가져오기", exact: true }).click();
      const creation = await created;
      expect(creation.status(), await creation.text()).toBe(201);
      expect(creation.request().postDataJSON()).toMatchObject({ sourceFormat: "dxf", sourceAssetId: expect.any(String) });
      const job = await creation.json() as { jobId: string };
      await expect.poll(async () => {
        const result = await get<{ status: string; stage: string }>(page, `/floors/${floor.id}/import-jobs/${job.jobId}`);
        expect(result.status, `import stage=${result.stage}`).not.toBe("failed");
        return result.status;
      }, { timeout: 60_000 }).toBe("review_required");
      await expect(page.getByText("조명 위치 후보 0개를 찾았습니다.", { exact: true })).toBeVisible();
      const prepared = await readDocument(page, current, `/import-jobs/${job.jobId}`);
      expect(prepared.generationId).not.toBe(before.generationId);
      expect(prepared.elementCount).toBe(3);
      expect(await readDocument(page, current)).toEqual(before);
      await expect(page.getByRole("img", { name: "맵 도형", exact: true }).locator("canvas")).toBeVisible();
      await lab.screenshot(page, info, "u14b-cad-prepared-before-commit");
      await page.getByRole("button", { name: "선택한 후보와 배경 적용", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "새 CAD 도면으로 맵을 교체할까요?", exact: true });
      await expect(dialog).toBeVisible();
      expect(await readDocument(page, current)).toEqual(before);
      const applied = waitResponse(page, `/floors/${floor.id}/import-jobs/${job.jobId}/apply`, "POST");
      await dialog.getByRole("button", { name: "교체 후 적용", exact: true }).click();
      const response = await applied;
      expect(response.ok(), await response.text()).toBe(true);
      expect(response.request().postDataJSON()).toMatchObject({ expectedRevision: before.revision, confirmMapReset: true, candidateIds: [], leaseToken: expect.any(String), leaseFence: expect.any(Number) });
      await expect.poll(async () => (await readDocument(page, current)).generationId).toBe(prepared.generationId);
      const elements = await readElements(page, current);
      expect(elements).toHaveLength(3);
      expect(elements.every(element => element.provenance?.importJobId === job.jobId)).toBe(true);
      expect(elements.some(element => ordinary.some(old => old.id === element.id))).toBe(false);
      expect(elements.find(element => element.type === "text")).toMatchObject({ geometry: { text: "U14B CAD" } });
      await assertFixturePreserved(page, current);
    });

    let imported: MapElement;
    await test.step("CAD 요소를 일반 속성으로 이동·삭제·저장한 뒤 undo와 재저장한다", async () => {
      await expectEditor(page);
      const elements = await readElements(page, current);
      imported = elements.find(element => element.type === "text")!;
      expect(imported).toBeDefined();
      await selectElement(page, imported);
      const panel = page.getByRole("complementary", { name: "도형 속성", exact: true });
      await expect(panel.getByLabel("텍스트", { exact: true })).toHaveValue("U14B CAD");
      const bounds = getMapElementBounds(imported);
      await fillNumber(panel.getByLabel("X 위치", { exact: true }), bounds.minX + 20);
      await panel.getByLabel("텍스트", { exact: true }).fill("U14b CAD 수정");
      await panel.getByLabel("글자 색상", { exact: true }).fill(red);
      await saveNormal(page, current);
      imported = (await readElements(page, current)).find(element => element.id === imported.id)!;
      expect(getMapElementBounds(imported).minX).toBeCloseTo(bounds.minX + 20, 4);
      expect(imported.style.strokeColor).toBe(red);
      await panel.getByRole("button", { name: "도형 삭제", exact: true }).click();
      await saveNormal(page, current, "delete");
      expect((await readElements(page, current)).some(element => element.id === imported.id)).toBe(false);
      // 저장 ACK가 이력을 지우거나 CAD 전용 API로 분기하면 이 역방향 저장이 실패해야 한다.
      await page.getByRole("button", { name: "실행 취소", exact: true }).click();
      await saveNormal(page, current, "add");
      expect((await readElements(page, current)).find(element => element.id === imported.id)).toEqual(imported);
      await page.reload(); await expectEditor(page);
      await selectElement(page, imported);
      await expect(panel.getByLabel("텍스트", { exact: true })).toHaveValue("U14b CAD 수정");
      await assertFixturePreserved(page, current);
    });

    await test.step("크기·격자는 명시 저장으로 checkpoint를 확정하고 undo 미리보기는 재저장한다", async () => {
      await page.getByRole("button", { name: "선택", exact: true }).click();
      const before = await readDocument(page, current);
      const baseline = await readElements(page, current);
      const panel = page.getByRole("complementary", { name: "속성 패널", exact: true });
      const width = before.width + 100, height = before.height + 100, gridSize = before.gridSize === 20 ? 25 : 20;
      await fillNumber(panel.getByLabel("맵 너비", { exact: true }), width);
      await fillNumber(panel.getByLabel("맵 높이", { exact: true }), height);
      await fillNumber(panel.getByLabel("격자 간격", { exact: true }), gridSize);
      const stageCreatesBefore = mutations.filter(record => /\/editor-stages$/.test(record.path)).length;
      await panel.getByRole("button", { name: "맵 설정 적용", exact: true }).click();
      await expect(page.getByTestId("floor-editor-canvas")).toHaveAttribute("data-map-width", String(width));
      expect(await readDocument(page, current)).toEqual(before);
      expect(mutations.filter(record => /\/editor-stages$/.test(record.path))).toHaveLength(stageCreatesBefore);
      // 설정 적용은 로컬 checkpoint이며 Save 한 번이 prepare와 commit을 수행한다.
      // 외부 undo의 ready-preview/별도 Save 계약과 혼동하지 않는다.
      const receipt = await saveCheckpoint(page, current, before, { width, height, gridSize });
      expect(receipt.result?.history).toEqual({ undo: { revision: before.revision }, redo: { revision: before.revision + 1 } });
      expect(await readDocument(page, current)).toMatchObject({ width, height, gridSize, revision: before.revision + 1 });
      const undoStage = waitResponse(page, `/floors/${floor.id}/editor-stages`, "POST");
      await page.getByRole("button", { name: "실행 취소", exact: true }).click();
      const undoResponse = await undoStage;
      expect(undoResponse.ok(), await undoResponse.text()).toBe(true);
      expect(undoResponse.request().postDataJSON()).toMatchObject({ historySource: { revision: before.revision } });
      const undo = await undoResponse.json() as MapStage;
      const resized = await readDocument(page, current);
      await assertReadyStage(page, current, undo.id, resized, { width: before.width, height: before.height, gridSize: before.gridSize });
      await saveStage(page, current, undo.id);
      await page.reload(); await expectEditor(page);
      expect(await readDocument(page, current)).toMatchObject({ width: before.width, height: before.height, gridSize: before.gridSize });
      expect(await readElements(page, current)).toEqual(baseline);
      await assertMonitoring(page, current, baseline, info, "cad-restored");
      await assertFixturePreserved(page, current);
    });

    await Promise.all(pendingEvidence);
    for (const id of stageIds) expect((await get<MapStage>(page, `/floors/${floor.id}/editor-stages/${id}`)).status).toBe("committed");
    expect(stageIds.size).toBeGreaterThanOrEqual(2);
    expect(mutations.filter(record => /\/cad-scene(?:\/|$)/.test(record.path))).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(serverFailures).toEqual([]);
    expect(evidenceErrors).toEqual([]);
  } finally {
    await Promise.all(pendingEvidence);
    await info.attach("u14b-http-evidence", { body: JSON.stringify({ scope, pageErrors, serverFailures, evidenceErrors, mutations, stageIds: [...stageIds],
      sourceAtStart, sourceAtEnd: await sourceEvidence(),
      dxfSha256: createHash("sha256").update(await readFile(dxfPath)).digest("hex") }, null, 2), contentType: "application/json" });
    await lab.screenshot(page, info, "u14b-final-or-failure");
    page.off("response", observe);
  }
});

async function login(page: Page, credentials: { loginId: string; password: string }) {
  await page.getByLabel("아이디").fill(credentials.loginId);
  await page.getByLabel("비밀번호").fill(credentials.password);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("button", { name: "로그아웃", exact: true })).toBeVisible();
}
async function json<T>(response: APIResponse, status = 200): Promise<T> {
  expect(response.status(), `${response.url()}: ${await response.text()}`).toBe(status);
  return response.json() as Promise<T>;
}
async function get<T>(page: Page, suffix: string) { return json<T>(await page.request.get(`/api${suffix}`)); }
async function post<T>(page: Page, suffix: string, data: unknown, status = 201) {
  return json<T>(await page.request.post(`/api${suffix}`, { data, headers: { Origin: new URL(page.url()).origin } }), status);
}
function waitResponse(page: Page, suffix: string, method: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === `/api${suffix}` && response.request().method() === method);
}
async function openEditor(page: Page, scope: Scope) {
  await page.goto(`/settings/floor-plans/${scope.floorId}/edit?siteId=${scope.siteId}`);
  await expectEditor(page);
}
async function expectEditor(page: Page) {
  await expect(page.getByTestId("floor-editor-canvas")).toHaveAttribute("data-map-ready", "true");
  await expect(page.getByRole("button", { name: "사각형", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "맵 맞춤", exact: true }).click();
}
async function fillNumber(field: Locator, value: number) { await field.fill(String(value)); await field.press("Tab"); }
async function point(page: Page, value: { x: number; y: number }) {
  return page.getByTestId("floor-editor-canvas").evaluate((node, p) => {
    const box = node.getBoundingClientRect();
    return { x: box.x + Number(node.dataset.panX) + p.x * Number(node.dataset.zoom), y: box.y + Number(node.dataset.panY) + p.y * Number(node.dataset.zoom) };
  }, value);
}
async function draw(page: Page, tool: string, start: { x: number; y: number }, end: { x: number; y: number }) {
  await page.getByRole("button", { name: tool, exact: true }).click();
  const a = await point(page, start), b = await point(page, end);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up();
  await expect(page.getByRole("complementary", { name: "도형 속성", exact: true })).toBeVisible();
}
async function selectElement(page: Page, element: MapElement) {
  await page.getByRole("button", { name: "선택", exact: true }).click();
  const bounds = getMapElementBounds(element);
  const p = await point(page, { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 });
  await page.mouse.click(p.x, p.y, { clickCount: element.groupId ? 2 : 1 });
  await expect(page.getByRole("complementary", { name: "도형 속성", exact: true })).toBeVisible();
}
async function readDocument(page: Page, scope: Scope, prefix = ""): Promise<MapDocumentRef> {
  return mapDocumentRefSchema.parse(await get(page, `/floors/${scope.floorId}${prefix}/map-document`));
}
async function readElements(page: Page, scope: Scope) {
  const ref = await readDocument(page, scope);
  const query = new URLSearchParams({ generationId: ref.generationId, revision: String(ref.revision) });
  const prefix = `/floors/${scope.floorId}/map-document`;
  // 이 fixture는 3개 이하이다. 잘못된 무한 pagination을 숨기지 않고 한 페이지를 엄격히 확인한다.
  const selection = await post<{ generationId: string; revision: number; ids: string[]; nextCursor: string | null }>(page, `${prefix}/selection?${query}`, { limit: 128 }, 200);
  expect(selection).toMatchObject({ generationId: ref.generationId, revision: ref.revision, nextCursor: null });
  expect(selection.ids).toHaveLength(ref.elementCount);
  const raw = await post<unknown[]>(page, `${prefix}/elements?${query}`, { ids: selection.ids }, 200);
  const elements = raw.map(value => mapElementSchema.parse(value)).sort((a, b) => a.id.localeCompare(b.id));
  expect(elements.map(element => element.id).sort()).toEqual([...selection.ids].sort());
  return elements;
}
async function saveNormal(page: Page, scope: Scope, operation?: string) {
  const before = await readDocument(page, scope);
  const saved = waitResponse(page, `/floors/${scope.floorId}/editor-state`, "PUT");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  const response = await saved;
  expect(response.status(), await response.text()).toBe(200);
  const payload = response.request().postDataJSON() as SaveEditorStateInput;
  expect(payload).toMatchObject({ expectedRevision: before.revision, leaseToken: expect.any(String), leaseFence: expect.any(Number),
    objectCreates: [], objectUpdates: [], objectDeletes: [], documentChanges: { generationId: before.generationId, requestId: expect.any(String) } });
  expect(payload.documentChanges).not.toHaveProperty("baseRevision");
  if (operation) expect(payload.documentChanges?.operations.some(op => op.kind === operation)).toBe(true);
  expect(payload).not.toHaveProperty("cadEdits");
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  const state = await get<FloorEditorState>(page, `/floors/${scope.floorId}/editor-state`);
  expect(state.floor.mapRevision).toBe(before.revision + 1);
  return state;
}
async function assertReadyStage(page: Page, scope: Scope, id: string, before: MapDocumentRef, dimensions: Pick<MapDocumentRef, "width" | "height" | "gridSize">) {
  await expect.poll(async () => {
    const stage = await get<MapStage>(page, `/floors/${scope.floorId}/editor-stages/${id}`);
    expect(["failed", "cancelled", "expired", "committed"], stage.errorCode ?? "stage 준비 실패").not.toContain(stage.status);
    return stage.status;
  }).toBe("ready");
  await expect(page.getByText("대량 편집 준비 완료 · 저장 대기", { exact: true })).toBeVisible();
  expect(await readDocument(page, scope)).toEqual(before);
  expect(await readDocument(page, scope, `/editor-stages/${id}`)).toMatchObject(dimensions);
}
async function saveStage(page: Page, scope: Scope, id: string) {
  const committed = waitResponse(page, `/floors/${scope.floorId}/editor-stages/${id}/commit`, "POST");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  const response = await committed;
  expect(response.status(), await response.text()).toBe(202);
  await expect.poll(async () => (await get<MapStage>(page, `/floors/${scope.floorId}/editor-stages/${id}`)).status).toBe("committed");
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  return get<MapStage>(page, `/floors/${scope.floorId}/editor-stages/${id}`);
}
async function saveCheckpoint(page: Page, scope: Scope, before: MapDocumentRef,
  dimensions: Pick<MapDocumentRef, "width" | "height" | "gridSize">) {
  const prefix = `/api/floors/${scope.floorId}/editor-stages`;
  const created = waitResponse(page, `/floors/${scope.floorId}/editor-stages`, "POST");
  const prepared = page.waitForResponse(response => response.request().method() === "POST"
    && new URL(response.url()).pathname.startsWith(`${prefix}/`) && new URL(response.url()).pathname.endsWith("/prepare"));
  const ready = page.waitForResponse(async response => response.request().method() === "GET"
    && new URL(response.url()).pathname.startsWith(`${prefix}/`) && !new URL(response.url()).pathname.slice(prefix.length + 1).includes("/")
    && response.ok() && (await response.json() as MapStage).status === "ready");
  const committed = page.waitForResponse(response => response.request().method() === "POST"
    && new URL(response.url()).pathname.startsWith(`${prefix}/`) && new URL(response.url()).pathname.endsWith("/commit"));
  await page.getByRole("button", { name: "저장", exact: true }).click();
  const response = await created;
  expect(response.status(), await response.text()).toBe(201);
  expect(response.request().postDataJSON()).toMatchObject({ expectedRevision: before.revision, floorPlan: dimensions,
    documentChanges: { generationId: before.generationId, operations: [] } });
  const stage = await response.json() as MapStage;
  const prepareResponse = await prepared;
  expect(new URL(prepareResponse.url()).pathname).toBe(`${prefix}/${stage.id}/prepare`);
  expect(prepareResponse.status(), await prepareResponse.text()).toBe(202);
  const preview = await (await ready).json() as MapStage;
  expect(preview).toMatchObject({ id: stage.id, status: "ready", preview: dimensions });
  const commitResponse = await committed;
  expect(new URL(commitResponse.url()).pathname).toBe(`${prefix}/${stage.id}/commit`);
  expect(commitResponse.status(), await commitResponse.text()).toBe(202);
  await expect.poll(async () => (await get<MapStage>(page, `/floors/${scope.floorId}/editor-stages/${stage.id}`)).status).toBe("committed");
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  return get<MapStage>(page, `/floors/${scope.floorId}/editor-stages/${stage.id}`);
}
async function assertFixturePreserved(page: Page, scope: Scope) {
  const state = await get<FloorEditorState>(page, `/floors/${scope.floorId}/editor-state`);
  expect(state.fixtures).toHaveLength(1);
  expect(state.fixtures[0]).toMatchObject({ id: scope.fixtureId, placementStatus: "unplaced" });
  expect(state.lightSlots).toEqual([]);
}
async function assertMonitoring(page: Page, scope: Scope, elements: MapElement[], info: TestInfo, label: string) {
  const ref = await readDocument(page, scope);
  await page.getByRole("link", { name: "모니터링", exact: true }).click();
  const map = page.getByRole("region", { name: "층 도면", exact: true });
  await map.scrollIntoViewIfNeeded();
  await expect(map.getByRole("img", { name: "맵 도형", exact: true }).locator("canvas")).toBeVisible();
  await expect(page.locator('[data-spatial-map-marker="true"]')).toHaveCount(0);
  expect(await readElements(page, scope)).toEqual(elements);
  const snapshot = floorMapSnapshotSchema.parse(await get(page, `/sites/${scope.siteId}/floors/${scope.floorId}/map-snapshot`));
  expect(snapshot.mapDocument).toEqual(ref);
  expect(snapshot.fixtures ?? []).toEqual([]);
  const target = elements.find(element => element.style.fillColor === red || element.style.strokeColor === red);
  expect(target, "일반 저장한 색상과 위치를 실제 모니터링에서 확인할 요소").toBeDefined();
  const bounds = getMapElementBounds(target!);
  // 격자/배경의 잉크는 통과시키지 않는다. 저장한 요소의 bounds 안에서 실제 합성된 빨강 픽셀을 찾는다.
  await expect.poll(async () => {
    const clip = await map.locator("[data-floor-map-surface]").evaluate((element, { bounds, width, height }) => {
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      const left = parseFloat(style.borderLeftWidth), top = parseFloat(style.borderTopWidth);
      const scaleX = (box.width - left - parseFloat(style.borderRightWidth)) / width;
      const scaleY = (box.height - top - parseFloat(style.borderBottomWidth)) / height;
      return { x: box.x + left + bounds.minX * scaleX, y: box.y + top + bounds.minY * scaleY,
        width: Math.max(1, (bounds.maxX - bounds.minX) * scaleX), height: Math.max(1, (bounds.maxY - bounds.minY) * scaleY) };
    }, { bounds, width: ref.width, height: ref.height });
    const screenshot = await page.screenshot({ clip, scale: "css" });
    return page.evaluate(async png => {
      const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 200 && [225, 29, 72].every((value, channel) => Math.abs(value - data[i + channel]) < 12)) ink++;
      }
      return ink;
    }, screenshot.toString("base64"));
  }).toBeGreaterThan(0);
  await lab.screenshot(page, info, `u14b-${label}-monitoring`);
}
async function sourceEvidence() {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const files = ["apps/web/e2e/common-map-real.spec.ts", "apps/web/e2e/support/real-backend-lab.ts",
    "apps/web/src/features/floor-editor/FloorEditorView.tsx", "apps/web/src/features/floor-editor/editor-store.ts",
    "apps/web/src/features/floor-editor/use-map-editor.ts", "apps/web/src/features/floor-editor/EditorPropertiesPanel.tsx",
    "apps/web/src/api/map-stages.ts",
    "apps/web/src/features/map-scene/MapSceneCanvas.tsx", "apps/api/src/floor-import/map-element-converter.ts"];
  const sha256: Record<string, string> = {};
  for (const file of files) sha256[file] = createHash("sha256").update(await readFile(`${root}/${file}`)).digest("hex");
  return { head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), sha256 };
}
async function registerUnplacedFixture(page: Page, siteId: string, floorId: string) {
  const session = await post<RegistrationSession>(page, "/registration-sessions", { siteId, floorId, gatewayId: lab.gateway.id });
  const suffix = `/registration-sessions/${session.id}`;
  const read = () => get<RegistrationSession>(page, suffix);
  await expect.poll(async () => (await read()).scanStatus).toBe("completed");
  // 기존 Lab의 첫 빈 RF scan 계약을 따른다. 실제 장비나 DB fixture 직접 삽입은 하지 않는다.
  expect((await read()).discoveredNodes).toEqual([]);
  await post(page, `${suffix}/scan/retry`, {});
  await expect.poll(async () => (await read()).scanStatus).toBe("completed");
  const node = (await read()).discoveredNodes.find(item => item.serialNumber === lab.fixtures[0].serialNumber);
  expect(node).toBeDefined();
  const batch = await post<RegisterFixtureBatchResult>(page, `${suffix}/nodes/register-batch`, { mode: "batch",
    defaults: { namePrefix: "U14b-", startNumber: 1, digits: 3, ratedWatt: "40.00", size: 20 }, nodes: [{ nodeId: node!.id }] });
  expect(batch.items[0]).toMatchObject({ nodeId: node!.id, status: "accepted" });
  await expect.poll(async () => (await read()).discoveredNodes.find(item => item.id === node!.id)?.status).toBe("provisioned");
  expect((await post<RegistrationSession>(page, `${suffix}/complete`, {})).status).toBe("completed");
}
