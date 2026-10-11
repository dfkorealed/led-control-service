# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: atlas-interactions-comments.spec.ts >> interactions 3 monitoring merged finder searches numbers filters and keeps five legends
- Location: e2e/atlas-interactions-comments.spec.ts:146:1

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('header')
Expected substring: "물류센터 B2 현장"
Error: strict mode violation: locator('header') resolved to 2 elements:
    1) <header data-shell-topbar="true" class="sticky top-0 z-10 grid min-h-16 min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1 gap-y-1 border-b border-border-default bg-surface-panel px-2 py-1 compact:grid-cols-[minmax(0,1fr)_auto_auto] compact:gap-x-4 compact:px-7 compact:py-2">…</header> aka getByText('모니터링물류센터 B2 현장물류센터 B2')
    2) <header class="flex items-start justify-between max-compact:flex-col max-compact:items-stretch gap-5 max-compact:gap-3 max-compact:order-0">…</header> aka getByText('모니터링마지막 갱신: 2026-10-12 00:07:')

Call log:
  - Expect "toContainText" with timeout 5000ms
  - waiting for locator('header')

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - complementary [ref=e4]:
    - generic [ref=e5]:
      - img "킨다 관제 센터" [ref=e6]:
        - img [ref=e7]
        - strong [ref=e8]: 킨다
        - generic [ref=e9]: 관제 센터
      - button "사이드바 접기" [expanded] [ref=e11] [cursor=pointer]:
        - img [ref=e12]
    - navigation "주 메뉴" [ref=e15]:
      - link "모니터링" [ref=e17] [cursor=pointer]:
        - /url: /monitoring?siteId=00000000-0000-4000-8000-000000000003
        - img [ref=e18]
        - generic [ref=e20]: 모니터링
      - link "제어" [ref=e22] [cursor=pointer]:
        - /url: /control?siteId=00000000-0000-4000-8000-000000000003
        - img [ref=e23]
        - generic [ref=e24]: 제어
      - link "통계" [ref=e26] [cursor=pointer]:
        - /url: /statistics/overview?siteId=00000000-0000-4000-8000-000000000003
        - img [ref=e27]
        - generic [ref=e29]: 통계
      - link "설정" [ref=e31] [cursor=pointer]:
        - /url: /settings?siteId=00000000-0000-4000-8000-000000000003
        - img [ref=e32]
        - generic [ref=e35]: 설정
  - main [ref=e36]:
    - generic [ref=e37]:
      - generic [ref=e38]: 모니터링
      - generic "현장 정보" [ref=e39]:
        - paragraph [ref=e40]: 물류센터 B2 현장
        - generic [ref=e41]: 물류센터 B2 현장
      - generic [ref=e42]:
        - button "알람센터, 확인 불가" [ref=e44] [cursor=pointer]:
          - img [ref=e45]
          - generic [ref=e48]: "?"
        - button "다크 모드로 변경" [ref=e49] [cursor=pointer]:
          - img [ref=e50]
        - link "내 계정 및 보안" [ref=e52] [cursor=pointer]:
          - /url: /settings/security?siteId=00000000-0000-4000-8000-000000000003
          - img [ref=e53]
      - region "현장 전체" [ref=e56]:
        - heading "현장 전체" [level=2] [ref=e57]
        - paragraph [ref=e58]: 물류센터 B2 현장
        - generic [ref=e59]:
          - generic [ref=e60]:
            - term [ref=e61]: 전체
            - definition [ref=e62]: 3대
          - generic [ref=e63]:
            - term [ref=e64]: 온라인
            - definition [ref=e65]: 3대
          - generic [ref=e66]:
            - term [ref=e67]: 장애
            - definition [ref=e68]: 0대
          - generic [ref=e69]:
            - term [ref=e70]: 오프라인
            - definition [ref=e71]: —
    - generic [ref=e73]:
      - generic [ref=e74]:
        - heading "모니터링" [level=1] [ref=e76]
        - generic [ref=e77]:
          - generic [ref=e78]:
            - text: "마지막 갱신:"
            - time [ref=e79]: 2026-10-12 00:07:09 (현장 시간)
          - button "새로고침" [ref=e80] [cursor=pointer]:
            - img [ref=e81]
            - text: 새로고침
      - group "모니터링 도구" [ref=e86]:
        - generic [ref=e87]:
          - generic [ref=e88]: 맵 선택
          - generic [ref=e89]:
            - button "맵 선택" [ref=e90]:
              - generic [ref=e91]: B2
              - generic [ref=e92]: ▾
            - combobox [ref=e95]
        - button "조명 검색/목록" [ref=e96] [cursor=pointer]:
          - img [ref=e97]
          - text: 조명 검색/목록
      - generic [ref=e100]:
        - generic [ref=e101]:
          - region "선택 층 조명 현황" [ref=e104]:
            - group "B2 · 조명 현황" [ref=e105]:
              - generic [ref=e106]:
                - generic [ref=e108]: 전체 조명
                - strong [ref=e109]: —
              - generic [ref=e110]:
                - generic [ref=e112]: 정상
                - strong [ref=e113]: —
              - generic [ref=e114]:
                - generic [ref=e116]: 점검 필요
                - strong [ref=e117]: —
              - generic [ref=e118]:
                - generic [ref=e120]: 오프라인
                - strong [ref=e121]: —
          - region "층 도면" [ref=e123]:
            - generic [ref=e125]:
              - region "상하좌우로 이동하고 확대 축소할 수 있는 지도" [ref=e126]:
                - generic [ref=e128]:
                  - generic:
                    - img
                  - generic [ref=e129]:
                    - button "B2-L01 정상 70%" [ref=e131] [cursor=pointer]
                    - button "B2-L02 정상 65%" [ref=e132] [cursor=pointer]
                    - button "B2-L03 정상 40%" [ref=e133] [cursor=pointer]
              - generic [ref=e134]:
                - generic [ref=e135]:
                  - list "조명 상태 범례":
                    - listitem:
                      - img
                      - generic: 정상
                    - listitem:
                      - img
                      - generic: 장애
                    - listitem:
                      - img
                      - generic: 오프라인
                    - listitem:
                      - img
                      - generic: 상태 확인 대기
                    - listitem:
                      - img
                      - generic: 조명 정보 확인 전
                - group "지도 조작" [ref=e136]:
                  - button "지도 축소" [ref=e137] [cursor=pointer]:
                    - img [ref=e138]
                  - button "지도 배율 100%" [ref=e139] [cursor=pointer]: 100%
                  - button "지도 확대" [ref=e140] [cursor=pointer]:
                    - img [ref=e141]
                  - button "지도 전체 보기" [ref=e142] [cursor=pointer]:
                    - img [ref=e143]
        - region "최근 운영 로그" [ref=e148]:
          - region "최근 활동" [ref=e149]:
            - generic [ref=e150]: 최근 활동
            - paragraph [ref=e152]: 운영 활동을 불러오지 못했습니다.
            - button "다시 조회" [ref=e153] [cursor=pointer]
            - button "전체 보기" [ref=e154] [cursor=pointer]:
              - text: 전체 보기
              - img [ref=e155]
