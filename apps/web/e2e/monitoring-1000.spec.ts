import { expect, test } from "@playwright/test";

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
}));

test("loads and renders 1,000 fixtures through cursor pages", async ({ page }) => {
  await page.route("**/auth/me", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        user: { id: "user-1", organizationId: "org-1", email: "operator@example.com", name: "Operator", role: "admin", status: "active" }
      })
    })
  );
  await page.route("**/sites/default/dashboard", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        site: { id: "site-1", name: "Production Scale Site" },
        summary: { totalFixtures: 1000, onlineFixtures: 1000, faultFixtures: 0, averageBrightness: 70 },
        floors: [
          { id: "floor-1", name: "B2", level: -2, floorPlan: { imageUrl: "/demo/floor-b2.svg", width: 1200, height: 800, version: 1 }, fixtures: [] }
        ],
        groups: [],
        gateways: [
          { id: "gateway-1", name: "Gateway B2", serialNumber: "GW-001", firmwareVersion: "1.0.0", lastHeartbeatAt: new Date().toISOString(), connectionStatus: "online" }
        ]
      })
    })
  );
  await page.route("**/floors/floor-1/fixtures?**", async (route) => {
    const url = new URL(route.request().url());
    const cursor = url.searchParams.get("cursor");
    const start = cursor ? fixtures.findIndex((fixture) => fixture.id === cursor) + 1 : 0;
    const items = fixtures.slice(start, start + 200);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items, nextCursor: start + 200 < fixtures.length ? items.at(-1)?.id : null })
    });
  });

  const startedAt = Date.now();
  await page.goto("/");
  await expect(page.locator(".fixture-dot")).toHaveCount(1000, { timeout: 10_000 });
  expect(Date.now() - startedAt).toBeLessThan(10_000);
  await expect(page.getByRole("button", { name: "B2-L1000 정상 70%" })).toBeVisible();
});
