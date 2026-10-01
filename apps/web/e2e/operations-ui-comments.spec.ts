import { expect, test, type Page } from "@playwright/test";
import { installSettingsApiRoutes, type SettingsFixture } from "./support/settings-api";

const alarmInstant = "2026-10-01T15:00:00.000Z";
const alarmId = (index: number) => `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`;
function alarmRow(index: number, isRead: boolean, siteId = "site-1") {
  const id = alarmId(index);
  return { id, siteId, type: "gateway_offline", status: "open", targetKey: `gateway:${id}`,
    fixtureId: null, gatewayId: id, openedAt: alarmInstant, lastObservedAt: alarmInstant,
    acknowledgedAt: null, acknowledgedByUserId: null, assignedToUserId: null, resolvedAt: null,
    resolvedByUserId: null, resolutionKind: null, resolutionNote: null, createdAt: alarmInstant, updatedAt: alarmInstant,
    acknowledgedBy: null, assignedTo: null, resolvedBy: null,
    target: { kind: "gateway", id, name: `테스트 알람 ${String(index).padStart(2, "0")}` }, isRead, readAt: isRead ? alarmInstant : null };
}

async function installAlarmFixture(page: Page) {
  await installSettingsApiRoutes(page, "viewer");
  const state = { reads: new Set<string>(), puts: [] as string[], gets: [] as { limit: number; cursor: string | null }[], failRead: false, failGet: false };
  await page.route("**/api/sites/*/monitoring-incidents**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "PUT") {
      const id = url.pathname.split("/").at(-2)!;
      state.puts.push(id);
      expect(request.postDataJSON()).toEqual({});
      if (state.failRead) return route.fulfill({ status: 503, json: { message: "private upstream reason" } });
      state.reads.add(id);
      return route.fulfill({ json: { incidentId: id, isRead: true, readAt: alarmInstant } });
    }
    expect(request.method()).toBe("GET");
    const limit = Number(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor");
    state.gets.push({ limit, cursor });
    if (state.failGet) return route.fulfill({ status: 503, json: { message: "private upstream reason" } });
    const start = cursor ? 26 : 1;
    const count = Math.min(limit, 28 - start);
    return route.fulfill({ json: {
      incidents: Array.from({ length: count }, (_, offset) => alarmRow(start + offset, state.reads.has(alarmId(start + offset)))),
      unreadCount: 27 - state.reads.size, activeCount: 27,
      nextCursor: start + count <= 27 ? "page_25" : null
    } });
  });
  return state;
}

const alarmTrigger = (page: Page) => page.locator('[data-shell-actions] button[aria-label^="알람센터,"]');

test("monitoring tall desktop allocates remaining height without pushing ticker below the viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await installSettingsApiRoutes(page, "viewer");
  await page.goto("/monitoring?siteId=site-1");
  await expect(page.locator("[data-spatial-map-marker]").first()).toBeVisible();
  const measurements = await page.locator("[data-monitoring-map-shell]").evaluate(node => {
    const chain = [];
    for (let current: Element | null = node; current; current = current.parentElement) {
      const bounds = current.getBoundingClientRect(), style = getComputedStyle(current);
      chain.push({ tag: current.tagName, classes: current.className, top: bounds.top, height: bounds.height,
        bottom: bounds.bottom, display: style.display, heightStyle: style.height, minHeight: style.minHeight,
        flex: style.flex, overflow: style.overflow });
    }
    const ticker = document.querySelector('[aria-label="최근 운영 로그"]')!.getBoundingClientRect();
    return { chain, tickerBottom: ticker.bottom, viewportHeight: window.innerHeight };
  });
  await testInfo.attach("monitoring height chain", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });
  expect(measurements.tickerBottom, JSON.stringify(measurements, null, 2)).toBeLessThanOrEqual(measurements.viewportHeight);
  expect(measurements.chain[0].height).toBeGreaterThan(240);
});

