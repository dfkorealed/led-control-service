import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { energyReportListResponseSchema } from "@led-control/shared/energy-p2-contracts";
import { mockDashboard } from "../src/test/fixtures";
import { installSettingsApiRoutes } from "./support/settings-api";
import { installMockApiBoundary } from "./support/mock-api-boundary";
import { browserReport, installFirstScreenStatisticsFixtures } from "./support/first-screen-statistics";
import { expectNoHorizontalOverflow, expectMinimumTouchTargets } from "./support/layout-assertions";

const siteId = mockDashboard.site.id, floorId = mockDashboard.floors[0].id, gatewayId = mockDashboard.gateways[0].id;
const fixtures = mockDashboard.floors[0].fixtures.slice(0, 3);
const siteName = "물류센터 B2 현장";
const marker = (page: Page, index = 0) => page.locator(`[data-spatial-map-marker="true"][aria-label^="${fixtures[index].name}"]`);

test.beforeEach(async ({ context, baseURL }) => {
  expect(process.env.E2E_REAL_BACKEND_LAB).not.toBe("1");
  expect(new URL(baseURL!).port).toBe("15187");
  await installMockApiBoundary(context, baseURL);
});

async function customer(page: Page, statistics = false, dark = false) {
  const writes: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method())) writes.push(`${request.method()} ${request.url()}`);
  });
  await page.addInitScript(value => localStorage.setItem("led-control.customer-theme.v1", value), dark ? "dark" : "light");
  await installSettingsApiRoutes(page, "admin", { ids: { siteId, floorId, gatewayId }, fixtures, readyMapDocument: true });
  if (statistics) await installFirstScreenStatisticsFixtures(page);
  // mockDashboard is a UI seed, not a complete current API envelope. Preserve
  // the explicit capabilities contract supplied by the controlled API helper.
  const dashboard = { ...structuredClone(mockDashboard), capabilities: { read: true, control: true, manage: true, commission: true } };
  dashboard.site.name = siteName;
  dashboard.floors = [{ ...dashboard.floors[0], fixtures, mapRevision: 7, mapConfigured: true }];
  dashboard.groups = [];
  dashboard.summary = { ...dashboard.summary, totalFixtures: 3, onlineFixtures: 3, faultFixtures: 0 };
  await page.route("**/api/sites/*/dashboard**", route => route.fulfill({ json: dashboard }));
  await page.route("**/api/sites", route => route.fulfill({ json: [{ id: siteId, name: siteName, customerName: "표시하지 않을 고객사" }] }));
  return writes;
}

