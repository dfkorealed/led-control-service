import { chromium, expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  expectMinimumTouchTargets,
  expectMinimumTouchTargetsAfterScrolling,
  expectNoHorizontalOverflow
} from "./support/layout-assertions";
import { installSettingsApiRoutes } from "./support/settings-api";
import { installMockApiBoundary } from "./support/mock-api-boundary";
import { StatisticsNativeZoomEvidence } from "./support/statistics-native-zoom-evidence";

test.beforeEach(async ({ context, baseURL }) => { await installMockApiBoundary(context, baseURL); });

async function installCadRegionList(page: Page) {
  const api = await installSettingsApiRoutes(page, "admin", { readyMapDocument: true });
  const jobId = "00000000-0000-4000-8000-000000000020";
  const job = { jobId, floorId: "floor-1", sourceAssetId: "00000000-0000-4000-8000-000000000010",
    renderedAssetId: null, sourceFormat: "dxf", status: "region_selection_required", stage: "region_selection_required",
    progressPercent: 70, attemptCount: 0, parserVersion: "cad-core/1", detectorVersion: null, failureCode: null,
    sourceAssetPath: "/api/floors/floor-1/assets/source/content", renderedAssetPath: null, renderedViewport: null,
    startedAt: null, reviewRequiredAt: null, appliedAt: null, completedAt: null, failedAt: null, cancelledAt: null,
    createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" };
  const regions = { jobId, selectionStatus: "selection_required", selectedRegionId: null, excludedRegionPrimitiveCount: 0,
    regions: Array.from({ length: 65 }, (_, index) => ({ regionId: `region-${index + 1}`,
      bounds: { minX: 0, minY: 0, maxX: 2000, maxY: 1000 }, primitiveCount: 1200, textCount: 20,
      lightCandidateCount: 12, area: 2000000, preview: { assetId: `00000000-0000-4000-8000-${String(50 + index).padStart(12, "0")}`,
        width: 640, height: 320, byteSize: 1024, sha256: "c".repeat(64) } })) };
  const mutationRequests: string[] = [];
  await page.route("**/api/floors/floor-1/import-jobs/**", route => {
    if (route.request().method() !== "GET") { mutationRequests.push(route.request().url()); return route.fulfill({ status: 404 }); }
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/active")) return route.fulfill({ json: { job } });
    if (path.endsWith(`/${jobId}/regions`)) return route.fulfill({ json: regions });
    return route.fulfill({ status: 404 });
  });
  // A controlled image response, never an uploaded customer file or external URL.
  await page.route("**/api/floors/floor-1/assets/*/content", route => route.fulfill({
    contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><rect x="10" y="10" width="620" height="300" fill="white" stroke="black"/></svg>'
  }));
  return { api, mutationRequests };
}

async function showCadPanel(page: Page) {
  await expect(page.getByRole("heading", { name: "B2 맵 편집" })).toBeVisible();
  // Region review is available before scene compilation; it does not depend
  // on the previous map's WebGL readiness. The radiogroup is the ready boundary.
  const information = page.getByRole("complementary", { name: "맵 편집 정보" });
  if (!await information.isVisible()) await page.getByRole("button", { name: "편집 정보 패널" }).click();
  await expect.poll(() => page.getByTestId("floor-editor-layout").evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(242);
  await expect.poll(() => page.locator('[data-testid="floor-editor-layout"] > main').evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(240);
  // Explicitly authorized one-case diagnostics only: inspect public layout
  // before the unchanged user click, without scrolling or changing the DOM.
  if (process.env.TASK8_CAD_GEOMETRY === "1") {
    const output = process.env.TASK8_OUTPUT;
    if (!output) throw new Error("TASK8_OUTPUT is required for CAD geometry evidence");
    mkdirSync(join(output, "originals"), { recursive: true });
    const geometry = await information.getByRole("tab", { name: "자료" }).evaluate(tab => {
      const describe = (element: Element | null) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const node = element as HTMLElement;
        return {
          tag: element.tagName, id: element.id, role: element.getAttribute("role"), label: element.getAttribute("aria-label"),
          className: element.getAttribute("class"), rect: rect.toJSON(),
          display: style.display, position: style.position, zIndex: style.zIndex,
          overflowX: style.overflowX, overflowY: style.overflowY,
          height: style.height, minHeight: style.minHeight, maxHeight: style.maxHeight,
          gridTemplateRows: style.gridTemplateRows, padding: style.padding, flex: style.flex,
          clientWidth: node.clientWidth, clientHeight: node.clientHeight,
          scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight,
          scrollLeft: node.scrollLeft, scrollTop: node.scrollTop
        };
      };
      const rect = tab.getBoundingClientRect();
      const points = [
        ["center", rect.x + rect.width / 2, rect.y + rect.height / 2],
        ["topLeft", rect.left + 1, rect.top + 1], ["topRight", rect.right - 1, rect.top + 1],
        ["bottomLeft", rect.left + 1, rect.bottom - 1], ["bottomRight", rect.right - 1, rect.bottom - 1]
      ] as const;
      const ancestors = [];
      for (let parent = tab.parentElement; parent; parent = parent.parentElement) ancestors.push(describe(parent));
      const shellContent = document.querySelector("[data-shell-content]");
      return {
        utc: new Date().toISOString(), url: location.href,
        viewport: { outerWidth, outerHeight, innerWidth, innerHeight, dpr: devicePixelRatio, scrollX, scrollY,
          visual: visualViewport ? { width: visualViewport.width, height: visualViewport.height,
            scale: visualViewport.scale, offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop,
            pageLeft: visualViewport.pageLeft, pageTop: visualViewport.pageTop } : null },
        targets: {
          tab: describe(tab), panel: describe(document.querySelector("#editor-information-panel")),
          workspace: describe(document.querySelector('[data-testid="floor-editor-layout"]')),
          editorMain: describe(document.querySelector('[data-testid="floor-editor-layout"] > main')),
          main: describe(shellContent?.closest("main") ?? null), shellContent: describe(shellContent),
          account: describe(document.querySelector('[aria-label="내 계정"]')),
          header: describe(document.querySelector("[data-shell-topbar]")),
          editorHeader: describe(document.querySelector('[data-testid="editor-toolbar"]')),
          bottomNav: describe(document.querySelector('[data-shell-navigation="compact"]'))
        }, ancestors,
        hits: points.map(([name, x, y]) => {
          const hit = document.elementFromPoint(x, y);
          return { name, x, y, tabReceivesPointer: Boolean(hit && (hit === tab || tab.contains(hit))),
            hit: describe(hit), stack: document.elementsFromPoint(x, y).map(describe) };
        })
      };
    });
    writeFileSync(join(output, "geometry.json"), JSON.stringify(geometry, null, 2));
    await page.screenshot({ path: join(output, "originals", "cad-preclick-original.png"), type: "png", fullPage: false });
  }
  await information.getByRole("tab", { name: "자료" }).evaluate(element => element.scrollIntoView({ block: "center" }));
  await expectMinimumTouchTargets(page, '[aria-label="편집 패널"]');
  await information.getByRole("tab", { name: "자료" }).click();
  return page.getByRole("region", { name: "CAD 가져오기", exact: true });
}

for (const viewport of [
  { width: 320, height: 740 }, { width: 390, height: 844 }, { width: 768, height: 900 },
  { width: 1023, height: 900 }, { width: 1024, height: 900 }, { width: 1287, height: 900 },
  { width: 1440, height: 900 }, { width: 390, height: 320 }, { width: 1440, height: 600 }
]) test(`Task8 CAD primary region and searchless page size at ${viewport.width}x${viewport.height}`, async ({ page }) => {
  await page.setViewportSize(viewport);
  const { mutationRequests } = await installCadRegionList(page);
  await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
  const panel = await showCadPanel(page);
  await expect(panel.getByRole("radio")).toHaveCount(20);
  const trigger = panel.getByRole("button", { name: /도면 영역 목록 상세 필터/ });
  await panel.getByRole("button", { name: "다음 페이지" }).click();
  await panel.getByRole("radio", { name: /^도면 영역 21 ·/ }).locator("xpath=ancestor::label").click();
  await trigger.focus(); await page.keyboard.press("Enter");
  const detail = page.getByRole("dialog", { name: "도면 영역 목록", exact: true });
  await expect(detail.getByRole("searchbox")).toHaveCount(0);
  await detail.getByRole("button", { name: /페이지당 항목 수/ }).click();
  await expect(page.getByRole("option")).toHaveText(["10개", "20개", "50개", "100개"]);
  await page.getByRole("option", { name: "50개", exact: true }).click();
  await expectMinimumTouchTargetsAfterScrolling(page, '[role="dialog"][aria-label="도면 영역 목록"]');
  await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
  await expect(panel.getByRole("radio")).toHaveCount(50);
  await expect(panel.getByText("1~50 / 65건", { exact: true })).toBeVisible();
  await expect(panel.getByRole("radio", { name: /^도면 영역 21 ·/ })).toBeChecked();
  await expect(panel.getByRole("button", { name: "선택 영역으로 장면 만들기" })).toBeEnabled();
  expect(mutationRequests).toEqual([]);
  await expectMinimumTouchTargetsAfterScrolling(page, '[aria-label="CAD 가져오기"]');
  await expectNoHorizontalOverflow(page);
});

test("Task8 native 200 CAD page size keeps primary region selection", async ({}, info) => {
  test.setTimeout(60000);
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", viewport: null, deviceScaleFactor: undefined, args: ["--window-size=1440,900"]
  });
  let native: StatisticsNativeZoomEvidence | undefined;
  try {
    const page = context.pages()[0]!;
    await installMockApiBoundary(context, info.project.use.baseURL);
    const { mutationRequests } = await installCadRegionList(page);
    await page.goto(`${info.project.use.baseURL}/settings/floor-plans/floor-1/edit?siteId=site-1`);
    native = await StatisticsNativeZoomEvidence.create(context, page, info);
    await native.global200(context);
    const panel = await showCadPanel(page);
    const trigger = panel.getByRole("button", { name: /도면 영역 목록 상세 필터/ });
    await trigger.focus(); await page.keyboard.press("Enter");
    const detail = page.getByRole("dialog", { name: "도면 영역 목록", exact: true });
    await expect(detail).toBeVisible(); await expect(detail.getByRole("searchbox")).toHaveCount(0);
    await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
    const region = panel.getByRole("radio", { name: /^도면 영역 1 ·/ });
    await region.evaluate(element => element.scrollIntoView({ block: "center" }));
    const nameObservations: unknown[] = [];
    const observeRegion = async () => {
      const observation = await panel.getByText("도면 영역 1", { exact: true }).evaluate(element => {
        const rect = element.getBoundingClientRect();
        const header = document.querySelector("[data-shell-topbar]")?.getBoundingClientRect();
        const nav = document.querySelector('[data-shell-navigation="compact"]')?.getBoundingClientRect();
        const clips = [...function* () { for (let node = element.parentElement; node; node = node.parentElement) yield node; }()].map(node => ({
          rect: node.getBoundingClientRect().toJSON(), overflowX: getComputedStyle(node).overflowX,
          overflowY: getComputedStyle(node).overflowY, clientWidth: node.clientWidth, clientHeight: node.clientHeight,
          clientLeft: node.clientLeft, clientTop: node.clientTop
        }));
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        const readable = rect.top >= (header?.bottom ?? 0) && rect.bottom <= (nav?.top ?? innerHeight)
          && rect.left >= 0 && rect.right <= innerWidth && Boolean(hit && (hit === element || element.contains(hit)))
          && clips.every(c => (!/auto|hidden|clip|scroll/.test(c.overflowX) || (rect.left >= c.rect.left + c.clientLeft && rect.right <= c.rect.left + c.clientLeft + c.clientWidth))
            && (!/auto|hidden|clip|scroll/.test(c.overflowY) || (rect.top >= c.rect.top + c.clientTop && rect.bottom <= c.rect.top + c.clientTop + c.clientHeight)));
        return { utc: new Date().toISOString(), name: element.textContent, rect: rect.toJSON(), clips, readable, scrollY, innerWidth, innerHeight };
      });
      nameObservations.push(observation);
      writeFileSync(info.outputPath("native-cad-name-observations.json"), JSON.stringify(nameObservations, null, 2));
      expect(observation.readable, "Actual CAD region name must be unclipped and above fixed navigation").toBe(true);
      const { utc: _observedAt, ...content } = observation;
      return content;
    };
    await observeRegion();
    await native.capture("Task8-CAD-region-name", region, async () => {
      await expect(region).toBeChecked();
    }, [], {
      description: "실제 도면 영역 1 이름·선택 표시, 기본 20개·CAD mutation 0",
      observe: async () => {
        await expect(page.getByRole("dialog", { name: "도면 영역 목록", exact: true })).not.toBeVisible();
        await expect(panel.getByRole("radio")).toHaveCount(20);
        await expect(panel.getByRole("radiogroup", { name: "가져올 도면 영역" })).toBeVisible();
        expect(mutationRequests).toEqual([]);
        await expect(region).toBeChecked();
        return { radios: await panel.getByRole("radio").count(), mutations: mutationRequests.length, expanded: await trigger.getAttribute("aria-expanded"), selected: await region.isChecked(), content: await observeRegion() };
      }
    });
    await expectMinimumTouchTargetsAfterScrolling(page, '[aria-label="CAD 가져오기"]');
  } finally { try { await native?.stop(); } finally { await context.close(); await native?.recordContextCleanup(); } }
});