for (const width of [320, 390, 768, 962, 1017, 1023, 1024, 1025, 1440]) {
  test(`monitoring explicit selection and responsive detail at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 320 : width === 768 ? 390 : width === 1024 ? 480 : 900 });
    await installSettingsApiRoutes(page, "viewer");
    await page.goto("/monitoring?siteId=site-1");
    const marker = page.locator("[data-spatial-map-marker]").first();
    await expect(marker).toBeVisible();
    await expect(marker).toHaveAttribute("data-selected", "false");
    await expect(page.locator("[data-monitoring-map-count]")).toHaveCount(0);
    const bounds = await marker.boundingBox();
    expect(bounds!.width).toBeGreaterThanOrEqual(48);
    expect(bounds!.height).toBeGreaterThanOrEqual(48);
    const dot = marker.locator("[data-spatial-map-marker-dot]");
    expect(await dot.evaluate(node => getComputedStyle(node).borderRadius)).toBe("9999px");
    expect((await page.locator("[data-monitoring-map-shell]").boundingBox())!.height).toBeGreaterThanOrEqual(240);
    expect((await page.getByTestId("monitoring-map-viewport").boundingBox())!.height).toBeGreaterThanOrEqual(240);
    await marker.click();
    await page.getByRole("button", { name: "상세 보기", exact: true }).click();
    await expect(page.locator("[data-monitoring-pin-popover]")).toHaveCount(0);
    const detail = width >= 1024 ? page.getByRole("complementary", { name: "조명 상세", exact: true }) : page.getByRole("dialog", { name: "조명 상세", exact: true });
    await expect(detail).toBeVisible();
    if (width >= 1024) await expect(detail).not.toHaveAttribute("aria-modal", "true");
    await expect(detail.getByRole("complementary", { name: "선택 조명 상세" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await detail.getByRole("button", { name: "조명 상세 닫기" }).click();
    await expect(detail).toHaveCount(0);
    await expect(marker).toBeFocused();
  });
}

test("monitoring short height keeps the minimum map and ticker reachable through page scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 320 });
  await installSettingsApiRoutes(page, "viewer");
  await page.goto("/monitoring?siteId=site-1");
  const map = page.locator("[data-monitoring-map-shell]");
  const ticker = page.getByRole("region", { name: "최근 운영 로그" });
  await expect(map).toBeVisible();
  const mapBounds = await map.boundingBox();
  const tickerBounds = await ticker.boundingBox();
  expect(mapBounds!.height).toBeGreaterThanOrEqual(240);
  expect(tickerBounds!.y).toBeGreaterThanOrEqual(mapBounds!.y + mapBounds!.height);
  await ticker.scrollIntoViewIfNeeded();
  const afterScroll = await ticker.boundingBox();
  const navigation = await page.locator('[data-shell-navigation="compact"]').boundingBox();
  expect(afterScroll!.y + afterScroll!.height).toBeLessThanOrEqual(navigation!.y);
  expect(await ticker.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
});

test("monitoring open detail crosses 1023/1024 without losing selection camera scroll or valid focus", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 480 });
  const fixtures: SettingsFixture[] = [1, 2].map(index => ({ id: alarmId(index), name: `경계 조명 ${index}`, x: index * 350, y: 250,
    ratedWatt: 40, brightness: 70, status: "online", statusReason: "reported", health: null, rssi: null, hopCount: null,
    commandSuccessRate: null, lastSeenAt: "2026-09-25T04:00:00.000Z", gateway: null, controllable: false, controlBlockReason: "fixture_unmapped" }));
  await installSettingsApiRoutes(page, "viewer", { fixtures });
  await page.goto("/monitoring?siteId=site-1");
  const viewport = page.getByTestId("monitoring-map-viewport");
  const marker = page.locator("[data-spatial-map-marker]").first();
  await marker.click();
  await page.getByRole("button", { name: "상세 보기", exact: true }).click();
  await page.getByRole("button", { name: "지도 확대", exact: true }).click();
  const camera = () => viewport.evaluate(node => {
    const surface = node.querySelector("[data-floor-map-surface]")!.getBoundingClientRect();
    const bounds = node.getBoundingClientRect();
    return { zoom: node.getAttribute("data-zoom"), x: (bounds.x + bounds.width / 2 - surface.x) / surface.width,
      y: (bounds.y + bounds.height / 2 - surface.y) / surface.height };
  });
  const originalCamera = await camera();
  const scrollBody = page.locator("[data-monitoring-detail-scroll]");
  await scrollBody.evaluate(node => { node.scrollTop = 80; });
  const originalScroll = await scrollBody.evaluate(node => node.scrollTop);
  expect(originalScroll).toBeGreaterThan(0);
  for (const width of [1023, 1024, 1023, 1025]) {
    await page.setViewportSize({ width, height: 480 });
    const surface = width >= 1024 ? page.getByRole("complementary", { name: "조명 상세", exact: true }) : page.getByRole("dialog", { name: "조명 상세", exact: true });
    await expect(surface).toBeVisible();
    await expect(marker).toHaveAttribute("data-selected", "true");
    await expect(page.locator("[data-monitoring-pin-popover]")).toHaveCount(0);
    await expect.poll(async () => (await camera()).zoom).toBe(originalCamera.zoom);
    await expect.poll(async () => Math.abs((await camera()).x - originalCamera.x)).toBeLessThan(.02);
    await expect.poll(async () => Math.abs((await camera()).y - originalCamera.y)).toBeLessThan(.02);
    const body = surface.locator("[data-monitoring-detail-scroll]");
    // The taller sheet may expose all content: its physical scroll clamps to
    // zero, but returning to the smaller aside must restore the saved offset.
    const expectedScroll = await body.evaluate((node, saved) => Math.min(saved, node.scrollHeight - node.clientHeight), originalScroll);
    const scrollMetrics = await body.evaluate(node => ({ top: node.scrollTop, client: node.clientHeight, height: node.scrollHeight }));
    await expect.poll(() => body.evaluate(node => node.scrollTop), { message: `width ${width}, scroll ${JSON.stringify(scrollMetrics)}` }).toBe(expectedScroll);
    await expect.poll(() => surface.evaluate(node => node.contains(document.activeElement))).toBe(true);
  }
  await page.getByRole("button", { name: "조명 상세 닫기", exact: true }).click();
  await expect(marker).toBeFocused();
  const otherMarker = page.locator("[data-spatial-map-marker]").nth(1);
  const finderTrigger = page.getByRole("button", { name: "조명 검색·상세", exact: true });
  await finderTrigger.click();
  const finder = page.getByRole("dialog", { name: "조명 검색·상세", exact: true });
  await finder.getByRole("button", { name: "상세 조명 선택", exact: true }).click();
  await page.getByRole("option", { name: new RegExp(`^${await otherMarker.getAttribute("title")} ·`) }).click();
  await finder.getByRole("button", { name: "상세 보기", exact: true }).click();
  await expect(otherMarker).toHaveAttribute("data-selected", "true");
  await expect(page.locator("[data-monitoring-detail-scroll]")).toContainText((await otherMarker.getAttribute("title"))!);
  await expect.poll(() => page.locator("[data-monitoring-detail-scroll]").evaluate(node => node.scrollTop)).toBe(0);
  await page.setViewportSize({ width: 1023, height: 480 });
  await expect(page.getByRole("dialog", { name: "조명 상세", exact: true })).toBeVisible();
  await expect.poll(() => page.locator("[data-monitoring-detail-scroll]").evaluate(node => node.scrollTop)).toBe(0);
  await page.getByRole("button", { name: "조명 상세 닫기", exact: true }).click();
  await expect(finderTrigger).toBeFocused();
});

for (const width of [320, 390, 768, 962, 1017, 1023, 1024, 1025, 1440]) {
  test(`monitoring full log 1000 rows has bounded body and reachable footer at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 320 : 600 });
    await installSettingsApiRoutes(page, "viewer");
    const reads: { limit: number; cursor: string | null; from: string | null; to: string | null }[] = [];
    let finishPeriod!: () => void;
    const periodResponse = new Promise<void>(resolve => { finishPeriod = resolve; });
    await page.route("**/api/sites/*/floors/*/monitoring-activity?*", async route => {
      const url = new URL(route.request().url());
      const read = { limit: Number(url.searchParams.get("limit")), cursor: url.searchParams.get("cursor"), from: url.searchParams.get("fromDate"), to: url.searchParams.get("toDate") };
      reads.push(read);
      if (read.from) await periodResponse;
      const count = read.from ? 1 : read.limit;
      return route.fulfill({ json: { generatedAt: "2026-10-02T00:00:00.000Z", retainedFrom: "2026-07-02T00:00:00.000Z",
        items: Array.from({ length: count }, (_, index) => ({ id: alarmId(index + 1), kind: "fixture_online", recordedAt: "2026-09-25T04:00:00.000Z", displayName: read.from ? "기간 조건 조명" : `실제 운영 기록 ${index + 1}` })), nextCursor: read.from ? null : "next_page" } });
    });
    await page.goto("/monitoring?siteId=site-1");
    await expect.poll(() => reads.some(read => read.limit === 5)).toBe(true);
    await page.getByRole("button", { name: "전체 보기", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "전체 로그", exact: true });
    const body = dialog.getByRole("region", { name: "운영 로그 본문", exact: true });
    await expect(body.locator("li")).toHaveCount(50);
    await dialog.getByRole("button", { name: "다음 페이지", exact: true }).click();
    await expect.poll(() => reads.at(-1)?.cursor).toBe("next_page");
    await dialog.getByRole("button", { name: "페이지당 항목 수", exact: true }).click();
    await page.getByRole("option", { name: "1000개", exact: true }).click();
    await expect(body.locator("li")).toHaveCount(1000);
    expect(reads.at(-1)).toEqual({ limit: 1000, cursor: null, from: null, to: null });
    await expect(dialog.getByRole("button", { name: "이전 페이지", exact: true })).toBeDisabled();
    const footer = dialog.locator("footer");
    const footerBefore = await footer.boundingBox();
    const closeBefore = await dialog.getByRole("button", { name: "전체 로그 닫기", exact: true }).boundingBox();
    expect(footerBefore!.y + footerBefore!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    expect(closeBefore!.y).toBeGreaterThanOrEqual(0);
    await body.evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(body.locator("li").last()).toBeInViewport();
    expect(await footer.boundingBox()).toEqual(footerBefore);
    expect(await dialog.getByRole("button", { name: "전체 로그 닫기", exact: true }).boundingBox()).toEqual(closeBefore);
    if (width === 320) {
      const segments = dialog.getByRole("group", { name: "조회 기간", exact: true }).getByRole("spinbutton");
      for (const offset of [0, 3]) {
        await segments.nth(offset + 2).fill("25");
        await segments.nth(offset + 1).fill("9");
        await segments.nth(offset).fill("2026");
      }
      await expect.poll(() => reads.at(-1)).toEqual({ limit: 1000, cursor: null, from: "2026-09-25", to: "2026-09-25" });
      await expect(body.locator("li")).toHaveCount(0);
      await expect(dialog.getByText("운영 활동을 불러오는 중", { exact: true })).toBeVisible();
      await expect(dialog.getByText("현재 0개", { exact: true })).toHaveCount(0);
      finishPeriod();
      await expect(body.locator("li")).toHaveCount(1);
      await expect(body).toContainText("기간 조건 조명");
      await dialog.getByRole("button", { name: "전체 보관 기간", exact: true }).click();
      await expect(body.locator("li")).toHaveCount(1000);
      expect(reads.at(-1)).toEqual({ limit: 1000, cursor: null, from: null, to: null });
    }
    await dialog.getByRole("button", { name: "전체 로그 닫기", exact: true }).click();
  });
}

