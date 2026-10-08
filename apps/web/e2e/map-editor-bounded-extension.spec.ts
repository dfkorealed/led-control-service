import { expect, test, type Page } from "@playwright/test";
import { createMapElementFromDrag } from "../src/features/floor-editor/map-element-tools";
import { installSettingsApiRoutes, type SettingsFixture } from "./support/settings-api";
import { expectMinimumTouchTargetsAfterScrolling } from "./support/layout-assertions";

const rectangle = (id: string, layerId: string, x: number) => ({ ...createMapElementFromDrag("rectangle", { x, y: 103 }, { x: x + 83, y: 186 }, id)!,
  layerId, style: { strokeColor: "#475569", strokeWidth: 1, fillColor: "#06b6d4", opacity: 1 } });
const light = (id: string, x: number): SettingsFixture => ({ id, name: id, x, y: 140, size: 20, ratedWatt: 40, brightness: 80, status: "online",
  health: null, rssi: null, hopCount: null, commandSuccessRate: null, lastSeenAt: new Date().toISOString(), gateway: null, controllable: true, controlBlockReason: null });
async function setup(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const api = await installSettingsApiRoutes(page, "admin", { readyMapDocument: true, fixtures: [light("fixture-1", 120), light("fixture-2", 200)],
    lightSlots: [{ id: "slot-1", x: 120, y: 140, rotation: 0, assignedFixtureId: "fixture-1" }],
    mapElements: [rectangle("shape-1", "map", 303), rectangle("shape-2", "other", 433)],
    mapLayers: [{ id: "map", name: "Map", order: 0, visible: true, locked: false }, { id: "other", name: "Other", order: 1, visible: true, locked: false }] });
  await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
  await expect(page.getByTestId("floor-editor-canvas")).toHaveAttribute("data-map-ready", "true");
  return api;
}
async function point(page: Page, x: number, y: number) {
  const canvas = page.getByTestId("floor-editor-canvas"), box = (await canvas.boundingBox())!;
  const zoom = Number(await canvas.getAttribute("data-zoom"));
  return { x: box.x + Number(await canvas.getAttribute("data-pan-x")) + x * zoom,
    y: box.y + Number(await canvas.getAttribute("data-pan-y")) + y * zoom };
}
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 10 }); await page.mouse.up();
}

