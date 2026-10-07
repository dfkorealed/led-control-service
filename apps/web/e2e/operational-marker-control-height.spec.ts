import { expect, test, type Locator, type Page } from "@playwright/test";
import { installOperationalMapFixture, operationalDenseFixtures, operationalIds } from "./support/operational-map-fixture";

const rows = operationalDenseFixtures();
const marker = (page: Page, index: number) => page.locator(`[data-spatial-map-marker="true"][aria-label^="${rows[index].name} "]`);
const paints = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
async function selected(page: Page) {
  const ids = [];
  for (const [index, row] of rows.entries()) if (await marker(page, index).getAttribute("data-selected") === "true") ids.push(row.id);
  return ids;
}
async function nativeReach(page: Page, target: Locator) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const measured = await target.evaluate(node => {
      const telemetry = window as Window & { controlReachWheels?: { trusted: boolean; x: number; y: number; deltaY: number; bodyY: number | undefined; documentY: number }[] };
      if (!telemetry.controlReachWheels) {
        telemetry.controlReachWheels = [];
        window.addEventListener("wheel", event => {
          telemetry.controlReachWheels!.push({ trusted: event.isTrusted, x: event.clientX, y: event.clientY, deltaY: event.deltaY,
            bodyY: document.querySelector<HTMLElement>("[data-control-panel-body]")?.scrollTop, documentY: scrollY });
        }, { capture: true, passive: true });
      }
      const box = node.getBoundingClientRect();
      const header = document.querySelector("main > header")?.getBoundingClientRect();
      const nav = document.querySelector('[data-shell-navigation="compact"]')?.getBoundingClientRect();
      const viewport = { left: 0, top: header?.bottom ?? 0, right: innerWidth, bottom: nav?.top ?? innerHeight };
      const clip = { ...viewport };
      let scroll: { point: { x: number; y: number }; delta: number; before: number; label: string } | undefined;
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
        const inner = { left: bounds.left + parseFloat(style.borderLeftWidth), top: bounds.top + parseFloat(style.borderTopWidth),
          right: bounds.right - parseFloat(style.borderRightWidth), bottom: bounds.bottom - parseFloat(style.borderBottomWidth) };
        if (["auto", "scroll", "hidden", "clip"].includes(style.overflowX)) {
          clip.left = Math.max(clip.left, inner.left); clip.right = Math.min(clip.right, inner.right);
        }
        if (["auto", "scroll", "hidden", "clip"].includes(style.overflowY)) {
          clip.top = Math.max(clip.top, inner.top); clip.bottom = Math.min(clip.bottom, inner.bottom);
        }
        // Window visibility alone misses a button clipped by its own auto-Y
        // ancestor. Wheel that actual owner, never the map or a scripted scroll.
        const delta = box.bottom > inner.bottom ? Math.ceil(box.bottom - inner.bottom)
          : box.top < inner.top ? Math.floor(box.top - inner.top) : 0;
        if (!scroll && ["auto", "scroll"].includes(style.overflowY) && delta &&
          (delta > 0 ? parent.scrollTop + parent.clientHeight < parent.scrollHeight : parent.scrollTop > 0)) {
          const left = Math.max(viewport.left, inner.left), right = Math.min(viewport.right, inner.right);
          const top = Math.max(viewport.top, inner.top), bottom = Math.min(viewport.bottom, inner.bottom);
          const point = { x: (left + right) / 2, y: (top + bottom) / 2 };
          const hit = document.elementFromPoint(point.x, point.y);
          if (right > left && bottom > top && hit && parent.contains(hit)) {
            scroll = { point, delta, before: parent.scrollTop, label: parent.getAttribute("data-control-panel-body") !== null ? "execution-body" : parent.tagName };
          }
        }
      }
      const visibleWidth = Math.max(0, Math.min(box.right, clip.right) - Math.max(box.left, clip.left));
      const visibleHeight = Math.max(0, Math.min(box.bottom, clip.bottom) - Math.max(box.top, clip.top));
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const hit = document.elementFromPoint(point.x, point.y);
      return { point, box: box.toJSON(), clip, visibleWidth, visibleHeight, hit: Boolean(hit && (hit === node || node.contains(hit))), scroll,
        documentY: scrollY, bodyY: document.querySelector<HTMLElement>("[data-control-panel-body]")?.scrollTop,
        wheels: [...telemetry.controlReachWheels], disabled: node instanceof HTMLButtonElement ? node.disabled : false };
    });
    // A center hit alone accepted a 43.5px clipped Apply in R68. Require a full
    // real 44px region without rounding the measured intersection upward.
    if (measured.hit && measured.visibleWidth >= 44 && measured.visibleHeight >= 44) {
      await test.info().attach(`native-reach-${await target.getAttribute("aria-label") ?? "apply"}`, { body: JSON.stringify(measured), contentType: "application/json" });
      return measured.point;
    }
    const size = page.viewportSize()!;
    const delta = measured.scroll?.delta ?? (measured.box.bottom > measured.clip.bottom
      ? Math.ceil(measured.box.bottom - measured.clip.bottom) : Math.floor(measured.box.top - measured.clip.top));
    const wheelPoint = measured.scroll?.point ?? { x: size.width - 8, y: Math.min(Math.max(measured.point.y, measured.clip.top + 12), measured.clip.bottom - 12) };
    await test.info().attach(`native-reach-attempt-${attempt}`, { body: JSON.stringify({ measured, wheelPoint, delta }), contentType: "application/json" });
    await page.mouse.move(wheelPoint.x, wheelPoint.y);
    await page.mouse.wheel(0, Math.max(-180, Math.min(180, delta)));
    await paints(page);
  }
  throw new Error(`Control is not reachable with bounded native scrolling: ${await target.getAttribute("aria-label")}`);
}