test("operations alarm center keyboard opening reads only visible rows and scrolling preserves next-page unread state", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const state = await installAlarmFixture(page);
  await page.goto("/monitoring?siteId=site-1");
  const trigger = alarmTrigger(page);
  await expect(trigger).toHaveAttribute("aria-label", "알람센터, 미읽음 27건");
  expect(state.gets.length).toBeGreaterThan(0);
  expect(state.gets.every(get => get.limit === 1 && get.cursor === null)).toBe(true);
  expect(state.puts).toHaveLength(0);
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "알람센터", exact: true });
  await expect(dialog).toBeVisible();
  await expect.poll(() => state.reads.has(alarmId(1))).toBe(true);
  expect(state.reads.has(alarmId(25))).toBe(false);
  expect(state.reads.has(alarmId(26))).toBe(false);
  expect(state.puts).toHaveLength(new Set(state.puts).size);

  await dialog.locator(`[data-alarm-id="${alarmId(25)}"]`).scrollIntoViewIfNeeded();
  await expect.poll(() => state.reads.has(alarmId(25))).toBe(true);
  expect(state.reads.has(alarmId(26))).toBe(false);
  await dialog.getByRole("button", { name: "알람 더 보기" }).click();
  await expect(dialog.locator(`[data-alarm-id="${alarmId(26)}"]`)).toBeAttached();
  expect(state.gets.some(get => get.limit === 25 && get.cursor === "page_25")).toBe(true);
  await dialog.locator(`[data-alarm-id="${alarmId(27)}"]`).scrollIntoViewIfNeeded();
  await expect.poll(() => state.reads.has(alarmId(27))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  const countAfterClose = state.puts.length;
  await page.getByRole("link", { name: "통계", exact: true }).click();
  await expect(page.getByTestId("shell-current-menu")).toHaveText("통계");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  expect(state.puts).toHaveLength(countAfterClose);
  await trigger.click();
  await expect(page.getByRole("dialog", { name: "알람센터", exact: true })).toContainText("현재 화면 상태");
  expect(state.puts).toHaveLength(new Set(state.puts).size);
});