async function evidence(page: Page, info: TestInfo, name: string, metrics: unknown) {
  const png = info.outputPath(`${name}.png`), json = info.outputPath(`${name}.json`);
  await page.screenshot({ path: png });
  await writeFile(json, JSON.stringify({ source: process.env.E2E_EVIDENCE_SOURCE ?? "437ebc39", viewport: page.viewportSize(), url: page.url(), metrics }, null, 2));
  await info.attach(name, { path: png, contentType: "image/png" });
  await info.attach(`${name}-metrics`, { path: json, contentType: "application/json" });
}
async function camera(map: Locator) { return map.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop, zoom: el.getAttribute("data-zoom") })); }
async function touchGeometry(page: Page) {
  return page.evaluate(name => {
    const rect = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right };
    };
    const map = document.querySelector('[data-testid="target-selection-map-viewport"]');
    const marker = document.querySelector(`[data-spatial-map-marker="true"][aria-label^="${name}"]`);
    const r = marker?.getBoundingClientRect();
    const hit = r ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
    return { scrollY, document: { height: document.scrollingElement?.scrollHeight, clientHeight: document.scrollingElement?.clientHeight },
      map: rect(map), topbar: rect(document.querySelector("[data-shell-topbar]")), nav: rect(document.querySelector('[data-shell-navigation="compact"]')),
      marker: rect(marker), camera: map && { x: map.scrollLeft, y: map.scrollTop, zoom: map.getAttribute("data-zoom") },
      hit: hit && { tag: hit.tagName, label: hit.getAttribute("aria-label"), closestButton: hit.closest("button")?.getAttribute("aria-label"), isMarker: !!marker?.contains(hit) } };
  }, fixtures[0].name);
}
async function blank(map: Locator) {
  return map.evaluate(el => {
    const r = el.getBoundingClientRect();
    for (const x of [.35, .55, .75]) for (const y of [.35, .55, .75]) {
      const p = { x: r.x + r.width * x, y: r.y + r.height * y };
      const hit = document.elementFromPoint(p.x, p.y);
      if (hit?.closest("[data-floor-map-surface]") && !hit.closest("button")) return p;
    }
    throw new Error("No reachable map blank point");
  });
}
async function mapReady(page: Page, manual = true) {
  const map = page.getByTestId(manual ? "target-selection-map-viewport" : "monitoring-map-viewport");
  await expect(map.locator("canvas").first()).toBeVisible();
  await expect(marker(page)).toBeVisible();
  return map;
}
async function hit(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  const bounds = await target.boundingBox(); expect(bounds).not.toBeNull();
  expect(await target.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
  expect(bounds!.y).toBeGreaterThanOrEqual(0); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  return bounds;
}
async function scrollTo(page: Page, target: Locator) {
  // Real wheel in the control/body hotzone, not the canvas gesture surface.
  for (let i = 0; i < 8; i++) {
    const visible = await target.evaluate(el => { const r = el.getBoundingClientRect(); const nav = document.querySelector('[data-shell-navigation="compact"]')?.getBoundingClientRect(); return r.y >= 0 && r.bottom <= (nav?.top ?? innerHeight) + 1; });
    if (visible) break;
    await page.mouse.move(8, 300); await page.mouse.wheel(0, 500);
  }
  const bounds = await hit(page, target);
  const nav = await page.locator('[data-shell-navigation="compact"]').boundingBox();
  expect(nav).not.toBeNull(); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(nav!.y + 1);
  return bounds;
}
async function statsReady(page: Page) {
  await expect(page.getByRole("group", { name: "에너지 요약", exact: true })).toContainText("4.25");
  await expect(page.getByRole("img", { name: "일별 상태 기반 추정 전력 사용량 꺾은선 차트", exact: true }).locator("svg")).toBeVisible();
  await expect(page.getByText("사용량 추이를 불러오는 중", { exact: true })).toHaveCount(0);
}

test("interactions 1 PC manual native CAD gestures preserve selection and raw draft", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 }); const writes = await customer(page);
  await page.goto(`/control?siteId=${siteId}`); const map = await mapReady(page);
  await expect(page.getByRole("button", { name: "조명 목록", exact: true })).toBeVisible();
  for (const name of ["이동", "개별 선택", "영역 선택", "구역 관리"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  await marker(page).click(); await expect(marker(page)).toHaveAttribute("aria-pressed", "true");
  await marker(page).click(); await expect(marker(page)).toHaveAttribute("aria-pressed", "false");
  await marker(page).click();
  const draft = page.getByRole("textbox", { name: "밝기 수치" }); await draft.fill("31");
  let p = await blank(map); await map.focus(); await page.mouse.move(p.x, p.y); await page.mouse.down();
  await page.mouse.move(p.x + 7, p.y); await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
  await page.mouse.move(p.x + 8, p.y); await expect(page.getByTestId("map-area-selection")).toBeVisible();
  await page.keyboard.press("Escape"); await page.mouse.up(); await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
  const pin = (await marker(page, 1).boundingBox())!;
  await page.mouse.move(pin.x - 6, pin.y - 6); await page.mouse.down(); await page.mouse.move(pin.x + pin.width + 6, pin.y + pin.height + 6, { steps: 6 }); await page.mouse.up();
  await expect(marker(page, 1)).toHaveAttribute("aria-pressed", "true");
  const beforeZoom = await camera(map); p = await blank(map); await page.mouse.move(p.x, p.y); await page.mouse.wheel(0, -120);
  await expect.poll(() => map.getAttribute("data-zoom")).not.toBe(beforeZoom.zoom);
  for (let i = 0; i < 12; i++) await page.getByRole("button", { name: "지도 확대", exact: true }).click();
  for (const kind of ["middle", "Space"] as const) {
    p = await blank(map); await map.focus(); const before = await camera(map); await page.mouse.move(p.x, p.y);
    if (kind === "Space") await page.keyboard.down("Space");
    await page.mouse.down({ button: kind === "middle" ? "middle" : "left" }); await page.mouse.move(p.x - 40, p.y - 40, { steps: 4 });
    await expect(page.getByTestId("map-area-selection")).toHaveCount(0); await page.mouse.up({ button: kind === "middle" ? "middle" : "left" });
    if (kind === "Space") await page.keyboard.up("Space"); await expect.poll(() => camera(map)).not.toEqual(before);
  }
  await expect(draft).toHaveValue("31"); expect(writes).toEqual([]); await expectNoHorizontalOverflow(page);
  await evidence(page, info, "manual-pc", { camera: await camera(map), map: await map.boundingBox() });
});

