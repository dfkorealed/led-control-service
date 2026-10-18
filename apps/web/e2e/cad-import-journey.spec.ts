import {
  installPreparedReview, installCadJourney, initialState, candidate, floorPlan, json, regions,
  createParityScene, serveNativeAsset, now, jobId, candidates, nativePoints, nativeScene
} from "./support/cad-journey";
import { expect, test, type Locator, type Page, type Route, type TestInfo } from "@playwright/test";
import { resolve } from "node:path";
import { installSettingsApiRoutes, type SettingsFixture } from "./support/settings-api";
import type { FloorEditorState } from "../src/features/floor-editor/editor-types";

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
    await expect(dialog.getByRole("button", { name: "확인 및 적용", exact: true })).toBeVisible();
    await expect(dialog.getByText(/조명 위치 후보|전체 슬롯 후보/)).toHaveCount(0);
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
    await expect(dialog.getByText("서버 적용이 완료되지 않았습니다. 도면을 확인한 뒤 다시 시도하세요.", { exact: true })).toBeVisible();
    await expect(apply).toBeEnabled();
    expect(api.state().floor.mapRevision).toBe(1);
    expect(api.state().objects).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath(`comments-cad-apply-recovery-${width}.png`) });
    await apply.click();
    await reset.getByRole("button", { name: "교체 후 적용" }).click();
    await expect.poll(() => attempts.length).toBe(2);
    const expectedPayload = {
      expectedRevision: 1, confirmMapReset: true, leaseToken: "comments-lease", leaseFence: 73,
      candidateIds: []
    };
    expect(attempts).toEqual([expectedPayload, expectedPayload]);
    await expect(reset).toBeHidden();
    await expect(dialog).toBeHidden();
    await expect.poll(() => api.state().floor.mapRevision).toBe(2);
    expect(api.state().objects).toEqual([]);
    expect(api.state().lightSlots).toHaveLength(0);
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
  test(`${native ? "Native WebGL: region 선택부터 슬롯 없이" : "Legacy SVG: 기존 적용 맵 슬롯 유지"} 조명 배치, 저장, 새로고침, 모니터링까지 (route fixture)`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1_440, height: 900 });
    const api = await installCadJourney(page, native);
    // New CAD has no placement slots; normal placement follows its 80-unit grid.
    // Historical legacy slots retain their original exact attachment positions.
    const points = (native ? nativePoints : candidates).map(({ x, y }) => native
      ? { x: Math.round(x / 80) * 80, y: Math.round(y / 80) * 80 } : { x, y });
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
    await expect(importDialog.getByRole("button", { name: "확인 및 적용", exact: true })).toBeVisible();
    await expect(importDialog.getByText(/조명 위치 후보|전체 슬롯 후보/)).toHaveCount(0);
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
      candidateIds: []
    });
    expect((api.applyPayloads()[0] as { candidateIds: string[] }).candidateIds).toHaveLength(0);
    await expect.poll(() => api.state().objects).toHaveLength(0);
    await expect.poll(() => api.state().lightSlots).toHaveLength(0);
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
      slotAssignments: native ? [] : [
        { slotId: "slot-1", assignedFixtureId: "fixture-1" },
        { slotId: "slot-2", assignedFixtureId: "fixture-2" }
      ]
    });
    expect(api.state().lightSlots.map(slot => slot.assignedFixtureId)).toEqual(native ? [] : ["fixture-1", "fixture-2"]);

    // Native edits must adopt the fixture save's new revision without a reload.
    // Keep the legacy reload path as separate persisted-placement coverage.
    if (!native) await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "B1 맵 편집" })).toBeVisible();
    await expect.poll(async () => (await currentState(page)).floor.mapRevision).toBe(3);
    await expect.poll(async () => (await currentState(page)).lightSlots.map(slot => slot.assignedFixtureId))
      .toEqual(native ? [] : ["fixture-1", "fixture-2"]);

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
      await verifyMonitoringComposition(page, size, undefined, points);
      await saveScreenshot(page, testInfo, "native-monitor-desktop-pan-zoom");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: /^지도 배율 \d+%$/ }).click();
      await verifyMonitoringComposition(page, size, undefined, points);
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
    await expect(importDialog.getByRole("button", { name: "확인 및 적용", exact: true })).toBeVisible();
    await expect(importDialog.getByText(/조명 위치 후보|전체 슬롯 후보/)).toHaveCount(0);
    await expect(preview).toHaveAttribute("data-preview-ready", "true");
    await expect(canvas).toHaveAttribute("data-background-url", "/api/floors/floor-1/assets/rendered/content");
    await expect(canvas).toHaveAttribute("data-rendered-object-count", "1");
    await expect(canvas).toHaveAttribute("data-rendered-fixture-count", "2");
    await expect(page.getByTestId("cad-scene-canvas")).toHaveCount(0);
    await expectImportPreviewFits(page);
    // The modal preview owns its fit on resize; the committed map and its
    // camera stay untouched until the reset confirmation applies geometry.
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
    await expect(importDialog.getByRole("button", { name: "확인 및 적용", exact: true })).toBeVisible();
    await expect(preview).toHaveAttribute("data-preview-ready", "true");
    await expectImportPreviewFits(page);
    await expect(importDialog.getByRole("checkbox")).toHaveCount(0);
    await importDialog.getByRole("button", { name: "확인 및 적용", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "새 CAD 도면으로 맵을 교체할까요?" });
    await expect(dialog).toContainText("조명 2개가 미배치 상태로 변경됩니다.");
    expect(api.payloads).toHaveLength(0);
    await dialog.getByRole("button", { name: "교체 후 적용" }).click();
    await expect.poll(() => api.payloads.length).toBe(1);
    expect(api.payloads[0]).toMatchObject({ candidateIds: [], expectedRevision: 1,
      confirmMapReset: true, leaseToken: "lease-floor-1", leaseFence: 1 });
    await expect.poll(() => api.state().lightSlots).toEqual([]);
    expect(api.state().objects).toEqual([]);
    expect(api.state().fixtures.every(fixture => fixture.placementStatus === "unplaced")).toBe(true);

    api.nextReview();
    await page.reload();
    await expect(importDialog.getByRole("button", { name: "확인 및 적용", exact: true })).toBeVisible();
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

