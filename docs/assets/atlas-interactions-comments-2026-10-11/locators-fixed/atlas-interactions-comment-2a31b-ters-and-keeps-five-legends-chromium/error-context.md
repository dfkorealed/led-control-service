# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: atlas-interactions-comments.spec.ts >> interactions 3 monitoring merged finder searches numbers filters and keeps five legends
- Location: e2e/atlas-interactions-comments.spec.ts:147:1

# Error details

```
Error: expect(locator).toHaveAttribute(expected) failed

Locator:  locator('[data-spatial-map-marker="true"][aria-label^="B2-L02"]')
Expected: "true"
Received: ""
Timeout:  5000ms

Call log:
  - Expect "toHaveAttribute" with timeout 5000ms
  - waiting for locator('[data-spatial-map-marker="true"][aria-label^="B2-L02"]')
    14 × locator resolved to <button type="button" title="B2-L02" aria-current="true" data-selected="true" data-variant="ghost" data-disabled="false" data-brightness-level="7" aria-label="B2-L02 정상 65%" data-spatial-map-marker="true" class="inline-flex min-h-11 items-center justify-center gap-2 rounded-control border font-bold focus-visible:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-60 px-3 py-0 text-body-sm text-content-primary hover:enabled:bg-surface-inset aria-pressed:bg-action-primar…>…</button>
       - unexpected value "null"

```

```yaml
- button "B2-L02 정상 65%"
```

# Test source

