// New approved-auxiliary harness. Runtime is pending the root final-source grant.
import { test, expect, type Page, type Locator, type TestInfo } from "../../../apps/web/node_modules/@playwright/test";
import { writeFile } from "node:fs/promises";
import { approvedAuxiliaryBinding } from "./page-session-ux-aux-binding";
import {
  ids, reviewCases, prepareCustomer, setReviewTheme, readGeometry, savePhase,
  rememberMapIdentity, actualCenter, nativeSwipe, expectNoHorizontalOverflow,
  expectMinimumTouchTargets, exposedPoint, expectContinuous44Hit, type GeometryContract
} from "./page-session-ux-aux-support";

// Six representative real-renderer cases, not a full matrix. API fixtures are
// read-only and no command is acknowledged or sent to real equipment.
const mon: GeometryContract = {
  map: '[data-testid="monitoring-map-viewport"]',
  regions: { toolbar: '[role="group"][aria-label="모니터링 도구"]', mapPanel: '[data-operation-map-panel]', footer: '[data-floor-map-footer]', detail: 'aside[aria-label="조명 상세"]', detailBody: '[data-monitoring-detail-scroll]', nav: '[data-shell-navigation="compact"]' },
  occluders: ['aside[aria-label="조명 상세"]', '[data-monitoring-pin-popover]', '[data-shell-navigation="compact"]']
};
const control: GeometryContract = {
  map: '[data-testid="target-selection-map-viewport"]',
  regions: { toolbar: '[data-target-selection-toolbar]', execution: '[data-control-execution-row]', selection: '[data-manual-selection-panel]', list: approvedAuxiliaryBinding.selectionContentSelector, more: approvedAuxiliaryBinding.moreContentSelector, auxiliaryBody: approvedAuxiliaryBinding.bodySelector, auxiliaryPanel: approvedAuxiliaryBinding.surfaceSelectors[0], important: '[aria-label="제어 중요 상태"]', mapPanel: '[data-operation-map-panel]', footer: '[data-floor-map-footer]', nav: '[data-shell-navigation="compact"]', ...(approvedAuxiliaryBinding.cameraOverlaySurfaceSelectors.length ? { cameraOverlay: approvedAuxiliaryBinding.cameraOverlaySurfaceSelectors.join(",") } : {}) },
  occluders: ['[data-shell-navigation="compact"]', ...approvedAuxiliaryBinding.cameraOverlaySurfaceSelectors, ...approvedAuxiliaryBinding.surfaceSelectors]
};
// Accessible-name prefix is stable across brightness/status changes.
const firstMarker = (page: Page) => page.locator('[data-spatial-map-marker="true"][aria-label^="UX 조명 01"]');
const mapCamera = (map: Locator) => map.evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop, zoom: element.getAttribute("data-zoom") }));
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

async function finite(page: Page) {
  await expectNoHorizontalOverflow(page);
  const documentMetrics = await page.evaluate(() => ({ y: scrollY, height: document.scrollingElement!.scrollHeight, client: document.scrollingElement!.clientHeight }));
  expect(documentMetrics.y, "manual mobile document scroll must remain zero").toBe(0);
  expect(documentMetrics.height, "manual mobile uses finite shell, not outer scrolling").toBeLessThanOrEqual(documentMetrics.client + 1);
  await expectMinimumTouchTargets(page, '[data-shell-navigation="compact"]');
}

async function row(page: Page, targets: Locator[]) {
  const boxes = await Promise.all(targets.map(target => target.boundingBox()));
  expect(boxes.every(Boolean), "every actual row control has geometry").toBe(true);
  const centers = boxes.map(box => box!.y + box!.height / 2);
  expect(Math.max(...centers) - Math.min(...centers), "controls must share one row").toBeLessThanOrEqual(1);
  await expectNoHorizontalOverflow(page);
}

/** Wheel the real scroll owner; never assign scrollTop or call scrollIntoView. */
async function internalEnd(page: Page, root: Locator, useExposedPoint = false) {
  const center = useExposedPoint ? await exposedPoint(root) : await actualCenter(root);
  await page.mouse.move(center.x, center.y);
  for (let step = 0; step < 10; step++) {
    const state = await root.evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight }));
    if (state.top >= state.height - state.client - 1) break;
    await page.mouse.wheel(0, 1600);
    await settle(page);
  }
  const state = await root.evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight }));
  expect(state.top, "native wheel must reach internal bottom").toBeGreaterThanOrEqual(state.height - state.client - 1);
  return state;
}

