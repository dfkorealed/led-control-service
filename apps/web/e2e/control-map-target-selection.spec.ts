import { expect, test, type Page } from "@playwright/test";
import { expectMinimumTouchTargetsAfterScrolling, expectNoHorizontalOverflow } from "./support/layout-assertions";
import { installSettingsApiRoutes, type SettingsFixture, type SettingsRole } from "./support/settings-api";
import { installMockApiBoundary } from "./support/mock-api-boundary";

const ids = {
  site: "99999999-9999-4999-8999-999999999901",
  floor: "99999999-9999-4999-8999-999999999902",
  gateway: "99999999-9999-4999-8999-999999999903",
  fixture: "99999999-9999-4999-8999-999999999904",
  fixtureTwo: "99999999-9999-4999-8999-999999999905",
  sensor: "99999999-9999-4999-8999-999999999906",
  group: "99999999-9999-4999-8999-999999999907",
  createdGroup: "99999999-9999-4999-8999-999999999908"
} as const;

const fixtures: SettingsFixture[] = [
  fixture(ids.fixture, "B2-L001", 120, 120),
  fixture(ids.fixtureTwo, "B2-L002", 600, 360),
  fixture(ids.sensor, "B2-SENSOR-001", 1_000, 300, {
    vehicleSensorCapabilityStatus: "supported",
    vehicleSensorCapabilityVerifiedAt: "2026-09-01T00:00:00.000Z"
  })
];

test.use({ timezoneId: "Asia/Seoul" });

test.beforeEach(async ({ context, baseURL }) => {
  await installMockApiBoundary(context, baseURL);
});

test("Task6 unmodified wheel zoom preserves the pointer anchor without a control POST", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installControlMapRoutes(page);
  await page.goto(`/control?siteId=${ids.site}`);
  const viewport = page.getByTestId("target-selection-map-viewport");
  await expect(viewport).toBeVisible();
  for (let index = 0; index < 10; index += 1) await page.getByRole("button", { name: "지도 확대", exact: true }).click();
  const before = await viewport.getAttribute("data-zoom");
  const box = (await viewport.boundingBox())!;
  const point = { x: box.x + box.width * .5, y: box.y + box.height * .5 };
  const surface = viewport.locator("[data-floor-map-surface]");
  const initialSurface = (await surface.boundingBox())!;
  const anchor = { x: (point.x - initialSurface.x) / initialSurface.width, y: (point.y - initialSurface.y) / initialSurface.height };
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, -120);
  await expect.poll(() => viewport.getAttribute("data-zoom")).not.toBe(before);
  await expect.poll(async () => { const after = (await surface.boundingBox())!; return Math.abs(after.x + anchor.x * after.width - point.x); }).toBeLessThan(2);
  await expect.poll(async () => { const after = (await surface.boundingBox())!; return Math.abs(after.y + anchor.y * after.height - point.y); }).toBeLessThan(2);
  await marker(page, "B2-L002").click();
  await expect(marker(page, "B2-L002")).toHaveAttribute("aria-pressed", "true");
  await expect(marker(page, "B2-L001")).toHaveAttribute("aria-pressed", "false");
  expect(api.postRequests).toEqual([]);
});

for (const flow of ["schedule", "event", "group"] as const) {
  test(`final review: ${flow} dialog provides a usable desktop map and marker selection`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installControlMapRoutes(page);
    await page.goto(`/control?siteId=${ids.site}${flow === "group" ? "" : "&mode=schedule"}`);
    if (flow === "schedule") {
      await page.getByRole("button", { name: "스케줄 추가" }).click();
      await page.getByRole("button", { name: "제어 대상 선택", exact: true }).click();
    } else if (flow === "event") {
      await page.getByRole("tab", { name: "이벤트 제어" }).click();
      await page.getByRole("button", { name: "이벤트 추가" }).click();
      await page.getByRole("button", { name: "감지 센서 선택", exact: true }).click();
    } else {
      await openCompactTools(page);
      await page.getByRole("button", { name: "구역 관리" }).click();
      await page.getByRole("button", { name: "새 구역" }).click();
    }
    const dialog = page.getByRole("dialog");
    const surface = dialog.locator("[data-floor-map-surface]");
    await expect(surface).toBeVisible();
    if (flow === "group") await test.info().attach("group-map-geometry", { contentType: "application/json", body: JSON.stringify(await dialog.evaluate(element => [...element.querySelectorAll<HTMLElement>("[data-fixture-group-map-editor], [data-target-selection-content], [data-floor-map-surface], [data-testid='target-selection-map-viewport']")].map(node => ({ tag: node.tagName, rect: node.getBoundingClientRect().toJSON(), className: node.className, attrs: Object.fromEntries([...node.attributes].filter(attr => attr.name.startsWith("data-")).map(attr => [attr.name, attr.value])) }))), null, 2) });
    const interactiveViewport = dialog.getByTestId("target-selection-map-viewport");
    // A fitted image may be smaller than its usable interactive viewport.
    await expect.poll(async () => (await interactiveViewport.boundingBox())!.width).toBeGreaterThanOrEqual(400);
    await expect.poll(async () => (await interactiveViewport.boundingBox())!.height).toBeGreaterThanOrEqual(240);
    const target = marker(dialog, flow === "event" ? "B2-SENSOR-001" : "B2-L001");
    await expectReachableInside(target, dialog);
    await target.click();
    await expect(target).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight)).toBe(0);
    await expectNoHorizontalOverflow(page);
  });
}

test("final review: compact manual controls follow the map and remain reachable at reduced height", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 660 });
  const api = await installControlMapRoutes(page);
  await page.goto(`/control?siteId=${ids.site}`);
  await marker(page, "B2-L001").click();
  const execution = page.getByRole("complementary", { name: "밝기 실행" });
  await openCompactExecution(page);
  const action = execution.getByRole("button", { name: "1개 조명에 밝기 적용" });
  await expect(execution.getByText("1개 선택", { exact: true })).toBeVisible();
  await execution.getByRole("textbox", { name: "밝기 수치" }).scrollIntoViewIfNeeded();
  await expect(execution.getByRole("textbox", { name: "밝기 수치" })).toBeVisible();
  // Manual control now follows map → execution → history, not a fixed sheet.
  await action.scrollIntoViewIfNeeded();
  await expectReachableInside(action, execution);
  const actionBox = (await action.boundingBox())!;
  const navBox = (await page.locator('[data-shell-navigation="compact"]').boundingBox())!;
  expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(navBox.y);
  expect(actionBox.y).toBeGreaterThanOrEqual(0);
  await expectNoHorizontalOverflow(page);
  expect(api.postRequests).toEqual([]);
});