// Prepare short desktop's real scroll owner from map chrome, never from the
// canvas (whose native wheel intentionally zooms). nativeReach stays unchanged.
async function scrollManualChromeToEnd(page: Page, direction: "end" | "start" = "end") {
  const workspace = page.locator("[data-control-layout]");
  const viewport = page.getByTestId("target-selection-map-viewport");
  const camera = await viewport.getAttribute("data-zoom");
  const chrome = page.getByRole("button", { name: "이동", exact: true });
  await chrome.click();
  const wheelChrome = page.getByRole("button", { name: "구역 관리", exact: true });
  await wheelChrome.hover();
  await paints(page);
  const afterHoverCamera = await viewport.getAttribute("data-zoom");
  const hit = await wheelChrome.evaluate(element => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    const ancestors = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      ancestors.push({ className: parent.className, overflowY: style.overflowY, overscrollY: style.overscrollBehaviorY, height: parent.clientHeight, content: parent.scrollHeight });
    }
    (window as Window & { task7ChromeTrustedWheel?: number }).task7ChromeTrustedWheel = 0;
    (window as Window & { task7ChromeEvents?: unknown[] }).task7ChromeEvents = [];
    window.addEventListener("wheel", event => {
      if (event.isTrusted) (window as Window & { task7ChromeTrustedWheel: number }).task7ChromeTrustedWheel += 1;
      (window as Window & { task7ChromeEvents: unknown[] }).task7ChromeEvents.push({ trusted: event.isTrusted, x: event.clientX, y: event.clientY, target: (event.target as Element)?.outerHTML.slice(0, 200), zoom: document.querySelector<HTMLElement>("[data-testid=target-selection-map-viewport]")?.dataset.zoom });
    }, { capture: true, passive: true });
    const canvas = document.querySelector<HTMLElement>("[data-testid=target-selection-map-viewport]")!.getBoundingClientRect();
    return { box: box.toJSON(), canvas: canvas.toJSON(), nativeHit: hit === element || element.contains(hit), ancestors };
  });
  expect(hit.nativeHit).toBe(true);
  expect(hit.box.x + hit.box.width / 2).toBeGreaterThan(hit.canvas.right);
  const before = await workspace.evaluate(element => element.scrollTop);
  await page.mouse.wheel(0, direction === "end" ? 10_000 : -10_000);
  await expect.poll(() => workspace.evaluate((element, end) => element.scrollTop - (end ? element.scrollHeight - element.clientHeight : 0), direction === "end")).toBe(0);
  await paints(page);
  const after = await workspace.evaluate(element => element.scrollTop);
  expect(hit.box.x + hit.box.width / 2).toBeGreaterThan((await viewport.boundingBox())!.x + (await viewport.boundingBox())!.width);
  console.log("Task7 native chrome scroll", JSON.stringify({ hit, before, after, camera, afterHoverCamera, afterCamera: await viewport.getAttribute("data-zoom"), events: await page.evaluate(() => (window as Window & { task7ChromeEvents: unknown[] }).task7ChromeEvents) }));
  await test.info().attach("manual-chrome-native-wheel", { body: JSON.stringify({ hit, before, after, camera, afterCamera: await viewport.getAttribute("data-zoom"), trusted: await page.evaluate(() => (window as Window & { task7ChromeTrustedWheel: number }).task7ChromeTrustedWheel) }), contentType: "application/json" });
  if (direction === "end") await expect.poll(() => workspace.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await viewport.getAttribute("data-zoom")).toBe(camera);
  expect(await page.evaluate(() => (window as Window & { task7ChromeTrustedWheel: number }).task7ChromeTrustedWheel)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
}

