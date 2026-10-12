# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: page-session-ux.spec.ts >> 05 resize without remount/reset >> 717x1227 to 390x844 light: inline/More, focus and raw31
- Location: ../../.superpowers/sdd/2026-10-12-map-workspace-comments/page-session-ux.spec.ts:291:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('[data-testid="target-selection-map-viewport"]').locator('canvas').first()
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for locator('[data-testid="target-selection-map-viewport"]').locator('canvas').first()

```

```yaml
- navigation "모바일 주 메뉴":
  - link "모니터링":
    - /url: /monitoring?siteId=12121212-1212-4121-8121-121212121212&mode=manual
  - link "제어":
    - /url: /control?siteId=12121212-1212-4121-8121-121212121212&mode=manual
  - link "통계":
    - /url: /statistics/overview?siteId=12121212-1212-4121-8121-121212121212&mode=manual
  - link "설정":
    - /url: /settings?siteId=12121212-1212-4121-8121-121212121212&mode=manual
- main:
  - text: 제어
  - img "킨다"
  - paragraph: 고객사 B2 현장
  - text: 고객사 B2 현장
  - button "알람센터, 확인 불가"
  - button "다크 모드로 변경"
  - region "현장 전체":
    - heading "현장 전체" [level=2]
    - paragraph: 고객사 B2 현장
    - term: 전체
    - definition: 3대
    - term: 온라인
    - definition: 3대
    - term: 장애
    - definition: 0대
    - term: 오프라인
    - definition: 0대
  - heading "조명 제어" [level=1]
  - tablist "제어 방식":
    - tab "수동 제어" [selected]
    - tab "스케줄 제어"
    - tab "이벤트 제어"
    - tab "그룹/구역"
  - tabpanel "수동 제어":
    - region "제어 대상 지도":
      - region "공간 대상 선택":
        - text: 표시 층
        - button "표시 층": B2
        - text: 선택 범위
        - button "선택 범위": 개별 조명
        - button "조명 목록"
        - group "B2 도면 조명 상태":
          - text: 전체
          - strong: "3"
          - text: 정상
          - strong: "3"
          - text: 장애
          - strong: "0"
          - text: 오프라인
          - strong: "0"
        - region "B2 도면":
          - button "UX 조명 01 정상 70%"
          - button "UX 조명 02 정상 70%"
          - button "UX 조명 03 정상 70%"
        - text: 정상 장애 오프라인 선택
        - group "지도 확대 축소":
          - button "지도 축소"
          - button "지도 배율 100%": 100%
          - button "지도 확대"
          - button "지도 화면 맞춤"
        - region "선택 대상 목록":
          - heading "선택 조명 0개" [level=3]
          - button "전체 보기"
    - complementary "밝기 실행":
      - region "제어 대상":
        - heading "제어 대상" [level=3]
        - strong: 0개 선택
        - text: 제어 불가
      - text: 밝기
      - textbox "밝기 수치": "70"
      - group "밝기":
        - slider "밝기": "70"
      - button "밝기 적용" [disabled]: 적용
      - button "더보기"
      - status "제어 중요 상태": 제어 대상을 하나 이상 선택해 주세요.