for (const width of [1024, 390]) test(`U13 common monitoring saved revision reload at ${width}px (HTTP fixture)`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ mobile }) => {
    if (mobile) window.document.addEventListener("DOMContentLoaded", () => {
      window.document.documentElement.dataset.ledControlMobileWebview = "true";
      window.document.documentElement.dataset.ledControlNativeAppState = "active";
    });
  }, { mobile: width < 768 });
  await installSettingsApiRoutes(page, "admin");
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let revision = 1;
  const requested: string[] = [];
  const document = () => ({ formatVersion: 1, generationId: "u13-generation", revision,
    width: 1200, height: 800, gridSize: 10, elementCount: revision === 2 ? 1 : 2,
    manifest: { assetId: "canonical", sha256: "a".repeat(64), byteSize: 100, decodedByteSize: 100 } });
  const shape = (id: string, x: number, color: string) => ({ id, type: "rectangle",
    geometry: { origin: { x, y: 200 }, width: 200, height: 200 },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    style: { strokeColor: null, fillColor: color, strokeWidth: 0, opacity: 1 },
    groupId: null, layerId: "layer", zIndex: 0, visible: true, locked: false, provenance: null });
  await page.route("**/api/sites/site-1/floors/floor-1/map-snapshot", route => route.fulfill({ json: {
    floorId: "floor-1", revision, width: 1200, height: 800, floorPlan: null, mapDocument: document(),
    objects: [], fixtures: [{ id: "fixture-1", name: "B2-L01", x: 100, y: 100, size: 20 }]
  } }));
  await page.route("**/api/floors/floor-1/map-document/**", route => {
    const url = new URL(route.request().url()); requested.push(url.pathname + url.search);
    const ref = document();
    if (url.pathname.endsWith("/manifest")) return route.fulfill({ json: {
      generationId: ref.generationId, revision: ref.revision, canonical: ref.manifest,
      displayLayerBindings: [{ layerName: "layer", layerId: "layer" }], groups: [],
      layers: [{ id: "layer", name: "Layer", order: 0, visible: true, locked: false }],
      display: { version: 2, sceneId: "00000000-0000-4000-8000-000000000001", regionId: "manual",
        manifestAssetId: "00000000-0000-4000-8000-000000000002", width: 1200, height: 800,
        gridSize: 10, padding: 0, tileSize: 512, lodMode: "additive", primitiveCount: 0, tileCount: 0,
        byteSize: 1, sha256: "a".repeat(64), sourceBounds: { minX: 0, minY: 0, maxX: 1200, maxY: 800 },
        transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }, tiles: [] }
    } });
    if (url.pathname.endsWith("/changes")) return route.fulfill({ json: {
      generationId: ref.generationId, revision: ref.revision, nextCursor: null,
      operations: [shape("kept", 700, "#06b6d4"), ...(revision === 2 ? [] : [shape("deleted", 300, "#e11d48")])]
        .map(element => ({ kind: "add", element }))
    } });
    return route.fulfill({ status: 404 });
  });
  await page.goto("/monitoring?siteId=site-1");
  const canvas = page.locator("[data-floor-map-webgl-overlay] canvas");
  await expect(canvas).toHaveCount(1);
  await expect(canvas).toBeVisible();
  await expect(page.locator(".floor-scene-canvas")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "저장", exact: true })).toHaveCount(0);
  const sample = async (x: number, rgb: number[]) => {
    const surface = page.locator("[data-floor-map-surface]");
    await surface.scrollIntoViewIfNeeded();
    const point = await surface.evaluate((element, x) => {
      const r = element.getBoundingClientRect();
      return { x: r.left + element.clientLeft + (r.width - element.clientLeft * 2) * x / 1200,
        y: r.top + element.clientTop + (r.height - element.clientTop * 2) * 300 / 800 };
    }, x);
    const png = (await page.screenshot({ scale: "css" })).toString("base64");
    return page.evaluate(async ({ png, point, rgb }) => {
      const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
      const sample = window.document.createElement("canvas"); sample.width = image.width; sample.height = image.height;
      const context = sample.getContext("2d")!; context.drawImage(image, 0, 0);
      const pixel = context.getImageData(Math.round(point.x), Math.round(point.y), 1, 1).data;
      return rgb.every((value, channel) => Math.abs(value - pixel[channel]) < 12);
    }, { png, point, rgb });
  };
  await expect.poll(() => sample(400, [225, 29, 72])).toBe(true);
  await expect.poll(() => sample(800, [6, 182, 212])).toBe(true);
  await page.getByRole("button", { name: "지도 확대", exact: true }).click();
  await expect(page.getByTestId("monitoring-map-viewport")).toHaveAttribute("data-zoom", "1.1");
  await expect.poll(() => sample(800, [6, 182, 212])).toBe(true);
  revision = 2; // A confirmed API revision fixture, not a real editor/database save.
  await page.reload();
  await expect.poll(() => sample(800, [6, 182, 212])).toBe(true);
  await expect.poll(() => sample(400, [225, 29, 72])).toBe(false);
  revision = 3; // Simulates the server reference after a saved inverse operation.
  await page.reload();
  await expect.poll(() => sample(400, [225, 29, 72])).toBe(true);
  expect(requested.some(path => path.includes("/elements"))).toBe(false);
  expect(requested.some(path => path.includes("revision=2"))).toBe(true);
  expect(errors).toEqual([]);
  const screenshot = testInfo.outputPath("u13-monitoring.png");
  await page.screenshot({ path: screenshot });
  await testInfo.attach("u13-monitoring", { path: screenshot, contentType: "image/png" });
});

