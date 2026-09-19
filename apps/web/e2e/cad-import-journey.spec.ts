import { expect, test, type Locator, type Page, type Route, type TestInfo } from "@playwright/test";
import { resolve } from "node:path";
import { buildCadSceneDescriptor, cadSceneManifestSchema, normalizeCadMapSize, type CadSceneState } from "@led-control/shared";
import { mapDisplayManifestSchema } from "@led-control/shared/map-display-contracts";
import type { MapDocumentRef } from "@led-control/shared/map-document-contracts";
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

for (const native of [false, true]) {
  test(`${native ? "Native WebGL: region 선택부터" : "Legacy SVG: 기존 적용 맵부터"} 슬롯 배치, 저장, 새로고침, 모니터링까지 (route fixture)`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1_440, height: 900 });
    const api = await installCadJourney(page, native);
    const points = (native ? nativePoints : candidates).map(({ x, y }) => ({ x, y }));
    const size = native ? nativeScene.manifest : { width: 1200, height: 800 };

    await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
    await expect(page.getByRole("heading", { name: "B1 맵 편집" })).toBeVisible();
    if (native) {
    expect(api.state().objects).toHaveLength(1);
    expect(api.state().fixtures.filter(fixture => fixture.placementStatus === "placed")).toHaveLength(2);
    if (native) await expectNativePixel(page, () => editorPoint(page, nativePoints[2]), [6, 182, 212]);
    const appliedStateRequestsAtStart = api.appliedStateRequestsBeforeApply();

    await page.getByLabel("CAD 파일").setInputFiles({
      name: "parking.dwg",
      mimeType: "application/dwg",
      buffer: Buffer.from("AC1027-e2e-cad")
    });
    await page.getByRole("button", { name: "CAD 가져오기" }).click();
    await expect(page.getByRole("progressbar", { name: "CAD 가져오기 진행률" })).toHaveAttribute("value", "0");
    await expect(page.getByRole("radiogroup", { name: "가져올 도면 영역" })).toBeVisible();
    const buildScene = page.getByRole("button", { name: "선택 영역으로 장면 만들기" });
    await expect(buildScene).toBeDisabled();
    await page.getByRole("radio", { name: "도면 영역 1 · 도형 3개", exact: true }).check();
    await expect(page.getByRole("img", { name: "도면 영역 1 미리보기", exact: true })).toBeVisible();
    await buildScene.click();
    await expect.poll(() => api.regionPayloads()).toEqual([{ regionId: "region-1" }]);
    await expect(page.getByText("조명 위치 후보 2개를 찾았습니다.")).toBeVisible();
    await expect(page.getByText("선택한 도면 영역의 장면 생성이 완료되었습니다.")).toBeVisible();

    if (native) {
      const reviewCanvas = page.getByTestId("floor-editor-canvas");
      await expect(reviewCanvas).toHaveAttribute("data-background-url", "");
      await expect(reviewCanvas).toHaveAttribute("data-map-width", String(nativeScene.manifest.width));
      await expect(reviewCanvas).toHaveAttribute("data-map-height", String(nativeScene.manifest.height));
      await expect(reviewCanvas).toHaveAttribute("data-rendered-fixture-count", "0");
      await expect(reviewCanvas).toHaveAttribute("data-rendered-object-count", "0");
      await expect(page.getByRole("img", { name: "맵 도형", exact: true })).toHaveCount(1);
      await expect(page.getByTestId("cad-scene-canvas")).toHaveCount(0);
      await page.getByText("격자 스냅", { exact: true }).click();
      await expectNativePixel(page, () => editorPoint(page, nativePoints[2]), [225, 29, 72]);
      await expectEditorMapFits(page);
      const fittedZoom = Number(await reviewCanvas.getAttribute("data-zoom"));
      await page.getByRole("button", { name: "확대", exact: true }).click();
      await expect.poll(async () => Number(await reviewCanvas.getAttribute("data-zoom"))).toBeGreaterThan(fittedZoom);
      await expectNativePixel(page, () => editorPoint(page, nativePoints[2]), [225, 29, 72]);
      await page.getByRole("button", { name: "축소", exact: true }).click();
      await expect.poll(async () => Number(await reviewCanvas.getAttribute("data-zoom"))).toBeCloseTo(fittedZoom);
      await page.getByRole("button", { name: "이동", exact: true }).click();
      const from = await editorPoint(page, { x: 8192, y: 7800 });
      const oldPan = Number(await reviewCanvas.getAttribute("data-pan-x"));
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + 50, from.y + 25, { steps: 4 });
      await page.mouse.up();
      await expect.poll(async () => Number(await reviewCanvas.getAttribute("data-pan-x"))).toBeCloseTo(oldPan + 50);
      await expectNativePixel(page, () => editorPoint(page, nativePoints[2]), [225, 29, 72]);
      await page.getByRole("button", { name: "선택", exact: true }).click();
      const candidate = page.getByRole("checkbox", { name: /후보 1\/2/ });
      await expect(candidate).toBeChecked();
      await reviewCanvas.click({ position: await editorPoint(page, nativePoints[0], false) });
      await expect(candidate).not.toBeChecked();
      await reviewCanvas.click({ position: await editorPoint(page, nativePoints[0], false) });
      await expect(candidate).toBeChecked();
      await saveScreenshot(page, testInfo, "native-review-before-apply");
      expect(api.appliedStateRequestsBeforeApply()).toBe(appliedStateRequestsAtStart);
    }

    const applyButton = page.getByRole("button", { name: "선택한 후보와 배경 적용" });
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
    }

    await page.reload({ waitUntil: "domcontentloaded" });
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
    await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
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
      await expect(page.getByRole("complementary", { name: "CAD 그룹 속성" })).toContainText("group-1");
      await canvas.dblclick({ position });
      const properties = page.getByRole("complementary", { name: "CAD 요소 속성" });
      await expect(properties).toContainText("native-3");
      await saveScreenshot(page, testInfo, "native-editor-primitive-selection");
      await properties.getByLabel("채우기 색상").fill("#06b6d4");
      await properties.getByRole("button", { name: "CAD 속성 적용" }).click();
      await expect.poll(() => api.cadPayloads()).toHaveLength(1);
      expect(api.cadPayloads()[0]).toMatchObject({
        expectedRevision: 3, leaseToken: "lease-floor-1", leaseFence: 1,
        overrideMutations: [{ operation: "upsert", locator: { lod: 0, tileX: 18, tileY: 12, part: 0 }, value: { elementId: "native-3", fillColor: "#06b6d4" } }],
        layerMutations: []
      });
      await expect(properties.getByRole("button", { name: "CAD 속성 적용" })).toBeEnabled();
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(canvas).toBeVisible();
      await page.getByRole("button", { name: "맵 맞춤", exact: true }).click();
      await expectNativePixel(page, () => editorPoint(page, nativePoints[2]), [6, 182, 212]);
      await canvas.dblclick({ position: await editorPoint(page, nativePoints[2], false) });
      await expect(page.getByRole("complementary", { name: "CAD 요소 속성" }).getByLabel("채우기 색상")).toHaveValue("#06b6d4");
      await saveScreenshot(page, testInfo, "native-editor-after-reload");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "맵 맞춤", exact: true }).click();
      await expectEditorMapFits(page);
      // At whole-map mobile scale the grid lines cover every native color pixel.
      await page.getByText("격자 스냅", { exact: true }).click();
      await expect(page.getByRole("checkbox", { name: "격자 스냅" })).not.toBeChecked();
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
      await page.getByRole("button", { name: "지도 화면 맞춤" }).click();
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
    await expect(page.getByText("조명 위치 후보 2개를 찾았습니다.")).toBeVisible();
    await expect(page.getByRole("img", { name: "맵 도형", exact: true })).toBeVisible();
    await expect(canvas).toHaveAttribute("data-background-url", "");
    await expect(canvas).toHaveAttribute("data-rendered-object-count", "0");
    await expect(canvas).toHaveAttribute("data-rendered-fixture-count", "0");
    await expect(page.getByTestId("cad-scene-canvas")).toHaveCount(0);
    await expectEditorMapFits(page);
    await page.getByText("격자 스냅", { exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "격자 스냅" })).not.toBeChecked();
    // The edit workflow uses desktop panels; inspect the same preview under the
    // narrow viewport policy without pretending hidden panels are touch controls.
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: "맵 맞춤", exact: true }).click();
    await expectEditorMapFits(page);
    await canvas.scrollIntoViewIfNeeded();
    await expectNativePixel(page, () => editorPoint(page, nativePoints[2]), [225, 29, 72]);
    await saveScreenshot(page, testInfo, `u13-prepared-${width}`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: "맵 맞춤", exact: true }).click();
    const fittedZoom = Number(await canvas.getAttribute("data-zoom"));
    await page.getByRole("button", { name: "확대", exact: true }).click();
    await expect.poll(async () => Number(await canvas.getAttribute("data-zoom"))).toBeGreaterThan(fittedZoom);
    await canvas.scrollIntoViewIfNeeded();
    await expectNativePixel(page, () => editorPoint(page, nativePoints[2]), [225, 29, 72]);
    await page.getByRole("button", { name: "축소", exact: true }).click();
    await page.getByRole("button", { name: "이동", exact: true }).click();
    const from = await editorPoint(page, { x: 8192, y: 7800 });
    const pan = Number(await canvas.getAttribute("data-pan-x"));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 20, from.y + 10, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => Number(await canvas.getAttribute("data-pan-x"))).toBeCloseTo(pan + 20);
    await page.getByRole("button", { name: "선택", exact: true }).click();
    await canvas.click({ position: await editorPoint(page, nativePoints[0], false) });
    await expect(page.getByRole("checkbox", { name: /후보 1\/2/ })).not.toBeChecked();
    expect(api.requests.some(path => path.startsWith("/floors/floor-1/map-document"))).toBe(false);
    expect(api.requests.filter(path => path.includes("/map-document/tiles/")).length).toBeGreaterThan(0);

    // Recovery comes from the fixture's durable job, not a local editor draft.
    await page.reload();
    await expect(page.getByText("조명 위치 후보 2개를 찾았습니다.")).toBeVisible();
    await expectEditorMapFits(page);
    await canvas.click({ position: await editorPoint(page, nativePoints[0], false) });
    await expect(page.getByRole("checkbox", { name: /후보 1\/2/ })).not.toBeChecked();
    await page.getByRole("button", { name: "선택한 후보와 배경 적용" }).click();
    const dialog = page.getByRole("dialog", { name: "새 CAD 도면으로 맵을 교체할까요?" });
    await expect(dialog).toContainText("조명 2개가 미배치 상태로 변경됩니다.");
    expect(api.payloads).toHaveLength(0);
    await dialog.getByRole("button", { name: "교체 후 적용" }).click();
    await expect.poll(() => api.payloads.length).toBe(1);
    expect(api.payloads[0]).toMatchObject({ candidateIds: [candidates[1].id], expectedRevision: 1,
      confirmMapReset: true, leaseToken: "lease-floor-1", leaseFence: 1 });
    await expect.poll(() => api.state().lightSlots).toEqual([
      expect.objectContaining({ x: nativePoints[1].x, y: nativePoints[1].y, assignedFixtureId: null })
    ]);
    expect(api.state().objects).toEqual([]);
    expect(api.state().fixtures.every(fixture => fixture.placementStatus === "unplaced")).toBe(true);

    api.nextReview();
    await page.reload();
    await expect(page.getByText("조명 위치 후보 0개를 찾았습니다.")).toBeVisible();
    await expectEditorMapFits(page);
    await page.getByRole("button", { name: "선택한 후보와 배경 적용" }).click();
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
        const lightSlotUpdates = new Map(
          payload.slotAssignments.map((update: { slotId: string; assignedFixtureId: string | null }) => [update.slotId, update.assignedFixtureId])
        );
        state.lightSlots = state.lightSlots.map(slot => ({
          ...slot,
          assignedFixtureId: lightSlotUpdates.has(slot.id) ? lightSlotUpdates.get(slot.id)! : slot.assignedFixtureId
        }));
        state.floor.mapRevision += 1;
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
      if (native) state.floor.cadScene = nativeScene.descriptor;
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
    floorPlan: state.floor.floorPlan, cadScene: state.floor.cadScene, objects: state.objects,
    fixtures: state.lightSlots.flatMap(slot => {
      if (!slot.assignedFixtureId) return [];
      const fixture = state.fixtures.find(candidate => candidate.id === slot.assignedFixtureId);
      return fixture ? [{ id: fixture.id, name: fixture.name, x: slot.x, y: slot.y, size: fixture.size ?? 20 }] : [];
    })
  };
}

