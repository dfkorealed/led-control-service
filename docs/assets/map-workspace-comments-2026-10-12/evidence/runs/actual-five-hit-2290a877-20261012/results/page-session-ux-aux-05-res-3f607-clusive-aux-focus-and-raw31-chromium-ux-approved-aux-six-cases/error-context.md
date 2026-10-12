# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: page-session-ux-aux.spec.ts >> 05 resize without remount/reset >> 717x1227 to 390x844 light: exclusive aux, focus and raw31
- Location: .superpowers/sdd/2026-10-12-map-workspace-comments/page-session-ux-aux.spec.ts:427:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator:  getByRole('status', { name: '제어 중요 상태', exact: true })
Expected: visible
Received: hidden
Timeout:  5000ms

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByRole('status', { name: '제어 중요 상태', exact: true })
    14 × locator resolved to <div role="status" aria-live="polite" aria-atomic="true" aria-label="제어 중요 상태" class="max-h-20 overflow-y-auto overscroll-contain text-caption"></div>
       - unexpected value "hidden"

```

```yaml
- log: "31"
- log
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
  - heading "조명 제어" [level=1]
  - paragraph: 수동 제어
  - tabpanel "수동 제어":
    - region "제어 대상 지도":
      - region "공간 대상 선택":
        - text: 표시 층
        - button "표시 층": B2
        - text: 선택 범위
        - button "선택 범위": 개별 조명
        - button "조명 목록"
        - region "B2 도면":
          - button "UX 조명 01 정상 70% 선택됨" [pressed]
          - button "UX 조명 02 정상 70%"
          - button "UX 조명 03 정상 70%"
        - group "지도 확대 축소":
          - button "지도 축소"
          - button "지도 배율 100%": 100%
          - button "지도 확대"
          - button "지도 화면 맞춤"
        - region "선택 대상 목록":
          - heading "선택 조명 1개" [level=3]
          - button "전체 보기"
    - complementary "밝기 실행":
      - region "제어 대상":
        - heading "제어 대상" [level=3]
        - strong: 1개 선택
        - text: 전송 가능
      - text: 밝기
      - textbox "밝기 수치": "31"
      - group "밝기":
        - slider "밝기": "31"
      - button "1개 조명에 밝기 적용": 적용
      - button "더보기"
      - status "제어 중요 상태"
