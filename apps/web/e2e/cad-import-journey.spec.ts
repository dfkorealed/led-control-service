import { expect, test, type Locator, type Page, type Route, type TestInfo } from "@playwright/test";
import { resolve } from "node:path";
import { buildCadSceneDescriptor, cadSceneManifestSchema, normalizeCadMapSize, type CadSceneState } from "@led-control/shared";
import { mapDisplayManifestSchema } from "@led-control/shared/map-display-contracts";
import type { MapDocumentRef, MapElement, MapOp } from "@led-control/shared/map-document-contracts";
import { getMapElementBounds } from "@led-control/shared/map-document-geometry";
import { encodeCadSceneTile, encodeMapDisplayTile, getCadSceneTileIntegrity } from "../../api/src/floor-import/cad-scene-codec";
import { installSettingsApiRoutes, type SettingsFixture } from "./support/settings-api";
import type { FloorEditorState, FloorImportJob } from "../src/features/floor-editor/editor-types";

const now = "2026-09-18T00:00:00.000Z";
const jobId = "00000000-0000-4000-8000-000000000020";
const sourceAssetId = "00000000-0000-4000-8000-000000000010";
const renderedAssetId = "00000000-0000-4000-8000-000000000040";
const candidates = [
  candidate("00000000-0000-4000-8000-000000000031", "insert-1", 200, 180),
  candidate("00000000-0000-4000-8000-000000000032", "insert-2", 400, 180)
];
const nativePoints = [{ x: 6400, y: 5376 }, { x: 7424, y: 4352 }, { x: 9472, y: 6400 }];
const nativeScene = createNativeScene();
const preparedScene = createPreparedScene();
const evidenceDirectory = resolve(import.meta.dirname, "../../../.local/cad-native-qa");

test.use({ actionTimeout: 10_000 });

test.beforeEach(async ({ page }) => {
  page.on("console", message => {
    if (message.type() === "error") console.error("CAD browser console:", message.text());
  });
});

for (const surface of ["editor", "monitoring"] as const) {
  test(`map loading ${surface} spans delayed query and image paint without returning on zoom`, async ({ page }, testInfo) => {
    const api = await installCadJourney(page, false);
    let releaseQuery!: () => void, releaseImage!: () => void;
    const query = new Promise<void>(resolve => { releaseQuery = resolve; });
    const image = new Promise<void>(resolve => { releaseImage = resolve; });
    const queryPath = surface === "editor" ? "floors/floor-1/editor-state" : "sites/site-1/floors/floor-1/map-snapshot";
    await page.route(`**/api/${queryPath}`, async route => { await query; await route.fallback(); });
    await page.route("**/api/floors/floor-1/assets/rendered/content", async route => { await image; await route.fallback(); });
    const loading = page.getByRole("status").filter({ hasText: "맵을 불러오는 중입니다." });
    try {
      await page.goto(surface === "editor" ? "/settings/floor-plans/floor-1/edit?siteId=site-1" : "/monitoring?siteId=site-1");
      await expect(loading).toHaveCount(1);
      await expect(loading).toHaveAttribute("aria-busy", "true");
      releaseQuery();
      const map = surface === "editor" ? page.getByTestId("floor-editor-canvas") : page.getByRole("region", { name: "층 도면" });
      await expect(map).toBeVisible();
      await expect(loading).toHaveCount(1);
      await page.screenshot({ path: testInfo.outputPath(`${surface}-loading.png`) });
      releaseImage();
      await expect(loading).toHaveCount(0);
      await page.getByRole("button", { name: surface === "editor" ? "확대" : "지도 확대", exact: true }).click();
      await expect(loading).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`${surface}-painted.png`) });
      expect(api.unhandledRequests).toEqual([]);
    } finally {
      releaseQuery();
      releaseImage();
    }
  });
}

test("map loading version-only editor save paints automatically with grid off and no slots", async ({ page }, testInfo) => {
  const api = await installCadJourney(page, false);
  api.state().lightSlots = [];
  await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
  const canvas = page.getByTestId("floor-editor-canvas");
  await expect(canvas).toBeVisible();
  await expect(canvas.getByRole("status")).toHaveCount(0);
  const transitions = await page.evaluate(async () => {
    const path = "/src/features/floor-editor/editor-store.ts";
    const { useFloorEditorStore } = await import(/* @vite-ignore */ path);
    useFloorEditorStore.getState().setSnap(false);
    await new Promise(resolve => setTimeout(resolve, 100));
    const root = document.querySelector('[data-testid="floor-editor-canvas"]')!;
    const store = useFloorEditorStore.getState();
    const camera = { pan: store.pan, zoom: store.zoom };
    return new Promise<{ loading: boolean; cameraStable: boolean }>((resolve, reject) => {
      let loading = false;
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("version paint did not settle")); }, 5000);
      const observer = new MutationObserver(() => {
        if (root.querySelector('[role="status"]')) loading = true;
        else if (loading) {
          observer.disconnect(); clearTimeout(timeout);
          const current = useFloorEditorStore.getState();
          resolve({ loading, cameraStable: JSON.stringify(camera) === JSON.stringify({ pan: current.pan, zoom: current.zoom }) });
        }
      });
      observer.observe(root, { childList: true, subtree: true });
      store.updateFloorPlan({ ...store.state.floor.floorPlan, version: store.state.floor.floorPlan.version + 1,
        gridSize: store.state.floor.floorPlan.gridSize + 10 });
    });
  });
  expect(transitions).toEqual({ loading: true, cameraStable: true });
  await expect(canvas.getByRole("status")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("version-only-painted.png") });
  expect(api.unhandledRequests).toEqual([]);
});

test("map loading readonly objects and empty maps announce their automatic first layer paint", async ({ page }, testInfo) => {
  const api = await installCadJourney(page, false);
  api.state().floor.floorPlan = null;
  await page.addInitScript(() => {
    const observed = window as unknown as { legacyPaintLoadingObserved: boolean };
    observed.legacyPaintLoadingObserved = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-floor-scene]') && [...document.querySelectorAll('[role="status"]')]
        .some(status => status.textContent?.includes("맵을 불러오는 중입니다."))) observed.legacyPaintLoadingObserved = true;
    }).observe(document, { childList: true, subtree: true });
  });
  for (const empty of [false, true]) {
    api.state().objects = empty ? [] : initialState().objects;
    await page.goto("/monitoring?siteId=site-1");
    await expect(page.getByRole("region", { name: "층 도면" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as { legacyPaintLoadingObserved: boolean }).legacyPaintLoadingObserved)).toBe(true);
    await expect(page.getByRole("status").filter({ hasText: "맵을 불러오는 중입니다." })).toHaveCount(0);
    await page.getByRole("button", { name: "지도 확대", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "맵을 불러오는 중입니다." })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`readonly-${empty ? "empty" : "objects"}-painted.png`) });
    await page.goto("about:blank");
  }
  expect(api.unhandledRequests).toEqual([]);
});

async function expectCadPageBounded(page: Page) {
  await expect.poll(() => page.evaluate(() => ({
    width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
    height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - innerHeight,
    x: window.scrollX, y: window.scrollY
  }))).toEqual({ width: 0, height: 0, x: 0, y: 0 });
}