test("final review: compact group name uses 16px text", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await installControlMapRoutes(page);
  await page.goto(`/control?siteId=${ids.site}`);
  await openCompactTools(page);
  await page.getByRole("button", { name: "구역 관리" }).click();
  await page.getByRole("button", { name: "새 구역" }).click();
  expect(await page.getByRole("textbox", { name: "구역 이름" }).evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  expect(api.postRequests).toEqual([]);
});

for (const viewport of [{ width: 390, height: 660 }, { width: 320, height: 740 }] as const) {
  test(`group creation at ${viewport.width}x${viewport.height} keeps a usable map and selectable marker`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installControlMapRoutes(page);
    await page.goto(`/control?siteId=${ids.site}`);
    await openCompactTools(page);
    await page.getByRole("button", { name: "구역 관리" }).click();
    await page.getByRole("button", { name: "새 구역" }).click();

    const dialog = page.getByRole("dialog", { name: "구역 생성" });
    const editor = dialog.getByTestId("fixture-group-map-editor");
    const content = editor.locator("[data-target-selection-content]");
    await expect(content).toBeVisible();
    await expect.poll(async () => content.evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(224);

    const target = marker(editor, "B2-L001");
    await target.click();
    await expect(target).toHaveAttribute("aria-pressed", "true");
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }] as const) {
  test(`clearing a 100-member group at ${viewport.width}x${viewport.height} keeps the selector usable while changes scroll separately`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installControlMapRoutes(page, { fixtureCount: 100, groupMemberCount: 100 });
    await page.goto(`/control?siteId=${ids.site}`);
    await openCompactTools(page);
    await page.getByRole("button", { name: "구역 관리" }).click();
    await page.getByRole("button", { name: "B2 입구 수정" }).click();

    const dialog = page.getByRole("dialog", { name: "구역 수정" });
    const editor = dialog.getByTestId("fixture-group-map-editor");
    const content = editor.locator("[data-target-selection-content]");
    await expect.poll(async () => content.evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(240);
    await test.info().attach("dense-marker-hit-geometry", { contentType: "application/json", body: JSON.stringify(await editor.evaluate(element => ["B2-L055", "B2-L066"].map(name => { const node = element.querySelector<HTMLElement>(`[data-spatial-map-marker][aria-label^='${name}']`)!; const rect = node.getBoundingClientRect(); return { name, rect: rect.toJSON(), centerHit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.getAttribute("aria-label") }; })), null, 2) });
    await editor.getByRole("button", { name: "선택 비우기" }).click();

    const changes = editor.locator('[aria-label="구역 구성 변경"]');
    await expect(changes.getByText(/^제거 예정:/)).toHaveCount(100);
    await expect(changes).toHaveCSS("overflow-y", "auto");
    expect(await changes.evaluate((element) => element.scrollHeight)).toBeGreaterThan(await changes.evaluate((element) => element.clientHeight));
    expect(await editor.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    await changes.scrollIntoViewIfNeeded();
    await expectReachableInside(changes, editor);
    await expectInternalWheelScroll(page, changes);
    await expectReachableInside(changes.getByText("제거 예정: B2-L100", { exact: true }), changes);
    await expect.poll(async () => content.evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(240);
    for (let index = 0; index < 20; index += 1) await editor.getByRole("button", { name: "지도 확대", exact: true }).click();
    const preciseTarget = marker(editor, "B2-L055");
    const hit = await preciseTarget.evaluate(element => { const rect = element.getBoundingClientRect(); return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("[data-spatial-map-marker]")?.getAttribute("aria-label"); });
    expect(hit).toMatch(/^B2-L055 /);
    const a = (await preciseTarget.boundingBox())!, b = (await marker(editor, "B2-L066").boundingBox())!;
    expect(a.width).toBe(48); expect(a.height).toBe(48);
    const overlapX = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
    const overlapY = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    expect(overlapX * overlapY).toBe(0);
    await expectReachableInside(preciseTarget, editor.getByTestId("target-selection-map-viewport"));
    await preciseTarget.click();
    await expect(marker(editor, "B2-L055")).toHaveAttribute("aria-pressed", "true");
  });
}

test("final review: boundary markers keep their whole coarse hit target inside the map", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installControlMapRoutes(page, { boundaryFixtures: true });
  await page.goto(`/control?siteId=${ids.site}`);
  const surface = page.locator("[data-floor-map-surface]");
  await expect(surface).toBeVisible();
  const bounds = (await surface.boundingBox())!;
  for (const name of ["B2-L001", "B2-L002"]) {
    const target = marker(page, name);
    const box = (await target.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(bounds.x);
    expect(box.y).toBeGreaterThanOrEqual(bounds.y);
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
    expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height);
  }
});

test("manual map selection stays synchronized with the list and command payload", async ({ page }) => {
  let commandBody: Record<string, unknown> | null = null;
  await installControlMapRoutes(page, { onDimmingCommand: (body) => { commandBody = body; } });
  await page.goto(`/control?siteId=${ids.site}`);

  await marker(page, "B2-L001").click();
  await expect(marker(page, "B2-L001")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "조명 목록 열기" }).click();
  await expect(page.getByRole("checkbox", { name: "B2-L001 선택" })).toBeChecked();
  await page.getByRole("button", { name: "조명 목록 닫기" }).click();
  await page.getByRole("button", { name: "1개 조명에 밝기 적용" }).click();

  expect(commandBody).toMatchObject({
    target: { type: "fixture", fixtureId: ids.fixture },
    brightness: 70
  });
});

test("schedule group authoring stores the current group fixture snapshot in its request", async ({ page }) => {
  const api = await installControlMapRoutes(page);
  await page.goto(`/control?siteId=${ids.site}&mode=schedule`);
  await page.getByRole("button", { name: "스케줄 추가" }).click();
  const dialog = page.getByRole("dialog", { name: "스케줄 추가" });
  await dialog.getByRole("button", { name: "제어 대상 선택" }).click();
  await page.getByRole("button", { name: "저장된 구역" }).click();
  await page.getByRole("button", { name: "B2 입구" }).click();
  await page.getByRole("button", { name: "2개 조명 선택 완료" }).click();
  await dialog.getByRole("button", { name: "스케줄 만들기" }).click();

  expect(api.scheduleRequests).toHaveLength(1);
  // A group is an authoring shortcut; the persisted automation contract is an immutable fixture snapshot.
  expect(api.scheduleRequests[0]).toMatchObject({
    target: { type: "fixtures", fixtureIds: [ids.fixture, ids.fixtureTwo] }
  });
});