test("operations alarm center failed reads preserve badge and successful retry uses canonical GET with stale refresh feedback", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const state = await installAlarmFixture(page);
  state.failRead = true;
  await page.goto("/monitoring?siteId=site-1");
  const trigger = alarmTrigger(page);
  await expect(trigger).toHaveAttribute("aria-label", "알람센터, 미읽음 27건");
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "알람센터", exact: true });
  const row = dialog.locator(`[data-alarm-id="${alarmId(1)}"]`);
  await expect(row.getByText("읽음 저장 실패", { exact: true })).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-label", "알람센터, 미읽음 27건");
  expect(state.reads.size).toBe(0);
  expect(state.puts).toHaveLength(new Set(state.puts).size);
  state.failRead = false;
  await row.getByRole("button", { name: "읽음 저장 다시 시도" }).click();
  await expect(trigger).toHaveAttribute("aria-label", "알람센터, 미읽음 26건");
  await expect(row.getByText("읽음", { exact: true })).toBeVisible();
  await expect(row.getByText("미해결", { exact: true })).toBeVisible();
  expect(state.puts.filter(id => id === alarmId(1))).toHaveLength(2);
  state.failGet = true;
  await dialog.getByRole("button", { name: "알람센터 닫기" }).click();
  await expect(trigger).toHaveAttribute("aria-label", "알람센터, 미읽음 26건, 갱신 실패");
  await trigger.click();
  await expect(page.getByText("알람 갱신 실패 · 마지막으로 확인한 값을 표시합니다.", { exact: true })).toBeVisible();
  await expect(page.getByText("private upstream reason", { exact: true })).toHaveCount(0);
});