```

# Test source

```ts
  50  |     const r = el.getBoundingClientRect();
  51  |     for (const x of [.35, .55, .75]) for (const y of [.35, .55, .75]) {
  52  |       const p = { x: r.x + r.width * x, y: r.y + r.height * y };
  53  |       const hit = document.elementFromPoint(p.x, p.y);
  54  |       if (hit?.closest("[data-floor-map-surface]") && !hit.closest("button")) return p;
  55  |     }
  56  |     throw new Error("No reachable map blank point");
  57  |   });
  58  | }
  59  | async function mapReady(page: Page, manual = true) {
  60  |   const map = page.getByTestId(manual ? "target-selection-map-viewport" : "monitoring-map-viewport");
  61  |   await expect(map.locator("canvas").first()).toBeVisible();
  62  |   await expect(marker(page)).toBeVisible();
  63  |   return map;
  64  | }
  65  | async function hit(page: Page, target: Locator) {
  66  |   await expect(target).toBeVisible();
  67  |   const bounds = await target.boundingBox(); expect(bounds).not.toBeNull();
  68  |   expect(await target.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
  69  |   expect(bounds!.y).toBeGreaterThanOrEqual(0); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  70  |   return bounds;
  71  | }
  72  | async function scrollTo(page: Page, target: Locator) {
  73  |   // Real wheel in the control/body hotzone, not the canvas gesture surface.
  74  |   for (let i = 0; i < 8; i++) {
  75  |     const visible = await target.evaluate(el => { const r = el.getBoundingClientRect(); const nav = document.querySelector("[data-customer-bottom-nav]")?.getBoundingClientRect(); return r.y >= 0 && r.bottom <= (nav?.top ?? innerHeight); });
  76  |     if (visible) break;
  77  |     await page.mouse.move(8, 300); await page.mouse.wheel(0, 500);
  78  |   }
  79  |   return hit(page, target);
  80  | }
  81  | async function statsReady(page: Page) {
  82  |   await expect(page.getByRole("group", { name: "에너지 요약", exact: true })).toContainText("4.25");
  83  |   await expect(page.getByRole("img", { name: "일별 상태 기반 추정 전력 사용량 꺾은선 차트", exact: true }).locator("svg")).toBeVisible();
  84  |   await expect(page.getByText("사용량 추이를 불러오는 중", { exact: true })).toHaveCount(0);
  85  | }
  86  | 
  87  | test("interactions 1 PC manual native CAD gestures preserve selection and raw draft", async ({ page }, info) => {
  88  |   await page.setViewportSize({ width: 1440, height: 900 }); const writes = await customer(page);
  89  |   await page.goto(`/control?siteId=${siteId}`); const map = await mapReady(page);
  90  |   await expect(page.getByRole("button", { name: "조명 목록", exact: true })).toBeVisible();
  91  |   for (const name of ["이동", "개별 선택", "영역 선택", "구역 관리"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  92  |   await marker(page).click(); await expect(marker(page)).toHaveAttribute("aria-pressed", "true");
  93  |   await marker(page).click(); await expect(marker(page)).toHaveAttribute("aria-pressed", "false");
  94  |   await marker(page).click();
  95  |   const draft = page.getByRole("textbox", { name: "밝기 수치" }); await draft.fill("31");
  96  |   let p = await blank(map); await map.focus(); await page.mouse.move(p.x, p.y); await page.mouse.down();
  97  |   await page.mouse.move(p.x + 7, p.y); await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
  98  |   await page.mouse.move(p.x + 8, p.y); await expect(page.getByTestId("map-area-selection")).toBeVisible();
  99  |   await page.keyboard.press("Escape"); await page.mouse.up(); await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
  100 |   const pin = (await marker(page, 1).boundingBox())!;
  101 |   await page.mouse.move(pin.x - 6, pin.y - 6); await page.mouse.down(); await page.mouse.move(pin.x + pin.width + 6, pin.y + pin.height + 6, { steps: 6 }); await page.mouse.up();
  102 |   await expect(marker(page, 1)).toHaveAttribute("aria-pressed", "true");
  103 |   const beforeZoom = await camera(map); p = await blank(map); await page.mouse.move(p.x, p.y); await page.mouse.wheel(0, -120);
  104 |   await expect.poll(() => map.getAttribute("data-zoom")).not.toBe(beforeZoom.zoom);
  105 |   for (let i = 0; i < 12; i++) await page.getByRole("button", { name: "지도 확대", exact: true }).click();
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
> 150 |   await expect(page.locator("header")).toContainText(siteName); await expect(page.locator("header")).not.toContainText("표시하지 않을 고객사");
      |                                        ^ Error: expect(locator).toContainText(expected) failed
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
  206 |     await page.setViewportSize({ width, height: 900 }); await statsReady(page); await expect(card).toHaveText(original);
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