test("event group target authoring sends sorted current target fixture IDs", async ({ page }) => {
  const api = await installControlMapRoutes(page);
  await page.goto(`/control?siteId=${ids.site}&mode=schedule`);
  await page.getByRole("tab", { name: "이벤트 제어" }).click();
  await page.getByRole("button", { name: "이벤트 추가" }).click();
  const dialog = page.getByRole("dialog", { name: "이벤트 추가" });
  await dialog.getByRole("button", { name: "감지 센서 선택" }).click();
  await page.getByRole("button", { name: "조명 목록 열기" }).click();
  await page.getByRole("checkbox", { name: "B2-SENSOR-001 선택" }).locator("xpath=ancestor::label").click();
  await page.getByRole("button", { name: "선택 완료", exact: true }).click();
  await page.getByRole("button", { name: "1개 조명 선택 완료" }).click();
  await dialog.getByRole("button", { name: "실행할 조명 선택" }).click();
  await page.getByRole("button", { name: "저장된 구역" }).click();
  await page.getByRole("button", { name: "B2 입구" }).click();
  await page.getByRole("button", { name: "2개 조명 선택 완료" }).click();
  await dialog.getByRole("button", { name: "저장" }).click();

  expect(api.eventRequests).toHaveLength(1);
  expect(api.eventRequests[0]).toMatchObject({
    sourceFixtureIds: [ids.sensor],
    targetFixtureIds: [ids.fixture, ids.fixtureTwo]
  });
});

test("creating a group renders its configuring Mesh lifecycle", async ({ page }) => {
  await installControlMapRoutes(page);
  await page.goto(`/control?siteId=${ids.site}`);
  await openCompactTools(page);
  await page.getByRole("button", { name: "구역 관리" }).click();
  await page.getByRole("button", { name: "새 구역" }).click();
  const dialog = page.getByRole("dialog", { name: "구역 생성" });
  await dialog.getByLabel("구역 이름").fill("야간 동선");
  const editor = dialog.getByTestId("fixture-group-map-editor");
  await editor.getByRole("button", { name: "층", exact: true }).click();
  await page.getByRole("option", { name: "B2" }).click();
  await editor.getByRole("button", { name: "게이트웨이", exact: true }).click();
  await page.getByRole("option", { name: "Gateway B2" }).click();
  await editor.getByRole("button", { name: "조명 목록 열기" }).click();
  await page.getByRole("checkbox", { name: "B2-L001 선택" }).locator("xpath=ancestor::label").click();
  await page.getByRole("button", { name: "선택 완료" }).click();
  await dialog.getByRole("button", { name: "구역 만들기" }).click();
  await expect(page.getByText("Mesh 설정 중", { exact: true })).toBeVisible();
});

test("a 404 floor map opens the list fallback", async ({ page }) => {
  await installControlMapRoutes(page, { mapStatus: 404 });
  await page.goto(`/control?siteId=${ids.site}`);

  await expect(page.getByRole("region", { name: "제어 대상 지도", exact: true })).toBeVisible();
  await expect(page.getByText("등록된 도면이 없어 목록으로 선택합니다.")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "조명 목록" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "B2-L001 선택" })).toBeVisible();
});

