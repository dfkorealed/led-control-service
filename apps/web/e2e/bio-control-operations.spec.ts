import { expect, test, type Page } from "@playwright/test";
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const site = id(1);
const footer = (page: Page) => page.locator("[data-command-history-panel]");
test.beforeEach(async ({ page, baseURL }) => {
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.origin === baseURL || ["data:", "blob:"].includes(url.protocol) ? route.continue() : route.abort();
  });
  expect((await page.request.post("/api/__fixture/reset")).ok()).toBe(true);
});
async function openManual(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport); await page.goto(`/control?siteId=${site}`);
  await expect(page.locator("[data-spatial-map-marker]")).toHaveCount(4);
}
async function chooseZone(page: Page) {
  const scope = page.getByRole("button", { name: /선택 범위/ });
  if (await scope.count()) { await scope.click(); await page.getByRole("option", { name: "저장된 구역", exact: true }).click(); }
  else await page.getByRole("group", { name: "대상 선택 방식" }).getByRole("button", { name: "저장된 구역", exact: true }).click();
  const choices = page.getByRole("group", { name: "저장된 구역 목록" });
  if (!(await choices.isVisible())) await page.locator("[data-manual-selection-panel]").getByRole("button", { name: "전체 보기", exact: true }).click();
  await choices.getByRole("button", { name: "입구 구역" }).click();
  await expect(page.locator('[data-spatial-map-marker][data-selected="true"]')).toHaveCount(2);
}
async function noOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, innerWidth, height: document.documentElement.scrollHeight, innerHeight }));
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.innerWidth); expect(dimensions.height).toBeLessThanOrEqual(dimensions.innerHeight);
}
async function rememberMap(page: Page) {
  await expect(page.getByTestId("target-selection-map-viewport")).toBeVisible();
  await expect(page.getByTestId("target-selection-map-viewport").locator("canvas").first()).toBeVisible();
  await page.evaluate(() => { const state = window as unknown as { bioMap: Element | null; bioCanvas: Element | null }; state.bioMap = document.querySelector('[data-testid="target-selection-map-viewport"]'); state.bioCanvas = state.bioMap?.querySelector('canvas') ?? null; });
}
async function sameMap(page: Page) {
  expect(await page.evaluate(() => { const state = window as unknown as { bioMap: Element | null; bioCanvas: Element | null }; const map = document.querySelector('[data-testid="target-selection-map-viewport"]'); return map === state.bioMap && map?.querySelector('canvas') === state.bioCanvas; })).toBe(true);
}
async function startTemporary(page: Page, expectedState = "지정 밝기 유지 중") {
  await page.getByRole("button", { name: "더보기", exact: true }).click();
  await page.getByRole("button", { name: "시간제 제어", exact: true }).click();
  await page.getByRole("button", { name: "120분", exact: true }).click();
  await page.getByRole("button", { name: "보조 패널 닫기" }).click();
  await page.locator("[data-control-submit]").click();
  const preview = page.getByRole("dialog", { name: "시간제 적용 미리보기" });
  await expect(preview).toContainText("120분 유지"); await preview.getByRole("button", { name: "시간제 적용", exact: true }).click();
  await expect(page.getByRole("status", { name: "제어 중요 상태" })).toContainText(expectedState);
}