async function blankPoint(map: Locator) {
  return map.evaluate(element => {
    const r = element.getBoundingClientRect();
    for (const yRatio of [0.4, 0.6, 0.25]) for (const xRatio of [0.4, 0.65, 0.25]) {
      const x = r.x + r.width * xRatio, y = r.y + r.height * yRatio;
      const hit = document.elementFromPoint(x, y);
      if (hit && element.contains(hit) && hit.closest('[data-floor-map-surface]') && !hit.closest('button')) return { x, y };
    }
    throw new Error("No exposed blank map point available for native CAD gesture");
  });
}

async function pan(page: Page, map: Locator, kind: "middle" | "space") {
  const start = await blankPoint(map), before = await mapCamera(map);
  if (kind === "space") { await map.focus(); await page.keyboard.down("Space"); }
  try {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down({ button: kind === "middle" ? "middle" : "left" });
    await page.mouse.move(start.x - 30, start.y - 24, { steps: 8 });
    await page.mouse.up({ button: kind === "middle" ? "middle" : "left" });
  } finally { if (kind === "space") await page.keyboard.up("Space"); }
  await settle(page);
  const after = await mapCamera(map);
  expect(after.x !== before.x || after.y !== before.y, `${kind} drag must move actual camera`).toBe(true);
  await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
  return { before, after };
}

async function selectFloor(page: Page, compact: boolean) {
  if (compact) {
    await page.getByRole("button", { name: /선택 범위/ }).click();
    await page.getByRole("option", { name: "층 전체", exact: true }).click();
  } else await page.getByRole("group", { name: "대상 선택 방식" }).getByRole("button", { name: "층 전체", exact: true }).click();
  const confirmation = page.getByRole("alertdialog", { name: "선택 방식 변경" });
  if (await confirmation.count()) await confirmation.getByRole("button", { name: "변경", exact: true }).click();
  await expect(page.getByRole("heading", { name: "선택 조명 60개", exact: true })).toBeVisible();
}


const selectionDisclosure = (page: Page) => page.locator('[data-manual-selection-panel]').getByRole("button", { name: /^(전체 보기|접기)$/ });
async function selectionList(page: Page) {
  const id = await selectionDisclosure(page).getAttribute("aria-controls");
  if (!id) throw new Error("Selection disclosure must identify its actual controlled panel");
  await expect(page.locator(approvedAuxiliaryBinding.surfaceSelectors[0])).toHaveAttribute("id", id);
  return page.locator(approvedAuxiliaryBinding.selectionContentSelector);
}
type Snapshot = Awaited<ReturnType<typeof readGeometry>>;
type Identity = Awaited<ReturnType<typeof rememberMapIdentity>>;

/** No map space is traded for an auxiliary. Raw/clipped/exposed measurements
 * stay separate: stable raw bounds alone cannot excuse a covered or zero map. */
