import { expect, test } from "@playwright/test";
import { installSettingsApiRoutes, type SettingsFixture } from "./support/settings-api";

const fixtures = Array.from({ length: 1000 }, (_, index) => ({
  id: `fixture-${String(index + 1).padStart(4, "0")}`,
  name: `B2-L${String(index + 1).padStart(4, "0")}`,
  x: 20 + (index % 40) * 29,
  y: 20 + Math.floor(index / 40) * 30,
  size: 20,
  ratedWatt: 40,
  brightness: 70,
  status: "online",
  statusReason: "reported",
  rssi: -60,
  hopCount: 2,
  commandSuccessRate: 0.99,
  lastSeenAt: "2026-07-12T00:00:00.000Z",
  gateway: { id: "gateway-1", name: "Gateway B2", connectionStatus: "online" },
  controllable: true,
  controlBlockReason: null
} satisfies SettingsFixture));

test("loads and renders 1,000 fixtures through cursor pages", async ({ page }) => {
  test.setTimeout(45_000);
  const api = await installSettingsApiRoutes(page, "admin", { fixtures });

  const startedAt = Date.now();
  await page.goto("/");
  await expect(page.locator(".fixture-dot")).toHaveCount(1000, { timeout: 10_000 });
  expect(Date.now() - startedAt).toBeLessThan(10_000);
  await expect(page.getByRole("button", { name: "B2-L1000 정상 70%" })).toBeVisible();

  await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
  await expect(page.getByRole("heading", { name: "B2 도면 편집" })).toBeVisible({ timeout: 30_000 });
  const canvas = page.getByLabel("B2 편집 캔버스");
  const fixturePixel = await canvas.locator("canvas").first().evaluate((element) => {
    const context = element.getContext("2d");
    return context ? Array.from(context.getImageData(20, 20, 1, 1).data) : [];
  });
  expect(fixturePixel).toEqual([32, 201, 151, 255]);
  await canvas.click({ position: { x: 20, y: 20 }, force: true });
  const properties = page.getByRole("complementary", { name: "속성 패널" });
  await expect(properties.getByRole("heading", { name: "B2-L0001" })).toBeVisible();
  await properties.getByLabel("X").fill("50");
  await page.getByRole("button", { name: "저장", exact: true }).click();

  await expect(page).toHaveURL(/\/settings\/floor-plans\?siteId=site-1$/);
  expect(api.fixtureUpdates).toHaveLength(1);
  expect(api.fixtureUpdates[0]).toMatchObject({ id: "fixture-0001", x: 50 });
});
