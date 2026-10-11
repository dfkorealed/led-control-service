# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: atlas-ui-fidelity.spec.ts >> browser comments dark mobile reports: common search reset CSV and filters remain reachable
- Location: e2e/atlas-ui-fidelity.spec.ts:470:1

# Error details

```
Error: expect(received).toBeLessThanOrEqual(expected)

Expected: <= 776
Received:    844
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - navigation "모바일 주 메뉴" [ref=e4]:
    - link "모니터링" [ref=e6] [cursor=pointer]:
      - /url: /monitoring?limit=20&query=parking&siteId=00000000-0000-4000-8000-000000000003
      - img [ref=e7]
      - generic [ref=e9]: 모니터링
    - link "제어" [ref=e11] [cursor=pointer]:
      - /url: /control?limit=20&query=parking&siteId=00000000-0000-4000-8000-000000000003
      - img [ref=e12]
      - generic [ref=e13]: 제어
    - link "통계" [ref=e15] [cursor=pointer]:
      - /url: /statistics/overview?limit=20&query=parking&siteId=00000000-0000-4000-8000-000000000003
      - img [ref=e16]
      - generic [ref=e18]: 통계
    - link "설정" [ref=e20] [cursor=pointer]:
      - /url: /settings?limit=20&query=parking&siteId=00000000-0000-4000-8000-000000000003
      - img [ref=e21]
      - generic [ref=e24]: 설정
  - main [ref=e25]:
    - generic [ref=e26]:
      - generic [ref=e27]: 통계
      - generic "현장 정보" [ref=e28]:
        - img "킨다" [ref=e29]:
          - img [ref=e30]
          - strong [ref=e31]: 킨다
        - paragraph [ref=e32]: 고객사 · 고객사 B2 현장 입구 물류센터 조명 관리 구역고객사 B2 현장 입구 물류센터 조명 관리 구역고객사 B2 현장 입구 물류센터 조명 관리 구역
        - generic [ref=e33]: Demo Underground Parking
      - generic [ref=e34]:
        - button "알람센터, 확인 불가" [ref=e36] [cursor=pointer]:
          - img [ref=e37]
          - generic [ref=e40]: "?"
        - button "라이트 모드로 변경" [pressed] [ref=e41] [cursor=pointer]:
          - img [ref=e42]
      - region "현장 전체" [ref=e48]:
        - heading "현장 전체" [level=2] [ref=e49]
        - paragraph [ref=e50]: 고객사 B2 현장 입구 물류센터 조명 관리 구역고객사 B2 현장 입구 물류센터 조명 관리 구역고객사 B2 현장 입구 물류센터 조명 관리 구역
        - generic [ref=e51]:
          - generic [ref=e52]:
            - term [ref=e53]: 전체
            - definition [ref=e54]: 16대
          - generic [ref=e55]:
            - term [ref=e56]: 온라인
            - definition [ref=e57]: 14대
          - generic [ref=e58]:
            - term [ref=e59]: 장애
            - definition [ref=e60]: 1대
          - generic [ref=e61]:
            - term [ref=e62]: 오프라인
            - definition [ref=e63]: —
    - region "통계" [ref=e65]:
      - navigation "통계 메뉴" [ref=e66]:
        - generic [ref=e67]:
          - link "개요" [ref=e68] [cursor=pointer]:
            - /url: /statistics/overview?limit=20&query=parking&siteId=00000000-0000-4000-8000-000000000003
            - generic [ref=e70]: 개요
          - link "사용 분석" [ref=e71] [cursor=pointer]:
            - /url: /statistics/analysis?limit=20&query=parking&siteId=00000000-0000-4000-8000-000000000003
            - generic [ref=e73]: 사용 분석
          - link "보고서" [ref=e74] [cursor=pointer]:
            - /url: /statistics/reports?limit=20&query=parking&siteId=00000000-0000-4000-8000-000000000003
            - generic [ref=e76]: 보고서
      - region "에너지 보고서" [ref=e77]:
        - generic [ref=e78]:
          - heading "보고서" [level=1] [ref=e80]
          - button "보고서 만들기" [ref=e82] [cursor=pointer]:
            - img [ref=e83]
            - text: 보고서 만들기
        - search "보고서 이력 필터" [ref=e86]:
          - region "보고서 조건" [ref=e87]:
            - generic [ref=e88]:
              - generic [ref=e90]:
                - generic [ref=e91]: 보고서 검색
                - searchbox "보고서 검색" [ref=e93]: parking
              - button "보고서 조건 상세 필터, 활성 조건 0개" [ref=e94]:
                - img [ref=e95]
                - generic [ref=e96]: 필터
            - generic "활성 조건" [ref=e98]:
              - generic [ref=e99]: 활성 조건
              - 'button "검색: parking 조건 제거" [ref=e100] [cursor=pointer]':
                - generic [ref=e101]: "검색: parking"
                - generic [ref=e102]: ×
            - generic [ref=e103]:
              - button "필터 초기화" [ref=e104] [cursor=pointer]
              - button "전체 초기화" [ref=e105] [cursor=pointer]
              - button "CSV 내보내기" [ref=e106] [cursor=pointer]:
                - img [ref=e107]
                - text: CSV 내보내기
        - region "보고서 이력" [ref=e110]:
          - group [ref=e111]:
            - region "요청한 보고서" [ref=e112]:
              - generic [ref=e113]:
                - generic [ref=e114]:
                  - paragraph [ref=e115]: 현재 목록 안에서 정렬
                  - generic [ref=e116]:
                    - generic [ref=e118]:
                      - button "기본 순서 정렬 기준 · 현재 목록 안에서 정렬" [ref=e119]:
                        - generic [ref=e120]: 기본 순서
                        - generic [ref=e121]: ▾
                      - combobox [ref=e124]
                    - button "오름차순으로 변경" [disabled] [ref=e125]:
                      - img [ref=e126]
                      - text: 오름차순
                - list "보고서 생성 이력" [ref=e128]:
                  - listitem [ref=e129]:
                    - generic [ref=e130]:
                      - generic [ref=e131]:
                        - term [ref=e132]: 대상
                        - definition [ref=e133]:
                          - paragraph [ref=e134]: 보고서 현장
                      - generic [ref=e135]:
                        - term [ref=e136]: 범위
                        - definition [ref=e137]: 현장
                      - generic [ref=e138]:
                        - term [ref=e139]: 기간
                        - definition [ref=e140]:
                          - generic [ref=e141]:
                            - time [ref=e142]: 2026-09-01
                            - generic [ref=e143]: ~
                            - time [ref=e144]: 2026-09-07
                      - generic [ref=e145]:
                        - term [ref=e146]: 상태
                        - definition [ref=e147]:
                          - generic [ref=e150]:
                            - img [ref=e151]
                            - generic [ref=e154]: 완료
                      - generic [ref=e155]:
                        - term [ref=e156]: 요청 시각
                        - definition [ref=e157]:
                          - time [ref=e158]: 2026-08-26 09:00:00
                      - generic [ref=e159]:
                        - term [ref=e160]: 파일 만료 시각
                        - definition [ref=e161]:
                          - time [ref=e162]: 2026-09-19 09:00:00
                      - generic [ref=e163]:
                        - term [ref=e164]: 작업
                        - definition [ref=e165]:
                          - button "보고서 현장 보고서 다운로드" [ref=e166] [cursor=pointer]: 다운로드
            - navigation "페이지 이동" [ref=e167]:
              - generic [ref=e168]:
                - button "이전 페이지" [disabled] [ref=e169]: 이전
                - status [ref=e170]:
                  - generic [ref=e171]: 1페이지
                  - generic [ref=e172]: 1~1 / 1건
                - button "다음 페이지" [disabled] [ref=e173]: 다음
```

