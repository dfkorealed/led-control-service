import { expect, test } from "@playwright/test";
import { createMapElementFromDrag } from "../src/features/floor-editor/map-element-tools";
import { installSettingsApiRoutes, type SettingsFixture } from "./support/settings-api";

const light: SettingsFixture = { id: "fixture-1", name: "Registered light", x: 120, y: 140, ratedWatt: 40, brightness: 70,
  status: "online", health: null, rssi: null, hopCount: null, commandSuccessRate: null, lastSeenAt: null,
  gateway: null, controllable: true, controlBlockReason: null };
const shape = createMapElementFromDrag("rectangle", { x: 300, y: 100 }, { x: 420, y: 220 }, "original")!;

for (const mode of ["elements_only", "elements_and_placement"] as const) {
  test(`R3 clear ${mode}: reload and historical slots/geometry/placement restore`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const api = await installSettingsApiRoutes(page, "admin", { readyMapDocument: true, fixtures: [light], mapElements: [shape],
      lightSlots: [{ id: "historical-slot", x: 120, y: 140, rotation: 0, assignedFixtureId: "fixture-1" }] });
    await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
    const canvas = page.getByTestId("floor-editor-canvas");
    await expect(canvas).toHaveAttribute("data-map-ready", "true");
    await page.getByRole("button", { name: "맵 초기화", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "맵 초기화", exact: true });
    await expect(dialog.getByRole("radio", { name: "요소만 초기화", exact: true })).toBeChecked();
    if (mode === "elements_and_placement") {
      const radio = dialog.getByRole("radio", { name: "요소와 조명 배치 초기화", exact: true });
      await radio.locator("xpath=ancestor::label[1]").click();
      await expect(radio).toBeChecked();
    }
    await page.screenshot({ path: info.outputPath(`${mode}-confirmation.png`), fullPage: true });
    await dialog.getByRole("button", { name: "초기화 실행", exact: true }).click();
    await expect(page.getByText("맵을 초기화했습니다.", { exact: true })).toBeVisible();
    const expectedPlaced = mode === "elements_only" ? "1" : "0";
    await expect(canvas).toHaveAttribute("data-rendered-fixture-count", expectedPlaced);
    await page.reload();
    await expect(canvas).toHaveAttribute("data-map-ready", "true");
    await expect(canvas).toHaveAttribute("data-rendered-fixture-count", expectedPlaced);
    const cleared = await page.evaluate(async () => (await fetch("/api/floors/floor-1/editor-state")).json());
    expect(cleared.lightSlots).toEqual([]);
    expect(cleared.floor.mapDocument.elementCount).toBe(0);
    expect(cleared.floor.mapDocument).toMatchObject({ width: 1200, height: 800, gridSize: 10 });
    expect(cleared.fixtures[0]).toMatchObject({ id: light.id, brightness: 70, ratedWatt: 40 });
    await page.getByRole("tab", { name: "기록", exact: true }).click();
    await page.getByRole("button", { name: "리비전 7 복구", exact: true }).click();
    await expect.poll(async () => page.evaluate(async () => (await fetch("/api/floors/floor-1/editor-state")).json()))
      .toMatchObject({ floor: { mapRevision: 9, mapDocument: { elementCount: 1 } }, lightSlots: [{ id: "historical-slot", assignedFixtureId: "fixture-1" }] });
    await page.reload();
    await expect(canvas).toHaveAttribute("data-map-ready", "true");
    await expect(canvas).toHaveAttribute("data-rendered-fixture-count", "1");
    await page.screenshot({ path: info.outputPath(`${mode}-restored.png`), fullPage: true });
    expect(api.atomicSavePayloads).toEqual([]);
  });
}

test("R3 clear cancel leaves dirty draft and historical slots untouched", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installSettingsApiRoutes(page, "admin", { readyMapDocument: true, fixtures: [light], mapElements: [shape],
    lightSlots: [{ id: "historical-slot", x: 120, y: 140, rotation: 0, assignedFixtureId: "fixture-1" }] });
  await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
  await expect(page.getByTestId("floor-editor-canvas")).toHaveAttribute("data-map-ready", "true");
  await page.evaluate(async () => {
    const path = "/src/features/floor-editor/editor-store.ts";
    const { useFloorEditorStore } = await import(/* @vite-ignore */ path);
    useFloorEditorStore.getState().updateFixture("fixture-1", { name: "Unsaved rename" });
  });
  await page.getByRole("button", { name: "맵 초기화", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "맵 초기화", exact: true });
  await page.screenshot({ path: info.outputPath("mobile-clear-confirmation.png"), fullPage: true });
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeEnabled();
  const baseline = await page.evaluate(async () => (await fetch("/api/floors/floor-1/editor-state")).json());
  expect(baseline.floor.mapRevision).toBe(7); expect(baseline.lightSlots).toHaveLength(1);
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("button", { name: "저장됨", exact: true })).toBeDisabled();
});