test("viewer control redirect issues no mutating request", async ({ page }) => {
  const api = await installControlMapRoutes(page, { role: "viewer" });
  await page.goto(`/control?siteId=${ids.site}`);

  await expect(page).toHaveURL(new RegExp(`/monitoring\\?siteId=${ids.site}$`));
  expect(api.postRequests).toEqual([]);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }] as const) {
  test(`desktop control at ${viewport.width}x${viewport.height} keeps page fixed with internal map/detail scroll and paged history drawer`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installControlMapRoutes(page, { fixtureCount: 80, groupCount: 40, historyCount: 24 });
    await page.goto(`/control?siteId=${ids.site}`);
    await expect(page.getByRole("region", { name: "제어 대상 지도", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "저장된 구역" }).click();
    console.info("TASK6_GROUP_LAYOUT_INITIAL", JSON.stringify(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-app-shell], [data-shell-content], [data-control-screen], [data-control-layout], [data-control-target-card], [data-spatial-target-selector], [data-target-selection-toolbar], [data-target-selection-content], [data-target-selection-detail-panel], [data-testid='target-selection-map-viewport'], [aria-label='지도 조작'], [aria-label='지도 확대 축소'], [aria-label='지도 조명 상태 범례']")].map(element => ({ label: element.getAttribute("aria-label") || element.getAttribute("data-testid"), data: [...element.attributes].filter(attr => attr.name.startsWith("data-")).map(attr => attr.name), rect: element.getBoundingClientRect().toJSON(), client: [element.clientWidth, element.clientHeight], scroll: [element.scrollWidth, element.scrollHeight], overflow: getComputedStyle(element).overflow, display: getComputedStyle(element).display })))));
    const history = page.getByRole("region", { name: "최근 명령 이력" });
    // Use real zoom controls and populated route data to create overflow in
    // each pane; CSS overflow declarations alone cannot prove scrollability.
    for (let index = 0; index < 20; index += 1) await page.getByRole("button", { name: "지도 확대", exact: true }).click();
    const map = page.getByRole("region", { name: "B2 도면" });
    await expect.poll(async () => Number(await map.getAttribute("data-zoom"))).toBeGreaterThan(2);
    // Control intentionally consumes unmodified wheel as camera zoom, not map overflow scrolling.
    const beforeWheelZoom = Number(await map.getAttribute("data-zoom"));
    await map.hover();
    await page.mouse.wheel(0, 100);
    await expect.poll(async () => Number(await map.getAttribute("data-zoom"))).toBeLessThan(beforeWheelZoom);
    const detail = page.locator("[data-target-selection-detail-panel]");
    await expect(detail).toHaveCSS("overflow-y", "auto");
    await expectInternalWheelScroll(page, detail);
    const finalGroup = detail.getByRole("button", { name: "B2 구역 040", exact: true });
    await expectReachableInside(finalGroup, detail);
    await finalGroup.click();
    await expect(finalGroup).toHaveAttribute("aria-current", "true");
    await history.getByRole("button", { name: "전체 보기", exact: true }).click();
    const historyDrawer = page.getByRole("dialog", { name: "명령 이력", exact: true });
    const historyList = historyDrawer.getByRole("region", { name: "명령 이력 본문" });
    await expect(historyList).toHaveCSS("overflow-y", "auto");
    // The default 50-row operations page contains these 24 fixture records.
    await expectInternalWheelScroll(page, historyList);
    const finalCommand = historyList.getByRole("button", { name: /99999999-9999-4999-8999-000000005023/ });
    await finalCommand.scrollIntoViewIfNeeded();
    await expectReachableInside(finalCommand, historyDrawer);
    await expect(historyDrawer.getByRole("button", { name: "다음" })).toBeDisabled();
    await finalCommand.click();
    await expect(historyDrawer).toHaveCount(0);
    await page.getByRole("button", { name: "상세 보기", exact: true }).click();
    await expect(page.getByRole("button", { name: "명령 상세 닫기" })).toBeVisible();
    console.info("TASK6_INLINE_LAYOUT", JSON.stringify(await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-control-layout], [data-control-screen], [data-control-panel], [data-control-panel-feedback], [data-command-status-region], #recent-command-details")].map(element => ({ attrs: [...element.attributes].filter(attr => attr.name.startsWith("data-") || attr.name === "id").map(attr => attr.name + "=" + attr.value), rect: element.getBoundingClientRect().toJSON(), client: [element.clientWidth, element.clientHeight], scroll: [element.scrollWidth, element.scrollHeight], overflow: getComputedStyle(element).overflow, flex: getComputedStyle(element).flex })))));
    const documentMetrics = await page.evaluate(() => ({ clientHeight: document.documentElement.clientHeight, scrollHeight: document.documentElement.scrollHeight }));
    expect(documentMetrics.scrollHeight).toBe(documentMetrics.clientHeight);
  });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 740 }] as const) {
  test(`mobile control fits ${viewport.width}x${viewport.height} with map marker touch targets and action above compact navigation`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const api = await installControlMapRoutes(page);
    await page.goto(`/control?siteId=${ids.site}`);
    await expect(page.getByRole("region", { name: "제어 대상 지도", exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    for (const name of ["지도 이동", "조명 선택"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    const tools = page.getByRole("region", { name: "제어 대상 지도", exact: true }).getByRole("group", { name: "지도 선택 도구", exact: true });
    for (const name of ["이동", "개별 선택", "영역 선택"]) {
      const tool = tools.getByRole("button", { name, exact: true });
      await expect(tool).toHaveCount(1);
      await expect(tool).toBeVisible();
    }
    await expectMinimumTouchTargetsAfterScrolling(page, "[data-control-screen]");
    await marker(page, "B2-L001").click();
    await expectMinimumTouchTargetsAfterScrolling(page, "[data-control-screen]");
    await openCompactExecution(page);
    await expectEditableFontSizes(page.getByRole("complementary", { name: "밝기 실행" }));
    await openCompactTools(page);
    await page.getByRole("button", { name: "조명 목록 열기" }).click();
    const drawer = page.getByRole("dialog", { name: "조명 목록" });
    await expect(drawer.getByRole("searchbox", { name: "조명 검색" })).toBeVisible();
    await expectMinimumTouchTargetsAfterScrolling(page, "[data-dialog-surface]");
    await expectEditableFontSizes(drawer);
    await expectNoHorizontalOverflow(page);
    await drawer.getByRole("button", { name: "선택 완료", exact: true }).click();
    await expectNoHorizontalOverflow(page);
    await openCompactExecution(page);
    const action = page.getByRole("button", { name: /밝기 적용/ });
    const navigation = page.locator('[data-shell-navigation="compact"]');
    await action.scrollIntoViewIfNeeded();
    const [actionBox, navigationBox] = await Promise.all([action.boundingBox(), navigation.boundingBox()]);
    expect(actionBox).not.toBeNull();
    expect(navigationBox).not.toBeNull();
    if (!actionBox || !navigationBox) return;
    expect(actionBox.y + actionBox.height).toBeLessThanOrEqual(navigationBox.y);
    // The integrated operations control has one metric input and slider.
    // Preserve mobile numeric editing and command safety through that entry.
    const brightness = page.getByRole("textbox", { name: "밝기 수치", exact: true });
    await brightness.fill("42"); await brightness.press("Enter");
    await expect(page.getByRole("slider", { name: "밝기", exact: true })).toHaveValue("42");
    await expect(page.locator("[data-control-presets]")).toHaveCount(0);
    expect(api.postRequests).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`mobile-control-${viewport.width}-execution.png`) });
    if (viewport.width === 320) {
      const history = page.getByRole("region", { name: "최근 명령 이력", exact: true });
      const error = history.getByRole("alert");
      await expect(error).toHaveText("최근 명령을 불러오지 못했습니다.");
      const metrics = await error.evaluate(element => {
        const text = element.firstChild;
        if (!text || text.nodeType !== Node.TEXT_NODE || !text.textContent?.startsWith("최근")) throw new Error("Expected the real public recent-history error text");
        const glyph = (offset: number) => {
          const range = document.createRange();
          range.setStart(text, offset); range.setEnd(text, offset + 1);
          const bounds = range.getBoundingClientRect();
          return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
        };
        const bounds = element.getBoundingClientRect();
        const ticker = element.closest('[aria-label="최근 이력"]');
        const buttons = ticker ? [...ticker.querySelectorAll("button")].map(button => {
          const rect = button.getBoundingClientRect();
          return { label: button.textContent, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }) : [];
        return { viewport: { width: window.innerWidth, height: window.innerHeight }, theme: document.documentElement.getAttribute("data-customer-theme"),
          message: element.textContent, messageWidth: bounds.width, first: glyph(0), second: glyph(1), buttons };
      });
      console.log("TASK11_TICKER_ERROR_READABILITY", JSON.stringify(metrics));
      await testInfo.attach("ticker-error-readability", { body: JSON.stringify(metrics, null, 2), contentType: "application/json" });
      // Preserve the fixture's actual error: a readable first word must not
      // depend on hiding that state, reducing font size or truncating it.
      expect(metrics.second.y).toBe(metrics.first.y);
    }
  });
}

for (const mode of ["fixtures", "floor", "group"] as const) {
  test(`synthetic browser two-pointer pinch for ${mode} targets zooms without an area rectangle or post-lift jump (not native WebView HIL)`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installControlMapRoutes(page);
    await page.goto(`/control?siteId=${ids.site}`);
    await expect(page.getByRole("region", { name: "제어 대상 지도", exact: true })).toBeVisible();
    if (mode !== "fixtures") await openCompactTools(page);
    if (mode !== "fixtures") await page.getByRole("button", { name: mode === "floor" ? "층 전체" : "저장된 구역", exact: true }).click();
    const viewport = page.getByRole("region", { name: "B2 도면" });
    await expect(viewport).toBeVisible();

    for (let index = 0; index < 15; index += 1) await page.getByRole("button", { name: "지도 확대", exact: true }).click();
    const bounds = (await viewport.boundingBox())!;
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const surface = viewport.locator("[data-floor-map-surface]");
    const before = (await surface.boundingBox())!;
    const anchor = { x: (center.x - before.x) / before.width, y: (center.y - before.y) / before.height };
    await dispatchTouchPointer(page, viewport, "pointerdown", { pointerId: 11, pointerType: "touch", button: 0, buttons: 1, clientX: center.x - 40, clientY: center.y });
    await dispatchTouchPointer(page, viewport, "pointerdown", { pointerId: 12, pointerType: "touch", button: 0, buttons: 1, clientX: center.x + 40, clientY: center.y });
    // Asymmetric expansion plus translation moves the midpoint by (+20, +12).
    await dispatchTouchPointer(page, viewport, "pointermove", { pointerId: 11, pointerType: "touch", button: -1, buttons: 1, clientX: center.x - 28, clientY: center.y + 12 });
    await dispatchTouchPointer(page, viewport, "pointermove", { pointerId: 12, pointerType: "touch", button: -1, buttons: 1, clientX: center.x + 68, clientY: center.y + 12 });
    await expect(viewport).toHaveAttribute("data-zoom", "3");
    await expect.poll(async () => {
      const after = (await surface.boundingBox())!;
      return Math.abs(after.x + anchor.x * after.width - (center.x + 20));
    }).toBeLessThan(2);
    await expect.poll(async () => {
      const after = (await surface.boundingBox())!;
      return Math.abs(after.y + anchor.y * after.height - (center.y + 12));
    }).toBeLessThan(2);
    await expect(page.getByTestId("map-area-selection")).toHaveCount(0);

    // Zoom commits before its scheduled frame applies the map-anchor scroll.
    // Observe that rendered pinch result before testing the remaining pointer;
    // otherwise the legitimate anchor adjustment is misread as a post-lift pan.
    const afterPinch = await viewport.evaluate((element) => new Promise<{ left: number; top: number }>((resolve) => {
      requestAnimationFrame(() => resolve({ left: element.scrollLeft, top: element.scrollTop }));
    }));
    await dispatchTouchPointer(page, viewport, "pointerup", { pointerId: 12, pointerType: "touch", button: 0, buttons: 0, clientX: center.x + 68, clientY: center.y + 12 });
    await dispatchTouchPointer(page, viewport, "pointermove", { pointerId: 11, pointerType: "touch", button: -1, buttons: 1, clientX: center.x - 20, clientY: center.y + 12 });
    await expect.poll(() => viewport.evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop }))).toEqual(afterPinch);
  });
}