async function manualState(page: Page, identity: Identity, phase: (name: string, extra?: unknown) => Promise<void>, name: string, state: "closed" | "list" | "more", before?: Snapshot) {
  const list = await selectionList(page), more = page.getByRole("button", { name: "더보기", exact: true });
  const content = page.locator(approvedAuxiliaryBinding.moreContentSelector);
  const panel = page.locator(approvedAuxiliaryBinding.surfaceSelectors[0]);
  await expect(more).toHaveAttribute("aria-controls", (await panel.getAttribute("id"))!);
  await expect(selectionDisclosure(page)).toHaveAttribute("aria-expanded", state === "list" ? "true" : "false");
  await expect(more).toHaveAttribute("aria-expanded", state === "more" ? "true" : "false");
  if (state === "list") await expect(list).toBeVisible(); else await expect(list).toBeHidden();
  if (state === "more") await expect(content).toBeVisible(); else await expect(content).toBeHidden();
  if (state === "closed") await expect(panel).toBeHidden(); else await expect(panel).toBeVisible();
  if (state !== "closed") {
    const surfaces = await Promise.all(approvedAuxiliaryBinding.surfaceSelectors.map(selector => page.locator(selector).isVisible()));
    expect(surfaces.filter(Boolean), "one actual opaque auxiliary surface must be included in exposed-map geometry").toHaveLength(1);
    const surface = page.locator(approvedAuxiliaryBinding.surfaceSelectors[surfaces.findIndex(Boolean)]);
    const surfaceBox = await surface.boundingBox(), anchorBox = await page.locator(approvedAuxiliaryBinding.anchorSelector).boundingBox();
    expect(surfaceBox).not.toBeNull(); expect(anchorBox).not.toBeNull();
    expect(Math.abs(surfaceBox!.y + surfaceBox!.height - (anchorBox!.y + anchorBox!.height)), "approved auxiliary sits at its source-defined map-bottom anchor").toBeLessThanOrEqual(1);
    await expectContinuous44Hit(panel.getByRole("button", { name: "보조 패널 닫기", exact: true }));
  }
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(control.map)).toHaveAttribute("tabindex", /-?\d+/);
  expect(await page.locator(control.map).evaluate(element => Boolean(element.closest('[inert],[aria-hidden="true"]'))), "nonmodal auxiliary must leave map available").toBe(false);
  const heading = page.locator('[data-manual-selection-panel]').getByRole("heading");
  const countBox = await heading.boundingBox(), fullBox = await selectionDisclosure(page).boundingBox();
  expect(countBox).not.toBeNull(); expect(fullBox).not.toBeNull();
  expect(fullBox!.y - (countBox!.y + countBox!.height), "44 full-view remains immediately below selection count").toBeGreaterThanOrEqual(0);
  expect(fullBox!.y - (countBox!.y + countBox!.height)).toBeLessThanOrEqual(5);
  await expectContinuous44Hit(selectionDisclosure(page));
  // Original camera44 scope is the exposed basic/closed map. The approved
  // z10 bottom reader may cover z6 cameras while open; record that occlusion
  // rather than inventing a new requirement that cameras must pierce it.
  if (state === "closed") await expectMinimumTouchTargets(page, approvedAuxiliaryBinding.cameraTouchSelector);
  const important = page.getByRole("status", { name: "제어 중요 상태", exact: true, includeHidden: true });
  await expect(important).toHaveCount(1);
  await expect(important).toHaveAttribute("aria-live", "polite");
  await expect(important).toHaveAttribute("aria-atomic", "true");
  expect(await important.evaluate(element => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.matches('[hidden],[inert],[aria-hidden="true"]') || style.display === "none" || style.visibility !== "visible") return true;
    }
    return false;
  }), "critical live region must not have a hidden or inert ancestor").toBe(false);
  const criticalText = (await important.textContent() ?? "").trim();
  // A valid fixture with no command/recovery warning has an intentionally
  // empty live region. Keep its owner/a11y checks; only real text has a hit.
  // The known empty-selection warning remains an independent basic-state
  // assertion, so a missing warning cannot become a blanket empty bypass.
  if (name === "basic-map-before-zoom") await expect(important).toHaveText("제어 대상을 하나 이상 선택해 주세요.");
  if (criticalText) { await expect(important).toBeVisible(); await actualCenter(important); }
  await finite(page); await identity.assertUnchanged();
  const after = await readGeometry(page, control);
  expect(after.map.bounds.height, "basic compact manual map240 target may not be bypassed by zoom").toBeGreaterThanOrEqual(240);
  expect(after.map.usable, "map must have an ancestor-unclipped usable box").not.toBeNull();
  expect(after.map.usable!.width).toBeGreaterThanOrEqual(after.map.bounds.width - 1);
  expect(after.map.usable!.height).toBeGreaterThanOrEqual(after.map.bounds.height - 1);
  expect(after.exposedMap.area, "actual map must not be completely covered").toBeGreaterThan(0);
  for (const region of ["toolbar", "execution", "selection", "more"]) {
    for (const item of after.regions[region] ?? []) {
      if (item.usable) expect(after.map.bounds.height, "map remains the dominant individual task region").toBeGreaterThanOrEqual(item.usable.height);
    }
  }
  // A source-approved opaque camera overlay is normal baseline occlusion, not
  // an auxiliary defect. Subtract it independently; fixed nav may never cover
  // the usable map and closed auxiliary state adds no further occlusion.
  for (const blocker of after.exposedMap.blockers.filter(item => item.selector === '[data-shell-navigation="compact"]')) {
    const overlapWidth = Math.min(after.map.usable!.right, blocker.bounds!.right) - Math.max(after.map.usable!.x, blocker.bounds!.x);
    const overlapHeight = Math.min(after.map.usable!.bottom, blocker.bounds!.bottom) - Math.max(after.map.usable!.y, blocker.bounds!.y);
    expect(overlapWidth <= 0 || overlapHeight <= 0, "fixed navigation must not cover the usable map").toBe(true);
  }
  const cameraOnly = await readGeometry(page, { ...control, occluders: approvedAuxiliaryBinding.cameraOverlaySurfaceSelectors });
  const baselineCameraOcclusionArea = after.map.usable!.width * after.map.usable!.height - cameraOnly.exposedMap.area;
  const additionalAuxiliaryOcclusionArea = cameraOnly.exposedMap.area - after.exposedMap.area;
  if (state === "closed") expect(Math.abs(additionalAuxiliaryOcclusionArea), "closed auxiliaries must add no occlusion beyond the actual camera baseline").toBeLessThanOrEqual(1);
  if (before) {
    expect(after.map.bounds, "auxiliary open/switch/close must preserve the map rect").toEqual(before.map.bounds);
    expect(after.map.camera, "auxiliary presentation must preserve the actual camera").toEqual(before.map.camera);
  }
  await phase(name, { auxiliary: state, criticalStatus: { text: criticalText, empty: !criticalText }, baseline: before && { mapBounds: before.map.bounds, camera: before.map.camera, exposedArea: before.exposedMap.area }, cameraPlacement: approvedAuxiliaryBinding.cameraPlacement, baselineCameraOcclusionArea, additionalAuxiliaryOcclusionArea, actualExposedArea: after.exposedMap.area });
  return after;
}