test("mixed click/marquee/style/delete is atomic, undoable, saved and reloaded without shifting canvas", async ({ page }, info) => {
  const api = await setup(page), canvas = page.getByTestId("floor-editor-canvas");
  const shape = await point(page, 340, 140), fixture = await point(page, 120, 140);
  await page.mouse.click(shape.x, shape.y); await expect(canvas).toHaveAttribute("data-map-selection-count", "1");
  await page.keyboard.down("Shift"); await page.mouse.click(fixture.x, fixture.y); await page.keyboard.up("Shift");
  await expect(page.getByRole("heading", { name: "2개 선택" })).toBeVisible();
  await expect(page.getByLabel("선택 회전")).toHaveCount(0);
  await page.keyboard.down("Shift"); await page.mouse.click(shape.x, shape.y); await page.keyboard.up("Shift");
  await expect(canvas).toHaveAttribute("data-map-selection-count", "1");
  const before = await canvas.boundingBox();
  await drag(page, await point(page, 80, 70), await point(page, 550, 260));
  await expect(page.getByRole("heading", { name: "4개 선택" })).toBeVisible();
  await page.getByLabel("채우기 색상", { exact: true }).fill("#e11d48");
  await page.getByRole("button", { name: "도형 스타일 적용" }).click();
  await page.getByRole("button", { name: "선택 전체 삭제", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "선택 전체 삭제" });
  await expect(dialog).toContainText("2개 도형을 삭제하고 2개 조명");
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-map-selection-count", "4");
  await page.getByRole("button", { name: "선택 전체 삭제", exact: true }).click();
  await dialog.getByRole("button", { name: "전체 삭제", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-rendered-fixture-count", "0");
  await page.getByRole("button", { name: "실행 취소", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-map-selection-count", "4");
  await expect(canvas).toHaveAttribute("data-rendered-fixture-count", "2");
  await page.getByRole("button", { name: "다시 실행", exact: true }).click();
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("region", { name: "알림" })).toContainText("맵을 저장했습니다.");
  expect(await canvas.boundingBox()).toEqual(before);
  expect(api.atomicSavePayloads).toHaveLength(1);
  expect(api.atomicSavePayloads[0].fixtureUpdates).toEqual(expect.arrayContaining([expect.objectContaining({ id: "fixture-1", placementStatus: "unplaced" }), expect.objectContaining({ id: "fixture-2", placementStatus: "unplaced" })]));
  expect(api.atomicSavePayloads[0].slotAssignments).toEqual([{ slotId: "slot-1", assignedFixtureId: null }]);
  expect(api.atomicSavePayloads[0].documentChanges!.operations.filter(op => op.kind === "delete")).toHaveLength(2);
  await page.reload(); await expect(canvas).toHaveAttribute("data-map-ready", "true");
  await expect(canvas).toHaveAttribute("data-rendered-fixture-count", "0");
  await page.screenshot({ path: info.outputPath("mixed-delete-reloaded.png"), fullPage: true });
});

test("compact rows select complete queries, show partial lights, rename hidden layers and persist undo", async ({ page }, info) => {
  const api = await setup(page), canvas = page.getByTestId("floor-editor-canvas");
  const fixture = await point(page, 120, 140); await page.mouse.click(fixture.x, fixture.y);
  await page.getByRole("tab", { name: "레이어", exact: true }).click();
  const lights = page.getByRole("checkbox", { name: "조명 배치 전체 선택" });
  await expect.poll(() => lights.evaluate(el => (el as HTMLInputElement).indeterminate)).toBe(true);
  await lights.locator("xpath=ancestor::label[1]").click(); await expect(canvas).toHaveAttribute("data-map-selection-count", "2");
  await expect(lights).toBeChecked();
  await page.getByRole("checkbox", { name: "Map 레이어 내 도형 선택" }).locator("xpath=ancestor::label[1]").click();
  await page.getByRole("checkbox", { name: "Other 레이어 내 도형 선택" }).locator("xpath=ancestor::label[1]").click();
  await expect(canvas).toHaveAttribute("data-map-selection-count", "4");
  await page.getByRole("checkbox", { name: "Map 레이어 내 도형 선택" }).locator("xpath=ancestor::label[1]").click();
  await expect(canvas).toHaveAttribute("data-map-selection-count", "3");
  await page.getByRole("button", { name: "Other 숨기기", exact: true }).click();
  await page.getByRole("button", { name: "Other 메뉴", exact: true }).click();
  await page.getByRole("menuitem", { name: "이름 변경", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "이름 변경" });
  await rename.getByLabel("이름", { exact: true }).fill("   "); await expect(rename.getByRole("button", { name: "이름 저장" })).toBeDisabled();
  await rename.getByLabel("이름", { exact: true }).fill("  Renamed  "); await rename.getByRole("button", { name: "이름 저장" }).click();
  await expect(page.getByRole("checkbox", { name: "Renamed 레이어 내 도형 선택" })).toBeChecked();
  await page.getByRole("button", { name: "실행 취소", exact: true }).click(); await expect(page.getByRole("button", { name: "Other 메뉴" })).toBeVisible();
  await page.getByRole("button", { name: "다시 실행", exact: true }).click();
  await page.getByRole("button", { name: "Renamed 잠금", exact: true }).click();
  await page.getByRole("button", { name: "Renamed 메뉴" }).click(); await expect(page.getByRole("menuitem", { name: "이름 변경" })).toHaveAttribute("aria-disabled", "true"); await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "선택 전체 삭제", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Renamed 잠금 해제" }).click();
  await page.getByRole("button", { name: "저장", exact: true }).click(); await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  expect(api.atomicSavePayloads[0].documentChanges!.operations).toEqual(expect.arrayContaining([{ kind: "layer.put", layer: expect.objectContaining({ id: "other", name: "Renamed", visible: false, locked: false }) }]));
  await page.reload(); await expect(canvas).toHaveAttribute("data-map-ready", "true"); await page.getByRole("tab", { name: "레이어", exact: true }).click();
  await expect(page.getByRole("button", { name: "Renamed 표시" })).toBeVisible();
  for (const row of await page.locator("[data-layer-row]").all()) expect((await row.boundingBox())!.height).toBeLessThanOrEqual(45);
  await page.screenshot({ path: info.outputPath("compact-rows.png"), fullPage: true });
});

test("actual pointer move/resize snaps only at release, inspector and warnings keep canvas stable", async ({ page }, info) => {
  const api = await setup(page), canvas = page.getByTestId("floor-editor-canvas");
  const p = await point(page, 340, 140); await page.mouse.click(p.x, p.y);
  const x = page.getByRole("textbox", { name: "X 위치", exact: true });
  await expect(x).toHaveValue("303");
  await drag(page, p, await point(page, 354, 149));
  await expect(x).toHaveValue("320"); await expect(page.getByRole("textbox", { name: "Y 위치" })).toHaveValue("110");
  await drag(page, await point(page, 403, 193), await point(page, 427, 217));
  await expect(page.getByRole("textbox", { name: "너비", exact: true })).toHaveValue("110");
  await expect(page.getByRole("textbox", { name: "높이", exact: true })).toHaveValue("110");
  await expect(x).toHaveValue("320");
  const before = await canvas.boundingBox();
  await x.fill("-100"); await x.press("Tab");
  await expect(page.getByRole("region", { name: "알림" })).toContainText("맵 범위"); expect(await canvas.boundingBox()).toEqual(before);
  await page.getByRole("region", { name: "알림" }).getByRole("button", { name: "알림 닫기" }).click();
  await page.getByRole("button", { name: "저장", exact: true }).click(); await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  expect(api.atomicSavePayloads[0].documentChanges!.operations).toEqual(expect.arrayContaining([{ kind: "update", element: expect.objectContaining({ id: "shape-1" }) }]));
  await page.screenshot({ path: info.outputPath("snap-resize-toast.png"), fullPage: true });
});

test("mobile toolbar retains reachable 44px controls", async ({ page }, info) => {
  await setup(page); await page.setViewportSize({ width: 390, height: 844 });
  await expectMinimumTouchTargetsAfterScrolling(page, '[data-testid="editor-toolbar"]');
  await page.screenshot({ path: info.outputPath("mobile-toolbar.png"), fullPage: true });
});
