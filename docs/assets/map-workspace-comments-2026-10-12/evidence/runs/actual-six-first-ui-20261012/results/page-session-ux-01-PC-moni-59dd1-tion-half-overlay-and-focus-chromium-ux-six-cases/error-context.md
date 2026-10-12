# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: page-session-ux.spec.ts >> 01 PC monitoring actual CAD and nonmodal detail >> 1194 light: pan, single selection, half overlay and focus
- Location: ../../.superpowers/sdd/2026-10-12-map-workspace-comments/page-session-ux.spec.ts:166:7

# Error details

```
Error: expect(locator).toHaveCount(expected) failed

Locator:  locator('[data-spatial-map-marker="true"][aria-pressed="true"]')
Expected: 1
Received: 0
Timeout:  5000ms

Call log:
  - Expect "toHaveCount" with timeout 5000ms
  - waiting for locator('[data-spatial-map-marker="true"][aria-pressed="true"]')
    14 × locator resolved to 0 elements
       - unexpected value "0"

```

# Page snapshot

```yaml
- generic [ref=e1]:
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
          - /url: /monitoring?siteId=12121212-1212-4121-8121-121212121212
          - img [ref=e18]
          - generic [ref=e20]: 모니터링
        - link "제어" [ref=e22] [cursor=pointer]:
          - /url: /control?siteId=12121212-1212-4121-8121-121212121212
          - img [ref=e23]
          - generic [ref=e24]: 제어
        - link "통계" [ref=e26] [cursor=pointer]:
          - /url: /statistics/overview?siteId=12121212-1212-4121-8121-121212121212
          - img [ref=e27]
          - generic [ref=e29]: 통계
        - link "설정" [ref=e31] [cursor=pointer]:
          - /url: /settings?siteId=12121212-1212-4121-8121-121212121212
          - img [ref=e32]
          - generic [ref=e35]: 설정
    - main [ref=e36]:
      - generic [ref=e37]:
        - generic [ref=e38]: 모니터링
        - generic "현장 정보" [ref=e39]:
          - paragraph [ref=e40]: 고객사 B2 현장
          - generic [ref=e41]: 고객사 B2 현장
        - generic [ref=e42]:
          - button "알람센터, 확인 불가" [ref=e44] [cursor=pointer]:
            - img [ref=e45]
            - generic [ref=e48]: "?"
          - button "다크 모드로 변경" [ref=e49] [cursor=pointer]:
            - img [ref=e50]
          - link "내 계정 및 보안" [ref=e52] [cursor=pointer]:
            - /url: /settings/security?siteId=12121212-1212-4121-8121-121212121212
            - img [ref=e53]
        - region "현장 전체" [ref=e56]:
          - heading "현장 전체" [level=2] [ref=e57]
          - paragraph [ref=e58]: 고객사 B2 현장
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
              - definition [ref=e71]: 0대
      - generic [ref=e73]:
        - heading "모니터링" [level=1] [ref=e74]
        - group "모니터링 도구" [ref=e75]:
          - generic [ref=e76]:
            - generic [ref=e77]: 맵 선택
            - generic [ref=e78]:
              - button "맵 선택" [ref=e79]:
                - generic [ref=e80]: B2
                - generic [ref=e81]: ▾
              - combobox [ref=e84]
          - button "조명 검색/목록" [ref=e85] [cursor=pointer]:
            - img [ref=e86]
            - generic [ref=e88]: 조명 검색/목록
          - 'generic "마지막 갱신: 2026-10-12 11:03:36 (현장 시간)" [ref=e90]':
            - text: "마지막 갱신:"
            - time [ref=e91]:
              - generic [ref=e92]: 2026-10-12 11:03:36 (현장 시간)
          - button "새로고침" [ref=e93] [cursor=pointer]:
            - img [ref=e94]
            - generic [ref=e99]: 새로고침
        - generic [ref=e101]:
          - generic [ref=e102]:
            - region "선택 층 조명 현황" [ref=e105]:
              - group "B2 · 조명 현황" [ref=e106]:
                - generic [ref=e107]:
                  - generic [ref=e109]: 전체 조명
                  - strong [ref=e110]: "3"
                - generic [ref=e111]:
                  - generic [ref=e113]: 정상
                  - strong [ref=e114]: "3"
                - generic [ref=e115]:
                  - generic [ref=e117]: 점검 필요
                  - strong [ref=e118]: "0"
                - generic [ref=e119]:
                  - generic [ref=e121]: 오프라인
                  - strong [ref=e122]: "0"
            - region "층 도면" [ref=e124]:
              - generic [ref=e126]:
                - region "상하좌우로 이동하고 확대 축소할 수 있는 지도" [ref=e127]:
                  - generic [ref=e129]:
                    - generic:
                      - img
                    - generic [ref=e130]:
                      - button "UX 조명 01 정상 70%" [ref=e132] [cursor=pointer]
                      - button "UX 조명 02 정상 70%" [ref=e133] [cursor=pointer]
                      - button "UX 조명 03 정상 70%" [ref=e134] [cursor=pointer]
                - generic [ref=e135]:
                  - generic [ref=e136]:
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
                  - group "지도 조작" [ref=e137]:
                    - button "지도 축소" [ref=e138] [cursor=pointer]:
                      - img [ref=e139]
                    - button "지도 배율 100%" [ref=e140] [cursor=pointer]: 100%
                    - button "지도 확대" [ref=e141] [cursor=pointer]:
                      - img [ref=e142]
                    - button "지도 전체 보기" [ref=e143] [cursor=pointer]:
                      - img [ref=e144]
          - region "최근 운영 로그" [ref=e149]:
            - region "최근 활동" [ref=e150]:
              - generic [ref=e151]: 최근 활동
              - paragraph [ref=e153]: 운영 활동을 불러오지 못했습니다.
              - button "다시 조회" [ref=e154] [cursor=pointer]
              - button "전체 보기" [ref=e155] [cursor=pointer]:
                - text: 전체 보기
                - img [ref=e156]
  - generic [ref=e159]:
    - dialog "UX 조명 01 조명 정보" [active] [ref=e160]:
      - generic [ref=e161]:
        - strong [ref=e162]: UX 조명 01
        - generic [ref=e163]:
          - img [ref=e164]
          - generic [ref=e167]: 정상
        - generic [ref=e168]:
          - generic [ref=e169]:
            - term [ref=e170]: 현재 밝기
            - definition [ref=e171]: 70%
          - generic [ref=e172]:
            - term [ref=e173]: 마지막 확인
            - definition [ref=e174]:
              - time [ref=e175]: 2026-10-12 11:03:36
        - paragraph [ref=e176]: 조치 불필요
        - button "상세 보기" [ref=e177] [cursor=pointer]
    - button "Dismiss" [ref=e179]
```

