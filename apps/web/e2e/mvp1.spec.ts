import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/auth/me", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        user: {
          id: "00000000-0000-4000-8000-000000000002",
          organizationId: "00000000-0000-4000-8000-000000000001",
          organizationType: "customer",
          loginId: "demo_admin",
          name: "Demo Administrator",
          role: "admin",
          status: "active"
        }
      })
    });
  });

  await page.route("**/sites/default/dashboard**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        site: {
          id: "site-1",
          name: "Demo Underground Parking",
          customerName: "Demo Customer",
          installationStatus: "installed",
          address: "서울시 강남구",
          tariffKwhRate: 160,
          timeZone: "Asia/Seoul"
        },
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
            meshControlGroups: [{ gatewayId: "gateway-1", status: "ready", version: 1, error: null }],
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
        groups: [{
          id: "group-1",
          name: "B2 Entrance Zone",
          floorId: "floor-1",
          gatewayId: "gateway-1",
          lifecycleStatus: "active",
          fixtureCount: 1,
          meshControlGroup: { status: "ready", version: 1, error: null },
          fixtureIds: ["fixture-1"]
        }],
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

  await page.route("**/sites", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([{ id: "site-1", name: "Demo Underground Parking" }])
    });
  });

  await page.route("**/sites/site-1/floors/floor-1/fixtures?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [{
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
          lastSeenAt: "2026-07-01T00:00:00.000Z",
          gateway: { id: "gateway-1", name: "Gateway B2", connectionStatus: "online" },
          controllable: true,
          controlBlockReason: null
        }],
        nextCursor: null
      })
    });
  });

  await page.route("**/sites/site-1/floors/floor-1/map-snapshot", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        floorId: "floor-1",
        revision: 1,
        width: 1200,
        height: 800,
        objects: []
      })
    });
  });

  await page.route("**/energy/sites/site-1/summary", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        siteId: "site-1",
        timeZone: "Asia/Seoul",
        source: "state_based_estimate",
        generatedAt: "2026-08-26T00:00:00.000Z",
        today: { estimatedKwh: 3.36, estimatedCost: 538, knownSeconds: 43200, unknownSeconds: 0, dataStatus: "available" },
        monthToDate: { estimatedKwh: 100.8, estimatedCost: 16128, knownSeconds: 2073600, unknownSeconds: 0, dataStatus: "available" },
        yearToDate: { estimatedKwh: 1226.4, estimatedCost: 196224, knownSeconds: 20000000, unknownSeconds: 0, dataStatus: "available" },
        monthForecast: { estimatedKwh: 120, estimatedCost: 19200, observedKnownSeconds: 2073600, reason: "available" },
        baseline24Hours: { estimatedKwh: 297.6, estimatedCost: 47616, fixtureCount: 10, daysInMonth: 31 },
        estimatedSavings: { kwh: 177.6, cost: 28416 },
        lastAggregatedAt: "2026-08-26T00:00:00.000Z"
      })
    });
  });

  await page.route("**/energy/sites/site-1/series?**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const granularity = params.get("granularity") === "month" ? "month" : "day";
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        siteId: "site-1",
        timeZone: "Asia/Seoul",
        source: "state_based_estimate",
        generatedAt: "2026-08-26T00:00:00.000Z",
        granularity,
        from: params.get("from"),
        to: params.get("to"),
        points: granularity === "day"
          ? [{ source: "state_based_estimate", period: "2026-08-26", estimatedKwh: 3.36, estimatedCost: 538, knownSeconds: 43200, unknownSeconds: 0, dataStatus: "available" }]
          : [{ source: "state_based_estimate", period: "2026-08-01", estimatedKwh: 100.8, estimatedCost: 16128, knownSeconds: 2073600, unknownSeconds: 0, dataStatus: "available" }]
      })
    });
  });
});

test("customer admin can view monitoring dashboard and navigate primary sections", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "모니터링" })).toBeVisible();
  await expect(page.getByText("전체 조명")).toBeVisible();
  await expect(page.getByRole("button", { name: "B2-L01 정상 70%" })).toBeVisible();

  await page.getByRole("link", { name: "제어" }).click();
  await expect(page.getByRole("heading", { name: "제어", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "조명 밝기 제어" })).toBeVisible();

  await page.getByRole("link", { name: "통계" }).click();
  await expect(page.getByRole("heading", { name: "통계", exact: true })).toBeVisible();
  await expect(page.getByText("에너지 리포트")).toBeVisible();
  await expect(page.getByRole("group", { name: "오늘 전력 사용량" })).toContainText("3.36 kWh");

  await page.getByRole("link", { name: "설정" }).click();
  await expect(page.getByRole("heading", { name: "설정", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "설정 개요" })).toBeVisible();
});