```

# Test source

```ts
  45  |   await page.mouse.move(center.x, center.y);
  46  |   for (let step = 0; step < 10; step++) {
  47  |     const state = await root.evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight }));
  48  |     if (state.top >= state.height - state.client - 1) break;
  49  |     await page.mouse.wheel(0, 1600);
  50  |     await settle(page);
  51  |   }
  52  |   const state = await root.evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight }));
  53  |   expect(state.top, "native wheel must reach internal bottom").toBeGreaterThanOrEqual(state.height - state.client - 1);
  54  |   return state;
  55  | }
  56  | 
  57  | async function blankPoint(map: Locator) {
  58  |   return map.evaluate(element => {
  59  |     const r = element.getBoundingClientRect();
  60  |     for (const yRatio of [0.4, 0.6, 0.25]) for (const xRatio of [0.4, 0.65, 0.25]) {
  61  |       const x = r.x + r.width * xRatio, y = r.y + r.height * yRatio;
  62  |       const hit = document.elementFromPoint(x, y);
  63  |       if (hit && element.contains(hit) && hit.closest('[data-floor-map-surface]') && !hit.closest('button')) return { x, y };
  64  |     }
  65  |     throw new Error("No exposed blank map point available for native CAD gesture");
  66  |   });
  67  | }
  68  | 
  69  | async function pan(page: Page, map: Locator, kind: "middle" | "space") {
  70  |   const start = await blankPoint(map), before = await mapCamera(map);
  71  |   if (kind === "space") { await map.focus(); await page.keyboard.down("Space"); }
  72  |   try {
  73  |     await page.mouse.move(start.x, start.y);
  74  |     await page.mouse.down({ button: kind === "middle" ? "middle" : "left" });
  75  |     await page.mouse.move(start.x - 30, start.y - 24, { steps: 8 });
  76  |     await page.mouse.up({ button: kind === "middle" ? "middle" : "left" });
  77  |   } finally { if (kind === "space") await page.keyboard.up("Space"); }
  78  |   await settle(page);
  79  |   const after = await mapCamera(map);
  80  |   expect(after.x !== before.x || after.y !== before.y, `${kind} drag must move actual camera`).toBe(true);
  81  |   await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
  82  |   return { before, after };
  83  | }
  84  | 
  85  | async function selectFloor(page: Page, compact: boolean) {
  86  |   if (compact) {
  87  |     await page.getByRole("button", { name: /선택 범위/ }).click();
  88  |     await page.getByRole("option", { name: "층 전체", exact: true }).click();
  89  |   } else await page.getByRole("group", { name: "대상 선택 방식" }).getByRole("button", { name: "층 전체", exact: true }).click();
  90  |   const confirmation = page.getByRole("alertdialog", { name: "선택 방식 변경" });
  91  |   if (await confirmation.count()) await confirmation.getByRole("button", { name: "변경", exact: true }).click();
  92  |   await expect(page.getByRole("heading", { name: "선택 조명 60개", exact: true })).toBeVisible();
  93  | }
  94  | 
  95  | async function detail(page: Page, info: TestInfo, phase: (name: string, extra?: unknown) => Promise<void>) {
  96  |   const map = page.locator(mon.map), opener = firstMarker(page);
  97  |   const identity = await rememberMapIdentity(map), before = await readGeometry(page, mon);
  98  |   try {
  99  |     await opener.click();
  100 |     await expect(page.locator('[data-spatial-map-marker="true"][aria-pressed="true"]')).toHaveCount(1);
  101 |     await page.getByRole("button", { name: "상세 보기", exact: true }).click();
  102 |     const aside = page.locator('aside[aria-label="조명 상세"]');
  103 |     await expect(aside).toBeVisible();
  104 |     await phase("detail-open");
  105 |     const after = await readGeometry(page, mon);
  106 |     expect(after.map.bounds).toEqual(before.map.bounds);
  107 |     expect(after.map.camera).toEqual(before.map.camera);
  108 |     await identity.assertUnchanged();
  109 |     const half = await aside.evaluate(element => ({ height: element.getBoundingClientRect().height, parent: element.parentElement!.getBoundingClientRect().height }));
  110 |     expect(Math.abs(half.height - half.parent / 2), "detail must occupy half of existing containing body").toBeLessThanOrEqual(1);
  111 |     const close = page.getByRole("button", { name: "조명 상세 닫기", exact: true }), headerBefore = await close.boundingBox();
  112 |     await expectMinimumTouchTargets(page, 'aside[aria-label="조명 상세"]');
  113 |     const body = page.locator('[data-monitoring-detail-scroll]');
  114 |     const end = await internalEnd(page, body);
  115 |     expect(await mapCamera(map)).toEqual(before.map.camera);
  116 |     expect(await close.boundingBox()).toEqual(headerBefore);
  117 |     await phase("detail-end", { end, half });
  118 |     await close.click();
  119 |     await expect(aside).toHaveCount(0);
  120 |     await expect(opener).toBeFocused();
  121 |     await identity.assertUnchanged();
  122 |     expect(await mapCamera(map)).toEqual(before.map.camera);
  123 |     // The original pin remains selected; its nonmodal popover is visible again.
  124 |     await page.getByRole("button", { name: "상세 보기", exact: true }).click();
  125 |     await expect(body).toBeVisible();
  126 |     await expect.poll(() => body.evaluate(element => element.scrollTop)).toBe(end.top);
  127 |     await aside.press("Escape");
  128 |     await expect(opener).toBeFocused();
  129 |     await phase("detail-closed", { half, end });
  130 |   } finally { await identity.dispose(); }
  131 | }
  132 | 
  133 | // Failure evidence is captured before rethrow. Original runner error and every
  134 | // phase remain in a fresh run directory; no automatic case reruns.
  135 | async function review(page: Page, info: TestInfo, index: number, setup: () => Promise<{ requests: unknown; assertNoWrites(): void }>, body: (phase: (name: string, extra?: unknown) => Promise<void>) => Promise<void>) {
  136 |   const scenario = reviewCases[index], contract = scenario.route === "monitoring" ? mon : control;
  137 |   let lastPhase = "setup", state: Awaited<ReturnType<typeof setup>> | undefined;
  138 |   const phase = async (name: string, extra?: unknown) => {
  139 |     lastPhase = name;
  140 |     await savePhase(page, info, name, contract, { case: scenario, requests: state?.requests, extra });
  141 |   };
  142 |   try {
  143 |     state = await setup();
  144 |     await page.goto(`/${scenario.route}?siteId=${ids.siteId}`);
> 145 |     await expect(page.locator(contract.map).locator("canvas").first()).toBeVisible();
      |                                                                        ^ Error: expect(locator).toBeVisible() failed
  146 |     await expect(firstMarker(page)).toBeVisible();
  147 |     await setReviewTheme(page, scenario.theme);
  148 |     await phase("ready");
  149 |     await body(phase);
  150 |     state.assertNoWrites();
  151 |     await phase("complete");
  152 |   } catch (error) {
  153 |     const original = { source: process.env.UX_SOURCE_SHA, case: scenario, phase: lastPhase, url: page.url(), requests: state?.requests, error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) };
  154 |     const path = info.outputPath("original-failure.json");
  155 |     await writeFile(path, JSON.stringify(original, null, 2));
  156 |     await info.attach("original-failure", { path, contentType: "application/json" });
  157 |     try { await savePhase(page, info, "failure", contract, original); }
  158 |     catch (captureError) { await info.attach("failure-capture-error", { body: String(captureError), contentType: "text/plain" }); }
  159 |     throw error;
  160 |   }
  161 | }
  162 | 
  163 | test.describe("01 PC monitoring actual CAD and nonmodal detail", () => {
  164 |   test.use({ viewport: reviewCases[0].viewport });
  165 |   // Catches selection-area regressions, camera remounts, flowing overlays and wheel leakage.
  166 |   test("1194 light: pan, single selection, half overlay and focus", async ({ page, context, baseURL }, info) => {
  167 |     await review(page, info, 0, () => prepareCustomer(page, context, baseURL!, 3), async phase => {
  168 |       const toolbar = page.getByRole("group", { name: "모니터링 도구" }), map = page.locator(mon.map);
  169 |       await row(page, [toolbar.getByRole("button", { name: /맵 선택/ }), toolbar.getByRole("button", { name: "조명 검색/목록" }), toolbar.getByRole("button", { name: "새로고침" }), toolbar.locator("time")]);
  170 |       await expectMinimumTouchTargets(page, '[role="group"][aria-label="모니터링 도구"]');
  171 |       for (let step = 0; step < 8; step++) await page.getByRole("button", { name: "지도 확대", exact: true }).click();
  172 |       const middle = await pan(page, map, "middle"), space = await pan(page, map, "space");
  173 |       const point = await blankPoint(map), old = await mapCamera(map);
  174 |       await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, -80); await settle(page);
  175 |       expect((await mapCamera(map)).zoom).not.toBe(old.zoom);
  176 |       await phase("native-gestures", { middle, space, wheelBefore: old, wheelAfter: await mapCamera(map) });
  177 |       await page.getByRole("button", { name: /^지도 배율/ }).click();
  178 |       await detail(page, info, phase);
  179 |       await expectNoHorizontalOverflow(page);
  180 |     });
  181 |   });
  182 | });
  183 | 
  184 | test.describe("02 short mobile monitoring", () => {
  185 |   test.use({ viewport: reviewCases[1].viewport });
  186 |   // Catches wrapped controls, lost accessible timestamp and inaccessible detail endings.
  187 |   test("390x600 dark: toolbar, HH:mm and detail scroll", async ({ page, context, baseURL }, info) => {
  188 |     await review(page, info, 1, () => prepareCustomer(page, context, baseURL!, 3), async phase => {
  189 |       const toolbar = page.getByRole("group", { name: "모니터링 도구" });
  190 |       await row(page, [toolbar.getByRole("button", { name: /맵 선택/ }), toolbar.getByRole("button", { name: "조명 검색/목록" }), toolbar.getByRole("button", { name: "새로고침" }), toolbar.locator("time")]);
  191 |       await expect(toolbar.locator("time")).toHaveText(/^\d{2}:\d{2}$/);
  192 |       await expect(toolbar.locator("time")).toHaveAttribute("aria-label", /현장 시간/);
  193 |       await expect(toolbar.locator("time")).toHaveAttribute("datetime", /T/);
  194 |       await expectMinimumTouchTargets(page, '[role="group"][aria-label="모니터링 도구"]');
  195 |       await expectMinimumTouchTargets(page, '[data-shell-navigation="compact"]');
  196 |       await detail(page, info, phase);
  197 |       await expectNoHorizontalOverflow(page);
  198 |     });
  199 |   });
  200 | });
  201 | 
  202 | test.describe("03 narrow finite manual workspace", () => {
  203 |   test.use({ viewport: reviewCases[2].viewport });
  204 |   // Catches outer-page overflow, broken 44px rows and accidental invalid-draft submission.
  205 |   test("320x600 light: two rows, invalid first Apply and More", async ({ page, context, baseURL }, info) => {
  206 |     await review(page, info, 2, () => prepareCustomer(page, context, baseURL!, 3), async phase => {
  207 |       await finite(page);
  208 |       await row(page, [page.getByRole("button", { name: /표시 층/ }), page.getByRole("button", { name: /선택 범위/ }), page.getByRole("button", { name: "조명 목록", exact: true })]);
  209 |       const input = page.getByRole("spinbutton", { name: "밝기 수치" }), more = page.getByRole("button", { name: "더보기", exact: true });
  210 |       await row(page, [input, page.locator('[data-slider-thumb]'), page.locator('[data-control-submit]'), more]);
  211 |       const mapGoal = (await readGeometry(page, control)).map;
  212 |       await firstMarker(page).click();
  213 |       for (const endpoint of ["0", "100"]) {
  214 |         await input.fill(endpoint);
  215 |         await settle(page);
  216 |         await phase(`slider-endpoint-${endpoint}`);
  217 |         await expectMinimumTouchTargets(page, '[data-control-execution-row]');
  218 |       }
  219 |       await expectMinimumTouchTargets(page, '[data-target-selection-toolbar]');
  220 |       await expectMinimumTouchTargets(page, '[data-floor-map-footer]');
  221 |       await expectMinimumTouchTargets(page, '[data-manual-selection-panel]');
  222 |       await input.fill("31"); await expect(input).toHaveValue("31");
  223 |       await page.getByRole("button", { name: "전체 보기", exact: true }).click();
  224 |       await more.click(); await expect(input).toHaveValue("31");
  225 |       const end = await internalEnd(page, page.locator('[data-control-more-content]'));
  226 |       await phase("more-end", { end, mapGoal240: { actual: mapGoal.bounds.height, met: mapGoal.bounds.height >= 240 } });
  227 |       await finite(page);
  228 |       await page.locator('[data-control-more-content]').getByRole("button", { name: "확인 필요한 명령", exact: true }).press("Escape");
  229 |       await expect(more).toBeFocused();
  230 |       await expect(input).toHaveValue("31");
  231 |       await expect(page.getByRole("status", { name: "제어 중요 상태", exact: true })).toBeVisible();
  232 |       await input.fill("101");
  233 |       await expect(page.getByRole("alert").filter({ hasText: "0~100 사이 정수를 입력해 주세요." })).toBeVisible();
  234 |       // Native pointer at disabled Apply still exercises capture/blur without force-click.
  235 |       const applyPoint = await actualCenter(page.locator('[data-control-submit]'));
  236 |       await page.mouse.click(applyPoint.x, applyPoint.y); await settle(page);
  237 |       await expect(input).toHaveValue("31");
  238 |       await phase("invalid-first-apply");
  239 |       await finite(page);
  240 |     });
  241 |   });
  242 | });
  243 | 
  244 | test.describe("04 native touch and long inline selection", () => {
  245 |   test.use({ viewport: reviewCases[3].viewport, hasTouch: true });
```