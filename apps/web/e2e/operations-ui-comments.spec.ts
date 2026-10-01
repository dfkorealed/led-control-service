import { expect, test, type Page } from "@playwright/test";
import { installSettingsApiRoutes } from "./support/settings-api";

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