test("interactions 2 native touch manual pans without hold-area and short dark actions remain reachable", async ({ browser, baseURL }, info) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 600 }, hasTouch: true, isMobile: true });
  await installMockApiBoundary(context, baseURL); const page = await context.newPage();
  const geometry: Array<{ phase: string; metrics: Awaited<ReturnType<typeof touchGeometry>> }> = [];
  let phase = "initial";
  try {
    const writes = await customer(page, false, true); await page.goto(`/control?siteId=${siteId}`); const map = await mapReady(page);
    await marker(page).tap(); await expect(marker(page)).toHaveAttribute("aria-pressed", "true");
    for (let i = 0; i < 8; i++) await page.getByRole("button", { name: "지도 확대", exact: true }).tap();
    phase = "body-scroll-before-marker"; geometry.push({ phase, metrics: await touchGeometry(page) });
    // Zoom's native scroll-into-view moves the document independently of the
    // map camera. Camera pan cannot repair sticky-header occlusion: use a real
    // body wheel in the gutter, then measure the restored map before any swipe.
    await page.mouse.move(8, 300); await page.mouse.wheel(0, -1200);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect.poll(async () => { const m = await touchGeometry(page); return m.map!.y - m.topbar!.bottom; }).toBeGreaterThanOrEqual(4);
    phase = "body-restored"; geometry.push({ phase, metrics: await touchGeometry(page) });
    const cdp = await context.newCDPSession(page);
    const point = (x: number, y: number, id = 1) => ({ x, y, id, radiusX: 2, radiusY: 2, force: 1 });
    const swipe = async (origin: { x: number; y: number }, dx: number, dy: number) => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(origin.x, origin.y)] });
      for (let i = 1; i <= 8; i++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(origin.x + dx * i / 8, origin.y + dy * i / 8)] });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    // Zoom may move the original marker outside the visible camera. Bring it
    // back with bounded real swipes, never by mutating scrollTop/camera/CSS.
    for (let i = 0; i < 24; i++) {
      const r = (await marker(page).boundingBox())!;
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const reachable = await marker(page).evaluate(el => {
        const r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
        return el.contains(document.elementFromPoint(x, y)) && !!document.elementFromPoint(x - 32, y - 32)?.closest("[data-floor-map-surface]");
      });
      if (reachable) break;
      // The geometrical map center can be behind the sticky shell after a
      // zoom control's native scroll-into-view. Use a genuinely reachable hit.
      const hotzone = await blank(map);
      const dx = Math.max(-50, Math.min(50, hotzone.x - x));
      const dy = Math.max(-50, Math.min(50, hotzone.y - y));
      await swipe(hotzone, dx, dy);
    }
    phase = "marker-hit-before-native-swipe"; geometry.push({ phase, metrics: await touchGeometry(page) });
    const markerBounds = (await hit(page, marker(page)))!, markerBefore = await camera(map);
    const selectionBefore = await map.locator("[data-spatial-map-marker]").evaluateAll(els => els.map(el => ({ name: el.getAttribute("aria-label"), selected: el.getAttribute("aria-pressed") })));
    phase = "marker-origin-native-swipe";
    await swipe({ x: markerBounds.x + markerBounds.width / 2, y: markerBounds.y + markerBounds.height / 2 }, -32, -32);
    await expect.poll(() => camera(map)).not.toEqual(markerBefore);
    expect(await map.locator("[data-spatial-map-marker]").evaluateAll(els => els.map(el => ({ name: el.getAttribute("aria-label"), selected: el.getAttribute("aria-pressed") })))).toEqual(selectionBefore);
    await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
    await marker(page).tap(); await expect(marker(page)).toHaveAttribute("aria-pressed", "false");
    await marker(page).tap(); await expect(marker(page)).toHaveAttribute("aria-pressed", "true");
    geometry.push({ phase: "marker-swipe-and-tap-complete", metrics: await touchGeometry(page) });
    await evidence(page, info, "manual-marker-origin-touch", { markerBounds, before: markerBefore, after: await camera(map), selectionBefore, geometry });
    const p = await blank(map), before = await camera(map);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(p.x, p.y)] });
    // A real held touch exceeds the former long-press window; manual CAD must never create an area.
    await page.waitForTimeout(600); await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
    for (let i = 1; i <= 8; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(p.x - i * 5, p.y - i * 5)] }); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => camera(map)).not.toEqual(before); await expect(marker(page)).toHaveAttribute("aria-pressed", "true");
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(p.x, p.y)] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(p.x, p.y), point(p.x + 40, p.y, 2)] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] }); await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
    const draft = page.getByRole("textbox", { name: "밝기 수치" }); await draft.fill("31");
    const clear = page.getByRole("button", { name: "선택 해제", exact: true }); const clearBounds = await scrollTo(page, clear);
    await expectMinimumTouchTargets(page, "[data-target-selection-detail-panel] button");
    await clear.tap(); await expect(draft).toHaveValue("31"); expect(writes).toEqual([]); await expectNoHorizontalOverflow(page);
    await evidence(page, info, "manual-touch-dark-short", { camera: await camera(map), clearBounds, nav: await page.locator('[data-shell-navigation="compact"]').boundingBox(), geometry });
  } catch (error) {
    geometry.push({ phase: `failure:${phase}`, metrics: await touchGeometry(page) });
    await evidence(page, info, "manual-touch-original-failure", { error: String(error), phase, geometry });
    throw error;
  } finally { await context.close(); }
});

