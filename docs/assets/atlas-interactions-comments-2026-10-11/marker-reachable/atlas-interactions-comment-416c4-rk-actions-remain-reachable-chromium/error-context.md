# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: atlas-interactions-comments.spec.ts >> interactions 2 native touch manual pans without hold-area and short dark actions remain reachable
- Location: e2e/atlas-interactions-comments.spec.ts:121:1

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Test source

```ts
  1   | import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
  2   | import { writeFile } from "node:fs/promises";
  3   | import { energyReportListResponseSchema } from "@led-control/shared/energy-p2-contracts";
  4   | import { mockDashboard } from "../src/test/fixtures";
  5   | import { installSettingsApiRoutes } from "./support/settings-api";
  6   | import { installMockApiBoundary } from "./support/mock-api-boundary";
  7   | import { browserReport, installFirstScreenStatisticsFixtures } from "./support/first-screen-statistics";
  8   | import { expectNoHorizontalOverflow, expectMinimumTouchTargets } from "./support/layout-assertions";
  9   | 
  10  | const siteId = mockDashboard.site.id, floorId = mockDashboard.floors[0].id, gatewayId = mockDashboard.gateways[0].id;
  11  | const fixtures = mockDashboard.floors[0].fixtures.slice(0, 3);
  12  | const siteName = "물류센터 B2 현장";
  13  | const marker = (page: Page, index = 0) => page.locator(`[data-spatial-map-marker="true"][aria-label^="${fixtures[index].name}"]`);
  14  | 
  15  | test.beforeEach(async ({ context, baseURL }) => {
  16  |   expect(process.env.E2E_REAL_BACKEND_LAB).not.toBe("1");
  17  |   expect(new URL(baseURL!).port).toBe("15187");
  18  |   await installMockApiBoundary(context, baseURL);
  19  | });
  20  | 
  21  | async function customer(page: Page, statistics = false, dark = false) {
  22  |   const writes: string[] = [];
  23  |   page.on("request", request => {
  24  |     if (new URL(request.url()).pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method())) writes.push(`${request.method()} ${request.url()}`);
  25  |   });
  26  |   await page.addInitScript(value => localStorage.setItem("led-control.customer-theme.v1", value), dark ? "dark" : "light");
  27  |   await installSettingsApiRoutes(page, "admin", { ids: { siteId, floorId, gatewayId }, fixtures, readyMapDocument: true });
  28  |   if (statistics) await installFirstScreenStatisticsFixtures(page);
  29  |   // mockDashboard is a UI seed, not a complete current API envelope. Preserve
  30  |   // the explicit capabilities contract supplied by the controlled API helper.
  31  |   const dashboard = { ...structuredClone(mockDashboard), capabilities: { read: true, control: true, manage: true, commission: true } };
  32  |   dashboard.site.name = siteName;
  33  |   dashboard.floors = [{ ...dashboard.floors[0], fixtures, mapRevision: 7, mapConfigured: true }];
  34  |   dashboard.groups = [];
  35  |   dashboard.summary = { ...dashboard.summary, totalFixtures: 3, onlineFixtures: 3, faultFixtures: 0 };
  36  |   await page.route("**/api/sites/*/dashboard**", route => route.fulfill({ json: dashboard }));
  37  |   await page.route("**/api/sites", route => route.fulfill({ json: [{ id: siteId, name: siteName, customerName: "표시하지 않을 고객사" }] }));
  38  |   return writes;
  39  | }
  40  | 
  41  | async function evidence(page: Page, info: TestInfo, name: string, metrics: unknown) {
  42  |   const png = info.outputPath(`${name}.png`), json = info.outputPath(`${name}.json`);
  43  |   await page.screenshot({ path: png });
  44  |   await writeFile(json, JSON.stringify({ source: "437ebc39", viewport: page.viewportSize(), url: page.url(), metrics }, null, 2));
  45  |   await info.attach(name, { path: png, contentType: "image/png" });
  46  |   await info.attach(`${name}-metrics`, { path: json, contentType: "application/json" });
  47  | }
  48  | async function camera(map: Locator) { return map.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop, zoom: el.getAttribute("data-zoom") })); }
  49  | async function blank(map: Locator) {
  50  |   return map.evaluate(el => {
  51  |     const r = el.getBoundingClientRect();
  52  |     for (const x of [.35, .55, .75]) for (const y of [.35, .55, .75]) {
  53  |       const p = { x: r.x + r.width * x, y: r.y + r.height * y };
  54  |       const hit = document.elementFromPoint(p.x, p.y);
  55  |       if (hit?.closest("[data-floor-map-surface]") && !hit.closest("button")) return p;
  56  |     }
  57  |     throw new Error("No reachable map blank point");
  58  |   });
  59  | }
  60  | async function mapReady(page: Page, manual = true) {
  61  |   const map = page.getByTestId(manual ? "target-selection-map-viewport" : "monitoring-map-viewport");
  62  |   await expect(map.locator("canvas").first()).toBeVisible();
  63  |   await expect(marker(page)).toBeVisible();
  64  |   return map;
  65  | }
  66  | async function hit(page: Page, target: Locator) {
  67  |   await expect(target).toBeVisible();
  68  |   const bounds = await target.boundingBox(); expect(bounds).not.toBeNull();
> 69  |   expect(await target.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
      |                                                                                                                                                                        ^ Error: expect(received).toBe(expected) // Object.is equality
  70  |   expect(bounds!.y).toBeGreaterThanOrEqual(0); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  71  |   return bounds;
  72  | }
  73  | async function scrollTo(page: Page, target: Locator) {
  74  |   // Real wheel in the control/body hotzone, not the canvas gesture surface.
  75  |   for (let i = 0; i < 8; i++) {
  76  |     const visible = await target.evaluate(el => { const r = el.getBoundingClientRect(); const nav = document.querySelector('[data-shell-navigation="compact"]')?.getBoundingClientRect(); return r.y >= 0 && r.bottom <= (nav?.top ?? innerHeight) + 1; });
  77  |     if (visible) break;
  78  |     await page.mouse.move(8, 300); await page.mouse.wheel(0, 500);
  79  |   }
  80  |   const bounds = await hit(page, target);
  81  |   const nav = await page.locator('[data-shell-navigation="compact"]').boundingBox();
  82  |   expect(nav).not.toBeNull(); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(nav!.y + 1);
  83  |   return bounds;
  84  | }
  85  | async function statsReady(page: Page) {
  86  |   await expect(page.getByRole("group", { name: "에너지 요약", exact: true })).toContainText("4.25");
  87  |   await expect(page.getByRole("img", { name: "일별 상태 기반 추정 전력 사용량 꺾은선 차트", exact: true }).locator("svg")).toBeVisible();
  88  |   await expect(page.getByText("사용량 추이를 불러오는 중", { exact: true })).toHaveCount(0);
  89  | }
  90  | 
  91  | test("interactions 1 PC manual native CAD gestures preserve selection and raw draft", async ({ page }, info) => {
  92  |   await page.setViewportSize({ width: 1440, height: 900 }); const writes = await customer(page);
  93  |   await page.goto(`/control?siteId=${siteId}`); const map = await mapReady(page);
  94  |   await expect(page.getByRole("button", { name: "조명 목록", exact: true })).toBeVisible();
  95  |   for (const name of ["이동", "개별 선택", "영역 선택", "구역 관리"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  96  |   await marker(page).click(); await expect(marker(page)).toHaveAttribute("aria-pressed", "true");
  97  |   await marker(page).click(); await expect(marker(page)).toHaveAttribute("aria-pressed", "false");
  98  |   await marker(page).click();
  99  |   const draft = page.getByRole("textbox", { name: "밝기 수치" }); await draft.fill("31");
  100 |   let p = await blank(map); await map.focus(); await page.mouse.move(p.x, p.y); await page.mouse.down();
  101 |   await page.mouse.move(p.x + 7, p.y); await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
  102 |   await page.mouse.move(p.x + 8, p.y); await expect(page.getByTestId("map-area-selection")).toBeVisible();
  103 |   await page.keyboard.press("Escape"); await page.mouse.up(); await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
  104 |   const pin = (await marker(page, 1).boundingBox())!;
  105 |   await page.mouse.move(pin.x - 6, pin.y - 6); await page.mouse.down(); await page.mouse.move(pin.x + pin.width + 6, pin.y + pin.height + 6, { steps: 6 }); await page.mouse.up();
  106 |   await expect(marker(page, 1)).toHaveAttribute("aria-pressed", "true");
  107 |   const beforeZoom = await camera(map); p = await blank(map); await page.mouse.move(p.x, p.y); await page.mouse.wheel(0, -120);
  108 |   await expect.poll(() => map.getAttribute("data-zoom")).not.toBe(beforeZoom.zoom);
  109 |   for (let i = 0; i < 12; i++) await page.getByRole("button", { name: "지도 확대", exact: true }).click();
  110 |   for (const kind of ["middle", "Space"] as const) {
  111 |     p = await blank(map); await map.focus(); const before = await camera(map); await page.mouse.move(p.x, p.y);
  112 |     if (kind === "Space") await page.keyboard.down("Space");
  113 |     await page.mouse.down({ button: kind === "middle" ? "middle" : "left" }); await page.mouse.move(p.x - 40, p.y - 40, { steps: 4 });
  114 |     await expect(page.getByTestId("map-area-selection")).toHaveCount(0); await page.mouse.up({ button: kind === "middle" ? "middle" : "left" });
  115 |     if (kind === "Space") await page.keyboard.up("Space"); await expect.poll(() => camera(map)).not.toEqual(before);
  116 |   }
  117 |   await expect(draft).toHaveValue("31"); expect(writes).toEqual([]); await expectNoHorizontalOverflow(page);
  118 |   await evidence(page, info, "manual-pc", { camera: await camera(map), map: await map.boundingBox() });
  119 | });
  120 | 
  121 | test("interactions 2 native touch manual pans without hold-area and short dark actions remain reachable", async ({ browser, baseURL }, info) => {
  122 |   const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 600 }, hasTouch: true, isMobile: true });
  123 |   await installMockApiBoundary(context, baseURL); const page = await context.newPage();
  124 |   try {
  125 |     const writes = await customer(page, false, true); await page.goto(`/control?siteId=${siteId}`); const map = await mapReady(page);
  126 |     await marker(page).tap(); await expect(marker(page)).toHaveAttribute("aria-pressed", "true");
  127 |     for (let i = 0; i < 8; i++) await page.getByRole("button", { name: "지도 확대", exact: true }).tap();
  128 |     const cdp = await context.newCDPSession(page);
  129 |     const point = (x: number, y: number, id = 1) => ({ x, y, id, radiusX: 2, radiusY: 2, force: 1 });
  130 |     const swipe = async (origin: { x: number; y: number }, dx: number, dy: number) => {
  131 |       await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(origin.x, origin.y)] });
  132 |       for (let i = 1; i <= 8; i++) {
  133 |         await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(origin.x + dx * i / 8, origin.y + dy * i / 8)] });
  134 |         await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  135 |       }
  136 |       await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  137 |     };
  138 |     // Zoom may move the original marker outside the visible camera. Bring it
  139 |     // back with bounded real swipes, never by mutating scrollTop/camera/CSS.
  140 |     for (let i = 0; i < 24; i++) {
  141 |       const r = (await marker(page).boundingBox())!;
  142 |       const x = r.x + r.width / 2, y = r.y + r.height / 2;
  143 |       const reachable = await marker(page).evaluate(el => {
  144 |         const r = el.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
  145 |         return el.contains(document.elementFromPoint(x, y)) && !!document.elementFromPoint(x - 32, y - 32)?.closest("[data-floor-map-surface]");
  146 |       });
  147 |       if (reachable) break;
  148 |       // The geometrical map center can be behind the sticky shell after a
  149 |       // zoom control's native scroll-into-view. Use a genuinely reachable hit.
  150 |       const hotzone = await blank(map);
  151 |       const dx = Math.max(-50, Math.min(50, hotzone.x - x));
  152 |       const dy = Math.max(-50, Math.min(50, hotzone.y - y));
  153 |       await swipe(hotzone, dx, dy);
  154 |     }
  155 |     const markerBounds = (await hit(page, marker(page)))!, markerBefore = await camera(map);
  156 |     const selectionBefore = await map.locator("[data-spatial-map-marker]").evaluateAll(els => els.map(el => ({ name: el.getAttribute("aria-label"), selected: el.getAttribute("aria-pressed") })));
  157 |     await swipe({ x: markerBounds.x + markerBounds.width / 2, y: markerBounds.y + markerBounds.height / 2 }, -32, -32);
  158 |     await expect.poll(() => camera(map)).not.toEqual(markerBefore);
  159 |     expect(await map.locator("[data-spatial-map-marker]").evaluateAll(els => els.map(el => ({ name: el.getAttribute("aria-label"), selected: el.getAttribute("aria-pressed") })))).toEqual(selectionBefore);
  160 |     await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
  161 |     await marker(page).tap(); await expect(marker(page)).toHaveAttribute("aria-pressed", "false");
  162 |     await marker(page).tap(); await expect(marker(page)).toHaveAttribute("aria-pressed", "true");
  163 |     await evidence(page, info, "manual-marker-origin-touch", { markerBounds, before: markerBefore, after: await camera(map), selectionBefore });
  164 |     const p = await blank(map), before = await camera(map);
  165 |     await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(p.x, p.y)] });
  166 |     // A real held touch exceeds the former long-press window; manual CAD must never create an area.
  167 |     await page.waitForTimeout(600); await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
  168 |     for (let i = 1; i <= 8; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(p.x - i * 5, p.y - i * 5)] }); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
  169 |     await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
```