const responsiveViewports = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 320, height: 740 }
] as const;

async function expectSettingsContentTopAligned(page: import("@playwright/test").Page) {
  const siteSelector = page.getByRole("button", { name: /현장 선택/ });
  await expect(siteSelector).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "설정 메뉴" });
  const contextBox = await siteSelector.boundingBox();
  const tabsBox = await tabs.boundingBox();
  const contentBox = await tabs.locator("xpath=following-sibling::*[1]").boundingBox();
  expect(contextBox).not.toBeNull();
  expect(tabsBox).not.toBeNull();
  expect(contentBox).not.toBeNull();
  if (!contextBox || !tabsBox || !contentBox) return;

  const contextGap = tabsBox.y - (contextBox.y + contextBox.height);
  const contentGap = contentBox.y - (tabsBox.y + tabsBox.height);
  expect(contextGap).toBeGreaterThanOrEqual(0);
  expect(contentGap).toBeGreaterThanOrEqual(0);
  expect(contentGap).toBeLessThanOrEqual(20);
}

test("operator customer routes are blocked and admin floor changes are reflected in monitoring", async ({ browser }) => {
  const operatorPage = await browser.newPage();
  const operatorApi = await installSettingsApiRoutes(operatorPage, "operator");
  await operatorPage.goto("/settings/commissioning?siteId=site-1");
  await expect(operatorPage).toHaveURL(/\/operator\/site-admins$/);
  await expect(operatorPage.getByRole("heading", { name: "현장 관리자 계정" })).toBeVisible();
  expect(operatorApi.requests.filter((request) => request.includes("/sites"))).toEqual([]);

  const adminPage = await browser.newPage();
  const adminApi = await installSettingsApiRoutes(adminPage, "admin", { readyMapDocument: true });
  await adminPage.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
  await expect(adminPage.getByRole("heading", { name: "B2 맵 편집" })).toBeVisible();
  await expect.poll(() => {
    const latestLease = [...adminApi.editorRequests].reverse().find((request) => request.type === "lease-acquire");
    return latestLease?.type === "lease-acquire" && latestLease.result.editable;
  }).toBe(true);

  await changeSelectedFixtureX(adminPage, "240");
  await adminPage.getByRole("button", { name: "저장", exact: true }).click();

  await expect(adminPage).toHaveURL(/\/settings\/floor-plans\/floor-1\/edit\?siteId=site-1$/);
  await expect(adminPage.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  await expect.poll(() => adminApi.editorRequests.filter(({ type }) => type === "atomic-save")).toHaveLength(1);

  const save = adminApi.editorRequests.find(({ type }) => type === "atomic-save");
  if (!save || save.type !== "atomic-save") throw new Error("atomic save request was not captured");
  const acquireBeforeSave = [...adminApi.editorRequests].reverse().find((request) => (
    request.type === "lease-acquire" && request.result.editable && request.sequence < save.sequence
  ));
  if (!acquireBeforeSave || acquireBeforeSave.type !== "lease-acquire") throw new Error("lease acquire before save was not captured");
  const { sequence: saveSequence, ...saveRequest } = save;
  expect(saveRequest).toMatchObject({
    type: "atomic-save",
    payload: {
      expectedRevision: 7,
      leaseToken: acquireBeforeSave.result.token,
      leaseFence: acquireBeforeSave.result.fence,
      fixtureUpdates: [{ id: "fixture-1", x: 240 }],
      slotAssignments: [],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: [],
      documentChanges: { generationId: "settings-e2e-map", requestId: expect.any(String), operations: [] }
    }
  });
  expect(acquireBeforeSave).toMatchObject({ type: "lease-acquire", payload: {}, result: { editable: true } });
  expect(acquireBeforeSave.sequence).toBeLessThan(saveSequence);

  await adminPage.getByRole("link", { name: "모니터링", exact: true }).click();
  await expect(adminPage).toHaveURL(/\/monitoring\?siteId=site-1$/);
  await expect.poll(() => adminApi.editorRequests.some((request) => (
    request.type === "lease-release"
    && request.sequence > saveSequence
    && request.payload.token === acquireBeforeSave.result.token
    && request.released
  ))).toBe(true);

  expect(adminApi.fixtureUpdates).toEqual([{ id: "fixture-1", x: 240 }]);

  const movedFixture = adminPage.getByRole("button", { name: "B2-L01 정상 70%" });
  await expect(movedFixture).toBeVisible();
  await expect(movedFixture).toHaveCSS("--fixture-left", "20%");

  await operatorPage.close();
  await adminPage.close();
});

test("common map elements saved in settings render immediately in monitoring", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installSettingsApiRoutes(page, "admin", { readyMapDocument: true });
  await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
  await expect(page.getByRole("heading", { name: "B2 맵 편집" })).toBeVisible();
  await expect.poll(() => {
    const latestLease = [...api.editorRequests].reverse().find((request) => request.type === "lease-acquire");
    return latestLease?.type === "lease-acquire" && latestLease.result.editable;
  }).toBe(true);

  const canvas = page.getByLabel("B2 편집 캔버스");
  await expect(canvas).toHaveAttribute("data-map-ready", "true");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("editor canvas has no layout box");
  await page.getByRole("button", { name: "사각형" }).click();
  await page.mouse.move(box.x + 320, box.y + 220);
  await page.mouse.down();
  await page.mouse.move(box.x + 460, box.y + 300);
  await page.mouse.up();
  await expect(page.getByRole("complementary", { name: "도형 속성" }).getByRole("heading", { name: "사각형" })).toBeVisible();

  for (const shape of [
    { tool: "삼각형", start: [520, 220], end: [640, 320] },
    { tool: "선", start: [320, 380], end: [480, 380] },
    { tool: "텍스트", start: [520, 380], end: [680, 440] }
  ] as const) {
    await page.getByRole("button", { name: shape.tool, exact: true }).click();
    await page.mouse.move(box.x + shape.start[0], box.y + shape.start[1]);
    await page.mouse.down();
    await page.mouse.move(box.x + shape.end[0], box.y + shape.end[1]);
    await page.mouse.up();
  }

  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  await expect.poll(() => api.atomicSavePayloads).toHaveLength(1);
  const payload = api.atomicSavePayloads[0];
  expect(payload.objectCreates).toEqual([]);
  const additions = payload.documentChanges?.operations.flatMap(operation => operation.kind === "add" ? [operation.element] : []) ?? [];
  expect(additions.map(element => element.type)).toEqual(["rectangle", "triangle", "line", "text"]);
  const [rectangle, triangle, line, text] = additions;
  if (rectangle?.type !== "rectangle" || triangle?.type !== "triangle" || line?.type !== "line" || text?.type !== "text") {
    throw new Error("saved common map elements are missing");
  }
  const targets = {
    rectangle: { x: rectangle.geometry.origin.x + rectangle.geometry.width / 2,
      y: rectangle.geometry.origin.y + rectangle.geometry.height / 2, radius: 0, color: rectangle.style.fillColor },
    triangle: { x: triangle.geometry.points.reduce((sum, point) => sum + point.x, 0) / 3,
      y: triangle.geometry.points.reduce((sum, point) => sum + point.y, 0) / 3, radius: 0, color: triangle.style.fillColor },
    line: { x: (line.geometry.start.x + line.geometry.end.x) / 2,
      y: (line.geometry.start.y + line.geometry.end.y) / 2, radius: 5, color: line.style.strokeColor },
    text: { x: text.geometry.position.x + text.geometry.width / 2,
      y: text.geometry.position.y + text.geometry.height / 2,
      radius: Math.max(text.geometry.width, text.geometry.height) / 2, color: text.style.strokeColor }
  };

  await page.getByRole("link", { name: "모니터링", exact: true }).click();
  await expect(page).toHaveURL(/\/monitoring\?siteId=site-1$/);
  await expect(page.locator("[data-floor-map-webgl-overlay] canvas")).toBeVisible();
  const surface = page.locator("[data-floor-map-surface]");
  await surface.scrollIntoViewIfNeeded();
  await expect.poll(async () => {
    const png = (await page.screenshot({ scale: "css" })).toString("base64");
    return surface.evaluate(async (element, { png, targets }) => {
      const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
      const sample = document.createElement("canvas"); sample.width = image.width; sample.height = image.height;
      const context = sample.getContext("2d")!; context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      const rect = element.getBoundingClientRect();
      const matches = (x: number, y: number, rgb: number[]) => {
        if (x < 0 || y < 0 || x >= image.width || y >= image.height) return false;
        const offset = (y * image.width + x) * 4;
        return rgb.every((value, channel) => Math.abs(value - pixels[offset + channel]) < 12);
      };
      const matchesAntialiasedBlueStroke = (x: number, y: number) => {
        if (x < 0 || y < 0 || x >= image.width || y >= image.height) return false;
        const offset = (y * image.width + x) * 4;
        // At fit-to-viewport scale this 1px map line occupies less than one CSS pixel.
        return pixels[offset + 2] - pixels[offset] > 100 && pixels[offset + 2] - pixels[offset + 1] > 70;
      };
      return Object.fromEntries(Object.entries(targets).map(([name, target]) => {
        if (!target.color) return [name, false];
        const rgb = [1, 3, 5].map(index => Number.parseInt(target.color!.slice(index, index + 2), 16));
        const x = Math.round(rect.left + rect.width * target.x / 1200);
        const y = Math.round(rect.top + rect.height * target.y / 800);
        const radiusX = name === "text" ? Math.ceil(rect.width * target.radius / 1200) : target.radius;
        const radiusY = name === "text" ? Math.ceil(rect.height * target.radius / 800) : target.radius;
        for (let py = y - radiusY; py <= y + radiusY; py++) {
          for (let px = x - radiusX; px <= x + radiusX; px++) {
            if (name === "line" ? matchesAntialiasedBlueStroke(px, py) : matches(px, py, rgb)) return [name, true];
          }
        }
        return [name, false];
      }));
    }, { png, targets });
  }).toEqual({ rectangle: true, triangle: true, line: true, text: true });
  expect(api.requests.some(request => request.includes("/map-document/changes"))).toBe(true);
});