test("Task6 native mouse direct selection is additive, honors the 8px threshold and cancels with Escape", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installControlMapRoutes(page);
  await page.goto(`/control?siteId=${ids.site}`);
  const viewport = page.getByTestId("target-selection-map-viewport");
  const first = marker(page, "B2-L001");
  const second = marker(page, "B2-L002");
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "false");
  await first.click();
  const bounds = (await viewport.locator("[data-floor-map-surface]").boundingBox())!;
  const blank = { x: bounds.x + bounds.width * .2, y: bounds.y + bounds.height * .7 };
  await viewport.focus();
  await page.mouse.move(blank.x, blank.y);
  await page.mouse.down();
  await page.mouse.move(blank.x + 7, blank.y);
  await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
  await page.mouse.move(blank.x + 8, blank.y);
  await expect(page.getByTestId("map-area-selection")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
  await page.mouse.up();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await expect(second).toHaveAttribute("aria-pressed", "false");
  const pin = (await second.boundingBox())!;
  await page.mouse.move(pin.x - 6, pin.y - 6);
  await page.mouse.down();
  await page.mouse.move(pin.x + pin.width + 6, pin.y + pin.height + 6, { steps: 6 });
  await page.mouse.up();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await expect(second).toHaveAttribute("aria-pressed", "true");
  const input = page.getByRole("textbox", { name: "밝기 수치" });
  await input.focus();
  await page.keyboard.press("Space");
  await expect(input).toBeFocused();
  expect(api.postRequests).toEqual([]);
});

test("Task6 native Space and middle-button drags pan without changing fixture selection", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installControlMapRoutes(page);
  await page.goto(`/control?siteId=${ids.site}`);
  const viewport = page.getByTestId("target-selection-map-viewport");
  await marker(page, "B2-L001").click();
  for (let index = 0; index < 15; index += 1) await page.getByRole("button", { name: "지도 확대", exact: true }).click();
  for (const kind of ["Space", "middle"] as const) {
    await viewport.focus();
    const point = await viewport.evaluate(element => {
      const rect = element.getBoundingClientRect();
      for (const x of [.3, .5, .7]) for (const y of [.3, .5, .7]) {
        const point = { x: rect.x + rect.width * x, y: rect.y + rect.height * y };
        const hit = document.elementFromPoint(point.x, point.y);
        if (hit?.closest("[data-floor-map-surface]") && !hit.closest("button")) return point;
      }
      throw new Error("No reachable blank map point");
    });
    const before = await viewport.evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop }));
    await page.mouse.move(point.x, point.y);
    if (kind === "Space") await page.keyboard.down("Space");
    await page.mouse.down({ button: kind === "middle" ? "middle" : "left" });
    await page.mouse.move(point.x - 40, point.y - 40, { steps: 4 });
    await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
    await page.mouse.up({ button: kind === "middle" ? "middle" : "left" });
    if (kind === "Space") await page.keyboard.up("Space");
    await expect.poll(() => viewport.evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop }))).not.toEqual(before);
  }
  await expect(marker(page, "B2-L001")).toHaveAttribute("aria-pressed", "true");
  await expect(marker(page, "B2-L002")).toHaveAttribute("aria-pressed", "false");
  expect(api.postRequests).toEqual([]);
});

