import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/auth/me", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        user: {
          id: "00000000-0000-4000-8000-000000000002",
          organizationId: "00000000-0000-4000-8000-000000000001",
          email: "operator@example.com",
          name: "Demo Operator",
          role: "admin",
          status: "active"
        }
      })
    });
  });

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
                rssi: -58,
                hopCount: 1,
                commandSuccessRate: 0.98,
                lastSeenAt: "2026-07-01T00:00:00.000Z"
              }
            ]
          }
        ],
        groups: [{ id: "group-1", name: "B2 Entrance Zone", fixtureIds: ["fixture-1"] }],
        gateways: [
          {
            id: "gateway-1",
            name: "Gateway B2",
            serialNumber: "GW-E2E-001",
            firmwareVersion: "mock-1.0.0",
            lastHeartbeatAt: "2026-07-01T00:00:00.000Z",
            connectionStatus: "online"
          }
        ]
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
  await expect(page.getByRole("button", { name: "B2-L01 정상 70%" })).toBeVisible();

  await page.getByRole("button", { name: "제어" }).click();
  await expect(page.getByRole("heading", { name: "제어", exact: true })).toBeVisible();
  await expect(page.getByText("빠른 밝기 제어")).toBeVisible();

  await page.getByRole("button", { name: "통계" }).click();
  await expect(page.getByRole("heading", { name: "통계", exact: true })).toBeVisible();
  await expect(page.getByText("에너지 리포트")).toBeVisible();
  await expect(page.locator(".metric").filter({ hasText: "일 사용량" })).toBeVisible();

  await page.getByRole("button", { name: "설정" }).click();
  await expect(page.getByRole("heading", { name: "설정", exact: true })).toBeVisible();
  await expect(page.getByText("운영 설정")).toBeVisible();
  await expect(page.getByText("통신 음영 검토")).toBeVisible();
});