test("CAD preview parity uses the editor raster resolution through apply and reload", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1900, height: 1000 });
  const api = await installPreparedReview(page);
  await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
  const dialog = page.getByRole("dialog", { name: "CAD 가져오기", exact: true });
  const preview = dialog.getByTestId("cad-import-preview");
  await expect(preview).toHaveAttribute("data-preview-ready", "true");
  await expectNativePixel(page, () => importPreviewPoint(page, nativePoints[2]), [225, 29, 72], preview);
  const previewRaster = await rasterResolution(preview);
  await page.evaluate(async () => {
    const path = "/src/features/floor-editor/editor-store.ts";
    const { useFloorEditorStore } = await import(/* @vite-ignore */ path);
    const states: unknown[] = [];
    (window as unknown as { parityCameras: unknown[] }).parityCameras = states;
    useFloorEditorStore.subscribe((state: { zoom: number; pan: unknown; mapScope: unknown }) => {
      states.push({ zoom: state.zoom, pan: state.pan, scope: state.mapScope });
    });
  });
  await page.screenshot({ path: testInfo.outputPath("preview.png") });
  await dialog.getByRole("button", { name: "확인 및 적용", exact: true }).click();
  await page.getByRole("dialog", { name: "새 CAD 도면으로 맵을 교체할까요?" })
    .getByRole("button", { name: "교체 후 적용" }).click();
  await expect(dialog).toBeHidden();
  const editor = page.getByTestId("floor-editor-canvas");
  await expect(editor).toHaveAttribute("data-map-ready", "true");
  await testInfo.attach("apply-camera-transitions", { body: JSON.stringify(await page.evaluate(() =>
    (window as unknown as { parityCameras: unknown[] }).parityCameras), null, 2), contentType: "application/json" });
  await expectEditorMapFits(page);
  await expectNativePixel(page, () => editorPoint(page, nativePoints[2]), [225, 29, 72], editor);
  const appliedRaster = await rasterResolution(editor);
  await page.screenshot({ path: testInfo.outputPath("applied.png") });
  await page.reload();
  await expect(editor).toHaveAttribute("data-map-ready", "true");
  await expectNativePixel(page, () => editorPoint(page, nativePoints[2]), [225, 29, 72], editor);
  const reloadedRaster = await rasterResolution(editor);
  await testInfo.attach("raster-parity", { body: JSON.stringify({ previewRaster, appliedRaster, reloadedRaster,
    appliedDocument: api.state().floor.mapDocument }, null, 2), contentType: "application/json" });
  expect(previewRaster.resolution).toBeCloseTo(1.5, 2);
  expect(appliedRaster.resolution).toBeCloseTo(1.5, 2);
  expect(reloadedRaster.resolution).toBeCloseTo(1.5, 2);
  expect(api.payloads).toHaveLength(1);
  expect(api.browserErrors).toEqual([]);
  expect(api.unhandledRequests).toEqual([]);
});

async function rasterResolution(surface: Locator) {
  return surface.getByRole("img", { name: "맵 도형", exact: true }).locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect();
    return { width: canvas.width, height: canvas.height, viewportWidth: rect.width,
      viewportHeight: rect.height, resolution: canvas.width / rect.width };
  });
}