test("Task6 synthetic touch hold cancels on a second pointer without a residual area or ghost click (not native WebView HIL)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await installControlMapRoutes(page);
  await page.goto(`/control?siteId=${ids.site}`);
  const viewport = page.getByTestId("target-selection-map-viewport");
  const surface = (await viewport.locator("[data-floor-map-surface]").boundingBox())!;
  const point = { x: surface.x + surface.width * .25, y: surface.y + surface.height * .7 };
  await dispatchTouchPointer(page, viewport, "pointerdown", { pointerId: 11, pointerType: "touch", button: 0, buttons: 1, clientX: point.x, clientY: point.y });
  await expect(page.getByTestId("map-area-selection")).toBeVisible();
  await dispatchTouchPointer(page, viewport, "pointerdown", { pointerId: 12, pointerType: "touch", button: 0, buttons: 1, clientX: point.x + 30, clientY: point.y });
  await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
  await dispatchTouchPointer(page, viewport, "pointerup", { pointerId: 12, pointerType: "touch", button: 0, buttons: 0, clientX: point.x + 30, clientY: point.y });
  await dispatchTouchPointer(page, viewport, "pointermove", { pointerId: 11, pointerType: "touch", button: -1, buttons: 1, clientX: point.x + 40, clientY: point.y + 20 });
  await dispatchTouchPointer(page, viewport, "pointerup", { pointerId: 11, pointerType: "touch", button: 0, buttons: 0, clientX: point.x + 40, clientY: point.y + 20 });
  await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
  const pin = marker(page, "B2-L001");
  await pin.evaluate(element => (element as HTMLButtonElement).click());
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await pin.click();
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  expect(api.postRequests).toEqual([]);
});

test("Task6 native pointer capture loss and keyboard blur cancel an area without selecting or posting", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installControlMapRoutes(page);
  await page.goto(`/control?siteId=${ids.site}`);
  const viewport = page.getByTestId("target-selection-map-viewport");
  await expect(viewport).toBeVisible();
  await marker(page, "B2-L001").click();
  for (const cancel of ["capture", "keyboard-blur"] as const) {
    await viewport.focus();
    const point = await viewport.evaluate(element => {
      const rect = element.getBoundingClientRect();
      for (const x of [.3, .5, .7]) for (const y of [.3, .5, .7]) {
        const point = { x: rect.x + rect.width * x, y: rect.y + rect.height * y };
        const hit = document.elementFromPoint(point.x, point.y);
        if (hit?.closest("[data-floor-map-surface]") && !hit.closest("button")) return point;
      }
      throw new Error("No reachable blank map point");
    });
    await viewport.evaluate(element => element.addEventListener("pointerdown", event => {
      element.setAttribute("data-test-pointer-id", String((event as PointerEvent).pointerId));
    }, { once: true }));
    await page.mouse.move(point.x, point.y); await page.mouse.down();
    await page.mouse.move(point.x + 12, point.y + 12);
    await expect(page.getByTestId("map-area-selection")).toBeVisible();
    if (cancel === "capture") {
      await viewport.evaluate(element => {
        const id = Number(element.getAttribute("data-test-pointer-id"));
        if (!element.hasPointerCapture(id)) throw new Error("Native pointer was not captured");
        element.releasePointerCapture(id);
      });
      await page.mouse.move(point.x + 13, point.y + 13);
    } else {
      // A Tab onto a marker is still inside the viewport and must NOT cancel.
      // Continue real Tab navigation until focus crosses the viewport boundary.
      for (let index = 0; index < 20 && await viewport.evaluate(element => element.contains(document.activeElement)); index += 1) await page.keyboard.press("Tab");
      expect(await viewport.evaluate(element => element.contains(document.activeElement))).toBe(false);
    }
    await expect(page.getByTestId("map-area-selection")).toHaveCount(0);
    await page.mouse.up();
    await expect(marker(page, "B2-L001")).toHaveAttribute("aria-pressed", "true");
    await expect(marker(page, "B2-L002")).toHaveAttribute("aria-pressed", "false");
  }
  expect(api.postRequests).toEqual([]);
});

async function expectInternalWheelScroll(page: Page, pane: ReturnType<Page["locator"]>) {
  const metrics = await pane.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight, content: element.scrollHeight,
    contentWidth: element.scrollWidth, top: element.scrollTop, left: element.scrollLeft, overflow: getComputedStyle(element).overflowY }));
  expect(metrics.width).toBeGreaterThan(0); expect(metrics.height).toBeGreaterThan(0);
  console.info("TASK6_INTERNAL_SCROLL_GEOMETRY", JSON.stringify({ metrics, pane: await pane.boundingBox(), layout: await page.locator("[data-control-layout]").boundingBox(), screen: await page.locator("[data-control-screen]").boundingBox(), page: await page.evaluate(() => ({ scrollY, innerWidth, innerHeight, documentHeight: document.documentElement.scrollHeight })) }));
  expect(metrics.overflow).toMatch(/auto|scroll/);
  await pane.hover();
  if (metrics.content > metrics.height) {
    await page.mouse.wheel(0, 10000);
    await expect.poll(() => pane.evaluate(element => element.scrollTop)).toBeGreaterThan(metrics.top);
    await expect.poll(() => pane.evaluate(element => element.scrollTop + element.clientHeight)).toBe(metrics.content);
  } else {
    const beforeY = await page.evaluate(() => scrollY);
    await pane.evaluate(element => {
      element.setAttribute("data-wheel-trusted", "0");
      element.addEventListener("wheel", event => { if (event.isTrusted) element.setAttribute("data-wheel-trusted", "1"); }, { once: true });
    });
    const bounds = (await pane.boundingBox())!;
    const point = { x: bounds.x + bounds.width / 2, y: (Math.max(80, bounds.y) + Math.min(page.viewportSize()!.height - 10, bounds.y + bounds.height)) / 2 };
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.outerHTML.slice(0, 300), point);
    await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, 100);
    await expect(pane).toHaveAttribute("data-wheel-trusted", "1");
    console.info("TASK6_DETAIL_WHEEL_EFFECT", JSON.stringify({ beforeY, afterY: await page.evaluate(() => scrollY), point, hit, afterScrollTop: await pane.evaluate(element => element.scrollTop) }));
    // At narrow desktop group layouts, fit-by-width produces horizontal-only
    // map overflow. Exercise that real axis rather than requiring fictitious Y overflow.
    expect(metrics.contentWidth).toBeGreaterThan(metrics.width);
    await page.mouse.wheel(10000, 0);
    await expect.poll(() => pane.evaluate(element => element.scrollLeft)).toBeGreaterThan(metrics.left);
    await expect.poll(() => pane.evaluate(element => element.scrollLeft + element.clientWidth)).toBe(metrics.contentWidth);
  }
}

