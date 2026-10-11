# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: atlas-interactions-comments.spec.ts >> interactions 6 overview title chart ticks and unchanged C8 content at PC and mobile
- Location: e2e/atlas-interactions-comments.spec.ts:205:1

# Error details

```
Error: expect(received).toBeGreaterThan(expected)

Expected: > 2
Received:   0
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
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
        - generic [ref=e38]: 통계
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
      - region "통계" [ref=e73]:
        - navigation "통계 메뉴" [ref=e74]:
          - generic [ref=e75]:
            - link "개요" [ref=e76] [cursor=pointer]:
              - /url: /statistics/overview?siteId=00000000-0000-4000-8000-000000000003
              - generic [ref=e78]: 개요
            - link "사용 분석" [ref=e79] [cursor=pointer]:
              - /url: /statistics/analysis?siteId=00000000-0000-4000-8000-000000000003
              - generic [ref=e81]: 사용 분석
            - link "보고서" [ref=e82] [cursor=pointer]:
              - /url: /statistics/reports?siteId=00000000-0000-4000-8000-000000000003
              - generic [ref=e84]: 보고서
        - region "에너지 통계" [ref=e85]:
          - heading "사용량 개요" [level=1] [ref=e86]
          - region "기준 대비 에너지 절감" [ref=e87]:
            - region "절감 비교 기간" [ref=e89]:
              - button "절감 비교 기간 상세 필터, 활성 조건 0개" [ref=e91]:
                - img [ref=e92]
                - generic [ref=e93]: 필터
              - generic [ref=e94]:
                - heading "기준 대비 에너지 절감" [level=3] [ref=e95]
                - paragraph [ref=e96]: 2026-08-01 ~ 2026-08-31
            - generic [ref=e97]:
              - generic [ref=e98]:
                - group "에너지 절감률" [ref=e100]:
                  - generic [ref=e102]: 에너지 절감률
                  - strong [ref=e103]: 35 %
                  - paragraph [ref=e104]: 24시간 100% 기준 대비 절감
                - group "예상 사용량" [ref=e106]:
                  - generic [ref=e108]: 예상 사용량
                  - strong [ref=e109]: 65 kWh
                  - paragraph [ref=e110]: 기준 100 kWh
                - group "예상 절감 전력" [ref=e112]:
                  - generic [ref=e114]: 예상 절감 전력
                  - strong [ref=e115]: 35 kWh
                  - paragraph [ref=e116]: 24시간 100% 운전 기준
                - group "예상 절감 비용" [ref=e118]:
                  - generic [ref=e120]: 예상 절감 비용
                  - strong [ref=e121]: 5,600원
                  - paragraph [ref=e122]: 현재 설정 단가 기준
              - group "기준 및 동기간 비교" [ref=e123]:
                - region "기준 대비 사용량 비교" [ref=e124]:
                  - heading "완료 기간 추정·예상 사용량 비교" [level=2] [ref=e126]
                  - img "기준 대비 에너지 사용량 비교 차트" [ref=e127]:
                    - application [ref=e130]:
                      - generic [ref=e139]:
                        - generic [ref=e142]: 8/25
                        - generic [ref=e143]:
                          - generic [ref=e145]: 0 kWh
                          - generic [ref=e147]: 25 kWh
                          - generic [ref=e149]: 50 kWh
                          - generic [ref=e151]: 75 kWh
                          - generic [ref=e153]: 100 kWh
                  - generic [ref=e154]:
                    - generic [ref=e155]: 완료 기간 추정 사용량
                    - generic [ref=e156]: 기준 사용량
                    - generic [ref=e157]: 예상 사용량
                  - paragraph [ref=e159]: 24시간 100% · 현재 등록 조명 기준
                  - list "기준 대비 에너지 비교 데이터" [ref=e160]:
                    - listitem [ref=e161]: "2026년 8월 25일: 기준 100 kWh, 예상 65 kWh, 절감 35 kWh, 절감률 35%, 수집률 92%"
                - complementary "동기간 비교" [ref=e162]:
                  - heading "이전 기간과 비교" [level=2] [ref=e164]
                  - generic [ref=e165]:
                    - group "직전 동기간 비교" [ref=e166]:
                      - strong [ref=e167]: 직전 동기간 비교
                      - generic [ref=e168]:
                        - img [ref=e169]
                        - generic [ref=e173]: 비교 불가
                      - paragraph [ref=e174]: 비교 가능한 사용량 데이터가 없습니다.
                    - group "전년 동기간 비교" [ref=e175]:
                      - strong [ref=e176]: 전년 동기간 비교
                      - generic [ref=e177]:
                        - img [ref=e178]
                        - generic [ref=e182]: 비교 불가
                      - paragraph [ref=e183]: 비교 가능한 사용량 데이터가 없습니다.
                  - paragraph [ref=e184]: 조명 구성 변화 미보정
          - region "오늘 사용량과 비용" [ref=e185]:
            - generic [ref=e187]:
              - heading "오늘 사용량과 비용" [level=3] [ref=e188]
              - paragraph [ref=e189]: Asia/Seoul · 마지막 집계 2026-08-26 09:00:00
            - group "에너지 요약" [ref=e190]:
              - group "오늘 전력 사용량" [ref=e192]:
                - generic [ref=e194]: 오늘 전력 사용량
                - strong [ref=e195]: 4.25 kWh
                - paragraph [ref=e196]: 680원 · 상태 기반 추정 · 오늘 00:00~09:00 · 진행 중
                - generic [ref=e197]:
                  - img [ref=e198]
                  - generic [ref=e201]: 수집 완료
              - group "이번 달 누적 전력 사용량" [ref=e203]:
                - generic [ref=e205]: 이번 달 누적 전력 사용량
                - strong [ref=e206]: 120.5 kWh
                - paragraph [ref=e207]: 19,280원 · 상태 기반 추정 · 2026-08-01 ~ 2026-08-26
                - generic [ref=e208]:
                  - img [ref=e209]
                  - generic [ref=e211]: 수집 공백 있음
              - group "올해 누적 전력 사용량" [ref=e213]:
                - generic [ref=e215]: 올해 누적 전력 사용량
                - strong [ref=e216]: 900 kWh
                - paragraph [ref=e217]: 144,000원 · 상태 기반 추정 · 2026-01-01 ~ 2026-08-26
                - generic [ref=e218]:
                  - img [ref=e219]
                  - generic [ref=e221]: 수집 공백 있음
            - paragraph [ref=e222]: 누적·일별·월별 비용은 당시 적용 단가의 저장 비용입니다.
            - group "사용량 및 비용" [ref=e223]:
              - region "상태 기반 추정 사용량" [ref=e224]:
                - generic [ref=e225]:
                  - generic [ref=e226]:
                    - paragraph [ref=e227]: 일별 사용량 추이
                    - generic [ref=e228]:
                      - heading "상태 기반 추정 사용량" [level=3] [ref=e229]
                      - 'generic "결측·수집 공백: 선이 끊긴 기간은 수집 데이터가 없으며, 수집 공백이 있는 기간은 추정값이 불완전할 수 있습니다." [ref=e230]':
                        - img [ref=e231]
                        - generic [ref=e233]: 결측·수집 공백
                    - paragraph [ref=e234]: 2026-08-01 ~ 2026-08-31
                  - region "사용량 조회 단위" [ref=e235]:
                    - button "사용량 조회 단위 상세 필터, 활성 조건 0개" [ref=e237]:
                      - img [ref=e238]
                      - generic [ref=e239]: 필터
                    - button "필터 초기화" [ref=e241] [cursor=pointer]
                - img "일별 상태 기반 추정 전력 사용량 꺾은선 차트" [ref=e242]:
                  - application [ref=e245]:
                    - generic [ref=e257]:
                      - generic [ref=e258]:
                        - generic [ref=e260]: 8/25
                        - generic [ref=e262]: 8/26
                        - generic [ref=e264]: 8/27
                      - generic [ref=e265]:
                        - generic [ref=e267]: 0 kWh
                        - generic [ref=e269]: 2 kWh
                        - generic [ref=e271]: 4 kWh
                        - generic [ref=e273]: 6 kWh
                        - generic [ref=e275]: 8 kWh
                - list "차트 데이터 및 수집 상태" [ref=e276]:
                  - listitem [ref=e277]: "2026년 8월 25일: 4.1 kWh, 656원"
                  - listitem [ref=e278]: "2026년 8월 26일: 4.25 kWh, 680원, 수집 공백 2시간 0분"
                  - listitem [ref=e279]: "2026년 8월 27일: 수집 데이터 없음"
          - generic [ref=e280]:
            - complementary "비용 비교" [ref=e281]:
              - heading "이번 달 비용 비교" [level=2] [ref=e282]
              - generic [ref=e283]:
                - generic [ref=e284]:
                  - term [ref=e285]: 24시간 100% 기준 비용
                  - definition [ref=e286]: 47,616원
                  - generic [ref=e287]: 297.6 kWh
                - generic [ref=e290]:
                  - term [ref=e291]: 이번 달 예상 비용
                  - definition [ref=e292]: 25,600원
                  - generic [ref=e293]: 160 kWh
                - generic [ref=e296]:
                  - term [ref=e297]: 예상 절감
                  - definition [ref=e298]: 22,016원
                  - generic [ref=e299]: 137.6 kWh
              - paragraph [ref=e300]: 예상·기준·절감 비용은 현재 설정 단가 기준입니다.
            - region "운영 인사이트" [ref=e301]:
              - heading "운영 인사이트" [level=2] [ref=e302]
              - generic [ref=e303]:
                - group "오늘 수집 품질" [ref=e304]:
                  - term [ref=e305]:
                    - generic [ref=e306]: 오늘 · 알려진 상태시간
                  - definition [ref=e307]: 43,200초
                  - term [ref=e308]: 수집 공백
                  - definition [ref=e309]: 0초
                - group "이번 달 누적 수집 품질" [ref=e310]:
                  - term [ref=e311]:
                    - generic [ref=e312]: 이번 달 누적 · 알려진 상태시간
                  - definition [ref=e313]: 2,073,600초
                  - term [ref=e314]: 수집 공백
                  - definition [ref=e315]: 7,200초
                - group "올해 누적 수집 품질" [ref=e316]:
                  - term [ref=e317]:
                    - generic [ref=e318]: 올해 누적 · 알려진 상태시간
                  - definition [ref=e319]: 20,000,000초
                  - term [ref=e320]: 수집 공백
                  - definition [ref=e321]: 7,200초
              - generic [ref=e322]:
                - generic [ref=e323]:
                  - term [ref=e324]: 최근 집계
                  - definition [ref=e325]:
                    - time [ref=e327]: 2026-08-26 09:00:00
                - generic [ref=e328]:
                  - term [ref=e329]: 기준 조명 수
                  - definition [ref=e330]: 10개
              - paragraph [ref=e331]: 현장 시간대 Asia/Seoul · 조명 상태 기록 기준 · 실측 전력 아님
  - generic [ref=e332]: "2"
```

