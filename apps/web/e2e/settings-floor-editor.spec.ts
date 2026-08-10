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
  await expect.poll(() => adminApi.editorRequests.filter(({ type }) => type === "atomic-save")).toHaveLength(1);

  const save = adminApi.editorRequests.find(({ type }) => type === "atomic-save");
  if (!save || save.type !== "atomic-save") throw new Error("atomic save request was not captured");
  const acquireBeforeSave = [...adminApi.editorRequests].reverse().find((request) => (
    request.type === "lease-acquire" && request.sequence < save.sequence
  ));
  if (!acquireBeforeSave || acquireBeforeSave.type !== "lease-acquire") throw new Error("lease acquire before save was not captured");
  const { sequence: saveSequence, ...saveRequest } = save;
  expect(saveRequest).toEqual({
    type: "atomic-save",
    payload: {
      expectedRevision: 7,
      fixtureUpdates: [{ id: "fixture-1", x: 240 }],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    }
  });
  expect(acquireBeforeSave).toMatchObject({ type: "lease-acquire", payload: {} });
  expect(acquireBeforeSave.sequence).toBeLessThan(saveSequence);

  await expect.poll(() => adminApi.editorRequests.some((request) => (
    request.type === "lease-release"
    && request.sequence > saveSequence
    && request.payload.token === acquireBeforeSave.issuedToken
  ))).toBe(true);

  expect(adminApi.fixtureUpdates).toEqual([{ id: "fixture-1", x: 240 }]);

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
  const floorRow = page.locator(".setting-card").filter({ hasText: "B2" });
  await expect(floorRow).toContainText("도면 등록됨");
  await expect(floorRow.getByRole("link", { name: "B2 도면 편집" })).toHaveCount(0);
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

test("settings browser fixture isolates unknown tenant route data", async ({ page }) => {
  await installSettingsApiRoutes(page, "admin");
  await page.goto("/settings/floor-plans?siteId=site-1");

  const status = await page.evaluate(async () => {
    const response = await fetch("/api/sites/site-foreign/dashboard");
    return response.status;
  });
  expect(status).toBe(404);
});