test("viewer is redirected before editor state and lease requests while mutation fixtures reject changes", async ({ page }) => {
  const api = await installSettingsApiRoutes(page, "viewer");
  await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");

  await expect(page).toHaveURL(/\/settings\/floor-plans\?siteId=site-1$/);
  const floorRow = page.getByTestId("floor-plan-item").filter({ hasText: "B2" });
  await expect(floorRow).toContainText("맵 설정됨");
  await expect(floorRow.getByRole("link", { name: "B2 맵 편집" })).toHaveCount(0);
  expect(api.requests.filter((path) => path.includes("/editor-state") || path.includes("/editor-lease"))).toEqual([]);

  const status = await page.evaluate(async () => {
    const response = await fetch("/api/floors/floor-1/editor-state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 7, fixtureUpdates: [], objectCreates: [], objectUpdates: [], objectDeletes: [] })
    });
    return response.status;
  });
  expect(status).toBe(403);
});

test("browser lease fixture preserves active tokens across conflict, renewal, and stale release", async ({ page }) => {
  await installSettingsApiRoutes(page, "admin");
  await page.goto("/");

  const outcomes = await page.evaluate(async () => {
    const request = async (path: string, method: string, body: Record<string, unknown>) => {
      const response = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() };
    };
    const payload = {
      expectedRevision: 7,
      fixtureUpdates: [],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    };
    const saveWithoutLease = await request("/api/floors/floor-1/editor-state", "PUT", payload);
    const acquired = await request("/api/floors/floor-1/editor-lease", "POST", {});
    const conflict = await request("/api/floors/floor-1/editor-lease", "POST", {});
    const staleRenewal = await request("/api/floors/floor-1/editor-lease", "POST", { token: "stale-token" });
    const staleRelease = await request("/api/floors/floor-1/editor-lease", "DELETE", { token: "stale-token" });
    const missingRelease = await request("/api/floors/floor-1/editor-lease", "DELETE", {});
    const renewed = await request("/api/floors/floor-1/editor-lease", "POST", { token: acquired.body.token });
    const released = await request("/api/floors/floor-1/editor-lease", "DELETE", { token: acquired.body.token });
    const noHolderRelease = await request("/api/floors/floor-1/editor-lease", "DELETE", { token: acquired.body.token });
    const reacquired = await request("/api/floors/floor-1/editor-lease", "POST", {});
    return { saveWithoutLease, acquired, conflict, staleRenewal, staleRelease, missingRelease, renewed, released, noHolderRelease, reacquired };
  });

  expect(outcomes.saveWithoutLease.status).toBe(409);
  expect(outcomes.acquired.body).toMatchObject({ editable: true });
  expect(outcomes.acquired.body.token).toEqual(expect.any(String));
  expect(outcomes.conflict.body).toMatchObject({ editable: false });
  expect(outcomes.conflict.body).not.toHaveProperty("token");
  expect(outcomes.staleRenewal.body).toMatchObject({ editable: false });
  expect(outcomes.staleRenewal.body).not.toHaveProperty("token");
  expect(outcomes.staleRelease).toEqual({ status: 403, body: { message: "floor editor lease is held by another user" } });
  expect(outcomes.missingRelease).toEqual({ status: 403, body: { message: "floor editor lease is held by another user" } });
  expect(outcomes.renewed.body).toMatchObject({ editable: true, token: outcomes.acquired.body.token });
  expect(outcomes.released.body).toEqual({ released: true });
  expect(outcomes.noHolderRelease).toEqual({ status: 200, body: { released: false } });
  expect(outcomes.reacquired.body).toMatchObject({ editable: true });
  expect(outcomes.reacquired.body.token).not.toBe(outcomes.acquired.body.token);
});