for (const hasTouch of [false, true]) test.describe(`Operational ${hasTouch ? "touch-capable" : "ordinary"} pointer`, () => {
  test.use({ hasTouch });
  for (const surface of ["monitoring", "control"] as const) test(`${surface} dense five true centers preserve exact IDs, anchors and disabled keyboard behavior`, async ({ page, baseURL }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const state = await installOperationalMapFixture(page, baseURL);
    await page.goto(`/${surface}?siteId=${operationalIds.siteId}`);
    await expect(marker(page, 0)).toBeVisible();
    const observations = [];
    for (let index = 0; index < 5; index++) {
      if (surface === "control" && (await selected(page)).length) await page.getByRole("button", { name: "선택 비우기", exact: true }).click();
      const pin = marker(page, index);
      const box = (await pin.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(48); expect(box.height).toBeGreaterThanOrEqual(48);
      const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await page.mouse.move(center.x, center.y); await paints(page);
      const hit = await pin.evaluate((node, point) => ({
        hitsSelf: document.elementFromPoint(point.x, point.y)?.closest("[data-spatial-map-marker]") === node,
        label: document.elementFromPoint(point.x, point.y)?.closest("[data-spatial-map-marker]")?.getAttribute("aria-label")
      }), center);
      await page.mouse.click(center.x, center.y); await paints(page);
      const observed = await selected(page);
      const expected = surface === "control" && index === 4 ? [] : [rows[index].id];
      observations.push({ id: rows[index].id, box, center, hit, observed, expected });
      expect.soft(observed).toEqual(expected);
      expect.soft(hit.hitsSelf).toBe(true);
      if (surface === "monitoring") {
        const popover = page.getByRole("dialog", { name: `${rows[index].name} 조명 정보`, exact: true });
        await expect(popover).toBeVisible();
        const bounds = (await popover.boundingBox())!;
        expect.soft(Math.abs(bounds.x + bounds.width / 2 - center.x)).toBeLessThanOrEqual(2);
        await page.keyboard.press("Escape");
        await expect(popover).not.toBeVisible();
        await expect.soft(pin).toBeFocused();
      } else if (index !== 4) await expect.soft(pin).toBeFocused();
    }
    await info.attach("dense-center-delivery", { body: JSON.stringify({ hasTouch, surface, rows, observations }), contentType: "application/json" });
    if (surface === "control" && (await selected(page)).length) await page.getByRole("button", { name: "선택 비우기", exact: true }).click();
    for (let index = 0; index < 5; index++) {
      const pin = marker(page, index);
      if (surface === "control" && index === 4) {
        await expect(pin).toBeDisabled(); await expect(pin).toHaveAttribute("data-disabled-reason", "조명 장애를 먼저 점검해야 합니다.");
        await marker(page, 3).focus(); await page.keyboard.press("Tab"); await expect(pin).not.toBeFocused();
        expect(await selected(page)).toEqual([]); continue;
      }
      await pin.focus(); await page.keyboard.press("Enter");
      await expect.poll(() => selected(page)).toEqual([rows[index].id]);
      if (surface === "monitoring") {
        const popover = page.getByRole("dialog", { name: `${rows[index].name} 조명 정보`, exact: true });
        await expect(popover).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(popover).not.toBeVisible();
        await expect(pin).toBeFocused();
        await paints(page);
      } else { await page.keyboard.press("Space"); await expect.poll(() => selected(page)).toEqual([]); }
    }
    expect(state.equipmentPosts).toEqual([]); expect(state.api.dimmingRequests).toEqual([]);
  });
});

for (const size of [{ width: 1024, height: 480 }, { width: 390, height: 320 }, { width: 1440, height: 900 }]) {
  test(`Control actual map and controls stay usable at ${size.width}x${size.height}`, async ({ page, baseURL }, info) => {
    await page.setViewportSize(size);
    const state = await installOperationalMapFixture(page, baseURL);
    await page.goto(`/control?siteId=${operationalIds.siteId}`);
    const viewport = page.getByTestId("target-selection-map-viewport");
    await expect(viewport).toBeVisible();
    const box = (await viewport.boundingBox())!;
    const legend = page.getByLabel("지도 조명 상태 범례", { exact: true });
    const zoom = page.getByRole("group", { name: "지도 확대 축소", exact: true });
    const legendBounds = (await legend.boundingBox())!;
    const zoomBounds = (await zoom.boundingBox())!;
    expect.soft(legendBounds.y).toBeGreaterThanOrEqual(zoomBounds.y + zoomBounds.height);
    const legendClipping = await legend.evaluate(node => {
      const bounds = node.getBoundingClientRect();
      const clipping: string[] = [];
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const rect = parent.getBoundingClientRect();
        if (["hidden", "clip"].includes(getComputedStyle(parent).overflowY) &&
            (bounds.top < rect.top - 2 || bounds.bottom > rect.bottom + 2)) clipping.push(parent.className);
      }
      return clipping;
    });
    expect.soft(legendClipping).toEqual([]);
    await info.attach("actual-map-bounds", { body: JSON.stringify({ size, box, legendBounds, zoomBounds, legendClipping }), contentType: "application/json" });
    expect.soft(box.height).toBeGreaterThanOrEqual(240);
    await info.attach("control-initial-full-page", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    if (size.width >= 760 && size.height < 600) await scrollManualChromeToEnd(page);
    const point = await nativeReach(page, page.getByRole("button", { name: "지도 확대", exact: true }));
    await page.mouse.click(point.x, point.y); await expect(viewport).toHaveAttribute("data-zoom", "1.1");
    const input = page.getByRole("textbox", { name: "밝기 수치" });
    if (size.width >= 760 && size.height < 600) await scrollManualChromeToEnd(page, "start");
    await nativeReach(page, input); await input.fill("42"); await input.press("Enter");
    const apply = page.getByRole("button", { name: "밝기 적용", exact: true });
    if (size.width >= 760 && size.height < 600) await scrollManualChromeToEnd(page);
    await nativeReach(page, apply); await expect(apply).toBeDisabled();
    const opener = page.getByRole("button", { name: "전체 보기", exact: true });
    const historyPoint = await nativeReach(page, opener); await page.mouse.click(historyPoint.x, historyPoint.y);
    await expect(page.getByRole("dialog", { name: "명령 이력", exact: true })).toBeVisible();
    await page.keyboard.press("Escape"); await expect(opener).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    expect(state.equipmentPosts).toEqual([]); expect(state.api.dimmingRequests).toEqual([]);
  });
}

async function markerPoint(page: Page, index: number, dx = 0, dy = 0) {
  const box = (await marker(page, index).boundingBox())!;
  return { x: box.x + box.width / 2 + dx, y: box.y + box.height / 2 + dy };
}
async function clickCenter(page: Page, index: number) {
  const point = await markerPoint(page, index);
  await page.mouse.move(point.x, point.y); await paints(page);
  // Zoom anchoring may move the marker during the existing hover/paint phase.
  // Activate this marker's current center, not a pre-paint screen coordinate.
  const currentPoint = await markerPoint(page, index);
  await page.mouse.click(currentPoint.x, currentPoint.y); await paints(page);
}

test.describe("Software touch delivery", () => {
  test.use({ hasTouch: true });
  for (const surface of ["monitoring", "control"] as const) test(`${surface} real browser taps resolve dense centers and 48px padding without hover`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const state = await installOperationalMapFixture(page, baseURL);
    await page.goto(`/${surface}?siteId=${operationalIds.siteId}`);
    await expect(marker(page, 0)).toBeVisible();
    for (let index = 0; index < 5; index++) {
      if (surface === "control" && (await selected(page)).length) await page.getByRole("button", { name: "선택 비우기", exact: true }).click();
      const point = await markerPoint(page, index);
      await page.touchscreen.tap(point.x, point.y);
      await expect.poll(() => selected(page)).toEqual(surface === "control" && index === 4 ? [] : [rows[index].id]);
      if (surface === "monitoring") {
        const popover = page.getByRole("dialog", { name: `${rows[index].name} 조명 정보`, exact: true });
        await expect(popover).toBeVisible(); await page.keyboard.press("Escape");
        await expect(marker(page, index)).toBeFocused(); await paints(page);
      }
    }
    if (surface === "control" && (await selected(page)).length) await page.getByRole("button", { name: "선택 비우기", exact: true }).click();
    // Twenty-two pixels is outside the 20px dot but inside its 48px button.
    const padding = await markerPoint(page, 2, 22);
    await page.touchscreen.tap(padding.x, padding.y);
    await expect.poll(() => selected(page)).toEqual([rows[2].id]);
    expect(state.equipmentPosts).toEqual([]); expect(state.api.dimmingRequests).toEqual([]);
  });

  test("control moved/cancelled and two-finger browser touches never synthesize a selection", async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const state = await installOperationalMapFixture(page, baseURL);
    await page.goto(`/control?siteId=${operationalIds.siteId}`);
    await expect(marker(page, 0)).toBeVisible();
    const client = await page.context().newCDPSession(page);
    const point = await markerPoint(page, 0);
    const touch = async (type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", points: Array<{ x: number; y: number; id: number }>) => {
      await client.send("Input.dispatchTouchEvent", { type, touchPoints: points }); await paints(page);
    };
    await touch("touchStart", [{ ...point, id: 1 }]);
    await touch("touchMove", [{ x: point.x + 8, y: point.y, id: 1 }]);
    await touch("touchEnd", []); expect(await selected(page)).toEqual([]);
    for (const cancellation of ["touchCancel", "blur", "Escape", "lostpointercapture"] as const) {
      await touch("touchStart", [{ ...point, id: 1 }]);
      if (cancellation === "touchCancel") await touch("touchCancel", []);
      else {
        if (cancellation === "Escape") await page.keyboard.press("Escape");
        else await page.evaluate(type => window.dispatchEvent(new Event(type)), cancellation);
        await touch("touchEnd", []);
      }
      expect(await selected(page)).toEqual([]);
    }
    const viewport = page.getByTestId("target-selection-map-viewport");
    const initialZoom = Number(await viewport.getAttribute("data-zoom"));
    await touch("touchStart", [{ ...point, id: 1 }]);
    await touch("touchStart", [{ ...point, id: 1 }, { x: point.x - 80, y: point.y, id: 2 }]);
    await touch("touchMove", [{ x: point.x + 40, y: point.y, id: 1 }, { x: point.x - 120, y: point.y, id: 2 }]);
    await touch("touchEnd", []);
    expect(Number(await viewport.getAttribute("data-zoom"))).toBeGreaterThan(initialZoom);
    expect(await selected(page)).toEqual([]);
    await client.detach();
    expect(state.equipmentPosts).toEqual([]); expect(state.api.dimmingRequests).toEqual([]);
  });
});

