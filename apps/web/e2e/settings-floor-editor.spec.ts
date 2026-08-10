import { expect, test } from "@playwright/test";
import { installSettingsApiRoutes } from "./support/settings-api";

test("operator commissioning is visible and admin floor changes are reflected in monitoring", async ({ browser }) => {
  const operatorPage = await browser.newPage();
  await installSettingsApiRoutes(operatorPage, "operator");
  await operatorPage.goto("/settings/commissioning?siteId=site-1");
  await expect(operatorPage.getByRole("heading", { name: "설치 및 시운전" })).toBeVisible();

  const adminPage = await browser.newPage();
  const adminApi = await installSettingsApiRoutes(adminPage, "admin");
  await adminPage.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
  await expect(adminPage.getByRole("heading", { name: "B2 도면 편집" })).toBeVisible();

  await adminPage.getByLabel("B2 편집 캔버스").click({ position: { x: 120, y: 140 } });
  await expect(adminPage.getByRole("complementary", { name: "속성 패널" }).getByRole("heading", { name: "B2-L01" })).toBeVisible();
  await adminPage.getByRole("complementary", { name: "속성 패널" }).getByLabel("X").fill("240");
  await adminPage.getByRole("button", { name: "저장", exact: true }).click();

  await expect(adminPage).toHaveURL(/\/settings\/floor-plans\?siteId=site-1$/);
  expect(adminApi.leaseRequests.length).toBeGreaterThan(0);
  expect(adminApi.leaseRequests).toEqual(expect.arrayContaining([{}]));
  expect(adminApi.leaseRequests.every((payload) => Object.keys(payload).length === 0)).toBe(true);
  expect(adminApi.atomicSavePayloads).toHaveLength(1);
  expect(adminApi.atomicSavePayloads[0]).toMatchObject({ expectedRevision: 7 });
  expect(adminApi.fixtureUpdates).toHaveLength(1);
  expect(adminApi.fixtureUpdates[0]).toMatchObject({ id: "fixture-1", x: 240 });

  await adminPage.goto("/monitoring?siteId=site-1");
  const movedFixture = adminPage.getByRole("button", { name: "B2-L01 정상 70%" });
  await expect(movedFixture).toBeVisible();
  await expect(movedFixture).toHaveCSS("--fixture-left", "20%");

  await operatorPage.close();
  await adminPage.close();
});

test("viewer is redirected before editor state and lease requests while mutation fixtures reject changes", async ({ page }) => {
  const api = await installSettingsApiRoutes(page, "viewer");
  await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");

  await expect(page).toHaveURL(/\/settings\/floor-plans\?siteId=site-1$/);
  await expect(page.getByRole("heading", { name: "도면 관리" })).toBeVisible();
  await expect(page.getByRole("link", { name: "B2 도면 편집" })).toHaveCount(0);
  expect(api.requests.filter((path) => path.includes("/editor-state") || path.includes("/editor-lease"))).toEqual([]);

  const status = await page.evaluate(async () => {
    const response = await fetch("/api/floors/floor-1/editor-state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 7, fixtureUpdates: [], objectCreates: [], objectUpdates: [], objectDeletes: [] })
    });
    return response.status;
  });
  expect(status).toBe(403);
});

test("settings fixtures do not expose foreign tenant routes", async ({ page }) => {
  await installSettingsApiRoutes(page, "admin");
  await page.goto("/settings/floor-plans?siteId=site-1");

  const status = await page.evaluate(async () => {
    const response = await fetch("/api/sites/site-foreign/dashboard");
    return response.status;
  });
  expect(status).toBe(404);
});
