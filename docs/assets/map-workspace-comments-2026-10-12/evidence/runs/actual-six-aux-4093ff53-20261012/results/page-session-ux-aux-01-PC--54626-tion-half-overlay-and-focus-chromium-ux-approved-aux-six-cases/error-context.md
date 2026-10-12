# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: page-session-ux-aux.spec.ts >> 01 PC monitoring actual CAD and nonmodal detail >> 1194 light: pan, single selection, half overlay and focus
- Location: .superpowers/sdd/2026-10-12-map-workspace-comments/page-session-ux-aux.spec.ts:289:7

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator:  locator('[data-monitoring-detail-scroll]').locator('dd').last()
Expected: "배치됨"
Received: "미배치"
Timeout:  5000ms

Call log:
  - Expect "toHaveText" with timeout 5000ms
  - waiting for locator('[data-monitoring-detail-scroll]').locator('dd').last()
    14 × locator resolved to <dd class="m-0 min-w-0 break-words text-body-sm">미배치</dd>
       - unexpected value "미배치"

```

```yaml
- definition: 미배치
```

# Test source

```ts
  133 |   const countBox = await heading.boundingBox(), fullBox = await selectionDisclosure(page).boundingBox();
  134 |   expect(countBox).not.toBeNull(); expect(fullBox).not.toBeNull();
  135 |   expect(fullBox!.y - (countBox!.y + countBox!.height), "44 full-view remains immediately below selection count").toBeGreaterThanOrEqual(0);
  136 |   expect(fullBox!.y - (countBox!.y + countBox!.height)).toBeLessThanOrEqual(5);
  137 |   await expectContinuous44Hit(selectionDisclosure(page));
  138 |   // Original camera44 scope is the exposed basic/closed map. The approved
  139 |   // z10 bottom reader may cover z6 cameras while open; record that occlusion
  140 |   // rather than inventing a new requirement that cameras must pierce it.
  141 |   if (state === "closed") await expectMinimumTouchTargets(page, approvedAuxiliaryBinding.cameraTouchSelector);
  142 |   const important = page.getByRole("status", { name: "제어 중요 상태", exact: true });
  143 |   await expect(important).toBeVisible(); await expect(important).toHaveAttribute("aria-live", "polite");
  144 |   await actualCenter(important);
  145 |   await finite(page); await identity.assertUnchanged();
  146 |   const after = await readGeometry(page, control);
  147 |   expect(after.map.bounds.height, "basic compact manual map240 target may not be bypassed by zoom").toBeGreaterThanOrEqual(240);
  148 |   expect(after.map.usable, "map must have an ancestor-unclipped usable box").not.toBeNull();
  149 |   expect(after.map.usable!.width).toBeGreaterThanOrEqual(after.map.bounds.width - 1);
  150 |   expect(after.map.usable!.height).toBeGreaterThanOrEqual(after.map.bounds.height - 1);
  151 |   expect(after.exposedMap.area, "actual map must not be completely covered").toBeGreaterThan(0);
  152 |   for (const region of ["toolbar", "execution", "selection", "more"]) {
  153 |     for (const item of after.regions[region] ?? []) {
  154 |       if (item.usable) expect(after.map.bounds.height, "map remains the dominant individual task region").toBeGreaterThanOrEqual(item.usable.height);
  155 |     }
  156 |   }
  157 |   // A source-approved opaque camera overlay is normal baseline occlusion, not
  158 |   // an auxiliary defect. Subtract it independently; fixed nav may never cover
  159 |   // the usable map and closed auxiliary state adds no further occlusion.
  160 |   for (const blocker of after.exposedMap.blockers.filter(item => item.selector === '[data-shell-navigation="compact"]')) {
  161 |     const overlapWidth = Math.min(after.map.usable!.right, blocker.bounds!.right) - Math.max(after.map.usable!.x, blocker.bounds!.x);
  162 |     const overlapHeight = Math.min(after.map.usable!.bottom, blocker.bounds!.bottom) - Math.max(after.map.usable!.y, blocker.bounds!.y);
  163 |     expect(overlapWidth <= 0 || overlapHeight <= 0, "fixed navigation must not cover the usable map").toBe(true);
  164 |   }
  165 |   const cameraOnly = await readGeometry(page, { ...control, occluders: approvedAuxiliaryBinding.cameraOverlaySurfaceSelectors });
  166 |   const baselineCameraOcclusionArea = after.map.usable!.width * after.map.usable!.height - cameraOnly.exposedMap.area;
  167 |   const additionalAuxiliaryOcclusionArea = cameraOnly.exposedMap.area - after.exposedMap.area;
  168 |   if (state === "closed") expect(Math.abs(additionalAuxiliaryOcclusionArea), "closed auxiliaries must add no occlusion beyond the actual camera baseline").toBeLessThanOrEqual(1);
  169 |   if (before) {
  170 |     expect(after.map.bounds, "auxiliary open/switch/close must preserve the map rect").toEqual(before.map.bounds);
  171 |     expect(after.map.camera, "auxiliary presentation must preserve the actual camera").toEqual(before.map.camera);
  172 |   }
  173 |   await phase(name, { auxiliary: state, baseline: before && { mapBounds: before.map.bounds, camera: before.map.camera, exposedArea: before.exposedMap.area }, cameraPlacement: approvedAuxiliaryBinding.cameraPlacement, baselineCameraOcclusionArea, additionalAuxiliaryOcclusionArea, actualExposedArea: after.exposedMap.area });
  174 |   return after;
  175 | }
  176 | 
  177 | /** Mobile monitoring intentionally allows document scrolling. Move it natively
  178 |  * off the fixed navigation before wheeling the detail body, and distinguish
  179 |  * that translation from map resize/camera movement instead of forcing scroll. */
  180 | async function moveMonitoringAboveNav(page: Page, before: Snapshot) {
  181 |   const aside = page.locator('aside[aria-label="조명 상세"]'), nav = page.locator('[data-shell-navigation="compact"]');
  182 |   const wheels: unknown[] = [];
  183 |   for (let step = 0; step < 6; step++) {
  184 |     const asideBox = await aside.boundingBox(), navBox = await nav.boundingBox();
  185 |     if (!asideBox || !navBox) throw new Error("Actual mobile detail/navigation geometry missing");
  186 |     const deficit = asideBox.y + asideBox.height - navBox.y;
  187 |     if (deficit <= 0) break;
  188 |     const origin = await exposedPoint(page.locator("body"), true);
  189 |     const scrollBefore = await page.evaluate(() => scrollY);
  190 |     await page.mouse.move(origin.x, origin.y); await page.mouse.wheel(0, Math.ceil(deficit + 2)); await settle(page);
  191 |     const scrollAfter = await page.evaluate(() => scrollY);
  192 |     wheels.push({ origin, delta: Math.ceil(deficit + 2), scrollBefore, scrollAfter });
  193 |     expect(scrollAfter, "native document wheel must move detail above the navigation").toBeGreaterThan(scrollBefore);
  194 |   }
  195 |   const moved = await readGeometry(page, mon), asideBox = await aside.boundingBox(), navBox = await nav.boundingBox();
  196 |   expect(asideBox!.y + asideBox!.height, "detail ending must be above fixed nav").toBeLessThanOrEqual(navBox!.y);
  197 |   expect(moved.map.bounds.width).toBe(before.map.bounds.width);
  198 |   expect(moved.map.bounds.height).toBe(before.map.bounds.height);
  199 |   expect(moved.map.bounds.x).toBe(before.map.bounds.x);
  200 |   expect(moved.map.bounds.y + moved.document.scrollY, "native document translation is not a map resize").toBe(before.map.bounds.y + before.document.scrollY);
  201 |   expect(moved.map.camera).toEqual(before.map.camera);
  202 |   return { wheels, beforeScrollY: before.document.scrollY, afterScrollY: moved.document.scrollY, beforeBounds: before.map.bounds, afterBounds: moved.map.bounds };
  203 | }
  204 | 
  205 | async function detail(page: Page, info: TestInfo, phase: (name: string, extra?: unknown) => Promise<void>) {
  206 |   const map = page.locator(mon.map), opener = firstMarker(page);
  207 |   const identity = await rememberMapIdentity(map), before = await readGeometry(page, mon);
  208 |   try {
  209 |     await opener.click();
  210 |     await expect(map.locator('[data-spatial-map-marker="true"][aria-current="true"]')).toHaveCount(1);
  211 |     await expect(opener).toHaveAttribute("aria-current", "true");
  212 |     await page.getByRole("button", { name: "상세 보기", exact: true }).click();
  213 |     const aside = page.locator('aside[aria-label="조명 상세"]');
  214 |     await expect(aside).toBeVisible();
  215 |     await phase("detail-open");
  216 |     const after = await readGeometry(page, mon);
  217 |     expect(after.map.bounds).toEqual(before.map.bounds);
  218 |     expect(after.map.camera).toEqual(before.map.camera);
  219 |     await identity.assertUnchanged();
  220 |     const half = await aside.evaluate(element => ({ height: element.getBoundingClientRect().height, parent: element.parentElement!.getBoundingClientRect().height }));
  221 |     expect(Math.abs(half.height - half.parent / 2), "detail must occupy half of existing containing body").toBeLessThanOrEqual(1);
  222 |     const mobile = (page.viewportSize()?.width ?? 0) < 1024;
  223 |     if (mobile) {
  224 |       const movement = await moveMonitoringAboveNav(page, after);
  225 |       await identity.assertUnchanged();
  226 |       await phase("detail-native-document-wheel", movement);
  227 |     }
  228 |     const close = page.getByRole("button", { name: "조명 상세 닫기", exact: true }), headerBefore = await close.boundingBox();
  229 |     await expectMinimumTouchTargets(page, 'aside[aria-label="조명 상세"]');
  230 |     const body = page.locator('[data-monitoring-detail-scroll]');
  231 |     const end = await internalEnd(page, body, mobile);
  232 |     const lastInformation = body.locator("dd").last();
> 233 |     await expect(lastInformation).toHaveText("배치됨");
      |                                   ^ Error: expect(locator).toHaveText(expected) failed
  234 |     await expect(lastInformation).toBeInViewport({ ratio: 1 });
  235 |     await actualCenter(lastInformation);
  236 |     expect(await mapCamera(map)).toEqual(before.map.camera);
  237 |     expect(await close.boundingBox()).toEqual(headerBefore);
  238 |     await phase("detail-end", { end, half });
  239 |     await close.click();
  240 |     await expect(aside).toHaveCount(0);
  241 |     await expect(opener).toBeFocused();
  242 |     await identity.assertUnchanged();
  243 |     expect(await mapCamera(map)).toEqual(before.map.camera);
  244 |     // Closing detail preserves selected pin/focus, not an automatically reopened
  245 |     // popover. Native re-click follows the actual production reopen path.
  246 |     await opener.click();
  247 |     await page.getByRole("button", { name: "상세 보기", exact: true }).click();
  248 |     await expect(body).toBeVisible();
  249 |     await expect.poll(() => body.evaluate(element => element.scrollTop)).toBe(end.top);
  250 |     await aside.press("Escape");
  251 |     await expect(opener).toBeFocused();
  252 |     await phase("detail-closed", { half, end });
  253 |   } finally { await identity.dispose(); }
  254 | }
  255 | 
  256 | // Failure evidence is captured before rethrow. Original runner error and every
  257 | // phase remain in a fresh run directory; no automatic case reruns.
  258 | async function review(page: Page, info: TestInfo, index: number, setup: () => Promise<{ requests: unknown; assertNoWrites(): void }>, body: (phase: (name: string, extra?: unknown) => Promise<void>) => Promise<void>) {
  259 |   const scenario = reviewCases[index], contract = scenario.route === "monitoring" ? mon : control;
  260 |   let lastPhase = "setup", state: Awaited<ReturnType<typeof setup>> | undefined;
  261 |   const phase = async (name: string, extra?: unknown) => {
  262 |     lastPhase = name;
  263 |     await savePhase(page, info, name, contract, { case: scenario, requests: state?.requests, extra });
  264 |   };
  265 |   try {
  266 |     state = await setup();
  267 |     await page.goto(`/${scenario.route}?siteId=${ids.siteId}`);
  268 |     await expect(page.locator(contract.map).locator("canvas").first()).toBeVisible();
  269 |     await expect(firstMarker(page)).toBeVisible();
  270 |     await setReviewTheme(page, scenario.theme);
  271 |     await phase("ready");
  272 |     await body(phase);
  273 |     state.assertNoWrites();
  274 |     await phase("complete");
  275 |   } catch (error) {
  276 |     const original = { source: process.env.UX_SOURCE_SHA, case: scenario, phase: lastPhase, url: page.url(), requests: state?.requests, error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) };
  277 |     const path = info.outputPath("original-failure.json");
  278 |     await writeFile(path, JSON.stringify(original, null, 2));
  279 |     await info.attach("original-failure", { path, contentType: "application/json" });
  280 |     try { await savePhase(page, info, "failure", contract, original); }
  281 |     catch (captureError) { await info.attach("failure-capture-error", { body: String(captureError), contentType: "text/plain" }); }
  282 |     throw error;
  283 |   }
  284 | }
  285 | 
  286 | test.describe("01 PC monitoring actual CAD and nonmodal detail", () => {
  287 |   test.use({ viewport: reviewCases[0].viewport });
  288 |   // Catches selection-area regressions, camera remounts, flowing overlays and wheel leakage.
  289 |   test("1194 light: pan, single selection, half overlay and focus", async ({ page, context, baseURL }, info) => {
  290 |     await review(page, info, 0, () => prepareCustomer(page, context, baseURL!, 3), async phase => {
  291 |       const toolbar = page.getByRole("group", { name: "모니터링 도구" }), map = page.locator(mon.map);
  292 |       await row(page, [toolbar.getByRole("button", { name: /맵 선택/ }), toolbar.getByRole("button", { name: "조명 검색/목록" }), toolbar.getByRole("button", { name: "새로고침" }), toolbar.locator("time")]);
  293 |       await expectMinimumTouchTargets(page, '[role="group"][aria-label="모니터링 도구"]');
  294 |       for (let step = 0; step < 8; step++) await page.getByRole("button", { name: "지도 확대", exact: true }).click();
  295 |       const middle = await pan(page, map, "middle"), space = await pan(page, map, "space");
  296 |       const point = await blankPoint(map), old = await mapCamera(map);
  297 |       await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, -80); await settle(page);
  298 |       expect((await mapCamera(map)).zoom).not.toBe(old.zoom);
  299 |       await phase("native-gestures", { middle, space, wheelBefore: old, wheelAfter: await mapCamera(map) });
  300 |       await page.getByRole("button", { name: /^지도 배율/ }).click();
  301 |       await detail(page, info, phase);
  302 |       await expectNoHorizontalOverflow(page);
  303 |     });
  304 |   });
  305 | });
  306 | 
  307 | test.describe("02 short mobile monitoring", () => {
  308 |   test.use({ viewport: reviewCases[1].viewport });
  309 |   // Catches wrapped controls, lost accessible timestamp and inaccessible detail endings.
  310 |   test("390x600 dark: toolbar, HH:mm and detail scroll", async ({ page, context, baseURL }, info) => {
  311 |     await review(page, info, 1, () => prepareCustomer(page, context, baseURL!, 3), async phase => {
  312 |       const toolbar = page.getByRole("group", { name: "모니터링 도구" });
  313 |       await row(page, [toolbar.getByRole("button", { name: /맵 선택/ }), toolbar.getByRole("button", { name: "조명 검색/목록" }), toolbar.getByRole("button", { name: "새로고침" }), toolbar.locator("time")]);
  314 |       await expect(toolbar.locator("time")).toHaveText(/^\d{2}:\d{2}$/, { useInnerText: true });
  315 |       await expect(toolbar.locator("time")).toHaveAttribute("aria-label", /현장 시간/);
  316 |       await expect(toolbar.locator("time")).toHaveAttribute("datetime", /T/);
  317 |       await expectMinimumTouchTargets(page, '[role="group"][aria-label="모니터링 도구"]');
  318 |       await expectMinimumTouchTargets(page, '[data-shell-navigation="compact"]');
  319 |       await detail(page, info, phase);
  320 |       await expectNoHorizontalOverflow(page);
  321 |     });
  322 |   });
  323 | });
  324 | 
  325 | test.describe("03 narrow finite manual workspace", () => {
  326 |   test.use({ viewport: reviewCases[2].viewport });
  327 |   // Catches tiny basic maps, weakened endpoint hits, concurrent auxiliaries,
  328 |   // lost critical state/raw draft, and accidental first-invalid Apply writes.
  329 |   test("320x600 light: map240, native0/100, first Apply and exclusive auxiliaries", async ({ page, context, baseURL }, info) => {
  330 |     await review(page, info, 2, () => prepareCustomer(page, context, baseURL!, 3), async phase => {
  331 |       const map = page.locator(control.map), identity = await rememberMapIdentity(map);
  332 |       try {
  333 |         const basic = await manualState(page, identity, phase, "basic-map-before-zoom", "closed");
```