/** Mobile monitoring intentionally allows document scrolling. Move it natively
 * off the fixed navigation before wheeling the detail body, and distinguish
 * that translation from map resize/camera movement instead of forcing scroll. */
async function moveMonitoringAboveNav(page: Page, before: Snapshot) {
  const aside = page.locator('aside[aria-label="조명 상세"]'), nav = page.locator('[data-shell-navigation="compact"]');
  const wheels: unknown[] = [];
  for (let step = 0; step < 6; step++) {
    const asideBox = await aside.boundingBox(), navBox = await nav.boundingBox();
    if (!asideBox || !navBox) throw new Error("Actual mobile detail/navigation geometry missing");
    const deficit = asideBox.y + asideBox.height - navBox.y;
    if (deficit <= 0) break;
    const origin = await exposedPoint(page.locator("body"), true);
    const scrollBefore = await page.evaluate(() => scrollY);
    await page.mouse.move(origin.x, origin.y); await page.mouse.wheel(0, Math.ceil(deficit + 2)); await settle(page);
    const scrollAfter = await page.evaluate(() => scrollY);
    wheels.push({ origin, delta: Math.ceil(deficit + 2), scrollBefore, scrollAfter });
    expect(scrollAfter, "native document wheel must move detail above the navigation").toBeGreaterThan(scrollBefore);
  }
  const moved = await readGeometry(page, mon), asideBox = await aside.boundingBox(), navBox = await nav.boundingBox();
  expect(asideBox!.y + asideBox!.height, "detail ending must be above fixed nav").toBeLessThanOrEqual(navBox!.y);
  expect(moved.map.bounds.width).toBe(before.map.bounds.width);
  expect(moved.map.bounds.height).toBe(before.map.bounds.height);
  expect(moved.map.bounds.x).toBe(before.map.bounds.x);
  expect(moved.map.bounds.y + moved.document.scrollY, "native document translation is not a map resize").toBe(before.map.bounds.y + before.document.scrollY);
  expect(moved.map.camera).toEqual(before.map.camera);
  return { wheels, beforeScrollY: before.document.scrollY, afterScrollY: moved.document.scrollY, beforeBounds: before.map.bounds, afterBounds: moved.map.bounds };
}