async function expectReachableInside(target: ReturnType<Page["locator"]>, pane: ReturnType<Page["locator"]>) {
  await expect(target).toBeVisible();
  const outer = await pane.boundingBox();
  const inner = await target.boundingBox();
  expect(outer).not.toBeNull();
  expect(inner).not.toBeNull();
  const visibleTop = Math.max(inner!.y, outer!.y);
  const visibleBottom = Math.min(inner!.y + inner!.height, outer!.y + outer!.height);
  expect(visibleBottom).toBeGreaterThan(visibleTop);
  expect(inner!.y + inner!.height / 2).toBeGreaterThanOrEqual(visibleTop);
  expect(inner!.y + inner!.height / 2).toBeLessThanOrEqual(visibleBottom);
  expect(await target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return Boolean(hit && (hit === element || element.contains(hit)));
  })).toBe(true);
}

async function expectEditableFontSizes(root: ReturnType<Page["locator"]>) {
  const fields = root.getByRole("textbox").or(root.getByRole("searchbox")).or(root.getByRole("spinbutton")).or(root.getByRole("combobox")).filter({ visible: true });
  expect(await fields.count()).toBeGreaterThan(0);
  for (const field of await fields.all()) {
    await field.scrollIntoViewIfNeeded();
    expect(await field.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  }
}

type FixtureOptions = Partial<Pick<SettingsFixture, "vehicleSensorCapabilityStatus" | "vehicleSensorCapabilityVerifiedAt">>;

function fixture(id: string, name: string, x: number, y: number, options: FixtureOptions = {}): SettingsFixture {
  return {
    id, name, x, y, size: 20, ratedWatt: 40, brightness: 70, status: "online",
    health: { faultCodes: [], observedAt: "2026-09-01T00:00:00.000Z" }, rssi: -55, hopCount: 1, commandSuccessRate: 1,
    lastSeenAt: "2026-09-01T00:00:00.000Z", gateway: { id: ids.gateway, name: "Gateway B2", connectionStatus: "online" },
    controllable: true, controlBlockReason: null, ...options
  };
}

function marker(root: Page | ReturnType<Page["getByRole"]>, name: string) {
  return root.locator(`[data-spatial-map-marker="true"][aria-label^="${name}"]`);
}

async function dispatchTouchPointer(
  page: Page,
  target: ReturnType<Page["locator"]>,
  type: string,
  init: Record<string, string | number>
) {
  await target.evaluate((element, { eventType, eventInit }) => {
    // Playwright's plain dispatchEvent initializer creates Event, which drops PointerEvent-only IDs.
    element.dispatchEvent(new PointerEvent(eventType, {
      bubbles: true,
      cancelable: true,
      isPrimary: eventInit.pointerId === 11,
      ...eventInit
    }));
  }, { eventType: type, eventInit: init });
}

async function installControlMapRoutes(page: Page, options: {
  onDimmingCommand?: (body: Record<string, unknown>) => void;
  mapStatus?: number;
  role?: SettingsRole;
  fixtureCount?: number;
  groupCount?: number;
  groupMemberCount?: number;
  historyCount?: number;
  boundaryFixtures?: boolean;
} = {}) {
  const fixtureData = options.fixtureCount
    ? Array.from({ length: options.fixtureCount }, (_, index) => fixture(
      `99999999-9999-4999-8999-${String(1000 + index).padStart(12, "0")}`,
      `B2-L${String(index + 1).padStart(3, "0")}`,
      30 + (index % 10) * 100,
      30 + Math.floor(index / 10) * 80
    ))
    : options.boundaryFixtures ? fixtures.map((item, index) => ({ ...item, x: index === 0 ? 0 : 1200, y: index === 0 ? 0 : 800 })) : fixtures;
  const api = await installSettingsApiRoutes(page, options.role ?? "admin", {
    fixtures: fixtureData,
    ids: { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway }
  });
  const groupFixtureIds = options.groupMemberCount
    ? fixtureData.slice(0, options.groupMemberCount).map((item) => item.id)
    : [ids.fixtureTwo, ids.fixture];
  const groups = [{ id: ids.group, name: "B2 입구", floorId: ids.floor, gatewayId: ids.gateway, lifecycleStatus: "active", fixtureCount: groupFixtureIds.length,
    meshControlGroup: { status: "ready", version: 1, error: null }, fixtureIds: groupFixtureIds }];
  if (options.groupCount) groups.splice(0, groups.length, ...Array.from({ length: options.groupCount }, (_, index) => ({
    ...groups[0], id: `99999999-9999-4999-8999-${String(4000 + index).padStart(12, "0")}`, name: `B2 구역 ${String(index + 1).padStart(3, "0")}`,
    fixtureCount: 1, fixtureIds: [fixtureData[index % fixtureData.length].id]
  })));
  const history = Array.from({ length: options.historyCount ?? 0 }, (_, index) => ({
    id: `99999999-9999-4999-8999-${String(5000 + index).padStart(12, "0")}`, siteId: ids.site, stage: "completed", outcome: "applied",
    brightness: 70, totalFixtureCount: 1, completedFixtureCount: 1, dispatchCount: 1, createdAt: "2026-09-01T00:00:00.000Z", errorMessage: null,
    targetFixtureIds: [fixtureData[0].id], dispatches: []
  }));
  const state = { scheduleRequests: [] as Record<string, unknown>[], eventRequests: [] as Record<string, unknown>[], postRequests: [] as string[] };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === "POST") state.postRequests.push(path);
    if (path === "/api/commands" && options.historyCount) {
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return route.fulfill({ json: { items: history.slice(offset, offset + limit), nextCursor: offset + limit < history.length ? String(offset + limit) : null,
        generatedAt: "2026-09-01T00:00:00Z", retentionEnabled: false, retainedFrom: "2026-06-01T00:00:00Z" } });
    }
    const historicalCommand = history.find((command) => path === `/api/commands/${command.id}`);
    if (historicalCommand) return route.fulfill({ json: { ...historicalCommand, generatedAt: "2026-09-01T00:00:00Z", retainedFrom: "2026-06-01T00:00:00Z", retentionEnabled: false } });
    if (path === `/api/sites/${ids.site}/dashboard`) {
      return route.fulfill({ json: dashboardResponse(fixtureData, groups, options.role ?? "admin") });
    }
    if (path === `/api/sites/${ids.site}/floors/${ids.floor}/map-snapshot` && options.mapStatus) {
      return route.fulfill({ status: options.mapStatus, json: { message: "map unavailable" } });
    }
    if (path === `/api/sites/${ids.site}/fixture-groups`) {
      if (request.method() === "GET") return route.fulfill({ json: groups });
      if (request.method() === "POST") {
        const input = request.postDataJSON() as Record<string, unknown>;
        const created = { ...groups[0], id: ids.createdGroup, name: input.name, fixtureCount: Array.isArray(input.fixtureIds) ? input.fixtureIds.length : 0,
          meshControlGroup: { status: "configuring", version: 1, error: null } };
        groups.push(created);
        return route.fulfill({ status: 201, json: created });
      }
    }
    if (path === `/api/sites/${ids.site}/automation/schedules`) {
      if (request.method() === "GET") return route.fulfill({ json: { items: [], total: 0, nextCursor: null } });
      if (request.method() === "POST") {
        const input = request.postDataJSON() as Record<string, unknown>;
        state.scheduleRequests.push(input);
        return route.fulfill({ status: 201, json: scheduleResponse(input) });
      }
    }
    if (path === `/api/sites/${ids.site}/automation/vehicle-event-rules`) {
      if (request.method() === "GET") return route.fulfill({ json: { items: [], total: 0, nextCursor: null } });
      if (request.method() === "POST") {
        const input = request.postDataJSON() as Record<string, unknown>;
        state.eventRequests.push(input);
        return route.fulfill({ status: 201, json: eventResponse(input) });
      }
    }
    if (path === "/api/commands/dimming" && request.method() === "POST") {
      options.onDimmingCommand?.(request.postDataJSON() as Record<string, unknown>);
    }
    return route.fallback();
  });
  return { ...api, ...state };
}

