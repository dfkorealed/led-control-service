import { test, expect, type Page, type Locator, type TestInfo } from "../../../apps/web/node_modules/@playwright/test";
import { writeFile } from "node:fs/promises";
import {
  ids, reviewCases, prepareCustomer, setReviewTheme, readGeometry, savePhase,
  rememberMapIdentity, actualCenter, nativeSwipe, expectNoHorizontalOverflow,
  expectMinimumTouchTargets, type GeometryContract
} from "./page-session-ux-support";

// Six representative real-renderer cases, not a full matrix. API fixtures are
// read-only and no command is acknowledged or sent to real equipment.
const mon: GeometryContract = {
  map: '[data-testid="monitoring-map-viewport"]',
  regions: { toolbar: '[role="group"][aria-label="모니터링 도구"]', mapPanel: '[data-operation-map-panel]', footer: '[data-floor-map-footer]', detail: 'aside[aria-label="조명 상세"]', detailBody: '[data-monitoring-detail-scroll]', nav: '[data-shell-navigation="compact"]' },
  occluders: ['aside[aria-label="조명 상세"]', '[data-monitoring-pin-popover]', '[data-shell-navigation="compact"]']
};
const control: GeometryContract = {
  map: '[data-testid="target-selection-map-viewport"]',
  regions: { toolbar: '[data-target-selection-toolbar]', execution: '[data-control-execution-row]', selection: '[data-manual-selection-panel]', list: '[data-manual-selection-panel] > div:last-child', more: '[data-control-more-content]', important: '[aria-label="제어 중요 상태"]', mapPanel: '[data-operation-map-panel]', footer: '[data-floor-map-footer]', nav: '[data-shell-navigation="compact"]' },
  occluders: ['[data-shell-navigation="compact"]']
};
// Accessible-name prefix is stable across brightness/status changes.
const firstMarker = (page: Page) => page.locator('[data-spatial-map-marker="true"][aria-label^="UX 조명 01"]');
const mapCamera = (map: Locator) => map.evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop, zoom: element.getAttribute("data-zoom") }));
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

async function finite(page: Page) {
  await expectNoHorizontalOverflow(page);
  const document = await page.evaluate(() => ({ y: scrollY, height: document.scrollingElement!.scrollHeight, client: document.scrollingElement!.clientHeight }));
  expect(document.y, "manual mobile document scroll must remain zero").toBe(0);
  expect(document.height, "manual mobile uses finite shell, not outer scrolling").toBeLessThanOrEqual(document.client + 1);
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
async function internalEnd(page: Page, root: Locator) {
  const center = await actualCenter(root);
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
    const close = page.getByRole("button", { name: "조명 상세 닫기", exact: true }), headerBefore = await close.boundingBox();
    await expectMinimumTouchTargets(page, 'aside[aria-label="조명 상세"]');
    const body = page.locator('[data-monitoring-detail-scroll]');
    const end = await internalEnd(page, body);
    expect(await mapCamera(map)).toEqual(before.map.camera);
    expect(await close.boundingBox()).toEqual(headerBefore);
    await phase("detail-end", { end, half });
    await close.click();
    await expect(aside).toHaveCount(0);
    await expect(opener).toBeFocused();
    await identity.assertUnchanged();
    expect(await mapCamera(map)).toEqual(before.map.camera);
    // The original pin remains selected; its nonmodal popover is visible again.
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
  // Catches outer-page overflow, broken 44px rows and accidental invalid-draft submission.
  test("320x600 light: two rows, invalid first Apply and More", async ({ page, context, baseURL }, info) => {
    await review(page, info, 2, () => prepareCustomer(page, context, baseURL!, 3), async phase => {
      await finite(page);
      await row(page, [page.getByRole("button", { name: /표시 층/ }), page.getByRole("button", { name: /선택 범위/ }), page.getByRole("button", { name: "조명 목록", exact: true })]);
      const input = page.getByRole("textbox", { name: "밝기 수치" }), more = page.getByRole("button", { name: "더보기", exact: true });
      await row(page, [input, page.locator('[data-slider-thumb]'), page.locator('[data-control-submit]'), more]);
      const mapGoal = (await readGeometry(page, control)).map;
      await firstMarker(page).click();
      for (const endpoint of ["0", "100"]) {
        await input.fill(endpoint);
        await settle(page);
        await phase(`slider-endpoint-${endpoint}`);
        await expectMinimumTouchTargets(page, '[data-control-execution-row]');
      }
      await expectMinimumTouchTargets(page, '[data-target-selection-toolbar]');
      await expectMinimumTouchTargets(page, '[data-floor-map-footer]');
      await expectMinimumTouchTargets(page, '[data-manual-selection-panel]');
      await input.fill("31"); await expect(input).toHaveValue("31");
      await page.getByRole("button", { name: "전체 보기", exact: true }).click();
      await more.click(); await expect(input).toHaveValue("31");
      const end = await internalEnd(page, page.locator('[data-control-more-content]'));
      await phase("more-end", { end, mapGoal240: { actual: mapGoal.bounds.height, met: mapGoal.bounds.height >= 240 } });
      await finite(page);
      await page.locator('[data-control-more-content]').getByRole("button", { name: "확인 필요한 명령", exact: true }).press("Escape");
      await expect(more).toBeFocused();
      await expect(input).toHaveValue("31");
      await expect(page.getByRole("status", { name: "제어 중요 상태", exact: true })).toBeVisible();
      await input.fill("101");
      await expect(page.getByRole("alert").filter({ hasText: "0~100 사이 정수를 입력해 주세요." })).toBeVisible();
      // Native pointer at disabled Apply still exercises capture/blur without force-click.
      const applyPoint = await actualCenter(page.locator('[data-control-submit]'));
      await page.mouse.click(applyPoint.x, applyPoint.y); await settle(page);
      await expect(input).toHaveValue("31");
      await phase("invalid-first-apply");
      await finite(page);
    });
  });
});

