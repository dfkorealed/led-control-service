# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: page-session-ux.spec.ts >> 06 PC manual empty and long-list ownership >> 1194 dark: equal-height empty panel and 60-row internal scroll
- Location: ../../.superpowers/sdd/2026-10-12-map-workspace-comments/page-session-ux.spec.ts:320:7

# Error details

```
Error: expect(locator).toBeHidden() failed

Locator:  getByRole('button', { name: '전체 보기', exact: true })
Expected: hidden
Received: visible
Timeout:  5000ms

Call log:
  - Expect "toBeHidden" with timeout 5000ms
  - waiting for getByRole('button', { name: '전체 보기', exact: true })
    14 × locator resolved to <button type="button" data-variant="ghost" aria-haspopup="dialog" class="inline-flex min-h-11 items-center justify-center gap-2 rounded-control border font-bold cursor-pointer focus-visible:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-60 px-4 py-0 text-body text-content-primary hover:enabled:bg-surface-inset aria-pressed:bg-action-primary-soft aria-pressed:text-action-primary border-transparent bg-transparent">…</button>
       - unexpected value "visible"

```

```yaml
- button "전체 보기"
```

# Test source

```ts
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
  292 |     await review(page, info, 4, () => prepareCustomer(page, context, baseURL!, 3), async phase => {
  293 |       const map = page.locator(control.map), identity = await rememberMapIdentity(map);
  294 |       try {
  295 |         await firstMarker(page).click();
  296 |         const input = page.getByRole("spinbutton", { name: "밝기 수치" });
  297 |         await input.fill("31");
  298 |         const before = await mapCamera(map);
  299 |         await page.getByRole("button", { name: "전체 보기", exact: true }).click();
  300 |         await page.getByRole("button", { name: "더보기", exact: true }).click();
  301 |         await identity.assertUnchanged(); expect(await mapCamera(map)).toEqual(before);
  302 |         await expect(input).toHaveValue("31"); await finite(page);
  303 |         await phase("both-expanded");
  304 |         await page.getByRole("button", { name: "접기", exact: true }).click();
  305 |         await page.getByRole("button", { name: "더보기", exact: true }).click();
  306 |         await input.focus();
  307 |         await page.setViewportSize(reviewCases[4].resize); await settle(page);
  308 |         await expect(input).toHaveValue("31"); await expect(input).toBeFocused();
  309 |         await identity.assertUnchanged(); await finite(page);
  310 |         const geometry = await readGeometry(page, control);
  311 |         await phase("resized-focused", { before, after: geometry.map.camera, mapGoal240: { actual: geometry.map.bounds.height, met: geometry.map.bounds.height >= 240 }, limitation: "Viewport resize only; no OS software keyboard" });
  312 |       } finally { await identity.dispose(); }
  313 |     });
  314 |   });
  315 | });
  316 | 
  317 | test.describe("06 PC manual empty and long-list ownership", () => {
  318 |   test.use({ viewport: reviewCases[5].viewport });
  319 |   // Catches empty-panel collapse and a list growing the map row instead of scrolling internally.
  320 |   test("1194 dark: equal-height empty panel and 60-row internal scroll", async ({ page, context, baseURL }, info) => {
  321 |     await review(page, info, 5, () => prepareCustomer(page, context, baseURL!, 60), async phase => {
  322 |       const map = page.locator(control.map), identity = await rememberMapIdentity(map);
  323 |       try {
  324 |         const listPanel = page.locator('[data-manual-selection-panel]'), operation = page.locator('[data-operation-map-panel]');
  325 |         const empty = { mapPanel: await operation.boundingBox(), selection: await listPanel.boundingBox() };
  326 |         expect(empty.mapPanel).not.toBeNull(); expect(empty.selection).not.toBeNull();
  327 |         expect(Math.abs(empty.mapPanel!.height - empty.selection!.height)).toBeLessThanOrEqual(1);
  328 |         await expect(page.getByRole("button", { name: "더보기", exact: true })).toBeHidden();
> 329 |         await expect(page.getByRole("button", { name: "전체 보기", exact: true })).toBeHidden();
      |                                                                                ^ Error: expect(locator).toBeHidden() failed
  330 |         await phase("empty-full-row", empty);
  331 |         await selectFloor(page, false);
  332 |         const list = listPanel.locator(':scope > div:last-child'), heading = page.getByRole("heading", { name: "선택 조명 60개", exact: true }), before = await heading.boundingBox();
  333 |         const end = await internalEnd(page, list);
  334 |         await actualCenter(list.getByText("UX 조명 60", { exact: true }));
  335 |         expect(await heading.boundingBox()).toEqual(before);
  336 |         await identity.assertUnchanged();
  337 |         await phase("pc-list-end", { end, empty, populated: { mapPanel: await operation.boundingBox(), selection: await listPanel.boundingBox() }, recoveryBrowser: "Not run; final control consumer unit cohort covers original UUID/recovery" });
  338 |         await expectNoHorizontalOverflow(page);
  339 |       } finally { await identity.dispose(); }
  340 |     });
  341 |   });
  342 | });
  343 | 
```