async function detail(page: Page, info: TestInfo, phase: (name: string, extra?: unknown) => Promise<void>) {
  const map = page.locator(mon.map), opener = firstMarker(page);
  const identity = await rememberMapIdentity(map), before = await readGeometry(page, mon);
  try {
    await opener.click();
    await expect(map.locator('[data-spatial-map-marker="true"][aria-current="true"]')).toHaveCount(1);
    await expect(opener).toHaveAttribute("aria-current", "true");
    await page.getByRole("button", { name: "상세 보기", exact: true }).click();
    const aside = page.locator('aside[aria-label="조명 상세"]');
    await expect(aside).toBeVisible();
    await phase("detail-open");
    const after = await readGeometry(page, mon);
    expect(after.map.bounds).toEqual(before.map.bounds);
    expect(after.map.camera).toEqual(before.map.camera);
    await identity.assertUnchanged();
    const half = await aside.evaluate(element => ({ height: element.getBoundingClientRect().height, parent: element.parentElement!.getBoundingClientRect().height }));
    expect(Math.abs(half.height - half.parent / 2), "detail must occupy half of existing containing body").toBeLessThanOrEqual(1);
    const mobile = (page.viewportSize()?.width ?? 0) < 1024;
    if (mobile) {
      const movement = await moveMonitoringAboveNav(page, after);
      await identity.assertUnchanged();
      await phase("detail-native-document-wheel", movement);
    }
    const close = page.getByRole("button", { name: "조명 상세 닫기", exact: true }), headerBefore = await close.boundingBox();
    await expectMinimumTouchTargets(page, 'aside[aria-label="조명 상세"]');
    const body = page.locator('[data-monitoring-detail-scroll]');
    const end = await internalEnd(page, body, mobile);
    const lastInformation = body.locator("dd").last();
    await expect(lastInformation).toHaveText("미배치");
    await expect(lastInformation).toBeInViewport({ ratio: 1 });
    await actualCenter(lastInformation);
    expect(await mapCamera(map)).toEqual(before.map.camera);
    expect(await close.boundingBox()).toEqual(headerBefore);
    await phase("detail-end", { end, half });
    await close.click();
    await expect(aside).toHaveCount(0);
    await expect(opener).toBeFocused();
    await identity.assertUnchanged();
    expect(await mapCamera(map)).toEqual(before.map.camera);
    // Closing detail preserves selected pin/focus, not an automatically reopened
    // popover. Native re-click follows the actual production reopen path.
    await opener.click();
    await page.getByRole("button", { name: "상세 보기", exact: true }).click();
    await expect(body).toBeVisible();
    await expect.poll(() => body.evaluate(element => element.scrollTop)).toBe(end.top);
    await aside.press("Escape");
    await expect(opener).toBeFocused();
    await phase("detail-closed", { half, end });
  } finally { await identity.dispose(); }
}

// Failure evidence is captured before rethrow. Original runner error and every
// phase remain in a fresh run directory; no automatic case reruns.
async function review(page: Page, info: TestInfo, index: number, setup: () => Promise<{ requests: unknown; assertNoWrites(): void }>, body: (phase: (name: string, extra?: unknown) => Promise<void>) => Promise<void>) {
  const scenario = reviewCases[index], contract = scenario.route === "monitoring" ? mon : control;
  let lastPhase = "setup", state: Awaited<ReturnType<typeof setup>> | undefined;
  const phase = async (name: string, extra?: unknown) => {
    lastPhase = name;
    await savePhase(page, info, name, contract, { case: scenario, requests: state?.requests, extra });
  };
  try {
    state = await setup();
    await page.goto(`/${scenario.route}?siteId=${ids.siteId}`);
    await expect(page.locator(contract.map).locator("canvas").first()).toBeVisible();
    await expect(firstMarker(page)).toBeVisible();
    await setReviewTheme(page, scenario.theme);
    await phase("ready");
    await body(phase);
    state.assertNoWrites();
    await phase("complete");
  } catch (error) {
    const original = { source: process.env.UX_SOURCE_SHA, case: scenario, phase: lastPhase, url: page.url(), requests: state?.requests, error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) };
    const path = info.outputPath("original-failure.json");
    await writeFile(path, JSON.stringify(original, null, 2));
    await info.attach("original-failure", { path, contentType: "application/json" });
    try { await savePhase(page, info, "failure", contract, original); }
    catch (captureError) { await info.attach("failure-capture-error", { body: String(captureError), contentType: "text/plain" }); }
    throw error;
  }
}

test.describe("01 PC monitoring actual CAD and nonmodal detail", () => {
  test.use({ viewport: reviewCases[0].viewport });
  // Catches selection-area regressions, camera remounts, flowing overlays and wheel leakage.
  test("1194 light: pan, single selection, half overlay and focus", async ({ page, context, baseURL }, info) => {
    await review(page, info, 0, () => prepareCustomer(page, context, baseURL!, 3), async phase => {
      const toolbar = page.getByRole("group", { name: "모니터링 도구" }), map = page.locator(mon.map);
      await row(page, [toolbar.getByRole("button", { name: /맵 선택/ }), toolbar.getByRole("button", { name: "조명 검색/목록" }), toolbar.getByRole("button", { name: "새로고침" }), toolbar.locator("time")]);
      await expectMinimumTouchTargets(page, '[role="group"][aria-label="모니터링 도구"]');
      for (let step = 0; step < 8; step++) await page.getByRole("button", { name: "지도 확대", exact: true }).click();
      const middle = await pan(page, map, "middle"), space = await pan(page, map, "space");
      const point = await blankPoint(map), old = await mapCamera(map);
      await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, -80); await settle(page);
      expect((await mapCamera(map)).zoom).not.toBe(old.zoom);
      await phase("native-gestures", { middle, space, wheelBefore: old, wheelAfter: await mapCamera(map) });
      await page.getByRole("button", { name: /^지도 배율/ }).click();
      await detail(page, info, phase);
      await expectNoHorizontalOverflow(page);
    });
  });
});