for (const width of [1039, 1434]) {
  test(`map editor comments CAD ${width}x909 opens a centered import dialog and restores its trigger`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 909 });
    const api = await installCadJourney(page, true);
    await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
    const trigger = page.getByRole("button", { name: "CAD 가져오기", exact: true });
    await page.screenshot({ path: testInfo.outputPath(`comments-cad-trigger-${width}.png`) });
    await expect(trigger, "opening the import dialog must not require a preselected file").toBeEnabled();
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "CAD 가져오기", exact: true });
    await expect(dialog).toBeVisible();
    await expectCadPageBounded(page);
    const box = (await dialog.boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.y + box.height / 2 - 909 / 2)).toBeLessThanOrEqual(2);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(909);
    const file = dialog.getByLabel("CAD 파일");
    await file.setInputFiles({ name: "parking.dwg", mimeType: "application/dwg", buffer: Buffer.from("AC1027-e2e-cad") });
    await page.screenshot({ path: testInfo.outputPath(`comments-cad-file-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(page.getByLabel("CAD 파일")).toHaveCount(0);
    await expectCadPageBounded(page);
    expect(api.applyPayloads()).toEqual([]);
    expect(api.savePayloads()).toEqual([]);
    expect(api.unhandledRequests).toEqual([]);
  });

  test(`map editor comments CAD ${width}x909 selects one preview and recovers failed apply with lease fence`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 909 });
    const api = await installCadJourney(page, true);
    await page.route("**/api/floors/floor-1/editor-lease", route => json(route, {
      editable: true, token: "comments-lease", fence: 73
    }));
    let releaseUpload!: () => void;
    const uploadPending = new Promise<void>(resolve => { releaseUpload = resolve; });
    await page.route("**/cad-e2e-upload", async route => {
      await uploadPending;
      await route.fulfill({ status: 200, body: "" });
    });
    const attempts: unknown[] = [];
    await page.route(`**/api/floors/floor-1/import-jobs/${jobId}/apply`, async route => {
      attempts.push(route.request().postDataJSON());
      if (attempts.length === 1) return json(route, { message: "Fixture apply unavailable" }, 503);
      return route.fallback();
    });
    await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
    await page.getByRole("button", { name: "CAD 가져오기", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "CAD 가져오기", exact: true });
    await dialog.getByLabel("CAD 파일").setInputFiles({
      name: "parking.dwg", mimeType: "application/dwg", buffer: Buffer.from("AC1027-e2e-cad")
    });
    try {
      await dialog.getByRole("button", { name: "파일 업로드", exact: true }).click();
      const progress = dialog.getByRole("progressbar", { name: "CAD 가져오기 진행률" });
      await expect(progress).toBeVisible();
      await expect(progress).toHaveAttribute("max", "100");
      const value = Number(await progress.getAttribute("value"));
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(100);
      await expect(dialog.getByRole("status", { name: "CAD 가져오기 상태" })).toContainText("CAD 파일을 업로드하는 중");
      await page.screenshot({ path: testInfo.outputPath(`comments-cad-progress-${width}.png`) });
    } finally {
      // Always release the synthetic upload even when a progress assertion fails.
      releaseUpload();
    }
    const regions = dialog.getByRole("button", { name: "가져올 도면 영역", exact: true });
    await expect(regions).toBeVisible();
    const preview = dialog.getByRole("region", { name: "CAD 도면 미리보기" });
    await expect(preview).toHaveCount(1);
    await expect(preview.getByRole("img")).toHaveCount(1);
    await expect(dialog.getByRole("radiogroup")).toHaveCount(0);
    await expect(dialog.getByRole("radio")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: /미리보기 보기/ })).toHaveCount(0);
    await expect(regions).toHaveText(/도면 영역 1/);
    expect(api.regionPayloads()).toEqual([]);
    await regions.click();
    await page.getByRole("option", { name: "도면 영역 2", exact: true }).click();
    await expect(preview.getByRole("img")).toHaveAttribute("src", "/api/floors/floor-1/assets/00000000-0000-4000-8000-000000000051/content");
    await expect(preview.getByRole("img")).toHaveCount(1);
    await regions.click();
    await page.getByRole("option", { name: "도면 영역 1", exact: true }).click();
    await expect(preview.getByRole("img")).toHaveAttribute("src", "/api/floors/floor-1/assets/00000000-0000-4000-8000-000000000050/content");
    await expectCadPageBounded(page);
    await page.screenshot({ path: testInfo.outputPath(`comments-cad-region-${width}.png`) });
    await dialog.getByRole("button", { name: "선택 영역으로 장면 만들기" }).click();
    await expect.poll(() => api.regionPayloads()).toEqual([{ regionId: "region-1" }]);
    await expect(dialog.getByText("조명 위치 후보 2개를 찾았습니다.")).toBeVisible();
    await expect(preview).toHaveCount(1);
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    const apply = dialog.getByRole("button", { name: "확인 및 적용", exact: true });
    await expect(apply).toBeEnabled();
    await expectCadPageBounded(page);
    await page.screenshot({ path: testInfo.outputPath(`comments-cad-review-${width}.png`) });
    await apply.click();
    const reset = page.getByRole("dialog", { name: "새 CAD 도면으로 맵을 교체할까요?" });
    await expect(reset).toContainText("조명 2개가 미배치 상태로 변경됩니다.");
    await expect(reset).toContainText("수동 도형 1개가 삭제됩니다.");
    await expect(reset).toContainText("기존 CAD 슬롯 1개가 삭제됩니다.");
    await reset.getByRole("button", { name: "취소", exact: true }).click();
    await expect(reset).toBeHidden();
    expect(attempts).toEqual([]);
    expect(api.state().floor.mapRevision).toBe(1);
    await expect(apply).toBeFocused();
    await apply.click();
    await reset.getByRole("button", { name: "교체 후 적용" }).click();
    await expect.poll(() => attempts.length).toBe(1);
    await expect(reset).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("서버 적용이 완료되지 않았습니다. 후보 선택을 확인한 뒤 다시 시도하세요.", { exact: true })).toBeVisible();
    await expect(apply).toBeEnabled();
    expect(api.state().floor.mapRevision).toBe(1);
    expect(api.state().objects).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath(`comments-cad-apply-recovery-${width}.png`) });
    await apply.click();
    await reset.getByRole("button", { name: "교체 후 적용" }).click();
    await expect.poll(() => attempts.length).toBe(2);
    const expectedPayload = {
      expectedRevision: 1, confirmMapReset: true, leaseToken: "comments-lease", leaseFence: 73,
      candidateIds: ["00000000-0000-4000-8000-000000000031", "00000000-0000-4000-8000-000000000032"]
    };
    expect(attempts).toEqual([expectedPayload, expectedPayload]);
    await expect(reset).toBeHidden();
    await expect(dialog).toBeHidden();
    await expect.poll(() => api.state().floor.mapRevision).toBe(2);
    expect(api.state().objects).toEqual([]);
    expect(api.state().lightSlots).toHaveLength(2);
    expect(api.state().fixtures.every(fixture => fixture.placementStatus === "unplaced")).toBe(true);
    expect(api.savePayloads()).toEqual([]);
    expect(api.unhandledRequests).toEqual([]);
    expect(api.browserErrors).toEqual([]);
    await expectCadPageBounded(page);
    await page.screenshot({ path: testInfo.outputPath(`comments-cad-applied-${width}.png`) });
  });
}

for (const lease of [
  { name: "read-only", value: { editable: false, holderName: "다른 관리자" } },
  { name: "missing-fence", value: { editable: true, token: "unfenced-lease", fence: 0 } }
]) {
  test(`map editor comments CAD ${lease.name} lease cannot mutate a recovered import`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1434, height: 909 });
    const api = await installPreparedReview(page);
    const mutations: string[] = [];
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/floors/floor-1/") && request.method() !== "GET" && !path.endsWith("/editor-lease")) {
        mutations.push(`${request.method()} ${path}`);
      }
    });
    await page.route("**/api/floors/floor-1/editor-lease", route => json(route, lease.value));
    await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
    const dialog = page.getByRole("dialog", { name: "CAD 가져오기", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("region", { name: "CAD 도면 미리보기" })).toHaveAttribute("data-preview-ready", "true");
    await expect(dialog.getByRole("button", { name: "확인 및 적용", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "가져오기 취소", exact: true })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath(`comments-cad-${lease.name}.png`) });
    expect(mutations).toEqual([]);
    expect(api.payloads).toEqual([]);
    expect(api.state().floor.mapRevision).toBe(1);
  });
}

for (const native of [false, true]) {
  test(`${native ? "Native WebGL: region 선택부터" : "Legacy SVG: 기존 적용 맵부터"} 슬롯 배치, 저장, 새로고침, 모니터링까지 (route fixture)`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1_440, height: 900 });
    const api = await installCadJourney(page, native);
    const points = (native ? nativePoints : candidates).map(({ x, y }) => ({ x, y }));
    const size = native ? nativeScene.manifest : { width: 1200, height: 800 };

    await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
    await expect(page.getByRole("heading", { name: "B1 맵 편집" })).toBeVisible();
    await expect(page.getByRole("button", { name: "저장됨", exact: true })).toBeDisabled();
    if (native) {
    expect(api.state().objects).toHaveLength(1);
    expect(api.state().fixtures.filter(fixture => fixture.placementStatus === "placed")).toHaveLength(2);
    // The pre-conversion legacy map uses its compatibility image, not a common
    // renderer. The newly applied prepared document is verified below.
    await expect(page.getByTestId("floor-editor-canvas")).toHaveAttribute("data-background-url", "/api/floors/floor-1/assets/rendered/content");
    const appliedStateRequestsAtStart = api.appliedStateRequestsBeforeApply();

    await page.getByRole("button", { name: "CAD 가져오기", exact: true }).click();
    const importDialog = page.getByRole("dialog", { name: "CAD 가져오기", exact: true });
    await page.getByLabel("CAD 파일").setInputFiles({
      name: "parking.dwg",
      mimeType: "application/dwg",
      buffer: Buffer.from("AC1027-e2e-cad")
    });
    await importDialog.getByRole("button", { name: "파일 업로드", exact: true }).click();
    await expect(importDialog.getByRole("button", { name: "가져올 도면 영역", exact: true })).toHaveText(/도면 영역 1/);
    const buildScene = page.getByRole("button", { name: "선택 영역으로 장면 만들기" });
    await expect(buildScene).toBeEnabled();
    expect(api.regionPayloads()).toEqual([]);
    await expect(page.getByRole("img", { name: "도면 영역 1 미리보기", exact: true })).toBeVisible();
    await buildScene.click();
    await expect.poll(() => api.regionPayloads()).toEqual([{ regionId: "region-1" }]);
    await expect(page.getByText("조명 위치 후보 2개를 찾았습니다.")).toBeVisible();
    await expect(page.getByText("선택한 도면 영역의 장면 생성이 완료되었습니다.")).toBeVisible();

    if (native) {
      const preview = importDialog.getByRole("region", { name: "CAD 도면 미리보기" });
      await expect(preview).toHaveAttribute("data-preview-ready", "true");
      await expectImportPreviewFits(page);
      await expectNativePixel(page, () => importPreviewPoint(page, nativePoints[2]), [225, 29, 72], preview);
      await expect(importDialog.getByRole("checkbox")).toHaveCount(0);
      // Import review is isolated from the committed editor until confirmation.
      await expect(page.getByTestId("floor-editor-canvas")).toHaveAttribute("data-rendered-fixture-count", "2");
      await expect(page.getByTestId("floor-editor-canvas")).toHaveAttribute("data-rendered-object-count", "1");
      await saveScreenshot(page, testInfo, "native-review-before-apply");
      expect(api.appliedStateRequestsBeforeApply()).toBe(appliedStateRequestsAtStart);
    }

    const applyButton = importDialog.getByRole("button", { name: "확인 및 적용", exact: true });
    await applyButton.click();
    let resetDialog = page.getByRole("dialog", { name: "새 CAD 도면으로 맵을 교체할까요?" });
    await expect(resetDialog).toContainText("조명 2개가 미배치 상태로 변경됩니다.");
    await expect(resetDialog).toContainText("수동 도형 1개가 삭제됩니다.");
    await expect(resetDialog).toContainText("기존 CAD 슬롯 1개가 삭제됩니다.");
    await resetDialog.getByRole("button", { name: "취소" }).click();
    await expect(resetDialog).not.toBeVisible();
    expect(api.applyPayloads()).toHaveLength(0);

    await applyButton.click();
    resetDialog = page.getByRole("dialog", { name: "새 CAD 도면으로 맵을 교체할까요?" });
    await resetDialog.getByRole("button", { name: "교체 후 적용" }).click();
    await expect.poll(() => api.applyPayloads()).toHaveLength(1);
    expect(api.applyPayloads()[0]).toMatchObject({
      expectedRevision: 1,
      confirmMapReset: true,
      candidateIds: expect.arrayContaining(candidates.map(candidate => candidate.id))
    });
    expect((api.applyPayloads()[0] as { candidateIds: string[] }).candidateIds).toHaveLength(candidates.length);
    await expect.poll(() => api.state().objects).toHaveLength(0);
    await expect.poll(() => api.state().lightSlots).toHaveLength(2);
    await expect.poll(() => api.state().fixtures.every(fixture => fixture.placementStatus === "unplaced")).toBe(true);
    await expect(page.getByText("CAD 도면을 적용하고 저장했습니다.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "저장됨", exact: true })).toBeDisabled();
    }

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "저장됨", exact: true })).toBeDisabled();
    await expect(page.getByTestId("placement-fixture-fixture-1")).toBeVisible();
    await expect(page.getByTestId("placement-fixture-fixture-2")).toBeVisible();
    await expect(page.getByTestId("floor-editor-canvas")).toHaveAttribute("data-map-width", String(size.width));
    await expect(page.getByTestId("floor-editor-canvas")).toHaveAttribute("data-map-height", String(size.height));
    if (native) {
      await page.getByRole("button", { name: "맵 맞춤", exact: true }).click();
      await expectEditorMapFits(page);
    }

    const canvas = page.getByTestId("floor-editor-canvas");
    const transform = await canvas.evaluate(element => ({
      zoom: Number(element.dataset.zoom),
      panX: Number(element.dataset.panX),
      panY: Number(element.dataset.panY)
    }));
    await page.getByTestId("placement-fixture-fixture-1").dragTo(canvas, {
      targetPosition: { x: transform.panX + points[0].x * transform.zoom, y: transform.panY + points[0].y * transform.zoom }
    });
    await page.getByTestId("placement-fixture-fixture-2").dragTo(canvas, {
      targetPosition: { x: transform.panX + points[1].x * transform.zoom, y: transform.panY + points[1].y * transform.zoom }
    });
    await expect.poll(async () => (await currentState(page)).fixtures.filter(fixture => fixture.placementStatus === "placed").length).toBe(2);
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await expect(page.getByRole("button", { name: "저장됨", exact: true })).toBeDisabled();
    await expect.poll(() => api.savePayloads()).toHaveLength(1);
    expect(api.savePayloads()[0]).toMatchObject({
      expectedRevision: 2,
      fixtureUpdates: [
        { id: "fixture-1", ...points[0], placementStatus: "placed" },
        { id: "fixture-2", ...points[1], placementStatus: "placed" }
      ],
      slotAssignments: [
        { slotId: "slot-1", assignedFixtureId: "fixture-1" },
        { slotId: "slot-2", assignedFixtureId: "fixture-2" }
      ]
    });
    expect(api.state().lightSlots.map(slot => slot.assignedFixtureId)).toEqual(["fixture-1", "fixture-2"]);

    // Native edits must adopt the fixture save's new revision without a reload.
    // Keep the legacy reload path as separate persisted-placement coverage.
    if (!native) await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "B1 맵 편집" })).toBeVisible();
    await expect.poll(async () => (await currentState(page)).floor.mapRevision).toBe(3);
    await expect.poll(async () => (await currentState(page)).lightSlots.map(slot => slot.assignedFixtureId))
      .toEqual(["fixture-1", "fixture-2"]);

    if (native) {
      await page.getByRole("button", { name: "맵 맞춤", exact: true }).click();
      await expectNativePixel(page, () => editorPoint(page, nativePoints[2]), [225, 29, 72]);
      await saveScreenshot(page, testInfo, "native-editor-before-edit");
      const position = await editorPoint(page, nativePoints[2], false);
      await canvas.click({ position });
      await expect(page.getByRole("region", { name: "선택 속성" }).getByRole("heading", { name: "3개 선택", exact: true })).toBeVisible();
      await canvas.dblclick({ position });
      const properties = page.getByRole("complementary", { name: "도형 속성" });
      await expect(properties.getByRole("heading")).toHaveText("사각형");
      await saveScreenshot(page, testInfo, "native-editor-primitive-selection");
      await properties.getByLabel("채우기 색상").fill("#06b6d4");
      await page.getByRole("button", { name: "저장", exact: true }).click();
      await expect.poll(() => api.savePayloads()).toHaveLength(2);
      expect(api.savePayloads()[1]).toMatchObject({
        expectedRevision: 3, leaseToken: "lease-floor-1", leaseFence: 1,
        documentChanges: { generationId: "prepared-first", operations: [{ kind: "update",
          element: expect.objectContaining({ id: "prepared-2", style: expect.objectContaining({ fillColor: "#06b6d4" }) }) }] }
      });
      await expect(page.getByRole("button", { name: "저장됨", exact: true })).toBeDisabled();
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(canvas).toBeVisible();
      await page.getByRole("button", { name: "맵 맞춤", exact: true }).click();
      await expectNativePixel(page, () => editorPoint(page, nativePoints[2]), [6, 182, 212]);
      await canvas.dblclick({ position: await editorPoint(page, nativePoints[2], false) });
      await expect(page.getByRole("complementary", { name: "도형 속성" }).getByLabel("채우기 색상")).toHaveValue("#06b6d4");
      await saveScreenshot(page, testInfo, "native-editor-after-reload");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "맵 맞춤", exact: true }).click();
      await expectEditorMapFits(page);
      // At whole-map mobile scale the grid lines cover every native color pixel.
      const mobileTools = page.getByRole("button", { name: "도구 및 조명 패널", exact: true });
      await mobileTools.click();
      await page.getByText("격자 스냅", { exact: true }).click();
      await expect(page.getByRole("checkbox", { name: "격자 스냅" })).not.toBeChecked();
      await mobileTools.click();
      await canvas.scrollIntoViewIfNeeded();
      await canvas.click({ position: { x: 12, y: 12 } });
      await canvas.evaluate(element => element.scrollIntoView({ block: "center" }));
      await expectNativePixel(page, () => editorPoint(page, nativePoints[2]), [6, 182, 212]);
      await saveScreenshot(page, testInfo, "native-editor-mobile-fit");
      await page.setViewportSize({ width: 1440, height: 900 });
    }

    const snapshotResponse = page.waitForResponse(response => response.url().includes("/map-snapshot") && response.status() === 200);
    await page.getByRole("link", { name: "모니터링", exact: true }).click();
    await expect(page).toHaveURL(/\/monitoring\?siteId=site-1$/);
    expect(await (await snapshotResponse).json()).toMatchObject({ revision: native ? 4 : 3, floorPlan: { renderedImageUrl: "/api/floors/floor-1/assets/rendered/content" } });
    await expect(page.getByRole("region", { name: "층 도면" })).toBeVisible();
    const renderedPlan = page.getByRole("img", { name: "B1 도면" });
    if (native) await expect(renderedPlan).toHaveCount(0);
    else {
      await expect(renderedPlan).toHaveAttribute("src", "/api/floors/floor-1/assets/rendered/content");
      await expect.poll(() => renderedPlan.evaluate((image: HTMLImageElement) => ({ complete: image.complete, width: image.naturalWidth, height: image.naturalHeight })))
        .toEqual({ complete: true, width: 1200, height: 800 });
    }
    const firstMarker = page.getByRole("button", { name: "B1-L01 정상 70%" });
    const secondMarker = page.getByRole("button", { name: "B1-L02 정상 70%" });
    await expectMarkerAtMapPoint(page, firstMarker, points[0], size);
    await expectMarkerAtMapPoint(page, secondMarker, points[1], size);
    if (native) {
      await verifyMonitoringComposition(page, size);
      await saveScreenshot(page, testInfo, "native-monitor-desktop-pan-zoom");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: /^지도 배율 \d+%$/ }).click();
      await verifyMonitoringComposition(page, size);
      await saveScreenshot(page, testInfo, "native-monitor-mobile-pan-zoom");
    }
    await expect.poll(() => api.monitoringSnapshotRequests()).toBeGreaterThan(0);
    expect(api.browserErrors).toEqual([]);
    expect(api.unhandledRequests).toEqual([]);
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`native CAD + 1,000 fixture browser benchmark ${viewport.width}x${viewport.height} (no backend/HIL)`, async ({ page }, testInfo) => {
    test.setTimeout(45_000);
    await page.setViewportSize(viewport);
    const generatedAt = new Date().toISOString();
    const fixtures: SettingsFixture[] = Array.from({ length: 1000 }, (_, index) => {
      const point = index < 2 ? nativePoints[index] : {
        x: 300 + (index % 40) * 395,
        y: 250 + Math.floor(index / 40) * 405
      };
      // Reserve space for a CAD pixel target and pan gesture, including the
      // fixed-pixel marker halos at the narrow viewport's whole-map scale.
      const y = index >= 2 && Math.hypot(point.x - nativePoints[2].x, point.y - nativePoints[2].y) < 2400 ? point.y - 4000 : point.y;
      return {
        id: `33333333-3333-4333-8333-${String(index + 1).padStart(12, "0")}`,
        name: `B1-L${String(index + 1).padStart(4, "0")}`, x: point.x, y,
        size: 20, ratedWatt: 40, brightness: 70, status: "online", statusReason: "reported",
        health: { faultCodes: [], observedAt: generatedAt }, rssi: -60, hopCount: 2,
        commandSuccessRate: 0.99, lastSeenAt: generatedAt,
        gateway: { id: "gateway-1", name: "Gateway B1", connectionStatus: "online" },
        controllable: true, controlBlockReason: null
      };
    });
    const api = await installSettingsApiRoutes(page, "admin", {
      fixtures, mapObjects: [], mapDimensions: nativeScene.manifest,
      ids: { siteId: "site-1", floorId: "floor-1", gatewayId: "gateway-1" }
    });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
      if (await serveNativeAsset(route, path)) return;
      if (path === nativeScene.descriptor.statePath) return json(route, {
        revision: 1, scene: nativeScene.descriptor, overrides: [], layers: []
      });
      if (path === "/sites/site-1/floors/floor-1/map-snapshot") return json(route, {
        floorId: "floor-1", revision: 1, width: nativeScene.manifest.width, height: nativeScene.manifest.height,
        floorPlan: floorPlan(true), cadScene: nativeScene.descriptor, objects: [],
        fixtures: fixtures.map(({ id, name, x, y, size }) => ({ id, name, x, y, size }))
      });
      return route.fallback();
    });
    const startedAt = Date.now();
    await page.goto("/monitoring?siteId=site-1");
    await expect(page.locator('[data-spatial-map-marker="true"]')).toHaveCount(1000, { timeout: 10_000 });
    await page.getByRole("region", { name: "층 도면" }).scrollIntoViewIfNeeded();
    await expectNativePixel(page, () => monitoringPoint(page, nativePoints[2]), [225, 29, 72]);
    const readyMs = Date.now() - startedAt;
    expect(readyMs).toBeLessThan(10_000);
    const interactionStartedAt = Date.now();
    await verifyMonitoringComposition(page, nativeScene.manifest, [225, 29, 72]);
    const panZoomProofMs = Date.now() - interactionStartedAt;
    expect(errors).toEqual([]);
    expect(api.fixturePageRequests).toBe(5);
    await saveScreenshot(page, testInfo, `native-1000-${viewport.width}`);
    const metrics = { viewport, fixtures: 1000, nativePrimitives: 3, readyMs, panZoomProofMs, fixturePageRequests: api.fixturePageRequests,
      scope: "Synthetic API routes, real Chromium WebGL/worker; screenshot assertion time included; not real DWG/backend/HIL or FPS benchmark" };
    console.log("native CAD browser benchmark", JSON.stringify(metrics));
    await testInfo.attach("browser-benchmark.json", { body: JSON.stringify(metrics, null, 2), contentType: "application/json" });
  });
}

for (const width of [1440, 390]) {
  test(`U13 prepared common import recovery and zero-candidate replacement ${width} (route fixture)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(({ mobile }) => {
      if (mobile) document.addEventListener("DOMContentLoaded", () => {
        document.documentElement.dataset.ledControlMobileWebview = "true";
        document.documentElement.dataset.ledControlNativeAppState = "active";
      });
    }, { mobile: width < 768 });
    const api = await installPreparedReview(page);
    await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
    const canvas = page.getByTestId("floor-editor-canvas");
    const importDialog = page.getByRole("dialog", { name: "CAD 가져오기", exact: true });
    const preview = importDialog.getByRole("region", { name: "CAD 도면 미리보기" });
    await expect(page.getByText("조명 위치 후보 2개를 찾았습니다.")).toBeVisible();
    await expect(preview).toHaveAttribute("data-preview-ready", "true");
    await expect(canvas).toHaveAttribute("data-background-url", "/api/floors/floor-1/assets/rendered/content");
    await expect(canvas).toHaveAttribute("data-rendered-object-count", "1");
    await expect(canvas).toHaveAttribute("data-rendered-fixture-count", "2");
    await expect(page.getByTestId("cad-scene-canvas")).toHaveCount(0);
    await expectImportPreviewFits(page);
    // The modal preview owns its fit on resize; the committed map and its
    // camera stay untouched until the reset confirmation applies all candidates.
    await page.setViewportSize({ width, height: 900 });
    await expectImportPreviewFits(page);
    await preview.scrollIntoViewIfNeeded();
    await expectNativePixel(page, () => importPreviewPoint(page, nativePoints[2]), [225, 29, 72], preview);
    await saveScreenshot(page, testInfo, `u13-prepared-${width}`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expectImportPreviewFits(page);
    await expect(importDialog.getByRole("checkbox")).toHaveCount(0);
    // The committed map has its own source; reviewing must not replace it.
    expect(api.state().floor.mapDocument).toBeUndefined();
    expect(api.requests.some(path => path.startsWith("/floors/floor-1/map-document"))).toBe(false);
    expect(api.requests.filter(path => path.includes("/map-document/tiles/")).length).toBeGreaterThan(0);

    // Recovery comes from the fixture's durable job, not a local editor draft.
    await page.reload();
    await expect(page.getByText("조명 위치 후보 2개를 찾았습니다.")).toBeVisible();
    await expect(preview).toHaveAttribute("data-preview-ready", "true");
    await expectImportPreviewFits(page);
    await expect(importDialog.getByRole("checkbox")).toHaveCount(0);
    await importDialog.getByRole("button", { name: "확인 및 적용", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "새 CAD 도면으로 맵을 교체할까요?" });
    await expect(dialog).toContainText("조명 2개가 미배치 상태로 변경됩니다.");
    expect(api.payloads).toHaveLength(0);
    await dialog.getByRole("button", { name: "교체 후 적용" }).click();
    await expect.poll(() => api.payloads.length).toBe(1);
    expect(api.payloads[0]).toMatchObject({ candidateIds: [candidates[0].id, candidates[1].id], expectedRevision: 1,
      confirmMapReset: true, leaseToken: "lease-floor-1", leaseFence: 1 });
    await expect.poll(() => api.state().lightSlots).toEqual([
      expect.objectContaining({ x: nativePoints[0].x, y: nativePoints[0].y, assignedFixtureId: null }),
      expect.objectContaining({ x: nativePoints[1].x, y: nativePoints[1].y, assignedFixtureId: null })
    ]);
    expect(api.state().objects).toEqual([]);
    expect(api.state().fixtures.every(fixture => fixture.placementStatus === "unplaced")).toBe(true);

    api.nextReview();
    await page.reload();
    await expect(page.getByText("조명 위치 후보 0개를 찾았습니다.")).toBeVisible();
    await expect(preview).toHaveAttribute("data-preview-ready", "true");
    await expectImportPreviewFits(page);
    await importDialog.getByRole("button", { name: "확인 및 적용", exact: true }).click();
    await dialog.getByRole("button", { name: "교체 후 적용" }).click();
    await expect.poll(() => api.payloads.length).toBe(2);
    expect(api.payloads[1]).toMatchObject({ candidateIds: [], expectedRevision: 2, confirmMapReset: true });
    await expect.poll(() => api.state().lightSlots).toEqual([]);
    await page.reload();
    await expect(page.getByTestId("placement-fixture-fixture-1")).toBeVisible();
    await expect(page.getByRole("img", { name: "맵 도형", exact: true })).toBeVisible();
    expect(api.state().floor.mapDocument?.generationId).toBe("prepared-second");
    expect(api.state().floor.mapRevision).toBe(3);
    expect(api.requests.some(path => /\/import-jobs\/[^/]+\/scene\//.test(path))).toBe(false);
    expect(api.browserErrors).toEqual([]);
    expect(api.unhandledRequests).toEqual([]);
  });
}

for (const order of ["hook-first", "renderer-first"]) {
  test(`U13 R1 import UI manifest completion ${order} and retry (route fixture)`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const api = await installPreparedReview(page);
    const pending = new Map<number, () => void>();
    let manifestRequests = 0;
    let overlap = true;
    let failRenderer = false;
    await page.route(`**/api/floors/floor-1/import-jobs/${jobId}/map-document/manifest?**`, async route => {
      const index = ++manifestRequests;
      // First manifest verifies the hook; second mounts the real renderer;
      // third is the visibility-triggered hook refetch while mount is pending.
      if (overlap && (index === 2 || index === 3)) {
        await new Promise<void>(resolve => { pending.set(index, resolve); });
      }
      if (failRenderer && index === 2) {
        failRenderer = false;
        return json(route, { message: "Fixture renderer manifest failure" }, 503);
      }
      return route.fallback();
    });
    await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
    const preview = page.getByRole("dialog", { name: "CAD 가져오기", exact: true })
      .getByRole("region", { name: "CAD 도면 미리보기" });
    // Sample a visible rectangle corner, away from the candidate's blue marker.
    const pixel = () => importPreviewPoint(page, { x: nativePoints[1].x + 140, y: nativePoints[1].y + 140 });
    await expect(preview).toBeVisible();
    await expect.poll(() => pending.has(2)).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => pending.has(3)).toBe(true);
    const first = order === "hook-first" ? 3 : 2;
    const completed = page.waitForResponse(response => response.url().includes(`/import-jobs/${jobId}/map-document/manifest?`));
    pending.get(first)!();
    await (await completed).finished();
    pending.get(first === 3 ? 2 : 3)!();
    await expect(preview).toHaveAttribute("data-preview-ready", "true");
    await expectNativePixel(page, pixel, [225, 29, 72], preview);
    await expect(page.getByRole("button", { name: "도면 다시 불러오기" })).toHaveCount(0);
    await expect(page.getByTestId("cad-scene-canvas")).toHaveCount(0);
    await expect(page.getByTestId("floor-editor-canvas")).toHaveAttribute("data-background-url", "/api/floors/floor-1/assets/rendered/content");

    overlap = false;
    failRenderer = true;
    manifestRequests = 0;
    await page.reload();
    await page.getByRole("button", { name: "도면 다시 불러오기" }).click();
    await expect(preview).toHaveAttribute("data-preview-ready", "true");
    await expectNativePixel(page, pixel, [225, 29, 72], preview);
    await expect(page.getByRole("button", { name: "도면 다시 불러오기" })).toHaveCount(0);
    expect(api.payloads).toEqual([]);
    expect(api.browserErrors).toEqual([]);
    expect(api.unhandledRequests).toEqual([]);
  });
}

async function installPreparedReview(page: Page) {
  const base = await installCadJourney(page, true);
  let activeJob: FloorImportJob | null = importJob("review_required", 100, true);
  let reviewCandidates = candidates.map((value, index) => ({ ...value, ...nativePoints[index] }));
  let prepared = preparedScene.ref;
  const payloads: unknown[] = [];
  const requests: string[] = [];
  await page.route("**/api/floors/floor-1/**", async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    requests.push(path);
    if (path === "/floors/floor-1/import-jobs/active") return json(route, { job: activeJob });
    if (activeJob) {
      const prefix = `/floors/floor-1/import-jobs/${activeJob.jobId}`;
      if (await servePreparedAsset(route, path, activeJob.jobId, prepared)) return;
      if (path === prefix) return json(route, activeJob);
      if (path === `${prefix}/regions`) return json(route, { ...regions(true), jobId: activeJob.jobId,
        regions: regions(true).regions.map(region => ({ ...region,
          lightCandidateCount: region.regionId === "region-1" ? reviewCandidates.length : 0 })) });
      if (path === `${prefix}/candidates`) return json(route, { candidates: reviewCandidates });
      if (path === `${prefix}/apply`) {
        const payload = route.request().postDataJSON();
        payloads.push(payload);
        const state = base.state();
        expect(payload.expectedRevision).toBe(state.floor.mapRevision);
        const accepted = reviewCandidates.filter(candidate => payload.candidateIds.includes(candidate.id));
        const deletedObjectCount = state.objects.length;
        const deletedSlotCount = state.lightSlots.length;
        const unplacedFixtureCount = state.fixtures.filter(fixture => fixture.placementStatus === "placed").length;
        state.objects = [];
        state.fixtures = state.fixtures.map(fixture => ({ ...fixture, x: 0, y: 0, placementStatus: "unplaced" }));
        state.lightSlots = accepted.map((candidate, index) => ({ id: `slot-${index + 1}`, x: candidate.x,
          y: candidate.y, rotation: 0, assignedFixtureId: null }));
        state.floor.mapRevision++;
        state.floor.cadScene = null;
        state.floor.mapDocument = { ...prepared, revision: state.floor.mapRevision };
        state.floor.floorPlan = floorPlan(true);
        const { version: _version, ...appliedFloorPlan } = floorPlan(true);
        // Apply's shared DTO still requires compatibility metadata. The common
        // preview never reads those assets; this is not a compatibility-OFF test.
        const result = { jobId: activeJob.jobId, status: "completed", revision: state.floor.mapRevision,
          acceptedCandidateIds: accepted.map(candidate => candidate.id), renderedAssetId,
          deletedObjectCount, deletedSlotCount, unplacedFixtureCount, createdSlotCount: accepted.length,
          floorPlan: appliedFloorPlan };
        activeJob = null;
        return json(route, result);
      }
    }
    const applied = base.state().floor.mapDocument;
    if (applied && await servePreparedAsset(route, path, undefined, applied)) return;
    return route.fallback();
  });
  return { ...base, payloads, requests, nextReview: () => {
    activeJob = { ...importJob("review_required", 100, true), jobId: "00000000-0000-4000-8000-000000000021" };
    prepared = { ...preparedScene.ref, generationId: "prepared-second" };
    reviewCandidates = [];
  } };
}