test("desktop_calendar_and_shared_add", async ({ page }) => {
  await openManual(page, { width: 1349, height: 1226 }); await chooseZone(page);
  expect(await footer(page).count()).toBe(1); await expect(footer(page).getByRole("button", { name: "전체 보기" })).toHaveCount(1);
  await page.getByRole("tab", { name: "스케줄 제어", exact: true }).click();
  await page.getByRole("button", { name: "달력", exact: true }).click(); await page.getByRole("button", { name: "이전 달" }).click();
  const strips = page.locator("[data-calendar-schedule]"); await expect(strips).toHaveCount(2);
  await expect(page.getByRole("button", { name: "스케줄 추가", exact: true })).toHaveCount(1);
  expect((await strips.first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const scheduleAdd = (await page.getByRole("button", { name: "스케줄 추가", exact: true }).boundingBox())!;
  await page.getByRole("tab", { name: "이벤트 제어", exact: true }).click();
  const eventAdd = (await page.getByRole("button", { name: "이벤트 추가", exact: true }).boundingBox())!;
  expect(Math.abs(scheduleAdd.x + scheduleAdd.width - eventAdd.x - eventAdd.width)).toBeLessThanOrEqual(1);
  await expect(page.getByRole("button", { name: "필터 초기화" })).toBeVisible(); await noOverflow(page);
});
test("mobile_320_more_preserves_map", async ({ page }) => {
  await openManual(page, { width: 320, height: 600 }); await chooseZone(page); await rememberMap(page);
  if (await page.getByRole("button", { name: "보조 패널 닫기" }).isVisible()) await page.getByRole("button", { name: "보조 패널 닫기" }).click();
  await startTemporary(page); await sameMap(page);
  expect((await page.request.post("/api/__fixture/phase", { data: { phase: "restored" } })).ok()).toBe(true);
  await expect(page.getByRole("status", { name: "제어 중요 상태" })).toContainText("자동 운전 복귀 확인");
  await sameMap(page); await noOverflow(page);
  const requests = await (await page.request.get("/api/__fixture/state")).json(); expect(requests.posts).toHaveLength(1); expect(requests.ends).toHaveLength(0);
});
test("mobile_390_partial_and_unknown", async ({ page }) => {
  await openManual(page, { width: 390, height: 844 }); await chooseZone(page); await rememberMap(page);
  if (await page.getByRole("button", { name: "보조 패널 닫기" }).isVisible()) await page.getByRole("button", { name: "보조 패널 닫기" }).click();
  await page.request.post("/api/__fixture/phase", { data: { phase: "partial" } }); await startTemporary(page, "일부 적용");
  await expect(page.getByRole("status", { name: "제어 중요 상태" })).toContainText("일부 적용");
  await expect(page.locator("[data-control-submit]")).toBeDisabled(); await sameMap(page);
  await page.request.post("/api/__fixture/phase", { data: { phase: "unknown" } });
  await expect(page.getByRole("status", { name: "제어 중요 상태" })).toContainText("적용 여부 확인 필요");
  await expect(page.locator("[data-control-submit]")).toBeDisabled(); await sameMap(page); await noOverflow(page);
  const requests = await (await page.request.get("/api/__fixture/state")).json(); expect(requests.posts).toHaveLength(1);
});
test("schedule_switch_save_cancel_focus", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 600 }); await page.goto(`/control?siteId=${site}&mode=schedule`);
  await page.getByRole("button", { name: "BIO 야간 작업" }).click(); await page.getByRole("menuitem", { name: "수정", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "스케줄 수정" }); const weekend = dialog.getByRole("switch", { name: "주말 제외" }); const holiday = dialog.getByRole("switch", { name: "휴일 제외" });
  await weekend.focus(); await weekend.press("Space"); await holiday.focus(); await holiday.press("Space");
  const visibleHoliday = holiday.locator("xpath=ancestor::*[@data-field][1]");
  await expect(holiday).toBeFocused();
  const bounds = (await visibleHoliday.boundingBox())!, dialogBounds = (await dialog.boundingBox())!;
  await test.info().attach("switch-scroll-boundary", { contentType: "application/json", body: JSON.stringify(await dialog.evaluate(element => {
    const box = element.getBoundingClientRect(); const backdrop = element.closest<HTMLElement>("[data-testid=modal-backdrop]");
    return { dialog: { top: box.top, bottom: box.bottom, height: box.height, scrollTop: element.scrollTop, scrollHeight: element.scrollHeight }, backdropScrollTop: backdrop?.scrollTop, backdropOverflow: backdrop ? getComputedStyle(backdrop).overflow : null };
  })) });
  expect(bounds.y).toBeGreaterThanOrEqual(dialogBounds.y); expect(bounds.y + bounds.height).toBeLessThanOrEqual(dialogBounds.y + dialogBounds.height);
  await dialog.getByRole("button", { name: "변경 저장" }).click(); await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "BIO 야간 작업" }).click(); await page.getByRole("menuitem", { name: "수정", exact: true }).click();
  await expect(weekend).toBeChecked(); await expect(holiday).toBeChecked(); await weekend.focus(); await weekend.press("Space"); await weekend.press("Escape");
  await expect(dialog).toBeHidden(); await expect(page.getByRole("button", { name: "BIO 야간 작업" })).toBeFocused();
  await page.getByRole("button", { name: "BIO 야간 작업" }).click(); await page.getByRole("menuitem", { name: "수정", exact: true }).click(); await expect(weekend).toBeChecked();
});