test("control selected neighbours, live zoom/pan and additive area retain exact target semantics", async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await installOperationalMapFixture(page, baseURL);
  await page.goto(`/control?siteId=${operationalIds.siteId}`);
  await expect(marker(page, 0)).toBeVisible();
  for (const index of [1, 2, 3, 0]) await clickCenter(page, index);
  expect(await selected(page)).toEqual(rows.slice(0, 4).map(row => row.id));
  await clickCenter(page, 0); await clickCenter(page, 4);
  expect(await selected(page)).toEqual(rows.slice(1, 4).map(row => row.id));
  await page.getByRole("button", { name: "지도 확대", exact: true }).click();
  await clickCenter(page, 0); expect(await selected(page)).toEqual(rows.slice(0, 4).map(row => row.id));
  await page.getByRole("button", { name: "선택 비우기", exact: true }).click();
  await clickCenter(page, 0);
  const point = await markerPoint(page, 0);
  await page.getByRole("button", { name: "영역 선택", exact: true }).click();
  await page.mouse.move(point.x - 40, point.y - 40); await page.mouse.down();
  await page.mouse.move(point.x + 40, point.y + 40);
  await expect(page.getByTestId("map-area-selection")).toBeVisible();
  await page.mouse.up();
  expect(await selected(page)).toEqual(rows.slice(0, 4).map(row => row.id));
  for (let step = 0; step < 9; step++) await page.getByRole("button", { name: "지도 확대", exact: true }).click();
  const viewport = page.getByTestId("target-selection-map-viewport");
  const box = (await viewport.boundingBox())!;
  for (const input of ["Space", "middle"] as const) {
    const before = await viewport.evaluate(node => ({ x: node.scrollLeft, y: node.scrollTop }));
    await page.mouse.move(box.x + 30, box.y + 30);
    if (input === "Space") { await viewport.focus(); await page.keyboard.down("Space"); }
    await page.mouse.down({ button: input === "middle" ? "middle" : "left" });
    await page.mouse.move(box.x + 70, box.y + 70);
    await expect(page.getByTestId("map-area-selection")).not.toBeVisible();
    await page.mouse.up({ button: input === "middle" ? "middle" : "left" });
    if (input === "Space") await page.keyboard.up("Space");
    const after = await viewport.evaluate(node => ({ x: node.scrollLeft, y: node.scrollTop }));
    expect(after).not.toEqual(before);
    expect(await selected(page)).toEqual(rows.slice(0, 4).map(row => row.id));
  }
  // Re-measure after the camera moved. A stale map coordinate cache would miss.
  await page.getByRole("button", { name: "개별 선택", exact: true }).click();
  await clickCenter(page, 0);
  expect(await selected(page)).toEqual(rows.slice(1, 4).map(row => row.id));
  expect(state.equipmentPosts).toEqual([]); expect(state.api.dimmingRequests).toEqual([]);
});