async function installCadJourney(page: Page, native = false) {
  const browserErrors: string[] = [];
  const unhandledRequests: string[] = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  let pollCount = 0;
  let applied = !native;
  let selected = false;
  let monitoringSnapshotRequestCount = 0;
  let appliedStateRequestsBeforeApply = 0;
  const applyPayloads: unknown[] = [];
  const savePayloads: unknown[] = [];
  const regionPayloads: unknown[] = [];
  const cadPayloads: unknown[] = [];
  const state = initialState();
  let appliedElements = preparedElements("#06b6d4");
  const appliedOperations: MapOp[] = [];
  const oldSceneId = "00000000-0000-4000-8000-000000000080";
  const oldJobId = "00000000-0000-4000-8000-000000000081";
  const oldDescriptor = { ...nativeScene.descriptor, id: oldSceneId, sourceImportJobId: oldJobId,
    manifestContentPath: nativeScene.descriptor.manifestContentPath.replace(jobId, oldJobId),
    tileContentPathTemplate: nativeScene.descriptor.tileContentPathTemplate.replace(jobId, oldJobId) };
  const oldTiles = nativeScene.tiles.map(tile => ({ ...tile, descriptor: { ...tile.descriptor, sceneId: oldSceneId } }));
  const oldScene = { descriptor: oldDescriptor, tiles: oldTiles,
    manifest: { ...nativeScene.manifest, sceneId: oldSceneId, tiles: oldTiles.map(tile => tile.descriptor) } };
  if (native) {
    state.floor.cadScene = oldDescriptor;
    state.floor.floorPlan = floorPlan(true);
  }
  const reviewCandidates = candidates.map((candidate, index) => ({ ...candidate, ...(native ? nativePoints[index] : {}) }));
  if (!native) {
    // New imports are native; legacy coverage starts from an already-applied SVG map.
    state.objects = [];
    state.fixtures = state.fixtures.map(fixture => ({ ...fixture, x: 0, y: 0, placementStatus: "unplaced" }));
    state.lightSlots = reviewCandidates.map((candidate, index) => ({ id: `slot-${index + 1}`, x: candidate.x, y: candidate.y, rotation: candidate.rotation, assignedFixtureId: null }));
    state.floor.mapRevision = 2;
    state.floor.floorPlan = floorPlan(false);
  }
  const sceneState: CadSceneState = { revision: 2, scene: nativeScene.descriptor, overrides: [], layers: [] };
  await page.route("**/old.svg", route => svg(route));

  await page.route("**/cad-e2e-upload", route => route.fulfill({ status: 200, body: "" }));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname.replace(/^\/api/, "");
    if (native && await servePreparedAsset(route, path, jobId, preparedScene.ref)) return;
    const document = state.floor.mapDocument;
    if (native && document && path.startsWith("/floors/floor-1/map-document")) {
      if (path.endsWith("/elements")) {
        const ids = request.postDataJSON().ids as string[];
        return json(route, appliedElements.filter(element => ids.includes(element.id)));
      }
      if (path.endsWith("/selection")) {
        const query = request.postDataJSON();
        return json(route, { generationId: document.generationId, revision: document.revision,
          ids: appliedElements.filter(element => {
            if (query.groupId && element.groupId !== query.groupId) return false;
            if (!query.bounds) return true;
            const bounds = getMapElementBounds(element);
            return bounds.minX <= query.bounds.maxX && bounds.maxX >= query.bounds.minX
              && bounds.minY <= query.bounds.maxY && bounds.maxY >= query.bounds.minY;
          }).map(element => element.id), nextCursor: null });
      }
      if (await servePreparedAsset(route, path, undefined, document,
        applied ? preparedScene : createPreparedScene("#06b6d4"), appliedOperations)) return;
    }
    if (native && path === nativeScene.descriptor.statePath) {
      if (!applied) appliedStateRequestsBeforeApply += 1;
      if (!applied) return json(route, { revision: state.floor.mapRevision, scene: oldDescriptor,
        layers: [], overrides: [{ elementId: "native-3", hidden: false, transform: null, strokeColor: null,
          fillColor: "#06b6d4", strokeWidth: null, text: null, locator: { lod: 0, tileX: 18, tileY: 12, part: 0 } }] });
      if (request.method() === "PUT") {
        const payload = request.postDataJSON();
        cadPayloads.push(payload);
        expect(payload.expectedRevision).toBe(state.floor.mapRevision);
        sceneState.overrides = payload.overrideMutations.map((mutation: { value: object; locator: object }) => ({
          hidden: false, transform: null, strokeColor: null, fillColor: null, strokeWidth: null, text: null,
          ...mutation.value, locator: mutation.locator
        }));
        state.floor.mapRevision += 1;
      }
      return json(route, { ...sceneState, revision: state.floor.mapRevision });
    }
    if (native && (await serveNativeAsset(route, path) || await serveNativeAsset(route, path, oldScene))) return;
    if (path === "/auth/me") return json(route, { user: { id: "user-1", organizationId: "org-1", organizationType: "customer", loginId: "admin", name: "관리자", role: "admin", status: "active" } });
    if (path === "/sites") return json(route, [{ id: "site-1", name: "검증 현장" }]);
    if (path === "/sites/site-1/monitoring-incidents") return json(route, {
      incidents: [], unreadCount: 0, activeCount: 0, nextCursor: null
    });
    if (path === "/sites/site-1/floors/floor-1/monitoring-activity") return json(route, {
      generatedAt: new Date().toISOString(), retainedFrom: now, items: [], nextCursor: null
    });
    if (path === "/sites/site-1/dashboard") return json(route, dashboard(state));
    if (path === "/sites/site-1/floors/floor-1/fixtures") return json(route, { items: staleMonitoringFixtures(state), nextCursor: null, generatedAt: new Date().toISOString() });
    if (path === "/sites/site-1/floors/floor-1/map-snapshot") {
      monitoringSnapshotRequestCount += 1;
      return json(route, mapSnapshot(state));
    }
    if (path === "/floors/floor-1/editor-state") {
      if (request.method() === "PUT") {
        const payload = request.postDataJSON();
        savePayloads.push(payload);
        for (const update of payload.fixtureUpdates) Object.assign(state.fixtures.find(fixture => fixture.id === update.id)!, update);
        const lightSlotUpdates = new Map<string, string | null>(
          payload.slotAssignments.map((update: { slotId: string; assignedFixtureId: string | null }) => [update.slotId, update.assignedFixtureId])
        );
        state.lightSlots = state.lightSlots.map(slot => ({
          ...slot,
          assignedFixtureId: lightSlotUpdates.has(slot.id) ? lightSlotUpdates.get(slot.id)! : slot.assignedFixtureId
        }));
        state.floor.mapRevision += 1;
        if (state.floor.mapDocument) {
          state.floor.mapDocument.revision = state.floor.mapRevision;
          for (const operation of (payload.documentChanges?.operations ?? []) as MapOp[]) {
            appliedOperations.push(operation);
            if (operation.kind === "update") appliedElements = appliedElements.map(element =>
              element.id === operation.element.id ? operation.element : element);
          }
        }
      }
      return json(route, state);
    }
    if (path === "/floors/floor-1/editor-lease") return json(route, { editable: true, token: "lease-floor-1", fence: 1 });
    if (path === "/floors/floor-1/editor-revisions") return json(route, { items: [], nextCursor: null });
    if (path === "/floors/floor-1/import-jobs/applied-overlay") return json(route, {
      overlay: applied ? {
        floorId: "floor-1", jobId, revision: state.floor.mapRevision,
        renderedAssetId, renderedAssetPath: "/api/floors/floor-1/assets/rendered/content",
        renderedViewport: native ? { width: nativeScene.manifest.width, height: nativeScene.manifest.height } : { width: 1200, height: 800 },
        appliedAt: now, candidates: reviewCandidates.map(candidate => ({ ...candidate, reviewStatus: "accepted" }))
      } : null
    });
    if (path === "/floors/floor-1/import-jobs/active") return json(route, { job: null });
    if (path === "/floors/floor-1/assets/upload-intent") return json(route, {
      assetId: sourceAssetId, uploadUrl: `${url.origin}/cad-e2e-upload`,
      accessPath: "/api/floors/floor-1/assets/source/content", expiresInSeconds: 300
    });
    if (path === `/floors/floor-1/assets/${sourceAssetId}/complete`) return json(route, {
      id: sourceAssetId, kind: "original", status: "ready", mimeType: "application/dwg", sizeBytes: 15,
      sha256: "a".repeat(64), accessPath: "/api/floors/floor-1/assets/source/content"
    });
    if (path === "/floors/floor-1/import-jobs" && request.method() === "POST") return json(route, importJob("queued", 0, native));
    if (path === `/floors/floor-1/import-jobs/${jobId}`) {
      pollCount += 1;
      return json(route, selected ? importJob("review_required", 100, native) : pollCount === 1 ? importJob("processing", 55, native) : importJob("region_selection_required", 70, native));
    }
    if (path === `/floors/floor-1/import-jobs/${jobId}/regions/select`) {
      regionPayloads.push(request.postDataJSON());
      selected = true;
      return json(route, regions(selected));
    }
    if (path === `/floors/floor-1/import-jobs/${jobId}/regions`) return json(route, regions(selected));
    if (/\/assets\/00000000-0000-4000-8000-00000000005[01]\/content$/.test(path)) return svg(route);
    if (path === `/floors/floor-1/import-jobs/${jobId}/candidates`) {
      return json(route, { candidates: reviewCandidates });
    }
    if (path === `/floors/floor-1/import-jobs/${jobId}/apply`) {
      const payload = request.postDataJSON();
      applyPayloads.push(payload);
      applied = true;
      state.objects = [];
      state.fixtures = state.fixtures.map(fixture => ({ ...fixture, x: 0, y: 0, placementStatus: "unplaced" }));
      const accepted = reviewCandidates.filter(candidate => payload.candidateIds.includes(candidate.id));
      state.lightSlots = accepted.map((candidate, index) => ({ id: `slot-${index + 1}`, x: candidate.x, y: candidate.y, rotation: candidate.rotation, assignedFixtureId: null }));
      state.floor.mapRevision = 2;
      state.floor.floorPlan = floorPlan(native);
      if (native) {
        state.floor.cadScene = null;
        state.floor.mapDocument = { ...preparedScene.ref, revision: 2 };
        appliedElements = preparedElements("#e11d48");
        appliedOperations.length = 0;
      }
      const { version: _version, ...appliedFloorPlan } = floorPlan(native);
      return json(route, {
        jobId, status: "completed", revision: 2, acceptedCandidateIds: accepted.map(candidate => candidate.id),
        renderedAssetId, deletedObjectCount: 1, unplacedFixtureCount: 2, deletedSlotCount: 1, createdSlotCount: accepted.length,
        floorPlan: appliedFloorPlan
      });
    }
    if (path === "/floors/floor-1/assets/rendered/content") return route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#fff"/><path d="M40 400H1160" stroke="#111827"/></svg>'
    });
    unhandledRequests.push(`${request.method()} ${path}`);
    return json(route, { message: path }, 404);
  });
  return {
    state: () => state, applyPayloads: () => applyPayloads, savePayloads: () => savePayloads,
    monitoringSnapshotRequests: () => monitoringSnapshotRequestCount,
    appliedStateRequestsBeforeApply: () => appliedStateRequestsBeforeApply,
    regionPayloads: () => regionPayloads, cadPayloads: () => cadPayloads, browserErrors, unhandledRequests
  };
}