test.describe("02 short mobile monitoring", () => {
  test.use({ viewport: reviewCases[1].viewport });
  // Catches wrapped controls, lost accessible timestamp and inaccessible detail endings.
  test("390x600 dark: toolbar, HH:mm and detail scroll", async ({ page, context, baseURL }, info) => {
    await review(page, info, 1, () => prepareCustomer(page, context, baseURL!, 3), async phase => {
      const toolbar = page.getByRole("group", { name: "모니터링 도구" });
      await row(page, [toolbar.getByRole("button", { name: /맵 선택/ }), toolbar.getByRole("button", { name: "조명 검색/목록" }), toolbar.getByRole("button", { name: "새로고침" }), toolbar.locator("time")]);
      await expect(toolbar.locator("time")).toHaveText(/^\d{2}:\d{2}$/, { useInnerText: true });
      await expect(toolbar.locator("time")).toHaveAttribute("aria-label", /현장 시간/);
      await expect(toolbar.locator("time")).toHaveAttribute("datetime", /T/);
      await expectMinimumTouchTargets(page, '[role="group"][aria-label="모니터링 도구"]');
      await expectMinimumTouchTargets(page, '[data-shell-navigation="compact"]');
      await detail(page, info, phase);
      await expectNoHorizontalOverflow(page);
    });
  });
});

test.describe("03 narrow finite manual workspace", () => {
  test.use({ viewport: reviewCases[2].viewport });
  // Catches tiny basic maps, weakened endpoint hits, concurrent auxiliaries,
  // lost critical state/raw draft, and accidental first-invalid Apply writes.
  test("320x600 light: map240, native0/100, first Apply and exclusive auxiliaries", async ({ page, context, baseURL }, info) => {
    await review(page, info, 2, () => prepareCustomer(page, context, baseURL!, 3), async phase => {
      const map = page.locator(control.map), identity = await rememberMapIdentity(map);
      try {
        const basic = await manualState(page, identity, phase, "basic-map-before-zoom", "closed");
        await row(page, [page.getByRole("button", { name: /표시 층/ }), page.getByRole("button", { name: /선택 범위/ }), page.getByRole("button", { name: "조명 목록", exact: true })]);
        const input = page.getByRole("textbox", { name: "밝기 수치" }), more = page.getByRole("button", { name: "더보기", exact: true });
        const thumb = page.locator('[data-slider-thumb]'), slider = thumb.locator('input[type="range"]'), apply = page.locator('[data-control-submit]');
        await row(page, [input, thumb, apply, more]);
        await firstMarker(page).click();
        await expect(page.getByRole("heading", { name: "선택 조명 1개", exact: true })).toBeVisible();
        for (const endpoint of ["0", "100"]) {
          await slider.focus(); await page.keyboard.press(endpoint === "0" ? "Home" : "End"); await settle(page);
          await expect(input).toHaveValue(endpoint); await expect(slider).toHaveValue(endpoint);
          const continuous44 = await Promise.all([input, thumb, apply, more].map(expectContinuous44Hit));
          await expectMinimumTouchTargets(page, '[data-control-execution-row]');
          await phase(`slider-endpoint-${endpoint}`, { continuous44 });
        }
        await expectMinimumTouchTargets(page, '[data-target-selection-toolbar]');
        await expectMinimumTouchTargets(page, approvedAuxiliaryBinding.cameraTouchSelector);
        await input.fill("31"); await expect(input).toHaveValue("31");
        // Selection resolves the empty-picker warning; its 18px flow change
        // precedes auxiliaries. Compare every auxiliary to this new baseline.
        const baseline = await manualState(page, identity, phase, "selected-raw31", "closed");
        await selectionDisclosure(page).click();
        await manualState(page, identity, phase, "list-open", "list", baseline);
        await more.click(); await expect(input).toHaveValue("31");
        await manualState(page, identity, phase, "list-to-more", "more", baseline);
        const content = page.locator(approvedAuxiliaryBinding.moreContentSelector), end = await internalEnd(page, page.locator(approvedAuxiliaryBinding.bodySelector), true);
        const finalAction = content.getByRole("button", { name: "확인 필요한 명령", exact: true });
        await actualCenter(finalAction); await expectContinuous44Hit(finalAction);
        await phase("more-end", { end });
        await finalAction.press("Escape"); await expect(more).toBeFocused();
        await manualState(page, identity, phase, "more-closed", "closed", baseline);
        await expect(input).toHaveValue("31");
        await input.fill("101");
        await expect(page.getByRole("alert").filter({ hasText: "0~100 사이 정수를 입력해 주세요." })).toBeVisible();
        // Do not force a disabled Apply or fake a command. Its real pointer hit
        // still exercises invalid capture/blur and must not emit a mutation.
        await expectContinuous44Hit(apply);
        const applyPoint = await actualCenter(apply);
        await page.mouse.click(applyPoint.x, applyPoint.y); await settle(page);
        await expect(input).toHaveValue("31"); await identity.assertUnchanged();
        await phase("invalid-first-apply"); await finite(page);
      } finally { await identity.dispose(); }
    });
  });
});

