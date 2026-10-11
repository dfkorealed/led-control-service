# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: atlas-interactions-comments.spec.ts >> interactions 4 mobile sheet nested calendar focus dates stay one line at 390 and 320
- Location: e2e/atlas-interactions-comments.spec.ts:156:1

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: getByRole('group', { name: '에너지 요약', exact: true })
Expected substring: "4.25"
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toContainText" with timeout 5000ms
  - waiting for getByRole('group', { name: '에너지 요약', exact: true })

```

```yaml
- main:
  - text: 통계
  - img "킨다"
  - paragraph: 물류센터 B2 현장
  - text: 물류센터 B2 현장
  - button "알람센터, 확인 불가"
  - button "다크 모드로 변경"
  - region "현장 전체":
    - heading "현장 전체" [level=2]
    - paragraph: 물류센터 B2 현장
    - term: 전체
    - definition: 3대
    - term: 온라인
    - definition: 3대
    - term: 장애
    - definition: 0대
    - term: 오프라인
    - definition: —
  - region "내 계정":
    - heading "내 계정" [level=2]
    - paragraph: Customer Admin · demo_admin
    - paragraph: 현장 관리자
    - button "로그아웃"
  - alert:
    - strong: 현장 권한을 확인하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도하세요.
    - button "다시 시도"