test.describe("Software touch hold", () => {
  test.use({ hasTouch: true });
  test("control native blank-touch hold selects an area after 400ms and pre-hold cancel stays inert", async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const state = await installOperationalMapFixture(page, baseURL);
    await page.goto(`/control?siteId=${operationalIds.siteId}`);
    await expect(marker(page, 0)).toBeVisible();
    await page.getByRole("button", { name: "영역 선택", exact: true }).click();
    const point = await markerPoint(page, 0);
    const client = await page.context().newCDPSession(page);
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x - 40, y: point.y - 40, id: 1 }] });
    // Real elapsed time exercises the existing 400ms timer; no clock mocking.
    await page.waitForTimeout(200);
    await expect(page.getByTestId("map-area-selection")).not.toBeVisible();
    await page.waitForTimeout(230);
    await expect(page.getByTestId("map-area-selection")).toBeVisible();
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x + 40, y: point.y + 40, id: 1 }] });
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => selected(page)).toEqual(rows.slice(0, 4).map(row => row.id));
    await page.getByRole("button", { name: "선택 비우기", exact: true }).click();
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x - 40, y: point.y - 40, id: 1 }] });
    await page.waitForTimeout(120);
    await client.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await page.waitForTimeout(320);
    await expect(page.getByTestId("map-area-selection")).not.toBeVisible();
    expect(await selected(page)).toEqual([]);
    await client.detach();
    expect(state.equipmentPosts).toEqual([]); expect(state.api.dimmingRequests).toEqual([]);
  });
});