test.describe("04 native touch and long inline selection", () => {
  test.use({ viewport: reviewCases[3].viewport, hasTouch: true });
  // Catches ghost selection on a marker-origin touch pan and an unreachable long list.
  test("390x600 dark: swipe then tap, 60 fixtures and internal ending", async ({ page, context, baseURL }, info) => {
    await review(page, info, 3, () => prepareCustomer(page, context, baseURL!, 60), async phase => {
      const map = page.locator(control.map), identity = await rememberMapIdentity(map);
      try {
        for (let step = 0; step < 8; step++) await page.getByRole("button", { name: "지도 확대", exact: true }).click();
        const markers = map.locator('[data-spatial-map-marker="true"]');
        const index = await markers.evaluateAll(elements => elements.findIndex(element => {
          const r = element.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
          return x > 40 && y > 100 && x < innerWidth - 40 && y < innerHeight - 140 && element.contains(document.elementFromPoint(x, y));
        }));
        expect(index, "touch origin must be a genuinely exposed marker").toBeGreaterThanOrEqual(0);
        const candidate = markers.nth(index);
        const before = await mapCamera(map);
        await nativeSwipe(context, page, candidate, { x: -25, y: -20 }); await settle(page);
        await expect(page.getByRole("heading", { name: "선택 조명 0개", exact: true })).toBeVisible();
        const after = await mapCamera(map);
        expect(after.x !== before.x || after.y !== before.y).toBe(true);
        await candidate.tap();
        await expect(page.getByRole("heading", { name: "선택 조명 1개", exact: true })).toBeVisible();
        await phase("native-touch", { before, after });
        await selectFloor(page, true);
        const opener = page.getByRole("button", { name: "전체 보기", exact: true });
        await opener.click();
        const listId = await page.getByRole("button", { name: "접기", exact: true }).getAttribute("aria-controls");
        const list = page.locator(`[id="${listId}"]`);
        const heading = page.getByRole("heading", { name: "선택 조명 60개", exact: true }), headingBefore = await heading.boundingBox();
        const end = await internalEnd(page, list);
        await actualCenter(list.getByText("UX 조명 60", { exact: true }));
        expect(await heading.boundingBox()).toEqual(headingBefore);
        await finite(page);
        await expectMinimumTouchTargets(page, '[data-manual-selection-panel] > div:first-child');
        await identity.assertUnchanged();
        await phase("inline-list-end", { end });
        await list.getByText("UX 조명 60", { exact: true }).press("Escape");
        await expect(page.getByRole("button", { name: "전체 보기", exact: true })).toBeFocused();
        await finite(page);
      } finally { await identity.dispose(); }
    });
  });
});

test.describe("05 resize without remount/reset", () => {
  test.use({ viewport: reviewCases[4].viewport });
  // Catches presentation toggles and breakpoint changes resetting renderer or raw draft.
  test("717x1227 to 390x844 light: inline/More, focus and raw31", async ({ page, context, baseURL }, info) => {
    await review(page, info, 4, () => prepareCustomer(page, context, baseURL!, 3), async phase => {
      const map = page.locator(control.map), identity = await rememberMapIdentity(map);
      try {
        await firstMarker(page).click();
        const input = page.getByRole("textbox", { name: "밝기 수치" });
        await input.fill("31");
        const before = await mapCamera(map);
        await page.getByRole("button", { name: "전체 보기", exact: true }).click();
        await page.getByRole("button", { name: "더보기", exact: true }).click();
        await identity.assertUnchanged(); expect(await mapCamera(map)).toEqual(before);
        await expect(input).toHaveValue("31"); await finite(page);
        await phase("both-expanded");
        await page.getByRole("button", { name: "접기", exact: true }).click();
        await page.getByRole("button", { name: "더보기", exact: true }).click();
        await input.focus();
        await page.setViewportSize(reviewCases[4].resize); await settle(page);
        await expect(input).toHaveValue("31"); await expect(input).toBeFocused();
        await identity.assertUnchanged(); await finite(page);
        const geometry = await readGeometry(page, control);
        await phase("resized-focused", { before, after: geometry.map.camera, mapGoal240: { actual: geometry.map.bounds.height, met: geometry.map.bounds.height >= 240 }, limitation: "Viewport resize only; no OS software keyboard" });
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
