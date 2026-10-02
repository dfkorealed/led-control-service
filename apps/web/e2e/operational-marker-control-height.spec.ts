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
    const box = (await target.boundingBox())!;
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const hit = await target.evaluate((node, point) => {
      const hit = document.elementFromPoint(point.x, point.y);
      return Boolean(hit && (hit === node || node.contains(hit)));
    }, point);
    if (hit) return point;
    // Move the real pointer over the appropriate scrollport and use native
    // wheel input. No forceclick, scripted scrollTop, clocks or CSS zoom.
    // The map consumes wheels for its own camera. Use the page gutter, outside
    // that inner scrollport, when reaching document-flow controls on mobile.
    const size = page.viewportSize()!;
    await page.mouse.move(size.width - 8, Math.min(Math.max(point.y, 110), size.height - 90));
    const header = await page.locator("main > header").boundingBox();
    const nav = page.getByRole("navigation", { name: "모바일 주 메뉴", exact: true });
    const navigation = await nav.count() ? await nav.boundingBox() : null;
    const top = header ? Math.max(0, header.y + header.height) + 12 : 130;
    const bottom = navigation ? navigation.y - 12 : size.height - 12;
    const desiredY = Math.max(top, Math.min(point.y, bottom));
    await page.mouse.wheel(0, Math.max(-180, Math.min(180, point.y - desiredY)));
    await paints(page);
  }
  throw new Error(`Control is not reachable with bounded native scrolling: ${await target.getAttribute("aria-label")}`);
}

for (const hasTouch of [false, true]) test.describe(`Operational ${hasTouch ? "touch-capable" : "ordinary"} pointer`, () => {
  test.use({ hasTouch });
  for (const surface of ["monitoring", "control"] as const) test(`${surface} dense five true centers preserve exact IDs, anchors and disabled keyboard behavior`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const state = await installOperationalMapFixture(page);
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
  test(`Control actual map and controls stay usable at ${size.width}x${size.height}`, async ({ page }, info) => {
    await page.setViewportSize(size);
    const state = await installOperationalMapFixture(page);
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
    const point = await nativeReach(page, page.getByRole("button", { name: "지도 확대", exact: true }));
    await page.mouse.click(point.x, point.y); await expect(viewport).toHaveAttribute("data-zoom", "1.1");
    const input = page.getByRole("textbox", { name: "밝기 수치" });
    await nativeReach(page, input); await input.fill("42"); await input.press("Enter");
    const apply = page.getByRole("button", { name: "밝기 적용", exact: true });
    await nativeReach(page, apply); await expect(apply).toBeDisabled();
    const opener = page.getByRole("button", { name: "명령 이력 열기", exact: true });
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
  await page.mouse.click(point.x, point.y); await paints(page);
}

test.describe("Software touch delivery", () => {
  test.use({ hasTouch: true });
  for (const surface of ["monitoring", "control"] as const) test(`${surface} real browser taps resolve dense centers and 48px padding without hover`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const state = await installOperationalMapFixture(page);
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

  test("control moved/cancelled and two-finger browser touches never synthesize a selection", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const state = await installOperationalMapFixture(page);
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

test("control selected neighbours, live zoom/pan and additive area retain exact target semantics", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await installOperationalMapFixture(page);
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
  await clickCenter(page, 0);
  expect(await selected(page)).toEqual(rows.slice(1, 4).map(row => row.id));
  expect(state.equipmentPosts).toEqual([]); expect(state.api.dimmingRequests).toEqual([]);
});


test.describe("Software touch hold", () => {
  test.use({ hasTouch: true });
  test("control native blank-touch hold selects an area after 400ms and pre-hold cancel stays inert", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const state = await installOperationalMapFixture(page);
    await page.goto(`/control?siteId=${operationalIds.siteId}`);
    await expect(marker(page, 0)).toBeVisible();
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