function scheduleResponse(input: Record<string, unknown>) {
  const fixtureIds = ((input.target as { fixtureIds?: string[] } | undefined)?.fixtureIds ?? []).slice();
  return { id: "99999999-9999-4999-8999-999999999910", ...input, fixtureIds, gatewayId: ids.gateway, targets: fixtureIds.map((fixtureId) => ({ fixtureId })), targetCount: fixtureIds.length,
    desiredRevision: 1, appliedRevision: 0, syncStatus: "PENDING", nextOccurrence: null, lastExecution: null,
    createdById: "admin-user-1", updatedById: "admin-user-1", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };
}

function eventResponse(input: Record<string, unknown>) {
  const sourceFixtureIds = (input.sourceFixtureIds as string[] | undefined) ?? [];
  const targetFixtureIds = (input.targetFixtureIds as string[] | undefined) ?? [];
  return { id: "99999999-9999-4999-8999-999999999911", ...input, gatewayId: ids.gateway,
    sources: sourceFixtureIds.map((fixtureId) => ({ fixtureId })), targets: targetFixtureIds.map((fixtureId) => ({ fixtureId })),
    sourceCount: sourceFixtureIds.length, targetCount: targetFixtureIds.length, desiredRevision: 1, appliedRevision: 0, syncStatus: "PENDING",
    lastDetection: null, lastExecution: null, createdById: "admin-user-1", updatedById: "admin-user-1", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };
}

function dashboardResponse(fixtureData: SettingsFixture[], groups: Array<Record<string, unknown>>, role: SettingsRole) {
  return {
    generatedAt: "2026-09-01T00:00:00.000Z",
    monitoringPolicy: { gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 180 },
    capabilities: role === "admin"
      ? { read: true, control: true, manage: true, commission: true }
      : { read: true, control: false, manage: false, commission: false },
    site: { id: ids.site, name: "고객사 B2 현장", customerName: "고객사", installationStatus: "installed", address: "서울", tariffKwhRate: 160, timeZone: "Asia/Seoul" },
    summary: { totalFixtures: fixtureData.length, onlineFixtures: fixtureData.length, faultFixtures: 0, averageBrightness: 70 },
    floors: [{ id: ids.floor, name: "B2", level: -2, floorPlan: null, meshControlGroups: [{ gatewayId: ids.gateway, status: "ready", version: 1, error: null }], fixtures: fixtureData }],
    groups,
    gateways: [{ id: ids.gateway, name: "Gateway B2", serialNumber: "GW-E2E-001", firmwareVersion: "e2e", lastHeartbeatAt: "2026-09-01T00:00:00.000Z", connectionStatus: "online" }]
  };
}

async function openCompactTools(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) < 760) {
    // Manual tools are always mounted in map chrome; preparation must not
    // change tool/selection state or recreate the removed disclosure behavior.
    const map = page.getByRole("region", { name: "제어 대상 지도", exact: true });
    await expect(map.getByRole("group", { name: "대상 선택 방식", exact: true })).toBeVisible();
    const tools = map.getByRole("group", { name: "지도 선택 도구", exact: true });
    await expect(tools).toBeVisible();
    for (const name of ["이동", "개별 선택", "영역 선택"]) await expect(tools.getByRole("button", { name, exact: true })).toBeVisible();
    for (const name of ["선택 도구 열기", "선택 도구 접기"]) await expect(map.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
}
async function openCompactExecution(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) < 760) {
    // Visibility is not viewport reach: callers keep their real scrolling and
    // hit checks. Readiness must not edit the draft, focus/blur it or Apply.
    const execution = page.getByRole("complementary", { name: "밝기 실행", exact: true });
    await expect(execution.getByRole("textbox", { name: "밝기 수치", exact: true })).toBeVisible();
    await expect(execution.getByRole("slider", { name: "밝기", exact: true })).toBeVisible();
    await expect(execution.locator("[data-control-submit]")).toBeVisible();
    for (const name of ["밝기 실행 설정 열기", "밝기 실행 설정 접기"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
}