async function currentState(page: Page) {
  return page.evaluate(async () => {
    const { useFloorEditorStore } = await import("/src/features/floor-editor/editor-store.ts");
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

function createPreparedScene() {
  const { sceneId, manifestAssetId, width, height, gridSize } = nativeScene.manifest;
  const tiles = nativePoints.map(({ x, y }, index) => {
    const tileX = Math.floor(x / 512);
    const tileY = Math.floor(y / 512);
    const payload = encodeMapDisplayTile([{
      elementId: `prepared-${index}`, groupId: "group-1", layerName: "WALLS", sourceType: "LWPOLYLINE",
      zIndex: index, fragmentOrder: 0,
      bounds: { minX: x - 200, minY: y - 200, maxX: x + 200, maxY: y + 200 }, clipBounds: null,
      style: { strokeColor: "#111827", fillColor: "#e11d48", strokeWidth: 4, opacity: 1 },
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

async function servePreparedAsset(route: Route, path: string, importJobId: string | undefined, ref: MapDocumentRef) {
  const prefix = `/floors/floor-1${importJobId ? `/import-jobs/${importJobId}` : ""}/map-document`;
  if (!path.startsWith(prefix)) return false;
  if (path === prefix) await json(route, ref);
  else {
    const query = new URL(route.request().url()).searchParams;
    expect(query.get("generationId")).toBe(ref.generationId);
    expect(query.get("revision")).toBe(String(ref.revision));
    if (path === `${prefix}/manifest`) await json(route, { generationId: ref.generationId, revision: ref.revision,
      canonical: ref.manifest, display: preparedScene.display,
      groups: [{ id: "group-1", parentId: null, name: "Prepared", visible: true, locked: false }],
      layers: [{ id: "walls", name: "WALLS", order: 0, visible: true, locked: false }],
      displayLayerBindings: [{ layerName: "WALLS", layerId: "walls" }] });
    else if (path === `${prefix}/changes`) await json(route, { generationId: ref.generationId, revision: ref.revision,
      operations: [], nextCursor: null });
    else {
      const tile = preparedScene.tiles.find(tile => path === `${prefix}/tiles/${tile.descriptor.assetId}`);
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

async function expectNativePixel(page: Page, locatePoint: () => Promise<{ x: number; y: number }>, rgb: number[]) {
  const canvas = page.locator('[data-testid="cad-scene-canvas"], [role="img"][aria-label="맵 도형"] canvas');
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

async function verifyMonitoringComposition(page: Page, size = nativeScene.manifest, rgb = [6, 182, 212]) {
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
  await page.mouse.move(panStart.x, panStart.y);
  await page.mouse.down();
  await page.mouse.move(panStart.x + 22, panStart.y + 14, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => {
    const afterPan = await monitoringPoint(page, nativePoints[2]);
    return Math.hypot(afterPan.x - beforePan.x, afterPan.y - beforePan.y);
  }).toBeGreaterThan(10);
  await verify();
}