function initialState(): FloorEditorState {
  return {
    floor: { id: "floor-1", siteId: "site-1", name: "B1", level: -1, mapRevision: 1, floorPlan: { imageUrl: "/old.svg", width: 800, height: 600, version: 1 } },
    objects: [{ id: "object-1", floorId: "floor-1", type: "rectangle", x: 50, y: 50, width: 200, height: 100, rotation: 0, strokeColor: "#334155", fillColor: "transparent", strokeWidth: 1, text: "", fontSize: null, zIndex: 0, locked: false, visible: true }],
    lightSlots: [{ id: "old-slot", x: 100, y: 100, rotation: 0, assignedFixtureId: "fixture-1" }],
    fixtures: [
      { id: "fixture-1", name: "B1-L01", x: 100, y: 100, size: 20, ratedWatt: 40, brightness: 70, status: "online", placementStatus: "placed", positionVerifiedAt: null },
      { id: "fixture-2", name: "B1-L02", x: 300, y: 100, size: 20, ratedWatt: 40, brightness: 70, status: "online", placementStatus: "placed", positionVerifiedAt: null }
    ]
  };
}

function importJob(status: FloorImportJob["status"], progressPercent: number, native = false): FloorImportJob {
  return {
    jobId, floorId: "floor-1", sourceAssetId, renderedAssetId: !native && status === "review_required" ? renderedAssetId : null,
    sourceFormat: "dwg", status, stage: status, progressPercent, attemptCount: status === "queued" ? 0 : 1,
    parserVersion: status === "review_required" ? "libredwg-0.14" : null,
    detectorVersion: status === "review_required" ? "site-drawing-20260803-v1" : null,
    failureCode: null, sourceAssetPath: "/api/floors/floor-1/assets/source/content",
    renderedAssetPath: !native && status === "review_required" ? "/api/floors/floor-1/assets/rendered/content" : null,
    renderedViewport: !native && status === "review_required" ? { width: 1200, height: 800 } : null,
    startedAt: status === "queued" ? null : now, reviewRequiredAt: status === "review_required" ? now : null,
    appliedAt: null, completedAt: null, failedAt: null, cancelledAt: null, createdAt: now, updatedAt: now
  };
}