test("interactions 3 monitoring merged finder searches numbers filters and keeps five legends", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 }); const writes = await customer(page); await page.goto(`/monitoring?siteId=${siteId}`);
  const map = await mapReady(page, false); const opener = page.getByRole("button", { name: "조명 검색/목록", exact: true }); await expect(opener).toHaveCount(1);
  for (const label of ["정상", "장애", "오프라인", "상태 확인 대기", "조명 정보 확인 전"]) await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  await expect(page.locator("[data-shell-topbar]")).toContainText(siteName); await expect(page.locator("[data-shell-topbar]")).not.toContainText("표시하지 않을 고객사");
  await opener.click(); const finder = page.getByRole("region", { name: "조명 검색 및 목록", exact: true });
  await finder.getByRole("searchbox", { name: "조명 이름 또는 번호 검색" }).fill("02"); await expect(finder.getByRole("list", { name: "조명 목록" }).getByRole("button")).toHaveCount(1);
  await finder.getByRole("button", { name: /B2-L02/ }).click(); await expect(finder).toHaveCount(0); await expect(marker(page, 1)).toHaveAttribute("aria-current", "true");
  await opener.click(); await finder.getByRole("searchbox").fill(""); await finder.getByRole("button", { name: /상태 필터/ }).click(); await page.getByRole("option", { name: "오프라인", exact: true }).click();
  await expect(finder.getByText("오프라인 조명이 없습니다.", { exact: true })).toBeVisible(); await finder.getByRole("button", { name: "전체 조명 보기", exact: true }).click();
  await expect(finder.getByRole("list", { name: "조명 목록" }).getByRole("button")).toHaveCount(3);
  await page.keyboard.press("Escape"); await expect(opener).toBeFocused(); expect(writes).toEqual([]); await expectNoHorizontalOverflow(page);
  await evidence(page, info, "monitoring-finder-legend", { map: await map.boundingBox(), camera: await camera(map), opener: await hit(page, opener) });
});