```

# Test source

```ts
  1   | import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
  2   | import { writeFile } from "node:fs/promises";
  3   | import { mockDashboard } from "../src/test/fixtures";
  4   | import { installSettingsApiRoutes } from "./support/settings-api";
  5   | import { installMockApiBoundary } from "./support/mock-api-boundary";
  6   | import { browserReport, installFirstScreenStatisticsFixtures } from "./support/first-screen-statistics";
  7   | import { expectNoHorizontalOverflow, expectMinimumTouchTargets } from "./support/layout-assertions";
  8   | 
  9   | const siteId = mockDashboard.site.id, floorId = mockDashboard.floors[0].id, gatewayId = mockDashboard.gateways[0].id;
  10  | const fixtures = mockDashboard.floors[0].fixtures.slice(0, 3);
  11  | const siteName = "물류센터 B2 현장";
  12  | const marker = (page: Page, index = 0) => page.locator(`[data-spatial-map-marker="true"][aria-label^="${fixtures[index].name}"]`);
  13  | 
  14  | test.beforeEach(async ({ context, baseURL }) => {
  15  |   expect(process.env.E2E_REAL_BACKEND_LAB).not.toBe("1");
  16  |   expect(new URL(baseURL!).port).toBe("15187");
  17  |   await installMockApiBoundary(context, baseURL);
  18  | });
  19  | 
  20  | async function customer(page: Page, statistics = false, dark = false) {
  21  |   const writes: string[] = [];
  22  |   page.on("request", request => {
  23  |     if (new URL(request.url()).pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method())) writes.push(`${request.method()} ${request.url()}`);
  24  |   });
  25  |   await page.addInitScript(value => localStorage.setItem("led-control.customer-theme.v1", value), dark ? "dark" : "light");
  26  |   await installSettingsApiRoutes(page, "admin", { ids: { siteId, floorId, gatewayId }, fixtures, readyMapDocument: true });
  27  |   if (statistics) await installFirstScreenStatisticsFixtures(page);
  28  |   const dashboard = structuredClone(mockDashboard);
  29  |   dashboard.site.name = siteName;
  30  |   dashboard.floors = [{ ...dashboard.floors[0], fixtures, mapRevision: 7, mapConfigured: true }];
  31  |   dashboard.groups = [];
  32  |   dashboard.summary = { ...dashboard.summary, totalFixtures: 3, onlineFixtures: 3, faultFixtures: 0 };
  33  |   await page.route("**/api/sites/*/dashboard**", route => route.fulfill({ json: dashboard }));
  34  |   await page.route("**/api/sites", route => route.fulfill({ json: [{ id: siteId, name: siteName, customerName: "표시하지 않을 고객사" }] }));
  35  |   return writes;
  36  | }
  37  | 
  38  | async function evidence(page: Page, info: TestInfo, name: string, metrics: unknown) {
  39  |   const png = info.outputPath(`${name}.png`), json = info.outputPath(`${name}.json`);
  40  |   await page.screenshot({ path: png });
  41  |   await writeFile(json, JSON.stringify({ source: "437ebc39", viewport: page.viewportSize(), url: page.url(), metrics }, null, 2));
  42  |   await info.attach(name, { path: png, contentType: "image/png" });
  43  |   await info.attach(`${name}-metrics`, { path: json, contentType: "application/json" });
  44  | }
  45  | async function camera(map: Locator) { return map.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop, zoom: el.getAttribute("data-zoom") })); }
  46  | async function blank(map: Locator) {
  47  |   return map.evaluate(el => {
  48  |     const r = el.getBoundingClientRect();
  49  |     for (const x of [.35, .55, .75]) for (const y of [.35, .55, .75]) {
  50  |       const p = { x: r.x + r.width * x, y: r.y + r.height * y };
  51  |       const hit = document.elementFromPoint(p.x, p.y);
  52  |       if (hit?.closest("[data-floor-map-surface]") && !hit.closest("button")) return p;
  53  |     }
  54  |     throw new Error("No reachable map blank point");
  55  |   });
  56  | }
  57  | async function mapReady(page: Page, manual = true) {
  58  |   const map = page.getByTestId(manual ? "target-selection-map-viewport" : "monitoring-map-viewport");
  59  |   await expect(map.locator("canvas").first()).toBeVisible();
  60  |   await expect(marker(page)).toBeVisible();
  61  |   return map;
  62  | }
  63  | async function hit(page: Page, target: Locator) {
  64  |   await expect(target).toBeVisible();
  65  |   const bounds = await target.boundingBox(); expect(bounds).not.toBeNull();
  66  |   expect(await target.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
  67  |   expect(bounds!.y).toBeGreaterThanOrEqual(0); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  68  |   return bounds;
  69  | }
  70  | async function scrollTo(page: Page, target: Locator) {
  71  |   // Real wheel in the control/body hotzone, not the canvas gesture surface.
  72  |   for (let i = 0; i < 8; i++) {
  73  |     const visible = await target.evaluate(el => { const r = el.getBoundingClientRect(); const nav = document.querySelector("[data-customer-bottom-nav]")?.getBoundingClientRect(); return r.y >= 0 && r.bottom <= (nav?.top ?? innerHeight); });
  74  |     if (visible) break;
  75  |     await page.mouse.move(8, 300); await page.mouse.wheel(0, 500);
  76  |   }
  77  |   return hit(page, target);
  78  | }
  79  | async function statsReady(page: Page) {
> 80  |   await expect(page.getByRole("group", { name: "에너지 요약", exact: true })).toContainText("4.25");
      |                                                                          ^ Error: expect(locator).toContainText(expected) failed
  81  |   await expect(page.getByRole("img", { name: "일별 상태 기반 추정 전력 사용량 꺾은선 차트", exact: true }).locator("svg")).toBeVisible();
  82  |   await expect(page.getByText("사용량 추이를 불러오는 중", { exact: true })).toHaveCount(0);
  83  | }
  84  | 
  85  | test("interactions 1 PC manual native CAD gestures preserve selection and raw draft", async ({ page }, info) => {
  86  |   await page.setViewportSize({ width: 1440, height: 900 }); const writes = await customer(page);
  87  |   await page.goto(`/control?siteId=${siteId}`); const map = await mapReady(page);
  88  |   await expect(page.getByRole("button", { name: "조명 목록", exact: true })).toBeVisible();
  89  |   for (const name of ["이동", "개별 선택", "영역 선택", "구역 관리"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  90  |   await marker(page).click(); await expect(marker(page)).toHaveAttribute("aria-pressed", "true");
  91  |   await marker(page).click(); await expect(marker(page)).toHaveAttribute("aria-pressed", "false");
  92  |   await marker(page).click();
  93  |   const draft = page.getByRole("textbox", { name: "밝기 수치" }); await draft.fill("31");
  94  |   let p = await blank(map); await map.focus(); await page.mouse.move(p.x, p.y); await page.mouse.down();
  95  |   await page.mouse.move(p.x + 7, p.y); await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
  96  |   await page.mouse.move(p.x + 8, p.y); await expect(page.getByTestId("map-area-selection")).toBeVisible();
  97  |   await page.keyboard.press("Escape"); await page.mouse.up(); await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
  98  |   const pin = (await marker(page, 1).boundingBox())!;
  99  |   await page.mouse.move(pin.x - 6, pin.y - 6); await page.mouse.down(); await page.mouse.move(pin.x + pin.width + 6, pin.y + pin.height + 6, { steps: 6 }); await page.mouse.up();
  100 |   await expect(marker(page, 1)).toHaveAttribute("aria-pressed", "true");
  101 |   const beforeZoom = await camera(map); p = await blank(map); await page.mouse.move(p.x, p.y); await page.mouse.wheel(0, -120);
  102 |   await expect.poll(() => map.getAttribute("data-zoom")).not.toBe(beforeZoom.zoom);
  103 |   for (let i = 0; i < 12; i++) await page.getByRole("button", { name: "지도 확대", exact: true }).click();
  104 |   for (const kind of ["middle", "Space"] as const) {
  105 |     p = await blank(map); await map.focus(); const before = await camera(map); await page.mouse.move(p.x, p.y);
  106 |     if (kind === "Space") await page.keyboard.down("Space");
  107 |     await page.mouse.down({ button: kind === "middle" ? "middle" : "left" }); await page.mouse.move(p.x - 40, p.y - 40, { steps: 4 });
  108 |     await expect(page.getByTestId("map-area-selection")).toHaveCount(0); await page.mouse.up({ button: kind === "middle" ? "middle" : "left" });
  109 |     if (kind === "Space") await page.keyboard.up("Space"); await expect.poll(() => camera(map)).not.toEqual(before);
  110 |   }
  111 |   await expect(draft).toHaveValue("31"); expect(writes).toEqual([]); await expectNoHorizontalOverflow(page);
  112 |   await evidence(page, info, "manual-pc", { camera: await camera(map), map: await map.boundingBox() });
  113 | });
  114 | 
  115 | test("interactions 2 native touch manual pans without hold-area and short dark actions remain reachable", async ({ browser, baseURL }, info) => {
  116 |   const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 600 }, hasTouch: true, isMobile: true });
  117 |   await installMockApiBoundary(context, baseURL); const page = await context.newPage();
  118 |   try {
  119 |     const writes = await customer(page, false, true); await page.goto(`/control?siteId=${siteId}`); const map = await mapReady(page);
  120 |     await marker(page).tap(); await expect(marker(page)).toHaveAttribute("aria-pressed", "true");
  121 |     for (let i = 0; i < 8; i++) await page.getByRole("button", { name: "지도 확대", exact: true }).tap();
  122 |     const cdp = await context.newCDPSession(page), p = await blank(map), before = await camera(map);
  123 |     const point = (x: number, y: number, id = 1) => ({ x, y, id, radiusX: 2, radiusY: 2, force: 1 });
  124 |     await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(p.x, p.y)] });
  125 |     // A real held touch exceeds the former long-press window; manual CAD must never create an area.
  126 |     await page.waitForTimeout(600); await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
  127 |     for (let i = 1; i <= 8; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(p.x - i * 5, p.y - i * 5)] }); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
  128 |     await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  129 |     await expect.poll(() => camera(map)).not.toEqual(before); await expect(marker(page)).toHaveAttribute("aria-pressed", "true");
  130 |     await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(p.x, p.y)] });
  131 |     await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(p.x, p.y), point(p.x + 40, p.y, 2)] });
  132 |     await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] }); await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
  133 |     const draft = page.getByRole("textbox", { name: "밝기 수치" }); await draft.fill("31");
  134 |     const clear = page.getByRole("button", { name: "선택 해제", exact: true }); const clearBounds = await scrollTo(page, clear);
  135 |     await expectMinimumTouchTargets(page, "[data-target-selection-detail-panel] button");
  136 |     await clear.tap(); await expect(draft).toHaveValue("31"); expect(writes).toEqual([]); await expectNoHorizontalOverflow(page);
  137 |     await evidence(page, info, "manual-touch-dark-short", { camera: await camera(map), clearBounds });
  138 |   } finally { await context.close(); }
  139 | });
  140 | 
  141 | test("interactions 3 monitoring merged finder searches numbers filters and keeps five legends", async ({ page }, info) => {
  142 |   await page.setViewportSize({ width: 1440, height: 900 }); const writes = await customer(page); await page.goto(`/monitoring?siteId=${siteId}`);
  143 |   const map = await mapReady(page, false); const opener = page.getByRole("button", { name: "조명 검색/목록", exact: true }); await expect(opener).toHaveCount(1);
  144 |   for (const label of ["정상", "장애", "오프라인", "상태 확인 대기", "조명 정보 확인 전"]) await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  145 |   await expect(page.locator("header")).toContainText(siteName); await expect(page.locator("header")).not.toContainText("표시하지 않을 고객사");
  146 |   await opener.click(); const finder = page.getByRole("region", { name: "조명 검색 및 목록", exact: true });
  147 |   await finder.getByRole("searchbox", { name: "조명 이름 또는 번호 검색" }).fill("02"); await expect(finder.getByRole("list", { name: "조명 목록" }).getByRole("button")).toHaveCount(1);
  148 |   await finder.getByRole("button", { name: /B2-L02/ }).click(); await expect(finder).toHaveCount(0); await expect(marker(page, 1)).toHaveAttribute("aria-pressed", "true");
  149 |   await opener.click(); await finder.getByRole("searchbox").fill(""); await finder.getByRole("button", { name: /상태 필터/ }).click(); await page.getByRole("option", { name: "오프라인", exact: true }).click();
  150 |   await expect(finder.getByText("오프라인 조명이 없습니다.", { exact: true })).toBeVisible(); await finder.getByRole("button", { name: "전체 조명 보기", exact: true }).click();
  151 |   await expect(finder.getByRole("list", { name: "조명 목록" }).getByRole("button")).toHaveCount(3);
  152 |   await page.keyboard.press("Escape"); await expect(opener).toBeFocused(); expect(writes).toEqual([]); await expectNoHorizontalOverflow(page);
  153 |   await evidence(page, info, "monitoring-finder-legend", { map: await map.boundingBox(), camera: await camera(map), opener: await hit(page, opener) });
  154 | });
  155 | 
  156 | test("interactions 4 mobile sheet nested calendar focus dates stay one line at 390 and 320", async ({ page }, info) => {
  157 |   const writes = await customer(page, true); await page.setViewportSize({ width: 390, height: 600 }); await page.goto(`/statistics?siteId=${siteId}`); await statsReady(page);
  158 |   for (const width of [390, 320]) {
  159 |     await page.setViewportSize({ width, height: 600 }); const opener = page.getByRole("button", { name: /^절감 비교 기간 상세 필터/ }); await opener.click();
  160 |     const sheet = page.getByRole("dialog", { name: "절감 비교 기간", exact: true }); await expect(sheet).toBeVisible();
  161 |     await expect.poll(async () => { const r = (await sheet.boundingBox())!; return Math.abs(r.y + r.height - 600); }).toBeLessThanOrEqual(1);
  162 |     const group = sheet.getByRole("group", { name: "완료 기간 시작일과 종료일", exact: true });
  163 |     const segments = group.getByRole("spinbutton"); await expect(segments).toHaveCount(6);
  164 |     await segments.first().click(); await page.keyboard.press("ArrowRight");
  165 |     expect(await group.evaluate(el => el.contains(document.activeElement))).toBe(true);
  166 |     const rects = await segments.evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, height: r.height }; }));
  167 |     expect(Math.max(...rects.map(r => r.y)) - Math.min(...rects.map(r => r.y))).toBeLessThanOrEqual(1);
  168 |     for (let i = 1; i < rects.length; i++) expect(rects[i].x).toBeGreaterThanOrEqual(rects[i - 1].right);
  169 |     const calendar = group.getByRole("button"); await expectMinimumTouchTargets(page, `[id="${await group.getAttribute("id")}"] button`);
  170 |     await calendar.click(); await expect(page.getByRole("grid")).toBeVisible(); await page.keyboard.press("Escape"); await expect(calendar).toBeFocused(); await expect(sheet).toBeVisible();
  171 |     const close = sheet.getByRole("button", { name: "필터 닫기", exact: true }); await close.scrollIntoViewIfNeeded(); const closeBounds = await hit(page, close);
  172 |     await evidence(page, info, `filter-sheet-${width}`, { sheet: await sheet.boundingBox(), dates: rects, group: await group.boundingBox(), closeBounds });
  173 |     await close.click(); await expect(opener).toBeFocused(); await expectNoHorizontalOverflow(page);
  174 |   }
  175 |   expect(writes).toEqual([]);
  176 | });
  177 | 
  178 | test("interactions 5 dark reports 577 summary expands below stable row and preserves actions", async ({ page }, info) => {
  179 |   await page.setViewportSize({ width: 577, height: 900 }); const writes = await customer(page, true, true);
  180 |   const complete = { ...browserReport("completed"), siteId, target: { scope: "site" as const, identityId: siteId, label: "완료 현장" } };
```