test("settings browser fixture isolates unknown tenant route data", async ({ page }) => {
  await installSettingsApiRoutes(page, "admin");
  await page.goto("/settings/floor-plans?siteId=site-1");

  const status = await page.evaluate(async () => {
    const response = await fetch("/api/sites/site-foreign/dashboard");
    return response.status;
  });
  expect(status).toBe(404);
});

test("dirty editor logout keeps the draft on cancel and logs out only after confirmation", async ({ page }) => {
  const api = await installSettingsApiRoutes(page, "admin", { readyMapDocument: true });
  await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
  await expect(page.getByRole("heading", { name: "B2 맵 편집" })).toBeVisible();
  await expect.poll(() => {
    const latestLease = [...api.editorRequests].reverse().find((request) => request.type === "lease-acquire");
    return latestLease?.type === "lease-acquire" && latestLease.result.editable;
  }).toBe(true);

  const xInput = await changeSelectedFixtureX(page, "260");

  await page.getByRole("region", { name: "내 계정" }).getByRole("button", { name: "로그아웃", exact: true }).click();
  let logoutDialog = page.getByRole("alertdialog", { name: "로그아웃 확인" });
  await expect(logoutDialog).toContainText("저장하지 않은 변경사항");
  await logoutDialog.getByRole("button", { name: "취소" }).click();

  await expect(page).toHaveURL(/\/settings\/floor-plans\/floor-1\/edit\?siteId=site-1$/);
  await expect(xInput).toHaveValue("260");
  expect(api.logoutRequests).toBe(0);
  await expect.poll(async () => page.evaluate(async () => (await fetch("/api/auth/me")).status)).toBe(200);

  await page.getByRole("region", { name: "내 계정" }).getByRole("button", { name: "로그아웃", exact: true }).click();
  logoutDialog = page.getByRole("alertdialog", { name: "로그아웃 확인" });
  await logoutDialog.getByRole("button", { name: "로그아웃" }).click();

  await expect(page.getByRole("heading", { name: "킨다 로그인" })).toBeVisible();
  expect(api.logoutRequests).toBe(1);
  await expect.poll(async () => page.evaluate(async () => (await fetch("/api/auth/me")).status)).toBe(401);
});