test.describe("04 native touch and long exclusive auxiliary selection", () => {
  test.use({ viewport: reviewCases[3].viewport, hasTouch: true });
  // Catches a tiny basic map bypassed by zoom, ghost selection, unreachable60,
  // map collapse/remount on exclusive-panel transitions, and missing close focus.
  test("390x600 dark: swipe0-tap1, long60 ending and list-More switch", async ({ page, context, baseURL }, info) => {
    await review(page, info, 3, () => prepareCustomer(page, context, baseURL!, 60), async phase => {
      const map = page.locator(control.map), identity = await rememberMapIdentity(map);
      try {
        await manualState(page, identity, phase, "basic-map-before-zoom", "closed");
        for (let step = 0; step < 8; step++) await page.getByRole("button", { name: "지도 확대", exact: true }).click();
        const markers = map.locator('[data-spatial-map-marker="true"]');
        const index = await markers.evaluateAll(elements => elements.findIndex(element => {
          const r = element.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
          return x > 40 && y > 100 && x < innerWidth - 40 && y < innerHeight - 140 && element.contains(document.elementFromPoint(x, y));
        }));
        expect(index, "touch origin must be a genuinely exposed marker").toBeGreaterThanOrEqual(0);
        const candidate = markers.nth(index), before = await mapCamera(map);
        await nativeSwipe(context, page, candidate, { x: -25, y: -20 }); await settle(page);
        await expect(page.getByRole("heading", { name: "선택 조명 0개", exact: true })).toBeVisible();
        const after = await mapCamera(map); expect(after.x !== before.x || after.y !== before.y).toBe(true);
        await candidate.tap();
        await expect(page.getByRole("heading", { name: "선택 조명 1개", exact: true })).toBeVisible();
        await phase("native-touch", { before, after, zoom: "Real zoom for dense fixture gesture only; basic-map240 already asserted" });
        await selectFloor(page, true);
        const baseline = await manualState(page, identity, phase, "long-selection-closed", "closed");
        await selectionDisclosure(page).click();
        await manualState(page, identity, phase, "long-list-open", "list", baseline);
        const list = await selectionList(page), heading = page.getByRole("heading", { name: "선택 조명 60개", exact: true }), headingBefore = await heading.boundingBox();
        const end = await internalEnd(page, page.locator(approvedAuxiliaryBinding.bodySelector), true), last = list.getByText("UX 조명 60", { exact: true });
        await expect(last).toBeInViewport({ ratio: 1 }); await actualCenter(last);
        expect(await heading.boundingBox()).toEqual(headingBefore);
        await manualState(page, identity, phase, "long-list-end", "list", baseline);
        await phase("long-list-ending-evidence", { end });
        await last.press("Escape"); await expect(selectionDisclosure(page)).toBeFocused();
        await manualState(page, identity, phase, "long-list-closed-focus", "closed", baseline);
        await selectionDisclosure(page).click();
        await manualState(page, identity, phase, "long-list-reopened", "list", baseline);
        const more = page.getByRole("button", { name: "더보기", exact: true }); await more.click();
        await manualState(page, identity, phase, "long-list-to-more", "more", baseline);
        await selectionDisclosure(page).click();
        await manualState(page, identity, phase, "long-more-to-list", "list", baseline);
        await page.getByRole("button", { name: "보조 패널 닫기", exact: true }).click(); await expect(selectionDisclosure(page)).toBeFocused();
        await manualState(page, identity, phase, "long-switch-closed-focus", "closed", baseline);
      } finally { await identity.dispose(); }
    });
  });
});