function candidate(id: string, sourceEntityId: string, x: number, y: number) {
  return {
    id, sourceEntityId, layerName: "LIGHT", blockName: "LED", x, y, rotation: 0, confidence: 0.95,
    detectionMethod: "rule_based" as const, provider: null, model: null, inputDigest: null,
    profileVersion: "site-drawing-20260803-v1", profileDigest: "b".repeat(64), reviewStatus: "pending" as const
  };
}

function floorPlan(native = false) {
  return {
    imageUrl: "/api/floors/floor-1/assets/rendered/content", sourceType: native ? "cad" as const : "image" as const,
    originalFileUrl: "/api/floors/floor-1/assets/source/content",
    renderedImageUrl: "/api/floors/floor-1/assets/rendered/content", width: native ? nativeScene.manifest.width : 1200,
    height: native ? nativeScene.manifest.height : 800, gridSize: native ? nativeScene.manifest.gridSize : 10, version: 2
  };
}

function dashboard(state: FloorEditorState) {
  const fixtures = staleMonitoringFixtures(state);
  return {
    generatedAt: new Date().toISOString(), monitoringPolicy: { gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 1200 },
    capabilities: { read: true, control: true, manage: true, commission: true },
    site: { id: "site-1", name: "검증 현장", customerName: "고객사", installationStatus: "installed", address: null, tariffKwhRate: 160, timeZone: "Asia/Seoul" },
    summary: { totalFixtures: fixtures.length, onlineFixtures: fixtures.length, faultFixtures: 0, averageBrightness: 70 },
    floors: [{ id: "floor-1", name: "B1", level: -1, floorPlan: { imageUrl: "/old.svg", width: 800, height: 600, version: 1 }, meshControlGroups: [], fixtures }],
    groups: [], gateways: []
  };
}