for (const viewport of responsiveViewports.filter(({ width }) => width <= 390)) {
  test(`dirty editor keeps the coarse ${viewport.width}px settings tabs on cancel and clears its sentinel on confirm`, async ({ browser, baseURL }) => {
    const page = await browser.newPage({ baseURL, viewport, hasTouch: true, isMobile: true });
    try {
      const api = await installSettingsApiRoutes(page, "admin", { readyMapDocument: true });
      await page.goto("/settings?siteId=site-1#fragment");
      await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1#fragment");
      await expect(page.getByRole("heading", { name: "B2 맵 편집" })).toBeVisible();
      await expect.poll(() => {
        const latestLease = [...api.editorRequests].reverse().find((request) => request.type === "lease-acquire");
        return latestLease?.type === "lease-acquire" && latestLease.result.editable;
      }).toBe(true);

      const xInput = await changeSelectedFixtureX(page, "260");

      const menu = page.getByRole("navigation", { name: "설정 메뉴" });
      const securityLink = menu.getByRole("link", { name: "계정 보안" });
      await expect(securityLink).toHaveAttribute("href", "/settings/security?siteId=site-1#fragment");

      await securityLink.click();
      const leaveDialog = page.getByRole("alertdialog", { name: "맵 편집 종료" });
      await expect(leaveDialog).toContainText("저장하지 않은 변경사항");
      await leaveDialog.getByRole("button", { name: "취소" }).click();

      await expect(page).toHaveURL(/\/settings\/floor-plans\/floor-1\/edit\?siteId=site-1#fragment$/);
      await expect(page.getByRole("heading", { name: "B2 맵 편집" })).toBeVisible();
      await expect(xInput).toHaveValue("260");
      await expect(menu).toBeVisible();
      await expect(securityLink).toBeFocused();

      await securityLink.click();
      await leaveDialog.getByRole("button", { name: "이동" }).click();

      await expect(page).toHaveURL(/\/settings\/security\?siteId=site-1#fragment$/);
      await expect(page.getByRole("form", { name: "비밀번호 변경" })).toBeVisible();
      await expect.poll(() => page.evaluate(() => Boolean(window.history.state?.__floorEditorDirtySentinel))).toBe(false);
      await page.goBack();
      await expect(page).toHaveURL(/\/settings\/floor-plans\/floor-1\/edit\?siteId=site-1#fragment$/);
      await expect(page.getByRole("heading", { name: "B2 맵 편집" })).toBeVisible();
      await expect.poll(() => page.evaluate(() => Boolean(window.history.state?.__floorEditorDirtySentinel))).toBe(false);
      await page.goForward();
      await expect(page).toHaveURL(/\/settings\/security\?siteId=site-1#fragment$/);
      await expect(page.getByRole("form", { name: "비밀번호 변경" })).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(/\/settings\/floor-plans\/floor-1\/edit\?siteId=site-1#fragment$/);
      await expect(page.getByRole("heading", { name: "B2 맵 편집" })).toBeVisible();

      const unexpectedDialogs: string[] = [];
      page.on("dialog", async (dialog) => {
        unexpectedDialogs.push(dialog.message());
        await dialog.dismiss();
      });
      await page.getByRole("button", { name: "로그아웃" }).click();
      await expect(page.getByRole("heading", { name: "킨다 로그인" })).toBeVisible();
      expect(unexpectedDialogs).toEqual([]);
      expect(api.logoutRequests).toBe(1);
    } finally {
      await page.close();
    }
  });
}

test("desktop settings link opens capability-filtered top tabs and preserves site scope", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installSettingsApiRoutes(page, "admin");
  await page.goto("/monitoring?siteId=site-1#settings");

  const settings = page.getByRole("link", { name: "설정", exact: true });
  await settings.hover();
  await expect(settings).not.toHaveAttribute("aria-expanded");
  await expect(page.getByRole("navigation", { name: "설정 메뉴" })).toHaveCount(0);
  await expect(settings.locator(".settings-nav-chevron")).toHaveCount(0);
  await settings.click();

  await expect(page).toHaveURL(/\/settings\?siteId=site-1#settings$/);
  const navigation = page.getByRole("navigation", { name: "설정 메뉴" });
  await expect(navigation.getByRole("link", { name: "설정 개요" })).toHaveAttribute("aria-current", "page");
  await expect(navigation.getByRole("link", { name: "유저 관리" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "조명 등록" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "계정 보안" })).toBeVisible();
  await navigation.getByRole("link", { name: "맵 관리" }).click();

  await expect(page).toHaveURL(/\/settings\/floor-plans\?siteId=site-1#settings$/);
  await expect(page.getByRole("heading", { name: "맵 관리" })).toBeVisible();
  await expect(settings).toHaveAttribute("aria-current", "page");
  await expect(navigation.getByRole("link", { name: "설정 개요" })).not.toHaveAttribute("aria-current");
  await expect(navigation.getByRole("link", { name: "맵 관리" })).toHaveAttribute("aria-current", "page");
  await expect(navigation.getByRole("link", { name: "계정 보안" })).not.toHaveAttribute("aria-current");
  await expectNoHorizontalOverflow(page);
});

test("desktop viewer settings tabs follow natural keyboard order and hide manage routes", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await installSettingsApiRoutes(page, "viewer");
  await page.goto("/monitoring?siteId=site-1");

  const settings = page.getByRole("link", { name: "설정", exact: true });
  await settings.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/settings\?siteId=site-1$/);
  const navigation = page.getByRole("navigation", { name: "설정 메뉴" });
  const overview = navigation.getByRole("link", { name: "설정 개요" });
  const floorPlans = navigation.getByRole("link", { name: "맵 관리" });
  const security = navigation.getByRole("link", { name: "계정 보안" });
  await expect(floorPlans).toBeVisible();
  await expect(security).toBeVisible();
  await expect(navigation.getByRole("link", { name: "유저 관리" })).toHaveCount(0);
  await expect(navigation.getByRole("link", { name: "조명 등록" })).toHaveCount(0);

  await overview.focus();
  await page.keyboard.press("Tab");
  await expect(floorPlans).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(security).toBeFocused();
  await expectNoHorizontalOverflow(page);
});

for (const viewport of responsiveViewports.filter(({ width }) => width <= 760)) {
  test(`coarse ${viewport.width}px settings navigation uses the same top tabs`, async ({ browser, baseURL }) => {
    const page = await browser.newPage({ baseURL, viewport, hasTouch: true, isMobile: true });
    try {
      await installSettingsApiRoutes(page, "admin");
      await page.goto("/monitoring?siteId=site-1");
      const settings = page.getByRole("link", { name: "설정", exact: true });
      await settings.click();

      await expect(page).toHaveURL(/\/settings\?siteId=site-1$/);
      const menu = page.getByRole("navigation", { name: "설정 메뉴" });
      await expect(menu).toBeVisible();
      await expect(menu).toHaveCSS("overflow-x", "auto");
      await expect(settings).toHaveAttribute("aria-current", "page");
      await expect(menu.getByRole("link", { name: "설정 개요" })).toHaveAttribute("aria-current", "page");
      await expectMinimumTouchTargetsAfterScrolling(page, 'nav[aria-label="설정 메뉴"]');
      await expectNoHorizontalOverflow(page);

      await page.goto("/settings/security?siteId=site-1");
      const activeSecurityTab = page
        .getByRole("navigation", { name: "설정 메뉴" })
        .getByRole("link", { name: "계정 보안" });
      await expect(activeSecurityTab).toHaveAttribute("aria-current", "page");
      await expect(activeSecurityTab).toBeInViewport();

      await menu.getByRole("link", { name: "맵 관리" }).click();
      await expect(page).toHaveURL(/\/settings\/floor-plans\?siteId=site-1$/);
      await expect(page.getByRole("heading", { name: "맵 관리" })).toBeVisible();
      await expectMinimumTouchTargetsAfterScrolling(page, "[data-app-shell]");
      await expectNoHorizontalOverflow(page);
    } finally {
      await page.close();
    }
  });
}

test("Task8 editor resize across 1023 and 1024 keeps renderer and draft identity", async ({ page }) => {
  await page.setViewportSize({ width: 1023, height: 900 });
  const api = await installSettingsApiRoutes(page, "admin", { readyMapDocument: true });
  await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
  const canvas = page.getByLabel("B2 편집 캔버스");
  await expect(canvas).toHaveAttribute("data-map-ready", "true");
  const original = await canvas.elementHandle();
  await changeSelectedFixtureX(page, "240");
  for (const width of [1024, 1023]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(canvas).toHaveAttribute("data-map-ready", "true");
    expect(await canvas.evaluate((element, prior) => element === prior, original)).toBe(true);
    await expect(page.getByRole("button", { name: "저장", exact: true })).toBeEnabled();
    await expect.poll(() => canvas.evaluate(element => element.clientHeight)).toBeGreaterThanOrEqual(240);
    await expectNoHorizontalOverflow(page);
  }
  expect(api.atomicSavePayloads).toEqual([]);
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(() => api.fixtureUpdates).toEqual([{ id: "fixture-1", x: 240 }]);
});

for (const viewport of responsiveViewports) {
  test(`floor editor keeps its workspace contract at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const api = await installSettingsApiRoutes(page, "admin", { readyMapDocument: true });
    await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
    await expect(page.getByRole("heading", { name: "B2 맵 편집" })).toBeVisible();
    await expect.poll(() => {
      const latestLease = [...api.editorRequests].reverse().find((request) => request.type === "lease-acquire");
      return latestLease?.type === "lease-acquire" && latestLease.result.editable;
    }).toBe(true);
    const canvas = page.getByTestId("floor-editor-canvas");
    await expect(canvas).toHaveAttribute("data-map-ready", "true");
    const information = page.getByRole("complementary", { name: "맵 편집 정보" });
    if (!await information.isVisible()) await page.getByRole("button", { name: "편집 정보 패널" }).click();
    await information.getByRole("tab", { name: "자료" }).click();
    await expect(page.getByRole("button", { name: "리비전 7 복구" })).toBeVisible();
    await information.getByRole("tab", { name: "속성" }).click();
    if (viewport.width < 1280) await page.getByRole("button", { name: "편집 정보 패널" }).click();
    await selectFixtureInCanvas(page);
    const stage = await canvas.boundingBox();
    expect(stage).not.toBeNull();
    if (stage) {
      expect(stage.width).toBeGreaterThan(200);
      expect(stage.height).toBeGreaterThanOrEqual(240);
      await canvas.evaluate(element => element.scrollIntoView({ block: "center" }));
      const visibleStage = await canvas.boundingBox();
      expect(visibleStage).not.toBeNull();
      // A short screen scrolls the full-size map; sufficient-height screens
      // still expose it above the fixed navigation without shrinking it.
      if (visibleStage && viewport.height >= 740) expect(visibleStage.y + visibleStage.height).toBeLessThanOrEqual(viewport.height - (viewport.width <= 760 ? 68 : 0));
    }
    await expectNoHorizontalOverflow(page);
    if (viewport.width <= 760) {
      await expectMinimumTouchTargetsAfterScrolling(page, '[data-testid="editor-toolbar"]');
      await expectMinimumTouchTargets(page, '[aria-label="편집 패널"]');
      await page.getByRole("button", { name: "편집 정보 패널" }).click();
      await page.getByRole("button", { name: "도구 및 조명 패널" }).click();
      await expectMinimumTouchTargets(page, '[aria-label="맵 편집 도구"]');
    }
  });
}

for (const viewport of responsiveViewports) {
  test(`settings routes keep their interactive contract at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installSettingsApiRoutes(page, "admin");

    await page.goto("/settings?siteId=site-1");
    await expect(page.getByRole("heading", { name: "설정 개요" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "조명 등록" })).toHaveCount(0);
    await expectSettingsContentTopAligned(page);
    await expectNoHorizontalOverflow(page);

    await page.goto("/settings/registration?siteId=site-1");
    await expect(page.getByRole("heading", { name: "조명 등록" })).toBeVisible();
    await expectSettingsContentTopAligned(page);
    await expectNoHorizontalOverflow(page);
    if (viewport.width <= 760) {
      const registrationTargets = page.getByTestId("registration-selectors");
      await registrationTargets.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await expect(page.getByLabel("등록 층")).toBeInViewport();
      await expect(page.getByLabel("등록 게이트웨이")).toBeInViewport();
      await expectMinimumTouchTargetsAfterScrolling(page, "[data-app-shell]");
    }

    await page.goto("/settings/floor-plans?siteId=site-1");
    await expect(page.getByRole("heading", { name: "맵 관리" })).toBeVisible();
    await expectSettingsContentTopAligned(page);
    await expectNoHorizontalOverflow(page);

    await page.goto("/settings/security?siteId=site-1");
    await expect(page.getByRole("form", { name: "비밀번호 변경" })).toBeVisible();
    await expect(page.getByLabel("현재 비밀번호")).toBeVisible();
    await expect(page.getByLabel("새 비밀번호", { exact: true })).toBeVisible();
    await expect(page.getByLabel("새 비밀번호 확인")).toBeVisible();
    await expectSettingsContentTopAligned(page);
    await expectNoHorizontalOverflow(page);
    if (viewport.width <= 760) await expectMinimumTouchTargetsAfterScrolling(page, "[data-app-shell]");
  });
}

test("viewer can enter personal password settings", async ({ page }) => {
  await installSettingsApiRoutes(page, "viewer");
  await page.goto("/settings/security?siteId=site-1");

  await expect(page).toHaveURL(/\/settings\/security\?siteId=site-1$/);
  await expect(page.getByRole("form", { name: "비밀번호 변경" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "설정 메뉴" }).getByRole("link", { name: "계정 보안" })).toHaveAttribute("aria-current", "page");
});

async function changeSelectedFixtureX(page: import("@playwright/test").Page, value: string) {
  const properties = await selectFixtureInCanvas(page);
  const xInput = properties.getByLabel("X");
  await xInput.fill(value);
  await xInput.press("Tab");
  await expect(xInput).toHaveValue(value);
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeEnabled();
  return xInput;
}

async function selectFixtureInCanvas(page: import("@playwright/test").Page) {
  const canvas = page.getByLabel("B2 편집 캔버스");
  await expect(canvas).toHaveAttribute("data-map-ready", "true");
  const zoom = Number(await canvas.getAttribute("data-zoom"));
  const panX = Number(await canvas.getAttribute("data-pan-x"));
  const panY = Number(await canvas.getAttribute("data-pan-y"));
  await canvas.click({ position: { x: panX + 120 * zoom, y: panY + 140 * zoom } });
  const information = page.getByRole("complementary", { name: "맵 편집 정보" });
  if (!await information.isVisible()) await page.getByRole("button", { name: "편집 정보 패널" }).click();
  await information.getByRole("tab", { name: "속성" }).click();
  const properties = page.getByRole("complementary", { name: "속성 패널" });
  await expect(properties.getByRole("heading", { name: "B2-L01" })).toBeVisible();
  return properties;
}