# Test source

```ts
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
  154 |   await finder.getByRole("button", { name: /B2-L02/ }).click(); await expect(finder).toHaveCount(0); await expect(marker(page, 1)).toHaveAttribute("aria-pressed", "true");
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
> 214 |     const ticks = await chart.locator(".recharts-cartesian-axis-tick text").evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { text: el.textContent, x: r.x, y: r.y, right: r.right, bottom: r.bottom }; })); expect(ticks.length).toBeGreaterThan(2);
      |                                                                                                                                                                                                                                                                   ^ Error: expect(received).toBeGreaterThan(expected)
  215 |     const bounds = (await chart.boundingBox())!;
  216 |     for (const tick of ticks) { expect(tick.x).toBeGreaterThanOrEqual(bounds.x); expect(tick.right).toBeLessThanOrEqual(bounds.x + bounds.width); }
  217 |     for (let a = 0; a < ticks.length; a++) for (let b = a + 1; b < ticks.length; b++) expect(ticks[a].right <= ticks[b].x || ticks[b].right <= ticks[a].x || ticks[a].bottom <= ticks[b].y || ticks[b].bottom <= ticks[a].y).toBe(true);
  218 |     await expectNoHorizontalOverflow(page); await evidence(page, info, `overview-${width}`, { chart: bounds, ticks, C8: original });
  219 |   }
  220 |   expect(writes).toEqual([]);
  221 | });
  222 | 
```