# Test source

```ts
  241 |   const search = page.getByRole("button", { name: "조명 검색·상세", exact: true }); const list = page.getByRole("button", { name: "조명 목록", exact: true });
  242 |   await search.click(); const popover = page.getByRole("dialog", { name: "조명 검색·상세", exact: true });
  243 |   await popover.getByRole("searchbox", { name: "조명 이름 또는 번호 검색", exact: true }).fill(fixtures[0].name);
  244 |   await popover.getByRole("button", { name: /상태 필터/ }).click(); await page.getByRole("option", { name: "정상", exact: true }).click();
  245 |   await popover.getByRole("button", { name: "조명 검색·상세 닫기", exact: true }).click(); await expect(search).toBeFocused();
  246 |   await list.click(); await expect(popover.getByRole("searchbox")).toHaveValue(fixtures[0].name);
  247 |   await expect(popover.getByRole("list", { name: "조명 목록", exact: true })).toBeVisible();
  248 |   await expect(popover.getByRole("button", { name: /상태 필터/ })).toContainText("정상");
  249 |   await toggleFromCustomerTab(page); await evidence(page, info, "finder-shared-state");
  250 |   await popover.getByRole("button", { name: "조명 검색·상세 닫기", exact: true }).click(); await expect(list).toBeFocused(); expect(writes).toEqual([]);
  251 | });
  252 | 
  253 | test("settings edit/password dialogs cancel to opener while independent MFA draft survives theme", async ({ page }, info) => {
  254 |   await page.setViewportSize({ width: 1440, height: 900 }); const { writes } = await customer(page);
  255 |   await page.goto(`/settings/site?siteId=${siteId}`);
  256 |   const edit = page.getByRole("button", { name: "현장 정보 수정", exact: true }); await edit.click();
  257 |   const dialog = page.getByRole("dialog", { name: "현장 정보 수정", exact: true }); await dialog.getByRole("textbox", { name: "현장명", exact: true }).fill("변경하지 않는 draft");
  258 |   // The modal makes this tab's header inert. A second controlled customer tab
  259 |   // uses its real theme button; CustomerThemeProvider receives the browser's
  260 |   // native storage event. No force click, synthetic event or HTML theme write.
  261 |   await toggleFromCustomerTab(page);
  262 |   await expect(dialog.getByRole("textbox", { name: "현장명", exact: true })).toHaveValue("변경하지 않는 draft");
  263 |   await evidence(page, info, "settings-site-edit-open");
  264 |   await dialog.getByRole("button", { name: "취소", exact: true }).click(); await expect(edit).toBeFocused();
  265 |   expect(writes).toEqual([]);
  266 |   await page.route("**/api/auth/mfa", route => route.fulfill({ json: { enabled: false, enabledAt: null } }));
  267 |   await page.route("**/api/auth/sessions", route => route.fulfill({ json: { sessions: [] } }));
  268 |   await page.route("**/api/auth/mfa/enrollment", route => route.fulfill({ json: { enrollmentToken: "fidelity-enrollment", secret: "FIDELITYFIXTURESECRET",
  269 |     otpauthUri: "otpauth://totp/LED%20Control:fidelity?secret=FIDELITYFIXTURESECRET", expiresAt: "2099-10-07T00:00:00.000Z" } }));
  270 |   await page.goto(`/settings/security?siteId=${siteId}`); await page.getByRole("button", { name: "2단계 인증 설정", exact: true }).click();
  271 |   const code = page.getByLabel("인증 앱 코드", { exact: true }); await code.fill("654321"); const codeNode = await code.elementHandle();
  272 |   const before = structuredClone(writes); expect(before).toHaveLength(1); expect(before[0].path).toBe("/api/auth/mfa/enrollment");
  273 |   const password = page.getByRole("button", { name: "비밀번호 변경", exact: true }); await password.click();
  274 |   const passwordDialog = page.getByRole("dialog", { name: "비밀번호 변경", exact: true });
  275 |   await passwordDialog.getByLabel("현재 비밀번호", { exact: true }).fill("fixture-current");
  276 |   await toggleFromCustomerTab(page);
  277 |   await expect(passwordDialog.getByLabel("현재 비밀번호", { exact: true })).toHaveValue("fixture-current");
  278 |   await evidence(page, info, "settings-password-dialog-open");
  279 |   await page.keyboard.press("Escape"); await expect(password).toBeFocused();
  280 |   expect(await code.evaluate((node, original) => node === original, codeNode)).toBe(true); await expect(code).toHaveValue("654321");
  281 |   expect(writes).toEqual(before); expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("FIDELITYFIXTURESECRET");
  282 |   await evidence(page, info, "settings-dialog-and-MFA-owner");
  283 | });
  284 | 
  285 | test("statistics actual zero and missing heatmap remain distinct through selection and theme", async ({ page }, info) => {
  286 |   const { writes } = await customer(page); await installFirstScreenStatisticsFixtures(page);
  287 |   await page.goto(`/statistics/analysis?siteId=${siteId}`);
  288 |   const heatmap = page.getByRole("group", { name: "시간대별 에너지 사용량", exact: true });
  289 |   const zero = heatmap.getByRole("button").nth(0), missing = heatmap.getByRole("button").nth(1);
  290 |   await expect(zero).toContainText("0"); await expect(missing).toContainText("—");
  291 |   await zero.click(); await expect(zero).toHaveAttribute("aria-pressed", "true");
  292 |   await missing.click(); await expect(missing).toHaveAttribute("aria-pressed", "true");
  293 |   await expect(zero).toHaveAttribute("aria-label", /평균 0 kWh/);
  294 |   await expect(missing).toHaveAttribute("aria-label", /평균 산정 불가/);
  295 |   await toggleTheme(page); await expect(missing).toContainText("—"); await documentFits(page);
  296 |   await evidence(page, info, "statistics-zero-not-gap"); expect(writes).toEqual([]);
  297 | });
  298 | 
  299 | test("gallery draws bounded readonly snapshots and disposes canvas on navigation without editor writes", async ({ page }, info) => {
  300 |   await page.setViewportSize({ width: 1440, height: 900 }); const { api, writes } = await customer(page);
  301 |   await page.goto(`/settings/floor-plans?siteId=${siteId}&keep=value#gallery`);
  302 |   const cards = page.getByTestId("floor-plan-item"); await expect(cards.first()).toBeVisible();
  303 |   const preview = cards.first().getByRole("img", { name: `${mockDashboard.floors[0].name} 도면 미리보기`, exact: true });
  304 |   await expect(preview).toBeVisible(); await expect(preview.locator("canvas").first()).toBeVisible();
  305 |   expect((await preview.boundingBox())!.height).toBe(176);
  306 |   await expect(preview.locator("[inert][aria-hidden=true]")).toHaveCount(1);
  307 |   await expect(preview.getByRole("button", { includeHidden: true })).toHaveCount(0);
  308 |   expect(await cards.getByRole("img").count()).toBeLessThanOrEqual(2);
  309 |   const node = await preview.locator("canvas").first().elementHandle();
  310 |   const snapshots = api.mapSnapshotRequests; expect(snapshots).toBeGreaterThan(0); expect(api.editorRequests).toEqual([]);
  311 |   await toggleTheme(page); await page.setViewportSize({ width: 1024, height: 768 });
  312 |   expect(api.mapSnapshotRequests).toBe(snapshots);
  313 |   expect(api.editorRequests).toEqual([]); expect(writes).toEqual([]);
  314 |   await evidence(page, info, "gallery-real-snapshot", { snapshots: api.mapSnapshotRequests });
  315 |   const history = cards.first().getByRole("link", { name: `${mockDashboard.floors[0].name} 변경 기록`, exact: true });
  316 |   const href = new URL((await history.getAttribute("href"))!, page.url());
  317 |   expect(href.searchParams.get("editorPanel")).toBe("details"); expect(href.searchParams.get("keep")).toBe("value"); expect(href.hash).toBe("#gallery");
  318 |   // Leave through the existing navigation: no lease initialization or restore intent.
  319 |   await page.getByRole("navigation", { name: "설정 메뉴" }).getByRole("link", { name: "현장 관리", exact: true }).click();
  320 |   await expect(page).toHaveURL(new RegExp(`/settings/site\\?siteId=${siteId}`));
  321 |   await expect.poll(() => node!.evaluate(element => element.isConnected)).toBe(false);
  322 |   expect(api.editorRequests).toEqual([]); expect(writes).toEqual([]);
  323 | });
  324 | 
  325 | // This seven-case correction suite intentionally does not replay Tasks 1–12.
  326 | // Each case owns controlled fixture reads and checks that pure UI emits no writes.
  327 | async function visibleAction(page: Page, target: Locator) {
  328 |   await target.scrollIntoViewIfNeeded(); await expect(target).toBeVisible();
  329 |   const bounds = await target.evaluate(element => {
  330 |     const rect = element.getBoundingClientRect();
  331 |     const nav = document.querySelector<HTMLElement>("[data-shell-navigation=compact]");
  332 |     const header = document.querySelector<HTMLElement>("[data-shell-topbar]");
  333 |     const navTop = nav?.getBoundingClientRect().top ?? innerHeight;
  334 |     const headerBottom = header?.getBoundingClientRect().bottom ?? 0;
  335 |     const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  336 |     return { x: rect.left, y: rect.top, width: rect.width, height: rect.height,
  337 |       bottom: rect.bottom, right: rect.right, navTop, headerBottom, viewportWidth: innerWidth,
  338 |       reachable: Boolean(hit && element.contains(hit)) };
  339 |   });
  340 |   expect(bounds.y).toBeGreaterThanOrEqual(bounds.headerBottom);
> 341 |   expect(bounds.bottom).toBeLessThanOrEqual(bounds.navTop);
      |                         ^ Error: expect(received).toBeLessThanOrEqual(expected)
  342 |   expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
  343 |   expect(bounds.height).toBeGreaterThanOrEqual(44); expect(bounds.width).toBeGreaterThanOrEqual(44);
  344 |   expect(bounds.reachable).toBe(true);
  345 |   return bounds;
  346 | }
  347 | 
  348 | async function centeredColumns(table: Locator) {
  349 |   const headers = table.locator("thead th"), cells = table.locator("tbody tr").first().locator("td");
  350 |   const alignments = [];
  351 |   for (let index = 1; index < await headers.count(); index += 1) {
  352 |     await expect(headers.nth(index)).toHaveCSS("text-align", "center");
  353 |     await expect(cells.nth(index)).toHaveCSS("text-align", "center");
  354 |     const sort = headers.nth(index).getByRole("button");
  355 |     if (await sort.count()) await expect(sort).toHaveCSS("justify-content", "center");
  356 |     alignments.push({ header: await headers.nth(index).innerText(), headerBounds: await headers.nth(index).boundingBox(), cellBounds: await cells.nth(index).boundingBox() });
  357 |   }
  358 |   return alignments;
  359 | }
  360 | 
  361 | for (const width of [578, 681]) test(`browser comments tall mobile ${width}: settled map fills remaining shell height`, async ({ page }, info) => {
  362 |   await page.setViewportSize({ width, height: 1227 }); await theme(page, "light"); const { writes } = await customer(page);
  363 |   await page.goto(`/monitoring?siteId=${siteId}`); await rootReady(page, "monitoring");
  364 |   const ticker = page.getByRole("region", { name: "최근 운영 로그", exact: true });
  365 |   await expect(ticker).not.toContainText("불러오는 중");
  366 |   const map = (await page.getByTestId("monitoring-map-viewport").boundingBox())!;
  367 |   const panel = (await page.locator("[data-monitoring-map-panel]").boundingBox())!;
  368 |   const nav = (await page.locator("[data-shell-navigation=compact]").boundingBox())!;
  369 |   expect(map.height).toBeGreaterThan(500); expect(panel.y + panel.height).toBeLessThanOrEqual(nav.y);
  370 |   expect(nav.y - (panel.y + panel.height)).toBeLessThanOrEqual(24);
  371 |   const cells = await page.getByRole("region", { name: "현장 전체", exact: true }).locator("dl > div").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width));
  372 |   expect(Math.max(...cells) - Math.min(...cells)).toBeLessThanOrEqual(1);
  373 |   await expect(page.getByText("ATLAS / OPERATIONS", { exact: true })).toHaveCount(0);
  374 |   const actions = { zoom: await visibleAction(page, page.getByRole("button", { name: "지도 확대", exact: true })),
  375 |     logs: await visibleAction(page, ticker.getByRole("button").first()) };
  376 |   await expectMinimumTouchTargets(page, "[data-shell-navigation=compact]"); await documentFits(page);
  377 |   await evidence(page, info, `comments-tall-${width}`, { map, panel, nav, cells, actions, writes }); expect(writes).toEqual([]);
  378 | });
  379 | 
  380 | test("browser comments short mobile: natural scroll exposes monitoring and manual actions", async ({ page }, info) => {
  381 |   await page.setViewportSize({ width: 390, height: 600 }); await theme(page, "light"); const { writes } = await customer(page);
  382 |   await page.goto(`/monitoring?siteId=${siteId}`); await rootReady(page, "monitoring");
  383 |   const map = page.getByTestId("monitoring-map-viewport"); expect((await map.boundingBox())!.height).toBeGreaterThanOrEqual(240);
  384 |   expect(await page.evaluate(() => document.scrollingElement!.scrollHeight)).toBeGreaterThan(600);
  385 |   const zoomBefore = await map.getAttribute("data-zoom");
  386 |   await page.mouse.move(2, 400); await page.mouse.wheel(0, 450);
  387 |   await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
  388 |   await expect(map).toHaveAttribute("data-zoom", zoomBefore!);
  389 |   const ticker = page.getByRole("region", { name: "최근 운영 로그", exact: true }); await expect(ticker).not.toContainText("불러오는 중");
  390 |   const logs = await visibleAction(page, ticker.getByRole("button").first());
  391 |   await documentFits(page); await evidence(page, info, "comments-short-monitoring", { logs, writes });
  392 |   await page.goto(`/control?siteId=${siteId}`); await rootReady(page, "control");
  393 |   const input = page.getByRole("textbox", { name: "밝기 수치", exact: true }); await input.fill("31"); await input.press("Enter");
  394 |   const actions = {} as Record<string, unknown>;
  395 |   for (const name of ["조명 목록 열기", "이동", "개별 선택", "영역 선택", "지도 확대"])
  396 |     actions[name] = await visibleAction(page, page.getByRole("button", { name, exact: true }));
  397 |   await expect(input).toHaveValue("31"); expect((await page.getByTestId("target-selection-map-viewport").boundingBox())!.height).toBeGreaterThanOrEqual(240);
  398 |   await input.scrollIntoViewIfNeeded(); await documentFits(page); await evidence(page, info, "comments-short-manual", { actions, writes }); expect(writes).toEqual([]);
  399 | });
  400 | 
  401 | test("browser comments PC: current site is plain information and header metrics stay compact", async ({ page }, info) => {
  402 |   await page.setViewportSize({ width: 1440, height: 900 }); const { writes } = await customer(page);
  403 |   await page.goto(`/monitoring?siteId=${siteId}&keep=value#comments`); await rootReady(page, "monitoring");
  404 |   await expect(page.getByRole("button", { name: /현장 선택/ })).toHaveCount(0); await expect(page.getByRole("listbox")).toHaveCount(0);
  405 |   await expect(page.locator("[data-shell-context]")).toContainText(`고객사 · ${longSite}`);
  406 |   await expect(page.getByText("ATLAS / OPERATIONS", { exact: true })).toHaveCount(0);
  407 |   await expect(page.getByRole("heading", { name: "모니터링", exact: true })).toBeVisible();
  408 |   await expect(page.locator("[data-operation-map-chrome]").getByRole("heading")).toHaveCount(0);
  409 |   const metrics = await page.getByRole("region", { name: "현장 전체", exact: true }).locator("dl").evaluate(element => {
  410 |     const rect = element.getBoundingClientRect(); const children = [...element.children].map(child => { const bounds = child.getBoundingClientRect(); return { x: bounds.x, width: bounds.width }; });
  411 |     return { width: rect.width, children, gap: getComputedStyle(element).columnGap };
  412 |   });
  413 |   expect(metrics.width).toBeLessThan(260); expect(metrics.gap).toBe("12px");
  414 |   const scope = new URL(page.url()); expect(scope.searchParams.get("keep")).toBe("value"); expect(scope.hash).toBe("#comments");
  415 |   await documentFits(page); await evidence(page, info, "comments-pc-monitoring", { metrics, writes }); expect(writes).toEqual([]);
  416 | });
  417 | 
  418 | test("browser comments manual: individual list owns central clear while brightness draft survives", async ({ page }, info) => {
  419 |   await page.setViewportSize({ width: 1440, height: 900 }); const { writes } = await customer(page);
  420 |   await page.goto(`/control?siteId=${siteId}`); await rootReady(page, "control");
  421 |   await page.getByRole("button", { name: "조명 목록 열기", exact: true }).click();
  422 |   const drawer = page.getByRole("dialog", { name: "조명 목록", exact: true });
  423 |   const choice = drawer.getByRole("checkbox", { name: `${fixtures[0].name} 선택`, exact: true });
  424 |   await choice.locator("xpath=ancestor::label").click(); await expect(choice).toBeChecked();
  425 |   await drawer.getByRole("button", { name: "선택 완료", exact: true }).click();
  426 |   const central = page.locator("[data-target-selection-detail-panel]"); await expect(central).toBeVisible();
  427 |   const selected = central.getByRole("list", { name: "선택 조명", exact: true }); await expect(selected).toContainText(fixtures[0].name);
  428 |   const execution = page.getByRole("complementary", { name: "밝기 실행", exact: true }); await expect(execution.getByRole("list", { name: "선택 조명", exact: true })).toHaveCount(0);
  429 |   await expect(execution.getByText("초안", { exact: true })).toHaveCount(0);
  430 |   const clear = central.getByRole("button", { name: "선택 해제", exact: true }); const clearBounds = await visibleAction(page, clear);
  431 |   const centralBounds = (await central.boundingBox())!; const mapBounds = (await page.getByTestId("target-selection-map-viewport").boundingBox())!;
  432 |   const executionBounds = (await execution.boundingBox())!;
  433 |   expect(clearBounds.x + clearBounds.width).toBeGreaterThan(centralBounds.x + centralBounds.width / 2);
  434 |   expect(clearBounds.y - centralBounds.y).toBeLessThanOrEqual(24);
  435 |   expect(centralBounds.x).toBeGreaterThanOrEqual(mapBounds.x + mapBounds.width); expect(centralBounds.x + centralBounds.width).toBeLessThanOrEqual(executionBounds.x);
  436 |   const input = page.getByRole("textbox", { name: "밝기 수치", exact: true }); await input.fill("31"); await input.press("Enter"); const owner = await input.elementHandle();
  437 |   await toggleTheme(page); await page.setViewportSize({ width: 1280, height: 900 });
  438 |   expect(await input.evaluate((node, original) => node === original, owner)).toBe(true); await expect(input).toHaveValue("31");
  439 |   await clear.click(); await expect(central.getByRole("list", { name: "선택 조명", exact: true })).toHaveCount(0); await expect(input).toHaveValue("31");
  440 |   await documentFits(page); await evidence(page, info, "comments-manual-central-clear", { centralBounds, mapBounds, executionBounds, clearBounds, writes }); expect(writes).toEqual([]);
  441 | });
```