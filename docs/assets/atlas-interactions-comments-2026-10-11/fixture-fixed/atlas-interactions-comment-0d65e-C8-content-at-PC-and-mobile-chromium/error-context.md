# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: atlas-interactions-comments.spec.ts >> interactions 6 overview title chart ticks and unchanged C8 content at PC and mobile
- Location: e2e/atlas-interactions-comments.spec.ts:199:1

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator: getByRole('region', { name: '운영 인사이트', exact: true })
Timeout: 5000ms
- Expected  - 19
+ Received  +  1

- 운영 인사이트
- 오늘 · 알려진 상태시간
- 43,200초
- 수집 공백
- 0초
- 이번 달 누적 · 알려진 상태시간
- 2,073,600초
- 수집 공백
- 7,200초
- 올해 누적 · 알려진 상태시간
- 20,000,000초
- 수집 공백
- 7,200초
- 최근 집계
- 2026-08-26 09:00:00
- 기준 조명 수
- 10개
-
- 현장 시간대 Asia/Seoul · 조명 상태 기록 기준 · 실측 전력 아님
+ 운영 인사이트오늘 · 알려진 상태시간43,200초수집 공백0초이번 달 누적 · 알려진 상태시간2,073,600초수집 공백7,200초올해 누적 · 알려진 상태시간20,000,000초수집 공백7,200초최근 집계2026-08-26 09:00:00기준 조명 수10개현장 시간대 Asia/Seoul · 조명 상태 기록 기준 · 실측 전력 아님

Call log:
  - Expect "toHaveText" with timeout 5000ms
  - waiting for getByRole('region', { name: '운영 인사이트', exact: true })
    14 × locator resolved to <section aria-label="운영 인사이트" data-variant="default" class="rounded-panel border bg-surface-panel border-border-default grid min-w-0 content-start gap-4 p-4 compact:p-6">…</section>
       - unexpected value "운영 인사이트오늘 · 알려진 상태시간43,200초수집 공백0초이번 달 누적 · 알려진 상태시간2,073,600초수집 공백7,200초올해 누적 · 알려진 상태시간20,000,000초수집 공백7,200초최근 집계2026-08-26 09:00:00기준 조명 수10개현장 시간대 Asia/Seoul · 조명 상태 기록 기준 · 실측 전력 아님"

```

```yaml
- region "운영 인사이트":
  - heading "운영 인사이트" [level=2]
  - group "오늘 수집 품질":
    - term: 오늘 · 알려진 상태시간
    - definition: 43,200초
    - term: 수집 공백
    - definition: 0초
  - group "이번 달 누적 수집 품질":
    - term: 이번 달 누적 · 알려진 상태시간
    - definition: 2,073,600초
    - term: 수집 공백
    - definition: 7,200초
  - group "올해 누적 수집 품질":
    - term: 올해 누적 · 알려진 상태시간
    - definition: 20,000,000초
    - term: 수집 공백
    - definition: 7,200초
  - term: 최근 집계
  - definition:
    - time: 2026-08-26 09:00:00
  - term: 기준 조명 수
  - definition: 10개
  - paragraph: 현장 시간대 Asia/Seoul · 조명 상태 기록 기준 · 실측 전력 아님