test("R3 clear network retry replays one id and inspects the server after every attempt", async ({ page }) => {
  await installSettingsApiRoutes(page, "admin", { readyMapDocument: true, mapElements: [shape] });
  const commands: Array<{ requestId: string; mode: string }> = [];
  let reads = 0;
  await page.route("**/api/floors/floor-1/editor-state", async route => { if (route.request().method() === "GET") reads++; await route.fallback(); });
  await page.route("**/api/floors/floor-1/editor-clear", async route => {
    commands.push(route.request().postDataJSON());
    if (commands.length === 1) await route.abort("failed"); else await route.fallback();
  });
  await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
  await expect(page.getByTestId("floor-editor-canvas")).toHaveAttribute("data-map-ready", "true");
  const before = reads;
  await page.getByRole("button", { name: "맵 초기화", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "맵 초기화", exact: true });
  await dialog.getByRole("button", { name: "초기화 실행", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("맵 초기화 결과를 확인하지 못했습니다.");
  expect(reads).toBeGreaterThan(before);
  await dialog.getByRole("button", { name: "초기화 실행", exact: true }).click();
  await expect(page.getByText("맵을 초기화했습니다.", { exact: true })).toBeVisible();
  expect(commands).toHaveLength(2); expect(commands[0]).toEqual(commands[1]);
  expect(reads).toBeGreaterThan(before + 1);
  await expect(page.getByText(/맵 초기화 결과를 확인하지 못했습니다/)).toHaveCount(0);
});

test("R3 clear rejects an authoritative wrong-floor response without replacing the draft", async ({ page }) => {
  await installSettingsApiRoutes(page, "admin", { readyMapDocument: true, mapElements: [shape] });
  await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
  await expect(page.getByTestId("floor-editor-canvas")).toHaveAttribute("data-map-ready", "true");
  const baseline = await page.evaluate(async () => (await fetch("/api/floors/floor-1/editor-state")).json());
  const ref = { ...baseline.floor.mapDocument, revision: 8, generationId: "wrong-floor-clear", elementCount: 0 };
  await page.route("**/api/floors/floor-1/editor-clear", route => route.fulfill({ json: ref }));
  await page.route("**/api/floors/floor-1/editor-state", route => route.fulfill({ json: {
    ...baseline, floor: { ...baseline.floor, id: "another-floor", mapRevision: 8, mapDocument: ref }
  } }));
  await page.getByRole("button", { name: "맵 초기화", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "맵 초기화", exact: true });
  await dialog.getByRole("button", { name: "초기화 실행", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("맵 초기화 결과를 확인하지 못했습니다.");
  await expect(page.getByText("맵을 초기화했습니다.", { exact: true })).toHaveCount(0);
  const current = await page.evaluate(async () => {
    const path = "/src/features/floor-editor/editor-store.ts";
    return (await import(/* @vite-ignore */ path)).useFloorEditorStore.getState().initialState.floor;
  });
  expect(current).toMatchObject({ id: "floor-1", mapRevision: 7 });
});

for (const legacy of [false, true]) {
  test(`R3 clear disables ${legacy ? "legacy destructive bypass" : "read-only lease"}`, async ({ page }) => {
    await installSettingsApiRoutes(page, "admin", { readyMapDocument: !legacy, mapElements: [shape] });
    if (!legacy) await page.route("**/api/floors/floor-1/editor-lease", route => route.fulfill({ json: { editable: false, holderName: "Other editor" } }));
    const mutations: string[] = [];
    page.on("request", request => { if (/editor-(clear|reset)$/.test(new URL(request.url()).pathname)) mutations.push(request.url()); });
    await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
    await expect(page.getByRole("button", { name: "맵 초기화", exact: true })).toBeDisabled();
    if (legacy) await expect(page.getByText(/이전 형식 맵은 초기화할 수 없습니다/)).toBeVisible();
    expect(mutations).toEqual([]);
  });
}
