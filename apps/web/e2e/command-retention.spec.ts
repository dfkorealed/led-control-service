import { expect, test } from "@playwright/test";
import { installSettingsApiRoutes } from "./support/settings-api";

const siteId = "22222222-2222-4222-8222-222222222222";
const commandId = "11111111-1111-4111-8111-111111111111";
const fixtureId = "33333333-3333-4333-8333-333333333331";
async function installFixture(page: Parameters<typeof installSettingsApiRoutes>[0]) {
  page.on("pageerror", (error) => { throw error; });
  await installSettingsApiRoutes(page, "admin", {
    ids: { siteId, floorId: "44444444-4444-4444-8444-444444444444", gatewayId: "77777777-7777-4777-8777-777777777771" },
    fixtures: [{ id: fixtureId, name: "B2-L001", x: 120, y: 140, ratedWatt: 40, brightness: 70, status: "online", health: null, rssi: -58, hopCount: 1, commandSuccessRate: 1, lastSeenAt: null, gateway: { id: "77777777-7777-4777-8777-777777777771", name: "Gateway", connectionStatus: "online" }, controllable: true, controlBlockReason: null }]
  });
}

// Route fixtures exercise browser cache/clock behavior, not actual hardware.
for (const error of [404, 410]) {
  test(`opened terminal detail hides stale content on ${error} without any POST`, async ({ page }) => {
    await installFixture(page);
    const command = { generatedAt: "2026-09-27T00:00:00.000Z", retainedFrom: "2026-06-27T00:00:00.000Z", retentionEnabled: false, id: commandId, siteId, stage: "verified_not_applied", outcome: "not_applied", createdAt: new Date().toISOString(), targetFixtureIds: [fixtureId], brightness: 37, totalFixtureCount: 1, completedFixtureCount: 1, dispatchCount: 1, dispatches: [], errorMessage: null };
    let fail = false;
    let posts = 0;
    await page.route("**/api/commands**", async (route) => {
      if (route.request().method() === "POST") { posts += 1; return route.fulfill({ status: 500, json: {} }); }
      const url = new URL(route.request().url());
      if (url.pathname === "/api/commands") return route.fulfill({ json: { items: [command], nextCursor: null, generatedAt: command.generatedAt, retainedFrom: command.retainedFrom, retentionEnabled: false } });
      if (url.pathname.includes("requiring-verification")) return route.fulfill({ json: { items: [], nextCursor: null, generatedAt: new Date().toISOString() } });
      if (url.pathname !== `/api/commands/${commandId}`) return route.fallback();
      return route.fulfill(fail ? { status: error, json: { code: error === 410 ? "command_expired" : "not_found" } } : { json: command });
    });
    await page.goto(`/control?siteId=${siteId}`);
    await page.getByRole("button", { name: new RegExp(`최근 명령 상세: ${commandId}`) }).click();
    await expect(page.getByRole("button", { name: "안전하게 다시 적용" })).toBeEnabled();
    fail = true;
    await page.evaluate((status) => {
      if (status === 404) { window.dispatchEvent(new Event("focus")); return; }
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
    }, error);
    await expect(page.getByRole("button", { name: "안전하게 다시 적용" })).toHaveCount(0);
    if (error === 410) await expect(page.getByText(/상세 보관 종료/)).toBeVisible();
    else { await expect(page.getByText(/명령 원본을 찾을 수 없습니다/)).toBeVisible(); await expect(page.getByText(/상세 보관 종료/)).toHaveCount(0); }
    expect(posts).toBe(0);
  });
}

for (const skew of [-60_000, 60_000]) for (const [createdAt, boundary] of [
  ["2026-05-31T12:00:00Z", "2026-08-31T12:00:00Z"],
  ["2026-02-28T23:00:00Z", "2026-05-28T23:00:00Z"],
  ["2024-02-29T23:30:00Z", "2024-05-29T23:30:00Z"]
]) {
test(`an open terminal result from ${createdAt} disappears at its first calendar cutoff with browser skew ${skew}`, async ({ page }) => {
  await page.clock.install({ time: new Date(Date.parse(boundary) - 60_000 + skew) });
  await installFixture(page);
  const command = { id: commandId, siteId, stage: "verified_not_applied", outcome: "not_applied", createdAt, targetFixtureIds: [fixtureId], brightness: 37, totalFixtureCount: 1, completedFixtureCount: 1, dispatchCount: 1, dispatches: [], errorMessage: null };
  let posts = 0;
  await page.route("**/api/commands**", async (route) => {
    if (route.request().method() === "POST") { posts += 1; return route.fulfill({ status: 500, json: {} }); }
    const path = new URL(route.request().url()).pathname;
    if (path !== "/api/commands" && path !== `/api/commands/${commandId}`) return route.fallback();
    const serverNow = await page.evaluate(() => Date.now()) - skew;
    const cutoff = new Date(serverNow);
    const day = cutoff.getUTCDate();
    cutoff.setUTCDate(1); cutoff.setUTCMonth(cutoff.getUTCMonth() - 3);
    cutoff.setUTCDate(Math.min(day, new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate()));
    const anchor = { generatedAt: new Date(serverNow).toISOString(), retainedFrom: cutoff.toISOString(), retentionEnabled: true };
    return route.fulfill({ json: path === "/api/commands" ? { ...anchor, items: [command], nextCursor: null } : { ...command, ...anchor } });
  });
  await page.goto(`/control?siteId=${siteId}`);
  await page.getByRole("button", { name: new RegExp(`최근 명령 상세: ${commandId}`) }).click();
  await expect(page.getByRole("button", { name: "안전하게 다시 적용" })).toBeEnabled();
  await page.clock.runFor(60_001);
  await expect(page.getByRole("button", { name: "안전하게 다시 적용" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: new RegExp(`최근 명령 상세: ${commandId}`) })).toHaveCount(0);
  expect(posts).toBe(0);
});
}
