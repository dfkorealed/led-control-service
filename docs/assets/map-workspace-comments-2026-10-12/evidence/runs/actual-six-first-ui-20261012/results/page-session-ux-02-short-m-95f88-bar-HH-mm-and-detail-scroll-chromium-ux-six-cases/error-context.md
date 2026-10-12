# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: page-session-ux.spec.ts >> 02 short mobile monitoring >> 390x600 dark: toolbar, HH:mm and detail scroll
- Location: ../../.superpowers/sdd/2026-10-12-map-workspace-comments/page-session-ux.spec.ts:187:7

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator: getByRole('group', { name: '모니터링 도구' }).locator('time')
Expected pattern: /^\d{2}:\d{2}$/
Received string:  "2026-10-12 11:03:45 (현장 시간)11:03"
Timeout: 5000ms

Call log:
  - Expect "toHaveText" with timeout 5000ms
  - waiting for getByRole('group', { name: '모니터링 도구' }).locator('time')
    13 × locator resolved to <time datetime="2026-10-12T02:03:45.773Z" aria-label="2026-10-12 11:03:45 (현장 시간)">…</time>
       - unexpected value "2026-10-12 11:03:45 (현장 시간)11:03"

```

```yaml
- time
```

# Test source

```ts
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
> 191 |       await expect(toolbar.locator("time")).toHaveText(/^\d{2}:\d{2}$/);
      |                                             ^ Error: expect(locator).toHaveText(expected) failed
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
  246 |   // Catches ghost selection on a marker-origin touch pan and an unreachable long list.
  247 |   test("390x600 dark: swipe then tap, 60 fixtures and internal ending", async ({ page, context, baseURL }, info) => {
  248 |     await review(page, info, 3, () => prepareCustomer(page, context, baseURL!, 60), async phase => {
  249 |       const map = page.locator(control.map), identity = await rememberMapIdentity(map);
  250 |       try {
  251 |         for (let step = 0; step < 8; step++) await page.getByRole("button", { name: "지도 확대", exact: true }).click();
  252 |         const markers = map.locator('[data-spatial-map-marker="true"]');
  253 |         const index = await markers.evaluateAll(elements => elements.findIndex(element => {
  254 |           const r = element.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
  255 |           return x > 40 && y > 100 && x < innerWidth - 40 && y < innerHeight - 140 && element.contains(document.elementFromPoint(x, y));
  256 |         }));
  257 |         expect(index, "touch origin must be a genuinely exposed marker").toBeGreaterThanOrEqual(0);
  258 |         const candidate = markers.nth(index);
  259 |         const before = await mapCamera(map);
  260 |         await nativeSwipe(context, page, candidate, { x: -25, y: -20 }); await settle(page);
  261 |         await expect(page.getByRole("heading", { name: "선택 조명 0개", exact: true })).toBeVisible();
  262 |         const after = await mapCamera(map);
  263 |         expect(after.x !== before.x || after.y !== before.y).toBe(true);
  264 |         await candidate.tap();
  265 |         await expect(page.getByRole("heading", { name: "선택 조명 1개", exact: true })).toBeVisible();
  266 |         await phase("native-touch", { before, after });
  267 |         await selectFloor(page, true);
  268 |         const opener = page.getByRole("button", { name: "전체 보기", exact: true });
  269 |         await opener.click();
  270 |         const listId = await page.getByRole("button", { name: "접기", exact: true }).getAttribute("aria-controls");
  271 |         const list = page.locator(`[id="${listId}"]`);
  272 |         const heading = page.getByRole("heading", { name: "선택 조명 60개", exact: true }), headingBefore = await heading.boundingBox();
  273 |         const end = await internalEnd(page, list);
  274 |         await actualCenter(list.getByText("UX 조명 60", { exact: true }));
  275 |         expect(await heading.boundingBox()).toEqual(headingBefore);
  276 |         await finite(page);
  277 |         await expectMinimumTouchTargets(page, '[data-manual-selection-panel] > div:first-child');
  278 |         await identity.assertUnchanged();
  279 |         await phase("inline-list-end", { end });
  280 |         await list.getByText("UX 조명 60", { exact: true }).press("Escape");
  281 |         await expect(page.getByRole("button", { name: "전체 보기", exact: true })).toBeFocused();
  282 |         await finite(page);
  283 |       } finally { await identity.dispose(); }
  284 |     });
  285 |   });
  286 | });
  287 | 
  288 | test.describe("05 resize without remount/reset", () => {
  289 |   test.use({ viewport: reviewCases[4].viewport });
  290 |   // Catches presentation toggles and breakpoint changes resetting renderer or raw draft.
  291 |   test("717x1227 to 390x844 light: inline/More, focus and raw31", async ({ page, context, baseURL }, info) => {
```