function staleMonitoringFixtures(state: FloorEditorState) {
  return state.fixtures.map((fixture, index) => monitoringFixture({
    ...fixture,
    x: 900 + index * 50,
    y: 700,
    placementStatus: "unplaced"
  }));
}

function monitoringFixture(fixture: FloorEditorState["fixtures"][number]) {
  return {
    ...fixture, rssi: -55, hopCount: 1, commandSuccessRate: 1, lastSeenAt: new Date().toISOString(),
    health: null, gateway: { id: "gateway-1", name: "Gateway B1", connectionStatus: "online" as const },
    controllable: true, controlBlockReason: null
  };
}

function mapSnapshot(state: FloorEditorState) {
  return {
    floorId: "floor-1", revision: state.floor.mapRevision,
    width: state.floor.floorPlan?.width ?? 1200, height: state.floor.floorPlan?.height ?? 800,
    floorPlan: state.floor.floorPlan, cadScene: state.floor.cadScene, mapDocument: state.floor.mapDocument, objects: state.objects,
    fixtures: state.lightSlots.flatMap(slot => {
      if (!slot.assignedFixtureId) return [];
      const fixture = state.fixtures.find(candidate => candidate.id === slot.assignedFixtureId);
      return fixture ? [{ id: fixture.id, name: fixture.name, x: slot.x, y: slot.y, size: fixture.size ?? 20 }] : [];
    })
  };
}