# Test source

```ts
  1   | import { test, expect, type Page, type Locator, type TestInfo } from "../../../apps/web/node_modules/@playwright/test";
  2   | import { writeFile } from "node:fs/promises";
  3   | import {
  4   |   ids, reviewCases, prepareCustomer, setReviewTheme, readGeometry, savePhase,
  5   |   rememberMapIdentity, actualCenter, nativeSwipe, expectNoHorizontalOverflow,
  6   |   expectMinimumTouchTargets, type GeometryContract
  7   | } from "./page-session-ux-support";
  8   | 
  9   | // Six representative real-renderer cases, not a full matrix. API fixtures are
  10  | // read-only and no command is acknowledged or sent to real equipment.
  11  | const mon: GeometryContract = {
  12  |   map: '[data-testid="monitoring-map-viewport"]',
  13  |   regions: { toolbar: '[role="group"][aria-label="모니터링 도구"]', mapPanel: '[data-operation-map-panel]', footer: '[data-floor-map-footer]', detail: 'aside[aria-label="조명 상세"]', detailBody: '[data-monitoring-detail-scroll]', nav: '[data-shell-navigation="compact"]' },
  14  |   occluders: ['aside[aria-label="조명 상세"]', '[data-monitoring-pin-popover]', '[data-shell-navigation="compact"]']
  15  | };
  16  | const control: GeometryContract = {
  17  |   map: '[data-testid="target-selection-map-viewport"]',
  18  |   regions: { toolbar: '[data-target-selection-toolbar]', execution: '[data-control-execution-row]', selection: '[data-manual-selection-panel]', list: '[data-manual-selection-panel] > div:last-child', more: '[data-control-more-content]', important: '[aria-label="제어 중요 상태"]', mapPanel: '[data-operation-map-panel]', footer: '[data-floor-map-footer]', nav: '[data-shell-navigation="compact"]' },
  19  |   occluders: ['[data-shell-navigation="compact"]']
  20  | };
  21  | // Accessible-name prefix is stable across brightness/status changes.
  22  | const firstMarker = (page: Page) => page.locator('[data-spatial-map-marker="true"][aria-label^="UX 조명 01"]');
  23  | const mapCamera = (map: Locator) => map.evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop, zoom: element.getAttribute("data-zoom") }));
  24  | const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  25  | 
  26  | async function finite(page: Page) {
  27  |   await expectNoHorizontalOverflow(page);
  28  |   const document = await page.evaluate(() => ({ y: scrollY, height: document.scrollingElement!.scrollHeight, client: document.scrollingElement!.clientHeight }));
  29  |   expect(document.y, "manual mobile document scroll must remain zero").toBe(0);
  30  |   expect(document.height, "manual mobile uses finite shell, not outer scrolling").toBeLessThanOrEqual(document.client + 1);
  31  |   await expectMinimumTouchTargets(page, '[data-shell-navigation="compact"]');
  32  | }
  33  | 
  34  | async function row(page: Page, targets: Locator[]) {
  35  |   const boxes = await Promise.all(targets.map(target => target.boundingBox()));
  36  |   expect(boxes.every(Boolean), "every actual row control has geometry").toBe(true);
  37  |   const centers = boxes.map(box => box!.y + box!.height / 2);
  38  |   expect(Math.max(...centers) - Math.min(...centers), "controls must share one row").toBeLessThanOrEqual(1);
  39  |   await expectNoHorizontalOverflow(page);
  40  | }
  41  | 
  42  | /** Wheel the real scroll owner; never assign scrollTop or call scrollIntoView. */
  43  | async function internalEnd(page: Page, root: Locator) {
  44  |   const center = await actualCenter(root);
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
> 100 |     await expect(page.locator('[data-spatial-map-marker="true"][aria-pressed="true"]')).toHaveCount(1);
      |                                                                                         ^ Error: expect(locator).toHaveCount(expected) failed
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
  145 |     await expect(page.locator(contract.map).locator("canvas").first()).toBeVisible();
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
```