async function controlGeometry(page: Page) {
  return page.locator("[data-control-screen]").evaluate(root => {
    const map = document.querySelector<HTMLElement>("[data-testid=target-selection-map-viewport]")!;
    const scene = map.querySelector<HTMLElement>("[data-floor-scene]")!;
    const shell = root.closest<HTMLElement>("[data-shell-content]")!;
    const rect = (node: Element) => { const { x, y, width, height, bottom } = node.getBoundingClientRect(); return { x, y, width, height, bottom }; };
    const viewport = rect(map), surface = rect(scene);
    return { root: rect(root), viewport, surface, availableBottom: innerHeight - parseFloat(getComputedStyle(shell).paddingBottom),
      zoom: map.dataset.zoom, centerXRatio: (viewport.x + viewport.width / 2 - surface.x) / surface.width,
      centerYRatio: (viewport.y + viewport.height / 2 - surface.y) / surface.height };
  });
}

for (const theme of ["light", "dark"] as const) for (const size of [
  { width: 1440, height: 900 }, { width: 1024, height: 600 }, { width: 390, height: 844 }
]) test(`Task7 ${theme} manual real remaining height and immediate controls at ${size.width}x${size.height}`, async ({ page, baseURL }, info) => {
  await page.setViewportSize(size);
  await page.addInitScript(value => localStorage.setItem("led-control.customer-theme.v1", value), theme);
  const state = await installOperationalMapFixture(page, baseURL);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`/control?siteId=${operationalIds.siteId}`);
  const viewport = page.getByTestId("target-selection-map-viewport");
  await expect(viewport).toBeVisible(); await paints(page);
  await expect(page.locator("html")).toHaveAttribute("data-customer-theme", theme);
  await expect(page.getByRole("button", { name: "개별 선택", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /밝기 실행 설정|선택 도구 열기/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "최근 결과", exact: true })).toHaveCount(0);
  const measured = await page.evaluate(() => {
    const map = document.querySelector<HTMLElement>('[data-control-target-card] [data-operation-map-panel]')!;
    const aside = document.querySelector<HTMLElement>('[data-control-panel]')!;
    const history = document.querySelector<HTMLElement>('[data-command-history-panel]')!;
    const card = document.querySelector<HTMLElement>('[data-control-target-card]')!;
    const canvas = document.querySelector<HTMLElement>('[data-testid="target-selection-map-viewport"]')!;
    const status = map.querySelector<HTMLElement>('[aria-label$="도면 조명 상태"]')!;
    return { map: map.getBoundingClientRect().toJSON(), aside: aside.getBoundingClientRect().toJSON(), canvas: canvas.getBoundingClientRect().toJSON(),
      history: history.getBoundingClientRect().toJSON(), card: card.getBoundingClientRect().toJSON(),
      presets: [...document.querySelectorAll<HTMLElement>('[aria-label="빠른 밝기 값"] button')].map(node => {
        const range = document.createRange(); range.selectNodeContents(node);
        return { text: node.textContent, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
          textLines: new Set([...range.getClientRects()].map(rect => rect.top)).size };
      }),
      pageOverflowY: document.documentElement.scrollHeight - innerHeight, pageOverflowX: document.documentElement.scrollWidth - innerWidth,
      labels: [...status.querySelectorAll('span > span')].map(node => getComputedStyle(node).fontSize),
      values: [...status.querySelectorAll('strong')].map(node => getComputedStyle(node).fontSize),
      scrollOwners: [...document.querySelectorAll<HTMLElement>('[data-shell-content],[data-control-layout],[data-control-safety-scroll]')].map(node => ({ className: node.className, overflow: getComputedStyle(node).overflowY, height: node.clientHeight, content: node.scrollHeight })) };
  });
  console.log(`Task7 actual geometry ${theme} ${size.width}x${size.height}: ${JSON.stringify(measured)}`);
  await info.attach(`Task7-${theme}-${size.width}-geometry`, { body: JSON.stringify(measured), contentType: "application/json" });
  const nativePath = info.outputPath(`Task7-${theme}-${size.width}-native.png`);
  await page.screenshot({ path: nativePath, fullPage: true });
  await info.attach(`Task7-${theme}-${size.width}-native`, { path: nativePath, contentType: "image/png" });
  expect(measured.pageOverflowX).toBe(0); expect(measured.canvas.height).toBeGreaterThanOrEqual(240);
  expect(measured.history.height).toBeGreaterThanOrEqual(44);
  expect(measured.card.width).toBeGreaterThan(0); expect(measured.card.height).toBeGreaterThan(0);
  for (const preset of measured.presets) { expect(preset.textLines).toBe(1); expect(preset.width).toBeGreaterThanOrEqual(44); expect(preset.height).toBeGreaterThanOrEqual(44); }
  expect(measured.labels).toEqual(["14px", "14px", "14px", "14px"]); expect(measured.values).toEqual(["16px", "16px", "16px", "16px"]);
  if (size.width >= 760) {
    expect(measured.pageOverflowY).toBe(0);
    expect(Math.abs(measured.map.y - measured.aside.y)).toBeLessThanOrEqual(2);
    if (size.height >= 900) expect(measured.history.bottom).toBeLessThanOrEqual(size.height);
  } else expect(measured.pageOverflowY).toBeGreaterThan(0);
  const input = page.getByRole("textbox", { name: "밝기 수치" });
  const inputPoint = await nativeReach(page, input); await page.mouse.click(inputPoint.x, inputPoint.y);
  await input.fill("30"); await input.press("Enter");
  await expect(page.getByRole("slider", { name: "밝기" })).toHaveValue("30");
  for (const value of [0, 30, 70, 100]) await expect(page.getByRole("button", { name: `${value}%`, exact: true })).toBeVisible();
  const opener = page.getByRole("region", { name: "최근 명령 이력", exact: true }).getByRole("button", { name: "전체 보기", exact: true });
  if (size.width >= 760 && size.height < 900) await scrollManualChromeToEnd(page);
  const historyPoint = await nativeReach(page, opener); await page.mouse.click(historyPoint.x, historyPoint.y);
  await expect(page.getByRole("dialog", { name: "명령 이력", exact: true })).toBeVisible();
  await page.keyboard.press("Escape"); await expect(opener).toBeFocused();
  expect(errors).toEqual([]); expect(state.equipmentPosts).toEqual([]); expect(state.api.dimmingRequests).toEqual([]);
});

