import { expect, test, type Locator } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { installSettingsApiRoutes } from "./support/settings-api";
import { installMockApiBoundary } from "./support/mock-api-boundary";

test.beforeEach(async ({ context, baseURL }) => { await installMockApiBoundary(context, baseURL); });

async function expectTabsFit(tabs: Locator) {
  await expect(tabs).toBeVisible();
  await tabs.scrollIntoViewIfNeeded();
  await expect(tabs).toBeInViewport({ ratio: 1 });
  const geometry = await tabs.evaluate(node => {
    const parent = node.getBoundingClientRect();
    return [...node.querySelectorAll<HTMLElement>('[role="tab"]')].map(tab => {
      const rect = tab.getBoundingClientRect();
      return { width: rect.width, height: rect.height, fits: rect.left >= parent.left && rect.right <= parent.right + 0.5,
        textFits: tab.scrollWidth <= tab.clientWidth, reachable: tab.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)) };
    });
  });
  for (const tab of geometry) {
    expect(tab.width).toBeGreaterThanOrEqual(44);
    expect(tab.height).toBeGreaterThanOrEqual(44);
    expect(tab.fits).toBe(true);
    expect(tab.textFits).toBe(true);
    expect(tab.reachable).toBe(true);
  }
}

for (const width of [1440, 1039, 390, 320]) {
  test(`F1 independent tabs fit and keep keyboard/panel semantics at ${width}px (HTTP fixture)`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 909 });
    await installSettingsApiRoutes(page, "admin", { readyMapDocument: true });
    await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
    await expect(page.getByTestId("floor-editor-canvas")).toHaveAttribute("data-map-ready", "true");
    await expect(page.getByRole("button", { name: "저장됨", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "맵으로 돌아가기", exact: true })).toHaveCount(0);
    const narrow = width < 1280;
    const tools = page.getByRole("button", { name: "도구 및 조명 패널" });
    const information = page.getByRole("button", { name: "편집 정보 패널" });
    if (narrow) await tools.click();
    const placements = page.getByRole("tablist", { name: "배치 상태" });
    await expectTabsFit(placements);
    await placements.getByRole("tab", { name: "미배치" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(placements.getByRole("tab", { name: "전체" })).toBeFocused();
    await expect(placements.getByRole("tab", { name: "전체" })).toHaveAttribute("aria-selected", "true");
    if (narrow) { await tools.click(); await information.click(); }
    const tabs = page.getByRole("tablist", { name: "편집 패널" });
    await expectTabsFit(tabs);
    await tabs.getByRole("tab", { name: "속성" }).focus();
    await page.keyboard.press("End");
    const history = tabs.getByRole("tab", { name: "기록" });
    await expect(history).toBeFocused();
    await expect(history).toHaveAttribute("aria-selected", "true");
    const controls = await history.getAttribute("aria-controls");
    await expect(page.locator(`[id="${controls}"]`)).toHaveAttribute("role", "tabpanel");
    await expect(page.locator(`[id="${controls}"]`)).toHaveAttribute("aria-labelledby", (await history.getAttribute("id"))!);
    const ids = await page.locator('[role="tab"]').evaluateAll(nodes => nodes.map(node => node.id));
    expect(new Set(ids).size).toBe(ids.length);
    await page.screenshot({ path: info.outputPath(`f1-tabs-${width}.png`) });
    await page.keyboard.press("Home");
    await expect(tabs.getByRole("tab", { name: "속성" })).toBeFocused();
    if (narrow) { await information.click(); await tools.click(); }
    await expect(placements.getByRole("tab", { name: "전체" })).toHaveAttribute("aria-selected", "true");
  });
}

test("F1 unchanged → edit → saved ACK → reload keeps the persisted state (HTTP fixture)", async ({ page }, info) => {
  const api = await installSettingsApiRoutes(page, "admin", { readyMapDocument: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
  await expect(page.getByTestId("floor-editor-canvas")).toHaveAttribute("data-map-ready", "true");
  await expect(page.getByRole("button", { name: "저장됨", exact: true })).toBeDisabled();
  const geometryPath = info.outputPath("editor-canvas-geometry.json");
  await writeFile(geometryPath, JSON.stringify(await page.getByLabel("B2 편집 캔버스").boundingBox()));
  await info.attach("editor-canvas-geometry", { path: geometryPath, contentType: "application/json" });
  await page.getByRole("tablist", { name: "배치 상태" }).getByRole("tab", { name: "전체" }).click();
  await page.getByTestId("placement-fixture-fixture-1").click();
  await page.getByLabel("조명명", { exact: true }).fill("F1 saved fixture");
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("button", { name: "저장됨", exact: true })).toBeDisabled();
  expect(api.atomicSavePayloads).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole("button", { name: "저장됨", exact: true })).toBeDisabled();
  await page.getByRole("tablist", { name: "배치 상태" }).getByRole("tab", { name: "전체" }).click();
  await page.getByTestId("placement-fixture-fixture-1").click();
  await expect(page.getByLabel("조명명", { exact: true })).toHaveValue("F1 saved fixture");
  expect(api.atomicSavePayloads).toHaveLength(1);
});