async function currentState(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/features/floor-editor/editor-store.ts";
    const { useFloorEditorStore } = await import(/* @vite-ignore */ path);
    return useFloorEditorStore.getState().state as FloorEditorState;
  });
}

async function expectMarkerAtMapPoint(
  page: Page,
  marker: Locator,
  point: { x: number; y: number },
  size = { width: 1200, height: 800 }
) {
  const actual = await marker.evaluate(element => {
    const markerBounds = element.getBoundingClientRect();
    const surfaceElement = element.closest("[data-floor-map-surface]")!;
    const surface = surfaceElement.getBoundingClientRect();
    const style = getComputedStyle(surfaceElement);
    const borderLeft = parseFloat(style.borderLeftWidth);
    const borderTop = parseFloat(style.borderTopWidth);
    const borderRight = parseFloat(style.borderRightWidth);
    const borderBottom = parseFloat(style.borderBottomWidth);
    return {
      x: markerBounds.left + markerBounds.width / 2 - surface.left - borderLeft,
      y: markerBounds.top + markerBounds.height / 2 - surface.top - borderTop,
      width: surface.width - borderLeft - borderRight,
      height: surface.height - borderTop - borderBottom
    };
  });
  expect(actual.x).toBeCloseTo(actual.width * point.x / size.width, 0);
  expect(actual.y).toBeCloseTo(actual.height * point.y / size.height, 0);
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function saveScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = resolve(evidenceDirectory, `${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

function svg(route: Route) {
  return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect x="40" y="40" width="1120" height="720" fill="none" stroke="#111827"/></svg>' });
}

function regions(selected: boolean) {
  return {
    jobId, selectionStatus: selected ? "selected" : "selection_required", selectedRegionId: selected ? "region-1" : null,
    excludedRegionPrimitiveCount: selected ? 1 : 0,
    regions: [3, 1].map((primitiveCount, index) => ({
      regionId: `region-${index + 1}`, bounds: { minX: 0, minY: 0, maxX: 1200, maxY: 800 },
      primitiveCount, textCount: 0, lightCandidateCount: index === 0 ? 2 : 0, area: 960000,
      preview: { assetId: `00000000-0000-4000-8000-00000000005${index}`, width: 1200, height: 800, byteSize: 1024, sha256: "c".repeat(64) }
    }))
  };
}

// These synthetic map-space rectangles exercise the production binary decoder,
// worker, WebGL renderer and picker. No DWG parser or backend is running here.
function createNativeScene() {
  const sceneId = "00000000-0000-4000-8000-000000000060";
  const manifestAssetId = "00000000-0000-4000-8000-000000000061";
  const sourceBounds = { minX: 5000, minY: 7000, maxX: 6200, maxY: 7800 };
  const size = normalizeCadMapSize(sourceBounds);
  const scale = Math.min((size.width - 2 * size.padding) / 1200, (size.height - 2 * size.padding) / 800);
  const tiles = nativePoints.map(({ x, y }, index) => {
    const tileX = Math.floor(x / 512);
    const tileY = Math.floor(y / 512);
    const payload = encodeCadSceneTile([{
      elementId: `native-${index + 1}`, groupId: "group-1", layerName: "WALLS", sourceType: "LWPOLYLINE",
      bounds: { minX: x - 200, minY: y - 200, maxX: x + 200, maxY: y + 200 }, clipBounds: null,
      style: { strokeColor: "#111827", fillColor: "#e11d48", strokeWidth: 4, opacity: 1 },
      type: "rectangle", geometry: { origin: { x: x - 200, y: y - 200 }, width: 400, height: 400, rotation: 0 }
    }]);
    return { payload, descriptor: {
      version: 1 as const, sceneId, tileX, tileY, lod: 0 as const, part: 0,
      assetId: `00000000-0000-4000-8000-00000000007${index}`, primitiveCount: 1,
      ...getCadSceneTileIntegrity(payload),
      bounds: { minX: tileX * 512, minY: tileY * 512, maxX: (tileX + 1) * 512, maxY: (tileY + 1) * 512 }
    } };
  });
  const manifest = cadSceneManifestSchema.parse({
    version: 1, sceneId, regionId: "region-1", manifestAssetId, ...size,
    tileSize: 512, lodMode: "additive", primitiveCount: 3, tileCount: tiles.length,
    byteSize: 1024, sha256: "a".repeat(64), sourceBounds,
    transform: { scaleX: scale, scaleY: -scale,
      translateX: (size.width - 1200 * scale) / 2 - sourceBounds.minX * scale,
      translateY: (size.height + 800 * scale) / 2 + sourceBounds.minY * scale },
    tiles: tiles.map(tile => tile.descriptor)
  });
  const descriptor = buildCadSceneDescriptor("site-1", "floor-1", {
    id: sceneId, version: 1, sourceImportJobId: jobId, ...size,
    tileSize: 512, primitiveCount: 3, tileCount: tiles.length, manifestAssetId
  });
  return { manifest, descriptor, tiles };
}

function preparedElements(fillColor: string): MapElement[] {
  return nativePoints.map(({ x, y }, index) => ({
    id: `prepared-${index}`, groupId: "group-1", layerId: "walls", zIndex: index,
    visible: true, locked: false, provenance: { importJobId: jobId, sourceId: `native-${index + 1}` },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    style: { strokeColor: "#111827", fillColor, strokeWidth: 4, opacity: 1 },
    type: "rectangle", geometry: { origin: { x: x - 200, y: y - 200 }, width: 400, height: 400 }
  }));
}

function createPreparedScene(fillColor = "#e11d48") {
  const { sceneId, manifestAssetId, width, height, gridSize } = nativeScene.manifest;
  const tiles = nativePoints.map(({ x, y }, index) => {
    const tileX = Math.floor(x / 512);
    const tileY = Math.floor(y / 512);
    const payload = encodeMapDisplayTile([{
      elementId: `prepared-${index}`, groupId: "group-1", layerName: "WALLS", sourceType: "LWPOLYLINE",
      zIndex: index, fragmentOrder: 0,
      bounds: { minX: x - 200, minY: y - 200, maxX: x + 200, maxY: y + 200 }, clipBounds: null,
      style: { strokeColor: "#111827", fillColor, strokeWidth: 4, opacity: 1 },
      type: "rectangle", geometry: { origin: { x: x - 200, y: y - 200 }, width: 400, height: 400, rotation: 0 }
    }]);
    return { payload, descriptor: { version: 2 as const, sceneId, tileX, tileY, lod: 0 as const, part: 0,
      assetId: `00000000-0000-4000-8000-00000000009${index}`, primitiveCount: 1,
      ...getCadSceneTileIntegrity(payload),
      bounds: { minX: tileX * 512, minY: tileY * 512, maxX: (tileX + 1) * 512, maxY: (tileY + 1) * 512 } } };
  });
  const ref: MapDocumentRef = { formatVersion: 1, generationId: "prepared-first", revision: 0,
    width, height, gridSize, elementCount: 3,
    manifest: { assetId: "canonical-prepared", byteSize: 1, decodedByteSize: 1, sha256: "a".repeat(64) } };
  const display = mapDisplayManifestSchema.parse({ version: 2, sceneId, manifestAssetId, regionId: "region-1",
    width, height, gridSize, padding: 0, tileSize: 512, lodMode: "additive", primitiveCount: 3,
    tileCount: tiles.length, byteSize: 1, sha256: "b".repeat(64),
    sourceBounds: { minX: 0, minY: 0, maxX: width, maxY: height },
    transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }, tiles: tiles.map(tile => tile.descriptor) });
  return { ref, display, tiles };
}

async function servePreparedAsset(route: Route, path: string, importJobId: string | undefined, ref: MapDocumentRef,
  scene = preparedScene, operations: MapOp[] = []) {
  const prefix = `/floors/floor-1${importJobId ? `/import-jobs/${importJobId}` : ""}/map-document`;
  if (!path.startsWith(prefix)) return false;
  if (path === prefix) await json(route, ref);
  else {
    const query = new URL(route.request().url()).searchParams;
    expect(query.get("generationId")).toBe(ref.generationId);
    expect(query.get("revision")).toBe(String(ref.revision));
    if (path === `${prefix}/manifest`) await json(route, { generationId: ref.generationId, revision: ref.revision,
      canonical: ref.manifest, display: scene.display,
      groups: [{ id: "group-1", parentId: null, name: "Prepared", visible: true, locked: false }],
      layers: [{ id: "walls", name: "WALLS", order: 0, visible: true, locked: false }],
      displayLayerBindings: [{ layerName: "WALLS", layerId: "walls" }] });
    else if (path === `${prefix}/changes`) await json(route, { generationId: ref.generationId, revision: ref.revision,
      operations, nextCursor: null });
    else {
      const tile = scene.tiles.find(tile => path === `${prefix}/tiles/${tile.descriptor.assetId}`);
      if (!tile) return false;
      await route.fulfill({ contentType: "application/octet-stream", body: tile.payload });
    }
  }
  return true;
}

async function serveNativeAsset(route: Route, path: string, scene = nativeScene) {
  if (path === scene.descriptor.manifestContentPath) {
    await json(route, scene.manifest);
    return true;
  }
  for (const { descriptor, payload } of scene.tiles) {
    const tilePath = scene.descriptor.tileContentPathTemplate
      .replace("{lod}", String(descriptor.lod)).replace("{tileX}", String(descriptor.tileX))
      .replace("{tileY}", String(descriptor.tileY)).replace("{part}", String(descriptor.part));
    if (path === tilePath) {
      await route.fulfill({ contentType: "application/octet-stream", body: payload });
      return true;
    }
  }
  return false;
}

async function editorPoint(page: Page, point: { x: number; y: number }, absolute = true) {
  return page.getByTestId("floor-editor-canvas").evaluate((element, { point, absolute }) => {
    const bounds = element.getBoundingClientRect();
    return {
      x: Number(element.dataset.panX) + point.x * Number(element.dataset.zoom) + (absolute ? bounds.left : 0),
      y: Number(element.dataset.panY) + point.y * Number(element.dataset.zoom) + (absolute ? bounds.top : 0)
    };
  }, { point, absolute });
}

async function importPreviewPoint(page: Page, point: { x: number; y: number }) {
  return page.getByRole("dialog", { name: "CAD 가져오기", exact: true })
    .getByRole("region", { name: "CAD 도면 미리보기" }).evaluate((element, { point, size }) => {
      const bounds = element.getBoundingClientRect();
      const zoom = Number((element as HTMLElement).dataset.zoom);
      return {
        x: bounds.left + (bounds.width - size.width * zoom) / 2 + point.x * zoom,
        y: bounds.top + (bounds.height - size.height * zoom) / 2 + point.y * zoom
      };
    }, { point, size: { width: nativeScene.manifest.width, height: nativeScene.manifest.height } });
}

async function expectImportPreviewFits(page: Page) {
  const preview = page.getByRole("dialog", { name: "CAD 가져오기", exact: true })
    .getByRole("region", { name: "CAD 도면 미리보기" });
  await expect.poll(() => preview.evaluate((element, size) => {
    const bounds = element.getBoundingClientRect();
    const zoom = Number((element as HTMLElement).dataset.zoom);
    return zoom > 0 && size.width * zoom <= bounds.width - 48 + 1 && size.height * zoom <= bounds.height - 48 + 1;
  }, { width: nativeScene.manifest.width, height: nativeScene.manifest.height }), {
    message: "the complete prepared map fits the import dialog preview"
  }).toBe(true);
}

async function expectEditorMapFits(page: Page) {
  await expect.poll(() => page.getByTestId("floor-editor-canvas").evaluate(element => {
    const { width, height } = element.getBoundingClientRect();
    const zoom = Number(element.dataset.zoom);
    const x = Number(element.dataset.panX);
    const y = Number(element.dataset.panY);
    return x >= 0 && y >= 0 &&
      x + Number(element.dataset.mapWidth) * zoom <= width &&
      y + Number(element.dataset.mapHeight) * zoom <= height;
  }), { message: "the complete native map fits the editor viewport" }).toBe(true);
}

async function monitoringPoint(page: Page, point: { x: number; y: number }, size = nativeScene.manifest) {
  return page.locator("[data-floor-map-surface]").evaluate((element, { point, size }) => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const left = parseFloat(style.borderLeftWidth);
    const top = parseFloat(style.borderTopWidth);
    return {
      x: bounds.left + left + (bounds.width - left - parseFloat(style.borderRightWidth)) * point.x / size.width,
      y: bounds.top + top + (bounds.height - top - parseFloat(style.borderBottomWidth)) * point.y / size.height
    };
  }, { point, size: { width: size.width, height: size.height } });
}

async function expectNativePixel(page: Page, locatePoint: () => Promise<{ x: number; y: number }>, rgb: number[], root: Page | Locator = page) {
  const canvas = root.locator('[data-testid="cad-scene-canvas"], [role="img"][aria-label="맵 도형"] canvas');
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => Boolean(element.getContext("webgl2") ?? element.getContext("webgl")))).toBe(true);
  // Sampling the composited screenshot (rather than readPixels after presentation)
  // also catches an opaque Konva/image layer accidentally covering valid WebGL.
  await expect.poll(async () => {
    const screenshot = await page.screenshot({ scale: "css" });
    const point = await locatePoint();
    return page.evaluate(async ({ png, point, rgb }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const sample = document.createElement("canvas");
      sample.width = image.width;
      sample.height = image.height;
      const context = sample.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(Math.round(point.x) - 2, Math.round(point.y) - 2, 5, 5).data;
      let matching = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (rgb.every((value, channel) => Math.abs(value - pixels[offset + channel]) < 12)) matching++;
      }
      return matching;
    }, { png: screenshot.toString("base64"), point, rgb });
  }, { message: `visible native CAD pixels with RGB ${rgb.join(",")}` }).toBeGreaterThan(0);
}

async function verifyMonitoringComposition(page: Page, size: { width: number; height: number } = nativeScene.manifest, rgb = [6, 182, 212]) {
  const region = page.getByRole("region", { name: "층 도면" });
  await region.scrollIntoViewIfNeeded();
  const verify = async () => {
    await expectNativePixel(page, () => monitoringPoint(page, nativePoints[2]), rgb);
    for (const [index, point] of nativePoints.slice(0, 2).entries()) {
      await expectMarkerAtMapPoint(page, page.locator('[data-spatial-map-marker="true"]').nth(index), point, size);
    }
  };
  await verify();
  const initialZoom = await region.getAttribute("data-zoom");
  await page.getByRole("button", { name: "지도 확대", exact: true }).click({ clickCount: 5 });
  await expect(region).not.toHaveAttribute("data-zoom", initialZoom!);
  await verify();
  const beforePan = await monitoringPoint(page, nativePoints[2]);
  const panStart = await monitoringPoint(page, { x: nativePoints[2].x + 500, y: nativePoints[2].y });
  expect(await page.evaluate(point => Boolean(document.elementFromPoint(point.x, point.y)?.closest("button")), panStart)).toBe(false);
  // Manual CAD navigation owns keyboard input on the inner gesture viewport,
  // not the outer floor-map region used for composition assertions.
  const viewport = page.getByTestId("monitoring-map-viewport");
  await viewport.focus();
  await expect(viewport).toBeFocused();
  await page.keyboard.down("Space");
  await page.mouse.move(panStart.x, panStart.y);
  await page.mouse.down();
  // Drag toward increasing scroll offsets; the fitted view may start at zero.
  await page.mouse.move(panStart.x - 22, panStart.y - 14, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  await expect.poll(async () => {
    const afterPan = await monitoringPoint(page, nativePoints[2]);
    return Math.hypot(afterPan.x - beforePan.x, afterPan.y - beforePan.y);
  }).toBeGreaterThan(10);
  await verify();
}