test.describe("05 resize without remount/reset", () => {
  test.use({ viewport: reviewCases[4].viewport });
  // Same existing resize case, now tests the approved exclusive presentation.
  test("717x1227 to 390x844 light: exclusive aux, focus and raw31", async ({ page, context, baseURL }, info) => {
    await review(page, info, 4, () => prepareCustomer(page, context, baseURL!, 3), async phase => {
      const map = page.locator(control.map), identity = await rememberMapIdentity(map);
      try {
        const basic = await manualState(page, identity, phase, "basic-map-before-zoom", "closed");
        await firstMarker(page).click();
        const input = page.getByRole("textbox", { name: "밝기 수치" }), more = page.getByRole("button", { name: "더보기", exact: true });
        await input.fill("31");
        // The normal-selection baseline is separate from the empty picker.
        const baseline = await manualState(page, identity, phase, "resize-selected-raw31", "closed");
        await selectionDisclosure(page).click();
        await manualState(page, identity, phase, "resize-list-open", "list", baseline);
        await more.click();
        await manualState(page, identity, phase, "resize-list-to-more", "more", baseline);
        await expect(input).toHaveValue("31");
        await more.click(); await expect(more).toBeFocused();
        await manualState(page, identity, phase, "resize-aux-closed", "closed", baseline);
        await input.focus();
        await page.setViewportSize(reviewCases[4].resize); await settle(page);
        await expect(input).toHaveValue("31"); await expect(input).toBeFocused();
        const resized = await manualState(page, identity, phase, "resized-focused", "closed");
        expect(resized.map.camera).toEqual(baseline.map.camera);
        await phase("resize-not-document-scroll", { previousViewport: reviewCases[4].viewport, currentViewport: reviewCases[4].resize, previousBounds: baseline.map.bounds, resizedBounds: resized.map.bounds, documentScrollY: resized.document.scrollY, limitation: "Viewport resize only; no OS software keyboard" });
        await more.click();
        await manualState(page, identity, phase, "resized-more-open", "more", resized);
        await selectionDisclosure(page).click();
        await manualState(page, identity, phase, "resized-more-to-list", "list", resized);
        await (await selectionList(page)).getByText("UX 조명 01", { exact: true }).press("Escape");
        await expect(selectionDisclosure(page)).toBeFocused(); await expect(input).toHaveValue("31");
        await manualState(page, identity, phase, "resized-list-closed-focus", "closed", resized);
      } finally { await identity.dispose(); }
    });
  });
});

test.describe("06 PC manual empty and long-list ownership", () => {
  test.use({ viewport: reviewCases[5].viewport });
  // Catches empty-panel collapse and a list growing the map row instead of scrolling internally.
  test("1194 dark: equal-height empty panel and 60-row internal scroll", async ({ page, context, baseURL }, info) => {
    await review(page, info, 5, () => prepareCustomer(page, context, baseURL!, 60), async phase => {
      const map = page.locator(control.map), identity = await rememberMapIdentity(map);
      try {
        const listPanel = page.locator('[data-manual-selection-panel]'), operation = page.locator('[data-operation-map-panel]');
        const empty = { mapPanel: await operation.boundingBox(), selection: await listPanel.boundingBox() };
        expect(empty.mapPanel).not.toBeNull(); expect(empty.selection).not.toBeNull();
        expect(Math.abs(empty.mapPanel!.height - empty.selection!.height)).toBeLessThanOrEqual(1);
        await expect(page.getByRole("button", { name: "더보기", exact: true })).toBeHidden();
        const inlineDisclosure = listPanel.locator(':scope > div:first-child > button[aria-controls]');
        await expect(inlineDisclosure).toHaveCount(1);
        await expect(inlineDisclosure).toBeHidden();
        await phase("empty-full-row", empty);
        await selectFloor(page, false);
        const list = listPanel.locator(':scope > div:last-child'), heading = page.getByRole("heading", { name: "선택 조명 60개", exact: true }), before = await heading.boundingBox();
        const end = await internalEnd(page, list);
        await actualCenter(list.getByText("UX 조명 60", { exact: true }));
        expect(await heading.boundingBox()).toEqual(before);
        await identity.assertUnchanged();
        await phase("pc-list-end", { end, empty, populated: { mapPanel: await operation.boundingBox(), selection: await listPanel.boundingBox() }, recoveryBrowser: "Not run; final control consumer unit cohort covers original UUID/recovery" });
        await expectNoHorizontalOverflow(page);
      } finally { await identity.dispose(); }
    });
  });
});