test("Control sufficient desktop height grows the actual map and preserves a live camera on resize", async ({ page, baseURL }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await installOperationalMapFixture(page, baseURL);
  await page.goto(`/control?siteId=${operationalIds.siteId}`);
  await expect(marker(page, 0)).toBeVisible(); await paints(page);
  const initial = await controlGeometry(page);
  await info.attach("desktop-900-initial", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await page.setViewportSize({ width: 1440, height: 1100 }); await paints(page);
  const taller = await controlGeometry(page);
  await info.attach("desktop-1100-initial", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  expect.soft(Math.abs(initial.availableBottom - initial.root.bottom)).toBeLessThanOrEqual(2);
  expect.soft(Math.abs(taller.availableBottom - taller.root.bottom)).toBeLessThanOrEqual(2);
  expect.soft(taller.viewport.height - initial.viewport.height).toBeGreaterThanOrEqual(198);
  expect.soft(taller.surface.height).toBeGreaterThan(initial.surface.height);
  await clickCenter(page, 0);
  const zoom = page.getByRole("button", { name: "지도 확대", exact: true });
  await zoom.click(); await paints(page);
  const beforeResize = await controlGeometry(page);
  await page.setViewportSize({ width: 1440, height: 900 }); await paints(page);
  const afterResize = await controlGeometry(page);
  expect(afterResize.zoom).toBe("1.1"); expect(await selected(page)).toEqual([rows[0].id]);
  expect.soft(afterResize.centerXRatio).toBeCloseTo(beforeResize.centerXRatio, 2);
  expect.soft(afterResize.centerYRatio).toBeCloseTo(beforeResize.centerYRatio, 2);
  await expect(zoom).toBeFocused();
  await info.attach("sufficient-height-geometry", { body: JSON.stringify({ initial, taller, beforeResize, afterResize }), contentType: "application/json" });
  expect(state.equipmentPosts).toEqual([]); expect(state.api.dimmingRequests).toEqual([]);
});

test("Operational fixture accepts its configured origin and fails closed for external and unknown routes", async ({ page, baseURL }, info) => {
  expect(baseURL).toBeTruthy();
  const failed: Array<{ url: string; resourceType: string; error: string | undefined }> = [];
  page.on("requestfailed", request => failed.push({ url: request.url(), resourceType: request.resourceType(), error: request.failure()?.errorText }));
  await expect(installOperationalMapFixture(page, undefined)).rejects.toThrow("configured baseURL");
  const state = await installOperationalMapFixture(page, baseURL);
  await page.goto(`/control?siteId=${operationalIds.siteId}`);
  await expect(marker(page, 0)).toBeVisible();
  const result = await page.evaluate(async () => ({
    origin: location.origin,
    unknown: (await fetch("/api/task9-followup-unknown")).status,
    externalBlocked: await fetch("https://task9-external.invalid/probe").then(() => false, () => true),
    externalApiBlocked: await fetch("https://task9-external.invalid/api/commands").then(() => false, () => true)
  }));
  await info.attach("configured-origin-proof", { body: JSON.stringify({ baseURL, result, failed }), contentType: "application/json" });
  expect(result.origin).toBe(new URL(baseURL!).origin);
  expect(result.unknown).toBe(404); expect(result.externalBlocked).toBe(true); expect(result.externalApiBlocked).toBe(true);
  // React Query may cancel duplicate dev/StrictMode API reads with ERR_ABORTED.
  // Document/static delivery and allowlist aborts are the origin contract here;
  // retain all failures in evidence without treating a cancelled API read as it.
  expect(failed.filter(item => new URL(item.url).origin === result.origin &&
    (["document", "script", "stylesheet", "image"].includes(item.resourceType) || item.error?.startsWith("net::ERR_BLOCKED_BY_CLIENT")))).toEqual([]);
  await expect.poll(() => failed.filter(item => item.url.startsWith("https://task9-external.invalid/")).map(item => item.error)).toEqual([expect.stringMatching(/^net::ERR_BLOCKED_BY_CLIENT(?:\.Inspector)?$/), expect.stringMatching(/^net::ERR_BLOCKED_BY_CLIENT(?:\.Inspector)?$/)]);
  expect(state.equipmentPosts).toEqual([]); expect(state.api.dimmingRequests).toEqual([]);
});
