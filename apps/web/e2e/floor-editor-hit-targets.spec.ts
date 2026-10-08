import { expect, test, type Page } from "@playwright/test";
import { installSettingsApiRoutes, type SettingsFixture } from "./support/settings-api";

const fixtures: SettingsFixture[] = [[20, 20], [49, 20], [20, 50], [49, 50]].map(([x, y], index) => ({
  id: `33333333-3333-4333-8333-${String(index + 1).padStart(12, "0")}`,
  name: `Dense ${index + 1}`, x, y, size: 20, ratedWatt: 40, brightness: 70,
  status: "online", statusReason: "reported", health: { faultCodes: [], observedAt: "2026-07-12T00:00:00.000Z" },
  rssi: -60, hopCount: 1, commandSuccessRate: 1, lastSeenAt: "2026-07-12T00:00:00.000Z",
  gateway: { id: "77777777-7777-4777-8777-777777777777", name: "Gateway", connectionStatus: "online" },
  controllable: true, controlBlockReason: null
}));
const ids = { siteId: "22222222-2222-4222-8222-222222222222", floorId: "44444444-4444-4444-8444-444444444444" };

async function openEditor(page: Page) {
  const api = await installSettingsApiRoutes(page, "admin", { fixtures, mapObjects: [], ids });
  await page.goto(`/settings/floor-plans/${ids.floorId}/edit?siteId=${ids.siteId}`);
  await expect(page.getByRole("heading", { name: "B2 맵 편집" })).toBeVisible();
  await expect(page.getByTestId("floor-editor-canvas")).toHaveAttribute("aria-disabled", "false");
  await expect.poll(() => api.editorRequests.some(request => request.type === "lease-acquire" && request.result.editable)).toBe(true);
  return api;
}

async function screenPoint(page: Page, x: number, y: number) {
  return page.getByTestId("floor-editor-canvas").evaluate((element, world) => {
    const bounds = element.getBoundingClientRect();
    const zoom = Number(element.getAttribute("data-zoom"));
    return { x: bounds.left + world.x * zoom + Number(element.getAttribute("data-pan-x")),
      y: bounds.top + world.y * zoom + Number(element.getAttribute("data-pan-y")) };
  }, { x, y });
}

async function clearSelection(page: Page) {
  // Independent centre checks must not click the previous selection's DOM
  // unplace button, which intentionally has priority above the canvas.
  const point = await screenPoint(page, 500, 300);
  await page.mouse.click(point.x, point.y);
  await expect(page.getByTestId("floor-editor-canvas")).toHaveAttribute("data-map-selection-count", "0");
}

test("dense editor uses actual bodies, nearest padding and Shift without changing the camera", async ({ page }) => {
  await openEditor(page);
  const canvas = page.getByTestId("floor-editor-canvas");
  const camera = await canvas.evaluate(element => [element.getAttribute("data-zoom"), element.getAttribute("data-pan-x"), element.getAttribute("data-pan-y")]);
  const properties = page.getByRole("complementary", { name: "속성 패널" });
  for (const fixture of fixtures) {
    await clearSelection(page);
    const point = await screenPoint(page, fixture.x, fixture.y);
    await page.mouse.click(point.x, point.y);
    await expect(properties.getByRole("heading", { name: fixture.name, exact: true })).toBeVisible();
  }
  await clearSelection(page);
  const padding = await screenPoint(page, 68, 20);
  await page.mouse.click(padding.x, padding.y);
  await expect(properties.getByRole("heading", { name: "Dense 2", exact: true })).toBeVisible();
  await clearSelection(page);
  const first = await screenPoint(page, 20, 20);
  await page.mouse.click(first.x, first.y);
  // The selected first fixture's resize handle covers the third centre at
  // this zoom. Exercise its reachable padding without overriding that handle.
  const second = await screenPoint(page, 20, 85);
  await page.keyboard.down("Shift");
  await page.mouse.click(second.x, second.y);
  await page.keyboard.up("Shift");
  await expect(canvas).toHaveAttribute("data-map-selection-count", "2");
  await page.keyboard.down("Shift");
  await page.mouse.click(second.x, second.y);
  await page.keyboard.up("Shift");
  await expect(canvas).toHaveAttribute("data-map-selection-count", "1");
  await expect(properties.getByRole("heading", { name: "Dense 1", exact: true })).toBeVisible();
  expect(await canvas.evaluate(element => [element.getAttribute("data-zoom"), element.getAttribute("data-pan-x"), element.getAttribute("data-pan-y")])).toEqual(camera);
});

test("dense editor drags and saves the same fixture whose visible centre was pressed", async ({ page }) => {
  const api = await openEditor(page);
  const start = await screenPoint(page, 20, 20), end = await screenPoint(page, 90, 20);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
  const properties = page.getByRole("complementary", { name: "속성 패널" });
  await expect(properties.getByRole("heading", { name: "Dense 1", exact: true })).toBeVisible();
  await expect(properties.getByLabel("X", { exact: true })).toHaveValue("90");
  await expect(properties.getByLabel("Y", { exact: true })).toHaveValue("20");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  expect(api.fixtureUpdates).toHaveLength(1);
  expect(api.fixtureUpdates[0]).toMatchObject({ id: fixtures[0].id, x: 90 });
});

test("dense editor touch tap selects the visible body rather than its padded neighbour", async ({ page }) => {
  await openEditor(page);
  const point = await screenPoint(page, 20, 20);
  await page.touchscreen.tap(point.x, point.y);
  await expect(page.getByRole("complementary", { name: "속성 패널" }).getByRole("heading", { name: "Dense 1", exact: true })).toBeVisible();
});