```ts
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
  69  |   expect(await target.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
  70  |   expect(bounds!.y).toBeGreaterThanOrEqual(0); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  71  |   return bounds;
  72  | }
  73  | async function scrollTo(page: Page, target: Locator) {
  74  |   // Real wheel in the control/body hotzone, not the canvas gesture surface.
  75  |   for (let i = 0; i < 8; i++) {
  76  |     const visible = await target.evaluate(el => { const r = el.getBoundingClientRect(); const nav = document.querySelector("[data-customer-bottom-nav]")?.getBoundingClientRect(); return r.y >= 0 && r.bottom <= (nav?.top ?? innerHeight); });
  77  |     if (visible) break;
  78  |     await page.mouse.move(8, 300); await page.mouse.wheel(0, 500);
  79  |   }
  80  |   return hit(page, target);
  81  | }
  82  | async function statsReady(page: Page) {
  83  |   await expect(page.getByRole("group", { name: "에너지 요약", exact: true })).toContainText("4.25");
  84  |   await expect(page.getByRole("img", { name: "일별 상태 기반 추정 전력 사용량 꺾은선 차트", exact: true }).locator("svg")).toBeVisible();
  85  |   await expect(page.getByText("사용량 추이를 불러오는 중", { exact: true })).toHaveCount(0);
  86  | }
  87  | 
  88  | test("interactions 1 PC manual native CAD gestures preserve selection and raw draft", async ({ page }, info) => {
  89  |   await page.setViewportSize({ width: 1440, height: 900 }); const writes = await customer(page);
  90  |   await page.goto(`/control?siteId=${siteId}`); const map = await mapReady(page);
  91  |   await expect(page.getByRole("button", { name: "조명 목록", exact: true })).toBeVisible();
  92  |   for (const name of ["이동", "개별 선택", "영역 선택", "구역 관리"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  93  |   await marker(page).click(); await expect(marker(page)).toHaveAttribute("aria-pressed", "true");
  94  |   await marker(page).click(); await expect(marker(page)).toHaveAttribute("aria-pressed", "false");
  95  |   await marker(page).click();
  96  |   const draft = page.getByRole("textbox", { name: "밝기 수치" }); await draft.fill("31");
  97  |   let p = await blank(map); await map.focus(); await page.mouse.move(p.x, p.y); await page.mouse.down();
  98  |   await page.mouse.move(p.x + 7, p.y); await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
  99  |   await page.mouse.move(p.x + 8, p.y); await expect(page.getByTestId("map-area-selection")).toBeVisible();
  100 |   await page.keyboard.press("Escape"); await page.mouse.up(); await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
  101 |   const pin = (await marker(page, 1).boundingBox())!;
  102 |   await page.mouse.move(pin.x - 6, pin.y - 6); await page.mouse.down(); await page.mouse.move(pin.x + pin.width + 6, pin.y + pin.height + 6, { steps: 6 }); await page.mouse.up();
  103 |   await expect(marker(page, 1)).toHaveAttribute("aria-pressed", "true");
  104 |   const beforeZoom = await camera(map); p = await blank(map); await page.mouse.move(p.x, p.y); await page.mouse.wheel(0, -120);
  105 |   await expect.poll(() => map.getAttribute("data-zoom")).not.toBe(beforeZoom.zoom);
  106 |   for (let i = 0; i < 12; i++) await page.getByRole("button", { name: "지도 확대", exact: true }).click();
  107 |   for (const kind of ["middle", "Space"] as const) {
  108 |     p = await blank(map); await map.focus(); const before = await camera(map); await page.mouse.move(p.x, p.y);
  109 |     if (kind === "Space") await page.keyboard.down("Space");
  110 |     await page.mouse.down({ button: kind === "middle" ? "middle" : "left" }); await page.mouse.move(p.x - 40, p.y - 40, { steps: 4 });
  111 |     await expect(page.getByTestId("map-area-selection")).toHaveCount(0); await page.mouse.up({ button: kind === "middle" ? "middle" : "left" });
  112 |     if (kind === "Space") await page.keyboard.up("Space"); await expect.poll(() => camera(map)).not.toEqual(before);
  113 |   }
  114 |   await expect(draft).toHaveValue("31"); expect(writes).toEqual([]); await expectNoHorizontalOverflow(page);
  115 |   await evidence(page, info, "manual-pc", { camera: await camera(map), map: await map.boundingBox() });
  116 | });
  117 | 
  118 | test("interactions 2 native touch manual pans without hold-area and short dark actions remain reachable", async ({ browser, baseURL }, info) => {
  119 |   const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 600 }, hasTouch: true, isMobile: true });
  120 |   await installMockApiBoundary(context, baseURL); const page = await context.newPage();
  121 |   try {
  122 |     const writes = await customer(page, false, true); await page.goto(`/control?siteId=${siteId}`); const map = await mapReady(page);
  123 |     await marker(page).tap(); await expect(marker(page)).toHaveAttribute("aria-pressed", "true");
  124 |     for (let i = 0; i < 8; i++) await page.getByRole("button", { name: "지도 확대", exact: true }).tap();
  125 |     const cdp = await context.newCDPSession(page), p = await blank(map), before = await camera(map);
  126 |     const point = (x: number, y: number, id = 1) => ({ x, y, id, radiusX: 2, radiusY: 2, force: 1 });
  127 |     await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(p.x, p.y)] });
  128 |     // A real held touch exceeds the former long-press window; manual CAD must never create an area.
  129 |     await page.waitForTimeout(600); await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
  130 |     for (let i = 1; i <= 8; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(p.x - i * 5, p.y - i * 5)] }); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
  131 |     await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  132 |     await expect.poll(() => camera(map)).not.toEqual(before); await expect(marker(page)).toHaveAttribute("aria-pressed", "true");
  133 |     await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(p.x, p.y)] });
  134 |     await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(p.x, p.y), point(p.x + 40, p.y, 2)] });
  135 |     await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] }); await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
  136 |     const draft = page.getByRole("textbox", { name: "밝기 수치" }); await draft.fill("31");
  137 |     const clear = page.getByRole("button", { name: "선택 해제", exact: true }); const clearBounds = await scrollTo(page, clear);
  138 |     await expectMinimumTouchTargets(page, "[data-target-selection-detail-panel] button");
  139 |     await clear.tap(); await expect(draft).toHaveValue("31"); expect(writes).toEqual([]); await expectNoHorizontalOverflow(page);
  140 |     await evidence(page, info, "manual-touch-dark-short", { camera: await camera(map), clearBounds });
  141 |   } catch (error) {
  142 |     await evidence(page, info, "manual-touch-original-failure", { error: String(error) });
  143 |     throw error;
  144 |   } finally { await context.close(); }
  145 | });
  146 | 
  147 | test("interactions 3 monitoring merged finder searches numbers filters and keeps five legends", async ({ page }, info) => {
  148 |   await page.setViewportSize({ width: 1440, height: 900 }); const writes = await customer(page); await page.goto(`/monitoring?siteId=${siteId}`);
  149 |   const map = await mapReady(page, false); const opener = page.getByRole("button", { name: "조명 검색/목록", exact: true }); await expect(opener).toHaveCount(1);
  150 |   for (const label of ["정상", "장애", "오프라인", "상태 확인 대기", "조명 정보 확인 전"]) await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  151 |   await expect(page.locator("[data-shell-topbar]")).toContainText(siteName); await expect(page.locator("[data-shell-topbar]")).not.toContainText("표시하지 않을 고객사");
  152 |   await opener.click(); const finder = page.getByRole("region", { name: "조명 검색 및 목록", exact: true });
  153 |   await finder.getByRole("searchbox", { name: "조명 이름 또는 번호 검색" }).fill("02"); await expect(finder.getByRole("list", { name: "조명 목록" }).getByRole("button")).toHaveCount(1);
> 154 |   await finder.getByRole("button", { name: /B2-L02/ }).click(); await expect(finder).toHaveCount(0); await expect(marker(page, 1)).toHaveAttribute("aria-pressed", "true");
      |                                                                                                                                    ^ Error: expect(locator).toHaveAttribute(expected) failed
  155 |   await opener.click(); await finder.getByRole("searchbox").fill(""); await finder.getByRole("button", { name: /상태 필터/ }).click(); await page.getByRole("option", { name: "오프라인", exact: true }).click();
  156 |   await expect(finder.getByText("오프라인 조명이 없습니다.", { exact: true })).toBeVisible(); await finder.getByRole("button", { name: "전체 조명 보기", exact: true }).click();
  157 |   await expect(finder.getByRole("list", { name: "조명 목록" }).getByRole("button")).toHaveCount(3);
  158 |   await page.keyboard.press("Escape"); await expect(opener).toBeFocused(); expect(writes).toEqual([]); await expectNoHorizontalOverflow(page);
  159 |   await evidence(page, info, "monitoring-finder-legend", { map: await map.boundingBox(), camera: await camera(map), opener: await hit(page, opener) });
  160 | });
  161 | 
  162 | test("interactions 4 mobile sheet nested calendar focus dates stay one line at 390 and 320", async ({ page }, info) => {
  163 |   const writes = await customer(page, true); await page.setViewportSize({ width: 390, height: 600 }); await page.goto(`/statistics?siteId=${siteId}`); await statsReady(page);
  164 |   for (const width of [390, 320]) {
  165 |     await page.setViewportSize({ width, height: 600 }); const opener = page.getByRole("button", { name: /^절감 비교 기간 상세 필터/ }); await opener.click();
  166 |     const sheet = page.getByRole("dialog", { name: "절감 비교 기간", exact: true }); await expect(sheet).toBeVisible();
  167 |     await expect.poll(async () => { const r = (await sheet.boundingBox())!; return Math.abs(r.y + r.height - 600); }).toBeLessThanOrEqual(1);
  168 |     const group = sheet.getByRole("group", { name: "완료 기간 시작일과 종료일", exact: true });
  169 |     const segments = group.getByRole("spinbutton"); await expect(segments).toHaveCount(6);
  170 |     await segments.first().click(); await page.keyboard.press("ArrowRight");
  171 |     expect(await group.evaluate(el => el.contains(document.activeElement))).toBe(true);
  172 |     const rects = await segments.evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, height: r.height }; }));
  173 |     expect(Math.max(...rects.map(r => r.y)) - Math.min(...rects.map(r => r.y))).toBeLessThanOrEqual(1);
  174 |     for (let i = 1; i < rects.length; i++) expect(rects[i].x).toBeGreaterThanOrEqual(rects[i - 1].right);
  175 |     const calendar = group.getByRole("button"); await expectMinimumTouchTargets(page, `[id="${await group.getAttribute("id")}"] button`);
  176 |     await calendar.click(); await expect(page.getByRole("grid")).toBeVisible(); await page.keyboard.press("Escape"); await expect(calendar).toBeFocused(); await expect(sheet).toBeVisible();
  177 |     const close = sheet.getByRole("button", { name: "필터 닫기", exact: true }); await close.scrollIntoViewIfNeeded(); const closeBounds = await hit(page, close);
  178 |     await evidence(page, info, `filter-sheet-${width}`, { sheet: await sheet.boundingBox(), dates: rects, group: await group.boundingBox(), closeBounds });
  179 |     await close.click(); await expect(opener).toBeFocused(); await expectNoHorizontalOverflow(page);
  180 |   }
  181 |   expect(writes).toEqual([]);
  182 | });
  183 | 
  184 | test("interactions 5 dark reports 577 summary expands below stable row and preserves actions", async ({ page }, info) => {
  185 |   await page.setViewportSize({ width: 577, height: 900 }); const writes = await customer(page, true, true);
  186 |   const request = { from: "2026-09-01", to: "2026-09-07", scope: "site" as const, identityId: siteId, format: "pdf" as const };
  187 |   const complete = { ...browserReport("completed", request), siteId, target: { scope: "site" as const, identityId: siteId, label: "완료 현장" } };
  188 |   const failed = { ...browserReport("failed", request), reportId: "30000000-0000-4000-8000-000000000042", siteId, target: { scope: "site" as const, identityId: siteId, label: "실패 현장" } };
  189 |   const response = energyReportListResponseSchema.parse({ reports: [complete, failed], nextCursor: null, totalCount: 2 });
  190 |   await page.route("**/energy/sites/*/reports*", route => route.fulfill({ json: response }));
  191 |   await page.goto(`/statistics/reports?siteId=${siteId}`); const jobs = page.getByRole("region", { name: "요청한 보고서", exact: true }); await expect(jobs).toContainText("완료 현장"); await expect(jobs).not.toHaveAttribute("aria-busy", "true");
  192 |   const toggle = jobs.getByRole("button", { name: "완료 현장 보고서 상세보기", exact: true }); await expect(toggle).toHaveAttribute("aria-expanded", "false");
  193 |   await expect(jobs.getByText("요청 시각", { exact: true })).toHaveCount(0); await expect(jobs.getByText("파일 만료 시각", { exact: true })).toHaveCount(0);
  194 |   await expect(jobs.getByRole("button", { name: "완료 현장 보고서 다운로드", exact: true })).toBeEnabled(); await expect(jobs.getByRole("button", { name: "실패 현장 보고서 다시 생성", exact: true })).toBeEnabled();
  195 |   await toggle.click(); const detail = jobs.getByRole("region", { name: "완료 현장 보고서 상세보기", exact: true }); await expect(detail).toContainText("요청 시각"); await expect(detail).toContainText("파일 만료 시각");
  196 |   const detailId = await toggle.getAttribute("aria-controls");
  197 |   await jobs.getByRole("button", { name: /정렬 기준/ }).click(); await page.getByRole("option", { name: "대상", exact: true }).click();
  198 |   await expect(toggle).toHaveAttribute("aria-controls", detailId!); await expect(toggle).toHaveAttribute("aria-expanded", "true");
  199 |   const toggleBounds = (await toggle.boundingBox())!, detailBounds = (await detail.boundingBox())!; expect(detailBounds.y).toBeGreaterThanOrEqual(toggleBounds.y + toggleBounds.height);
  200 |   await expect(jobs.locator('time[datetime="2026-09-01"]')).toHaveCount(2); await expectNoHorizontalOverflow(page);
  201 |   await evidence(page, info, "reports-dark-577-details", { toggleBounds, detailBounds, download: await jobs.getByRole("button", { name: "완료 현장 보고서 다운로드", exact: true }).boundingBox() });
  202 |   await toggle.click(); await expect(detail).toHaveCount(0); expect(writes).toEqual([]);
  203 | });
  204 | 
  205 | test("interactions 6 overview title chart ticks and unchanged C8 content at PC and mobile", async ({ page }, info) => {
  206 |   const writes = await customer(page, true); await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(`/statistics?siteId=${siteId}`); await statsReady(page);
  207 |   await expect(page.getByRole("heading", { name: "사용량 개요", exact: true })).toHaveClass(/sr-only/);
  208 |   const card = page.getByRole("region", { name: "운영 인사이트", exact: true });
  209 |   for (const text of ["43,200초", "2,073,600초", "20,000,000초", "7,200초", "10개", "현장 시간대 Asia/Seoul · 조명 상태 기록 기준 · 실측 전력 아님"]) await expect(card).toContainText(text);
  210 |   const original = await card.textContent();
  211 |   for (const width of [1440, 390]) {
  212 |     await page.setViewportSize({ width, height: 900 }); await statsReady(page); await expect(card).toHaveText(original);
  213 |     const chart = page.getByRole("img", { name: "일별 상태 기반 추정 전력 사용량 꺾은선 차트", exact: true }); await chart.scrollIntoViewIfNeeded();
  214 |     const ticks = await chart.locator(".recharts-cartesian-axis-tick text").evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { text: el.textContent, x: r.x, y: r.y, right: r.right, bottom: r.bottom }; })); expect(ticks.length).toBeGreaterThan(2);
  215 |     const bounds = (await chart.boundingBox())!;
  216 |     for (const tick of ticks) { expect(tick.x).toBeGreaterThanOrEqual(bounds.x); expect(tick.right).toBeLessThanOrEqual(bounds.x + bounds.width); }
  217 |     for (let a = 0; a < ticks.length; a++) for (let b = a + 1; b < ticks.length; b++) expect(ticks[a].right <= ticks[b].x || ticks[b].right <= ticks[a].x || ticks[a].bottom <= ticks[b].y || ticks[b].bottom <= ticks[a].y).toBe(true);
  218 |     await expectNoHorizontalOverflow(page); await evidence(page, info, `overview-${width}`, { chart: bounds, ticks, C8: original });
  219 |   }
  220 |   expect(writes).toEqual([]);
  221 | });
  222 | 
```