test("interactions 4 mobile sheet nested calendar focus dates stay one line at 390 and 320", async ({ page }, info) => {
  const writes = await customer(page, true); await page.setViewportSize({ width: 390, height: 600 }); await page.goto(`/statistics?siteId=${siteId}`); await statsReady(page);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 600 }); const opener = page.getByRole("button", { name: /^절감 비교 기간 상세 필터/ }); await opener.click();
    const sheet = page.getByRole("dialog", { name: "절감 비교 기간", exact: true }); await expect(sheet).toBeVisible();
    await expect.poll(async () => { const r = (await sheet.boundingBox())!; return Math.abs(r.y + r.height - 600); }).toBeLessThanOrEqual(1);
    const group = sheet.getByRole("group", { name: "완료 기간 시작일과 종료일", exact: true });
    const segments = group.getByRole("spinbutton"); await expect(segments).toHaveCount(6);
    await segments.first().click(); await page.keyboard.press("ArrowRight");
    expect(await group.evaluate(el => el.contains(document.activeElement))).toBe(true);
    const rects = await segments.evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, height: r.height }; }));
    expect(Math.max(...rects.map(r => r.y)) - Math.min(...rects.map(r => r.y))).toBeLessThanOrEqual(1);
    for (let i = 1; i < rects.length; i++) expect(rects[i].x).toBeGreaterThanOrEqual(rects[i - 1].right);
    const calendar = group.getByRole("button"); await expectMinimumTouchTargets(page, `[id="${await group.getAttribute("id")}"] button`);
    await calendar.click(); await expect(page.getByRole("grid")).toBeVisible(); await page.keyboard.press("Escape"); await expect(calendar).toBeFocused(); await expect(sheet).toBeVisible();
    const close = sheet.getByRole("button", { name: "필터 닫기", exact: true }); await close.scrollIntoViewIfNeeded(); const closeBounds = await hit(page, close);
    await evidence(page, info, `filter-sheet-${width}`, { sheet: await sheet.boundingBox(), dates: rects, group: await group.boundingBox(), closeBounds });
    await close.click(); await expect(opener).toBeFocused(); await expectNoHorizontalOverflow(page);
  }
  expect(writes).toEqual([]);
});

