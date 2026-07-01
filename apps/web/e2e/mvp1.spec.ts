import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/sites/default/dashboard", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        site: { id: "site-1", name: "Demo Underground Parking" },
        summary: {
          totalFixtures: 12,
          onlineFixtures: 11,
          faultFixtures: 1,
          averageBrightness: 62
        },
        floors: [
          {
            id: "floor-1",
            name: "B2",
            level: -2,
            floorPlan: { imageUrl: "/demo/floor-b2.svg", width: 1200, height: 800, version: 1 },
            fixtures: [
              {
                id: "fixture-1",
                name: "B2-L01",
                x: 120,
                y: 140,
                ratedWatt: 40,
                brightness: 70,
                status: "online",
                lastSeenAt: "2026-07-01T00:00:00.000Z"
              }
            ]
          }
        ],
        groups: [{ id: "group-1", name: "B2 Entrance Zone", fixtureIds: ["fixture-1"] }]
      })
    });
  });

  await page.route("**/energy/default/estimate", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        day: { kwh: 3.36, cost: 537.6 },
        month: { kwh: 100.8, cost: 16128 },
        year: { kwh: 1226.4, cost: 196224 }
      })
    });
  });
});

test("operator can view monitoring dashboard and navigate primary sections", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "모니터링" })).toBeVisible();
  await expect(page.getByText("전체 조명")).toBeVisible();
  await expect(page.getByText("B2-L01")).toBeVisible();

  await page.getByRole("button", { name: "제어" }).click();
  await expect(page.getByRole("heading", { name: "제어", exact: true })).toBeVisible();
  await expect(page.getByText("개별 조명 제어")).toBeVisible();

  await page.getByRole("button", { name: "통계" }).click();
  await expect(page.getByRole("heading", { name: "통계", exact: true })).toBeVisible();
  await expect(page.getByText("3.36 kWh")).toBeVisible();

  await page.getByRole("button", { name: "설정" }).click();
  await expect(page.getByRole("heading", { name: "설정", exact: true })).toBeVisible();
  await expect(page.getByText("통신 음영 검토")).toBeVisible();
});