```

# Test source

```ts
  106 |   for (const kind of ["middle", "Space"] as const) {
  107 |     p = await blank(map); await map.focus(); const before = await camera(map); await page.mouse.move(p.x, p.y);
  108 |     if (kind === "Space") await page.keyboard.down("Space");
  109 |     await page.mouse.down({ button: kind === "middle" ? "middle" : "left" }); await page.mouse.move(p.x - 40, p.y - 40, { steps: 4 });
  110 |     await expect(page.getByTestId("map-area-selection")).toHaveCount(0); await page.mouse.up({ button: kind === "middle" ? "middle" : "left" });
  111 |     if (kind === "Space") await page.keyboard.up("Space"); await expect.poll(() => camera(map)).not.toEqual(before);
  112 |   }
  113 |   await expect(draft).toHaveValue("31"); expect(writes).toEqual([]); await expectNoHorizontalOverflow(page);
  114 |   await evidence(page, info, "manual-pc", { camera: await camera(map), map: await map.boundingBox() });
  115 | });
  116 | 
  117 | test("interactions 2 native touch manual pans without hold-area and short dark actions remain reachable", async ({ browser, baseURL }, info) => {
  118 |   const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 600 }, hasTouch: true, isMobile: true });
  119 |   await installMockApiBoundary(context, baseURL); const page = await context.newPage();
  120 |   try {
  121 |     const writes = await customer(page, false, true); await page.goto(`/control?siteId=${siteId}`); const map = await mapReady(page);
  122 |     await marker(page).tap(); await expect(marker(page)).toHaveAttribute("aria-pressed", "true");
  123 |     for (let i = 0; i < 8; i++) await page.getByRole("button", { name: "지도 확대", exact: true }).tap();
  124 |     const cdp = await context.newCDPSession(page), p = await blank(map), before = await camera(map);
  125 |     const point = (x: number, y: number, id = 1) => ({ x, y, id, radiusX: 2, radiusY: 2, force: 1 });
  126 |     await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(p.x, p.y)] });
  127 |     // A real held touch exceeds the former long-press window; manual CAD must never create an area.
  128 |     await page.waitForTimeout(600); await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
  129 |     for (let i = 1; i <= 8; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(p.x - i * 5, p.y - i * 5)] }); await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
  130 |     await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  131 |     await expect.poll(() => camera(map)).not.toEqual(before); await expect(marker(page)).toHaveAttribute("aria-pressed", "true");
  132 |     await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(p.x, p.y)] });
  133 |     await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(p.x, p.y), point(p.x + 40, p.y, 2)] });
  134 |     await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] }); await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
  135 |     const draft = page.getByRole("textbox", { name: "밝기 수치" }); await draft.fill("31");
  136 |     const clear = page.getByRole("button", { name: "선택 해제", exact: true }); const clearBounds = await scrollTo(page, clear);
  137 |     await expectMinimumTouchTargets(page, "[data-target-selection-detail-panel] button");
  138 |     await clear.tap(); await expect(draft).toHaveValue("31"); expect(writes).toEqual([]); await expectNoHorizontalOverflow(page);
  139 |     await evidence(page, info, "manual-touch-dark-short", { camera: await camera(map), clearBounds });
  140 |   } catch (error) {
  141 |     await evidence(page, info, "manual-touch-original-failure", { error: String(error) });
  142 |     throw error;
  143 |   } finally { await context.close(); }
  144 | });
  145 | 
  146 | test("interactions 3 monitoring merged finder searches numbers filters and keeps five legends", async ({ page }, info) => {
  147 |   await page.setViewportSize({ width: 1440, height: 900 }); const writes = await customer(page); await page.goto(`/monitoring?siteId=${siteId}`);
  148 |   const map = await mapReady(page, false); const opener = page.getByRole("button", { name: "조명 검색/목록", exact: true }); await expect(opener).toHaveCount(1);
  149 |   for (const label of ["정상", "장애", "오프라인", "상태 확인 대기", "조명 정보 확인 전"]) await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  150 |   await expect(page.locator("header")).toContainText(siteName); await expect(page.locator("header")).not.toContainText("표시하지 않을 고객사");
  151 |   await opener.click(); const finder = page.getByRole("region", { name: "조명 검색 및 목록", exact: true });
  152 |   await finder.getByRole("searchbox", { name: "조명 이름 또는 번호 검색" }).fill("02"); await expect(finder.getByRole("list", { name: "조명 목록" }).getByRole("button")).toHaveCount(1);
  153 |   await finder.getByRole("button", { name: /B2-L02/ }).click(); await expect(finder).toHaveCount(0); await expect(marker(page, 1)).toHaveAttribute("aria-pressed", "true");
  154 |   await opener.click(); await finder.getByRole("searchbox").fill(""); await finder.getByRole("button", { name: /상태 필터/ }).click(); await page.getByRole("option", { name: "오프라인", exact: true }).click();
  155 |   await expect(finder.getByText("오프라인 조명이 없습니다.", { exact: true })).toBeVisible(); await finder.getByRole("button", { name: "전체 조명 보기", exact: true }).click();
  156 |   await expect(finder.getByRole("list", { name: "조명 목록" }).getByRole("button")).toHaveCount(3);
  157 |   await page.keyboard.press("Escape"); await expect(opener).toBeFocused(); expect(writes).toEqual([]); await expectNoHorizontalOverflow(page);
  158 |   await evidence(page, info, "monitoring-finder-legend", { map: await map.boundingBox(), camera: await camera(map), opener: await hit(page, opener) });
  159 | });
  160 | 
  161 | test("interactions 4 mobile sheet nested calendar focus dates stay one line at 390 and 320", async ({ page }, info) => {
  162 |   const writes = await customer(page, true); await page.setViewportSize({ width: 390, height: 600 }); await page.goto(`/statistics?siteId=${siteId}`); await statsReady(page);
  163 |   for (const width of [390, 320]) {
  164 |     await page.setViewportSize({ width, height: 600 }); const opener = page.getByRole("button", { name: /^절감 비교 기간 상세 필터/ }); await opener.click();
  165 |     const sheet = page.getByRole("dialog", { name: "절감 비교 기간", exact: true }); await expect(sheet).toBeVisible();
  166 |     await expect.poll(async () => { const r = (await sheet.boundingBox())!; return Math.abs(r.y + r.height - 600); }).toBeLessThanOrEqual(1);
  167 |     const group = sheet.getByRole("group", { name: "완료 기간 시작일과 종료일", exact: true });
  168 |     const segments = group.getByRole("spinbutton"); await expect(segments).toHaveCount(6);
  169 |     await segments.first().click(); await page.keyboard.press("ArrowRight");
  170 |     expect(await group.evaluate(el => el.contains(document.activeElement))).toBe(true);
  171 |     const rects = await segments.evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, height: r.height }; }));
  172 |     expect(Math.max(...rects.map(r => r.y)) - Math.min(...rects.map(r => r.y))).toBeLessThanOrEqual(1);
  173 |     for (let i = 1; i < rects.length; i++) expect(rects[i].x).toBeGreaterThanOrEqual(rects[i - 1].right);
  174 |     const calendar = group.getByRole("button"); await expectMinimumTouchTargets(page, `[id="${await group.getAttribute("id")}"] button`);
  175 |     await calendar.click(); await expect(page.getByRole("grid")).toBeVisible(); await page.keyboard.press("Escape"); await expect(calendar).toBeFocused(); await expect(sheet).toBeVisible();
  176 |     const close = sheet.getByRole("button", { name: "필터 닫기", exact: true }); await close.scrollIntoViewIfNeeded(); const closeBounds = await hit(page, close);
  177 |     await evidence(page, info, `filter-sheet-${width}`, { sheet: await sheet.boundingBox(), dates: rects, group: await group.boundingBox(), closeBounds });
  178 |     await close.click(); await expect(opener).toBeFocused(); await expectNoHorizontalOverflow(page);
  179 |   }
  180 |   expect(writes).toEqual([]);
  181 | });
  182 | 
  183 | test("interactions 5 dark reports 577 summary expands below stable row and preserves actions", async ({ page }, info) => {
  184 |   await page.setViewportSize({ width: 577, height: 900 }); const writes = await customer(page, true, true);
  185 |   const complete = { ...browserReport("completed"), siteId, target: { scope: "site" as const, identityId: siteId, label: "완료 현장" } };
  186 |   const failed = { ...browserReport("failed"), reportId: "30000000-0000-4000-8000-000000000042", siteId, target: { scope: "site" as const, identityId: siteId, label: "실패 현장" } };
  187 |   await page.route("**/energy/sites/*/reports*", route => route.fulfill({ json: { reports: [complete, failed], nextCursor: null, totalCount: 2 } }));
  188 |   await page.goto(`/statistics/reports?siteId=${siteId}`); const jobs = page.getByRole("region", { name: "요청한 보고서", exact: true }); await expect(jobs).toContainText("완료 현장"); await expect(jobs).not.toHaveAttribute("aria-busy", "true");
  189 |   const toggle = jobs.getByRole("button", { name: "완료 현장 보고서 상세보기", exact: true }); await expect(toggle).toHaveAttribute("aria-expanded", "false");
  190 |   await expect(jobs.getByText("요청 시각", { exact: true })).toHaveCount(0); await expect(jobs.getByText("파일 만료 시각", { exact: true })).toHaveCount(0);
  191 |   await expect(jobs.getByRole("button", { name: "완료 현장 보고서 다운로드", exact: true })).toBeEnabled(); await expect(jobs.getByRole("button", { name: "실패 현장 보고서 다시 생성", exact: true })).toBeEnabled();
  192 |   await toggle.click(); const detail = jobs.getByRole("region", { name: "완료 현장 보고서 상세보기", exact: true }); await expect(detail).toContainText("요청 시각"); await expect(detail).toContainText("파일 만료 시각");
  193 |   const toggleBounds = (await toggle.boundingBox())!, detailBounds = (await detail.boundingBox())!; expect(detailBounds.y).toBeGreaterThanOrEqual(toggleBounds.y + toggleBounds.height);
  194 |   await expect(jobs.locator('time[datetime="2026-09-01"]')).toHaveCount(2); await expectNoHorizontalOverflow(page);
  195 |   await evidence(page, info, "reports-dark-577-details", { toggleBounds, detailBounds, download: await jobs.getByRole("button", { name: "완료 현장 보고서 다운로드", exact: true }).boundingBox() });
  196 |   await toggle.click(); await expect(detail).toHaveCount(0); expect(writes).toEqual([]);
  197 | });
  198 | 
  199 | test("interactions 6 overview title chart ticks and unchanged C8 content at PC and mobile", async ({ page }, info) => {
  200 |   const writes = await customer(page, true); await page.setViewportSize({ width: 1440, height: 900 }); await page.goto(`/statistics?siteId=${siteId}`); await statsReady(page);
  201 |   await expect(page.getByRole("heading", { name: "사용량 개요", exact: true })).toHaveClass(/sr-only/);
  202 |   const card = page.getByRole("region", { name: "운영 인사이트", exact: true });
  203 |   for (const text of ["43,200초", "2,073,600초", "20,000,000초", "7,200초", "10개", "현장 시간대 Asia/Seoul · 조명 상태 기록 기준 · 실측 전력 아님"]) await expect(card).toContainText(text);
  204 |   const original = await card.innerText();
  205 |   for (const width of [1440, 390]) {
> 206 |     await page.setViewportSize({ width, height: 900 }); await statsReady(page); await expect(card).toHaveText(original);
      |                                                                                                    ^ Error: expect(locator).toHaveText(expected) failed
  207 |     const chart = page.getByRole("img", { name: "일별 상태 기반 추정 전력 사용량 꺾은선 차트", exact: true }); await chart.scrollIntoViewIfNeeded();
  208 |     const ticks = await chart.locator(".recharts-cartesian-axis-tick text").evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { text: el.textContent, x: r.x, y: r.y, right: r.right, bottom: r.bottom }; })); expect(ticks.length).toBeGreaterThan(2);
  209 |     const bounds = (await chart.boundingBox())!;
  210 |     for (const tick of ticks) { expect(tick.x).toBeGreaterThanOrEqual(bounds.x); expect(tick.right).toBeLessThanOrEqual(bounds.x + bounds.width); }
  211 |     for (let a = 0; a < ticks.length; a++) for (let b = a + 1; b < ticks.length; b++) expect(ticks[a].right <= ticks[b].x || ticks[b].right <= ticks[a].x || ticks[a].bottom <= ticks[b].y || ticks[b].bottom <= ticks[a].y).toBe(true);
  212 |     await expectNoHorizontalOverflow(page); await evidence(page, info, `overview-${width}`, { chart: bounds, ticks, C8: original });
  213 |   }
  214 |   expect(writes).toEqual([]);
  215 | });
  216 | 
```