test("interactions 5 dark reports 577 summary expands below stable row and preserves actions", async ({ page }, info) => {
  await page.setViewportSize({ width: 577, height: 900 }); const writes = await customer(page, true, true);
  const request = { from: "2026-09-01", to: "2026-09-07", scope: "site" as const, identityId: siteId, format: "pdf" as const };
  const complete = { ...browserReport("completed", request), siteId, target: { scope: "site" as const, identityId: siteId, label: "완료 현장" } };
  const failed = { ...browserReport("failed", request), reportId: "30000000-0000-4000-8000-000000000042", siteId, target: { scope: "site" as const, identityId: siteId, label: "실패 현장" } };
  const response = energyReportListResponseSchema.parse({ reports: [complete, failed], nextCursor: null, totalCount: 2 });
  await page.route("**/energy/sites/*/reports*", route => route.fulfill({ json: response }));
  await page.goto(`/statistics/reports?siteId=${siteId}`); const jobs = page.getByRole("region", { name: "요청한 보고서", exact: true }); await expect(jobs).toContainText("완료 현장"); await expect(jobs).not.toHaveAttribute("aria-busy", "true");
  const toggle = jobs.getByRole("button", { name: "완료 현장 보고서 상세보기", exact: true }); await expect(toggle).toHaveAttribute("aria-expanded", "false");
  // Sort menu options remain in the DOM; the compact card's actual dt fields
  // must omit these details, rather than pretending all matching DOM text vanishes.
  await expect(jobs.locator("dt").filter({ hasText: /^요청 시각$/ })).toHaveCount(0); await expect(jobs.locator("dt").filter({ hasText: /^파일 만료 시각$/ })).toHaveCount(0);
  await expect(jobs.getByRole("button", { name: "완료 현장 보고서 다운로드", exact: true })).toBeEnabled(); await expect(jobs.getByRole("button", { name: "실패 현장 보고서 다시 생성", exact: true })).toBeEnabled();
  await toggle.click(); const detail = jobs.getByRole("region", { name: "완료 현장 보고서 상세보기", exact: true }); await expect(detail).toContainText("요청 시각"); await expect(detail).toContainText("파일 만료 시각");
  const detailId = await toggle.getAttribute("aria-controls");
  await jobs.getByRole("button", { name: /정렬 기준/ }).click(); await page.getByRole("option", { name: "대상", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-controls", detailId!); await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const toggleBounds = (await toggle.boundingBox())!, detailBounds = (await detail.boundingBox())!; expect(detailBounds.y).toBeGreaterThanOrEqual(toggleBounds.y + toggleBounds.height);
  await expect(jobs.locator('time[datetime="2026-09-01"]')).toHaveCount(2); await expectNoHorizontalOverflow(page);
  await evidence(page, info, "reports-dark-577-details", { toggleBounds, detailBounds, download: await jobs.getByRole("button", { name: "완료 현장 보고서 다운로드", exact: true }).boundingBox() });
  await toggle.click(); await expect(detail).toHaveCount(0); expect(writes).toEqual([]);
});

test("interactions 6 overview title chart ticks and unchanged C8 content at PC and mobile", async ({ page }, info) => {
  const writes = await customer(page, true); await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(`/statistics?siteId=${siteId}`); await statsReady(page);
  await expect(page.getByRole("heading", { name: "사용량 개요", exact: true })).toHaveClass(/sr-only/);
  const card = page.getByRole("region", { name: "운영 인사이트", exact: true });
  for (const text of ["43,200초", "2,073,600초", "20,000,000초", "7,200초", "10개", "현장 시간대 Asia/Seoul · 조명 상태 기록 기준 · 실측 전력 아님"]) await expect(card).toContainText(text);
  const original = await card.textContent();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 }); await statsReady(page); await expect(card).toHaveText(original!);
    const chart = page.getByRole("img", { name: "일별 상태 기반 추정 전력 사용량 꺾은선 차트", exact: true }); await chart.scrollIntoViewIfNeeded();
    await expect(chart.locator(".recharts-cartesian-axis-tick-value").first()).toBeVisible();
    const ticks = await chart.locator(".recharts-cartesian-axis-tick-value").evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { text: el.textContent, x: r.x, y: r.y, right: r.right, bottom: r.bottom }; })); expect(ticks.length).toBeGreaterThan(2);
    const bounds = (await chart.boundingBox())!;
    for (const tick of ticks) { expect(tick.x).toBeGreaterThanOrEqual(bounds.x); expect(tick.right).toBeLessThanOrEqual(bounds.x + bounds.width); }
    for (let a = 0; a < ticks.length; a++) for (let b = a + 1; b < ticks.length; b++) expect(ticks[a].right <= ticks[b].x || ticks[b].right <= ticks[a].x || ticks[a].bottom <= ticks[b].y || ticks[b].bottom <= ticks[a].y).toBe(true);
    await expectNoHorizontalOverflow(page); await evidence(page, info, `overview-${width}`, { chart: bounds, ticks, C8: original });
  }
  expect(writes).toEqual([]);
});