```

# Test source

```ts
  43  | 
  44  | /** Wheel the real scroll owner; never assign scrollTop or call scrollIntoView. */
  45  | async function internalEnd(page: Page, root: Locator, useExposedPoint = false) {
  46  |   const center = useExposedPoint ? await exposedPoint(root) : await actualCenter(root);
  47  |   await page.mouse.move(center.x, center.y);
  48  |   for (let step = 0; step < 10; step++) {
  49  |     const state = await root.evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight }));
  50  |     if (state.top >= state.height - state.client - 1) break;
  51  |     await page.mouse.wheel(0, 1600);
  52  |     await settle(page);
  53  |   }
  54  |   const state = await root.evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight }));
  55  |   expect(state.top, "native wheel must reach internal bottom").toBeGreaterThanOrEqual(state.height - state.client - 1);
  56  |   return state;
  57  | }
  58  | 
  59  | async function blankPoint(map: Locator) {
  60  |   return map.evaluate(element => {
  61  |     const r = element.getBoundingClientRect();
  62  |     for (const yRatio of [0.4, 0.6, 0.25]) for (const xRatio of [0.4, 0.65, 0.25]) {
  63  |       const x = r.x + r.width * xRatio, y = r.y + r.height * yRatio;
  64  |       const hit = document.elementFromPoint(x, y);
  65  |       if (hit && element.contains(hit) && hit.closest('[data-floor-map-surface]') && !hit.closest('button')) return { x, y };
  66  |     }
  67  |     throw new Error("No exposed blank map point available for native CAD gesture");
  68  |   });
  69  | }
  70  | 
  71  | async function pan(page: Page, map: Locator, kind: "middle" | "space") {
  72  |   const start = await blankPoint(map), before = await mapCamera(map);
  73  |   if (kind === "space") { await map.focus(); await page.keyboard.down("Space"); }
  74  |   try {
  75  |     await page.mouse.move(start.x, start.y);
  76  |     await page.mouse.down({ button: kind === "middle" ? "middle" : "left" });
  77  |     await page.mouse.move(start.x - 30, start.y - 24, { steps: 8 });
  78  |     await page.mouse.up({ button: kind === "middle" ? "middle" : "left" });
  79  |   } finally { if (kind === "space") await page.keyboard.up("Space"); }
  80  |   await settle(page);
  81  |   const after = await mapCamera(map);
  82  |   expect(after.x !== before.x || after.y !== before.y, `${kind} drag must move actual camera`).toBe(true);
  83  |   await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
  84  |   return { before, after };
  85  | }
  86  | 
  87  | async function selectFloor(page: Page, compact: boolean) {
  88  |   if (compact) {
  89  |     await page.getByRole("button", { name: /선택 범위/ }).click();
  90  |     await page.getByRole("option", { name: "층 전체", exact: true }).click();
  91  |   } else await page.getByRole("group", { name: "대상 선택 방식" }).getByRole("button", { name: "층 전체", exact: true }).click();
  92  |   const confirmation = page.getByRole("alertdialog", { name: "선택 방식 변경" });
  93  |   if (await confirmation.count()) await confirmation.getByRole("button", { name: "변경", exact: true }).click();
  94  |   await expect(page.getByRole("heading", { name: "선택 조명 60개", exact: true })).toBeVisible();
  95  | }
  96  | 
  97  | 
  98  | const selectionDisclosure = (page: Page) => page.locator('[data-manual-selection-panel]').getByRole("button", { name: /^(전체 보기|접기)$/ });
  99  | async function selectionList(page: Page) {
  100 |   const id = await selectionDisclosure(page).getAttribute("aria-controls");
  101 |   if (!id) throw new Error("Selection disclosure must identify its actual controlled panel");
  102 |   await expect(page.locator(approvedAuxiliaryBinding.surfaceSelectors[0])).toHaveAttribute("id", id);
  103 |   return page.locator(approvedAuxiliaryBinding.selectionContentSelector);
  104 | }
  105 | type Snapshot = Awaited<ReturnType<typeof readGeometry>>;
  106 | type Identity = Awaited<ReturnType<typeof rememberMapIdentity>>;
  107 | 
  108 | /** No map space is traded for an auxiliary. Raw/clipped/exposed measurements
  109 |  * stay separate: stable raw bounds alone cannot excuse a covered or zero map. */
  110 | async function manualState(page: Page, identity: Identity, phase: (name: string, extra?: unknown) => Promise<void>, name: string, state: "closed" | "list" | "more", before?: Snapshot) {
  111 |   const list = await selectionList(page), more = page.getByRole("button", { name: "더보기", exact: true });
  112 |   const content = page.locator(approvedAuxiliaryBinding.moreContentSelector);
  113 |   const panel = page.locator(approvedAuxiliaryBinding.surfaceSelectors[0]);
  114 |   await expect(more).toHaveAttribute("aria-controls", (await panel.getAttribute("id"))!);
  115 |   await expect(selectionDisclosure(page)).toHaveAttribute("aria-expanded", state === "list" ? "true" : "false");
  116 |   await expect(more).toHaveAttribute("aria-expanded", state === "more" ? "true" : "false");
  117 |   if (state === "list") await expect(list).toBeVisible(); else await expect(list).toBeHidden();
  118 |   if (state === "more") await expect(content).toBeVisible(); else await expect(content).toBeHidden();
  119 |   if (state === "closed") await expect(panel).toBeHidden(); else await expect(panel).toBeVisible();
  120 |   if (state !== "closed") {
  121 |     const surfaces = await Promise.all(approvedAuxiliaryBinding.surfaceSelectors.map(selector => page.locator(selector).isVisible()));
  122 |     expect(surfaces.filter(Boolean), "one actual opaque auxiliary surface must be included in exposed-map geometry").toHaveLength(1);
  123 |     const surface = page.locator(approvedAuxiliaryBinding.surfaceSelectors[surfaces.findIndex(Boolean)]);
  124 |     const surfaceBox = await surface.boundingBox(), anchorBox = await page.locator(approvedAuxiliaryBinding.anchorSelector).boundingBox();
  125 |     expect(surfaceBox).not.toBeNull(); expect(anchorBox).not.toBeNull();
  126 |     expect(Math.abs(surfaceBox!.y + surfaceBox!.height - (anchorBox!.y + anchorBox!.height)), "approved auxiliary sits at its source-defined map-bottom anchor").toBeLessThanOrEqual(1);
  127 |     await expectContinuous44Hit(panel.getByRole("button", { name: "보조 패널 닫기", exact: true }));
  128 |   }
  129 |   await expect(page.getByRole("dialog")).toHaveCount(0);
  130 |   await expect(page.locator(control.map)).toHaveAttribute("tabindex", /-?\d+/);
  131 |   expect(await page.locator(control.map).evaluate(element => Boolean(element.closest('[inert],[aria-hidden="true"]'))), "nonmodal auxiliary must leave map available").toBe(false);
  132 |   const heading = page.locator('[data-manual-selection-panel]').getByRole("heading");
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
> 143 |   await expect(important).toBeVisible(); await expect(important).toHaveAttribute("aria-live", "polite");
      |                           ^ Error: expect(locator).toBeVisible() failed
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
  233 |     await expect(lastInformation).toHaveText("미배치");
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
```