for (const common of [false, true]) {
  test(`CAD preview parity preserves lines text dimensions and hidden layers (${common ? "native" : "legacy"} replacement)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1900, height: 1000 });
    const scene = createParityScene();
    const api = await installPreparedReview(page, scene);
    if (common) {
      api.state().floor.mapDocument = { ...scene.ref, generationId: "previous-common", revision: 1 };
      api.state().floor.cadScene = null;
      api.state().objects = [];
    }
    await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
    const dialog = page.getByRole("dialog", { name: "CAD 가져오기", exact: true });
    const preview = dialog.getByTestId("cad-import-preview");
    await expect(preview).toHaveAttribute("data-preview-ready", "true");
    const checks = [
      { name: "dimension-line", bounds: { minX: 10260, minY: 5150, maxX: 10690, maxY: 5180 }, rgb: [190, 18, 60] },
      { name: "dimension-label", bounds: { minX: 10260, minY: 5290, maxX: 10690, maxY: 5590 }, rgb: [22, 163, 74] },
      { name: "text", bounds: { minX: 12288, minY: 5200, maxX: 12780, maxY: 5590 }, rgb: [37, 99, 235] },
      { name: "hidden-layer", bounds: { minX: 14360, minY: 5160, maxX: 14790, maxY: 5590 }, rgb: [255, 0, 255], hidden: true }
    ];
    const verify = async (surface: Locator, preview: boolean, phase: string) => {
      const results: Record<string, number> = {};
      for (const point of nativePoints) await expectNativePixel(page, () => preview
        ? importPreviewPoint(page, point) : editorPoint(page, point), [225, 29, 72], surface);
      for (const check of checks) {
        await expect.poll(async () => {
          const count = await featurePixelCount(page, surface, preview, check.bounds, check.rgb);
          results[check.name] = count;
          return check.hidden ? count === 0 : count > 0;
        }, { message: `${phase}: ${check.name} has its expected visible layer/color` }).toBe(true);
      }
      console.info("CAD parity pixels", JSON.stringify({ common, phase, results }));
      await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) });
    };
    await verify(preview, true, "preview");
    await dialog.getByRole("button", { name: "확인 및 적용", exact: true }).click();
    await page.getByRole("dialog", { name: "새 CAD 도면으로 맵을 교체할까요?" })
      .getByRole("button", { name: "교체 후 적용" }).click();
    await expect(dialog).toBeHidden();
    const editor = page.getByTestId("floor-editor-canvas");
    await expect(editor).toHaveAttribute("data-map-ready", "true");
    await expectEditorMapFits(page);
    await page.evaluate(async () => {
      const path = "/src/features/floor-editor/editor-store.ts";
      const { useFloorEditorStore } = await import(/* @vite-ignore */ path);
      useFloorEditorStore.getState().setSnap(false);
    });
    await verify(editor, false, "applied");
    await page.reload();
    await expect(editor).toHaveAttribute("data-map-ready", "true");
    await verify(editor, false, "reloaded");
    const previewAssets = api.requests.filter(path => path.includes("/import-jobs/") && path.includes("/tiles/"))
      .map(path => path.split("/tiles/")[1]);
    const appliedAssets = api.requests.filter(path => !path.includes("/import-jobs/") && path.includes("/tiles/"))
      .map(path => path.split("/tiles/")[1]);
    expect([...new Set(previewAssets)].sort()).toEqual([...new Set(appliedAssets)].sort());
    expect(api.state().floor.mapDocument?.generationId).toBe(scene.ref.generationId);
    expect(api.browserErrors).toEqual([]);
    expect(api.unhandledRequests).toEqual([]);
  });
}

async function featurePixelCount(page: Page, surface: Locator, preview: boolean,
  bounds: { minX: number; minY: number; maxX: number; maxY: number }, rgb: number[]) {
  const origin = preview ? await importPreviewPoint(page, { x: bounds.minX, y: bounds.minY })
    : await editorPoint(page, { x: bounds.minX, y: bounds.minY });
  const zoom = Number(await surface.getAttribute("data-zoom"));
  const screenshot = await page.screenshot({ scale: "css" });
  return page.evaluate(async ({ png, origin, width, height, rgb }) => {
    const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
    const sample = document.createElement("canvas"); sample.width = image.width; sample.height = image.height;
    const context = sample.getContext("2d")!; context.drawImage(image, 0, 0);
    const pixels = context.getImageData(Math.floor(origin.x), Math.floor(origin.y), Math.ceil(width) + 1, Math.ceil(height) + 1).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) if (rgb.every((value, channel) => Math.abs(value - pixels[i + channel]) < 24)) count++;
    return count;
  }, { png: screenshot.toString("base64"), origin, width: (bounds.maxX - bounds.minX) * zoom,
    height: (bounds.maxY - bounds.minY) * zoom, rgb });
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



async function saveScreenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = resolve(evidenceDirectory, `${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}





// These synthetic map-space rectangles exercise the production binary decoder,
// worker, WebGL renderer and picker. No DWG parser or backend is running here.












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

async function verifyMonitoringComposition(page: Page, size: { width: number; height: number } = nativeScene.manifest, rgb = [6, 182, 212], markerPoints = nativePoints) {
  const region = page.getByRole("region", { name: "층 도면" });
  await region.scrollIntoViewIfNeeded();
  const verify = async () => {
    await expectNativePixel(page, () => monitoringPoint(page, nativePoints[2]), rgb);
    for (const [index, point] of markerPoints.slice(0, 2).entries()) {
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
