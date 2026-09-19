import { expect, test, type Page } from "@playwright/test";
import type { MapElement, MapGroup, MapLayer, MapOp } from "@led-control/shared/map-document-contracts";
import type { FloorEditorState } from "./editor-types";

declare global { interface Window { editorSmoke: ReturnType<typeof import("./floor-editor-smoke")["mountFloorEditorSmoke"]>;
  mountFloorEditorSmoke: typeof import("./floor-editor-smoke")["mountFloorEditorSmoke"] } }

async function fixture(page: Page, size = { width: 1200, height: 800 }) {
  const hash = "a".repeat(64), sceneId = "00000000-0000-4000-8000-000000000001", assetId = "00000000-0000-4000-8000-000000000002";
  const layers: MapLayer[] = [{ id: "map", name: "Map", order: 0, visible: true, locked: false }];
  const groups: MapGroup[] = [];
  const elements = new Map<string, MapElement>([["imported", { id: "imported", type: "rectangle", layerId: "map", groupId: null, zIndex: 0,
    visible: true, locked: false, provenance: { importJobId: "job", sourceId: "source" },
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }, style: { strokeColor: "#ff0000", fillColor: "#00cc66", strokeWidth: 2, opacity: 1 },
    geometry: { origin: { x: 100, y: 100 }, width: 160, height: 100 } }]]);
  let state: FloorEditorState = { floor: { id: "u10b", siteId: "site", name: "통합 검증", level: 1, mapRevision: 1,
    floorPlan: { imageUrl: "", sourceType: "none", ...size, gridSize: 10, version: 1 },
    mapDocument: { formatVersion: 1, generationId: "gen", revision: 1, ...size, gridSize: 10, elementCount: 1,
      manifest: { assetId, sha256: hash, byteSize: 1, decodedByteSize: 1 } } },
    fixtures: [{ id: "fixture", name: "등록 조명", x: 0, y: 0, placementStatus: "unplaced", ratedWatt: 40, brightness: 80, status: "online" }], objects: [],
    lightSlots: [{ id: "slot", x: 500, y: 500, rotation: 0, assignedFixtureId: null }] };
  const requests: unknown[] = [];
  await page.route("**/api/floors/**", async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path.endsWith("/editor-state")) {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON(); requests.push(body);
        for (const op of body.documentChanges?.operations ?? []) {
          const operation = op as MapOp;
          if (operation.kind === "delete") elements.delete(operation.id);
          else if (operation.kind === "add" || operation.kind === "update") elements.set(operation.element.id, operation.element);
          else if (operation.kind === "layer.put") { const index = layers.findIndex(layer => layer.id === operation.layer.id); if (index < 0) layers.push(operation.layer); else layers[index] = operation.layer; }
          else if (operation.kind === "group.put") groups.push(operation.group);
        }
        const revision = state.floor.mapRevision + 1;
        state = { ...state, floor: { ...state.floor, mapRevision: revision, mapDocument: { ...state.floor.mapDocument!, revision, elementCount: elements.size } },
          fixtures: state.fixtures.map(fixture => ({ ...fixture, ...body.fixtureUpdates.find((patch: { id: string }) => patch.id === fixture.id) })),
          lightSlots: state.lightSlots.map(slot => { const assignment = body.slotAssignments.find((patch: { slotId: string }) => patch.slotId === slot.id); return assignment ? { ...slot, assignedFixtureId: assignment.assignedFixtureId } : slot; }) };
      }
      return route.fulfill({ json: state });
    }
    if (path.endsWith("/manifest")) return route.fulfill({ json: { generationId: "gen", revision: state.floor.mapRevision, canonical: state.floor.mapDocument!.manifest,
      groups, layers, displayLayerBindings: [], display: { version: 2, sceneId, regionId: "manual", manifestAssetId: assetId,
        ...size, padding: 0, gridSize: 10, tileSize: 512, lodMode: "additive", primitiveCount: 0, tileCount: 0,
        byteSize: 1, sha256: hash, sourceBounds: { minX: 0, minY: 0, maxX: size.width, maxY: size.height },
        transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }, tiles: [] } } });
    if (path.endsWith("/changes")) return route.fulfill({ json: { generationId: "gen", revision: state.floor.mapRevision,
      operations: [...elements.values()].map(element => ({ kind: "add", element })), nextCursor: null } });
    if (path.endsWith("/elements")) return route.fulfill({ json: route.request().postDataJSON().ids.flatMap((id: string) => elements.has(id) ? [elements.get(id)] : []) });
    if (path.endsWith("/selection")) return route.fulfill({ json: { generationId: "gen", revision: state.floor.mapRevision, ids: [...elements.keys()], nextCursor: null } });
    if (path.endsWith("/editor-revisions")) return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path.endsWith("/active")) return route.fulfill({ json: { job: null } });
    if (path.endsWith("/applied-overlay")) return route.fulfill({ json: { overlay: null } });
    return route.fulfill({ json: {} });
  });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/src/features/floor-editor/floor-editor-smoke.html");
  await page.waitForFunction(() => Boolean(window.mountFloorEditorSmoke));
  await page.evaluate(async state => {
    const path = "/src/api/map-document.ts";
    const { createMapDocumentSource } = await import(/* @vite-ignore */ path);
    const source = createMapDocumentSource({ floorId: "u10b", authScope: "fixture-validation" });
    await source.getManifest(state.floor.mapDocument, new AbortController().signal);
    await source.getChanges(state.floor.mapDocument, undefined, new AbortController().signal);
  }, state);
  const mount = async () => page.evaluate(async state => {
    window.editorSmoke?.dispose();
    window.editorSmoke = window.mountFloorEditorSmoke(state);
  }, state);
  await mount();
  await expect(page.getByTestId("floor-editor-canvas")).toBeVisible().catch(error => { throw new Error(`${error}\nPage errors: ${JSON.stringify(errors)}`); });
  await expect(page.getByRole("img", { name: "맵 도형" }).locator("canvas")).toBeVisible();
  await expect(page.getByTestId("floor-editor-canvas")).toHaveAttribute("data-map-ready", "true");
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return { errors, requests, elements, mount, state: () => state };
}

for (const width of [1440, 1024, 390, 320]) test(`production View shape save/reload and bounded layout at ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const h = await fixture(page);
  const canvas = page.getByTestId("floor-editor-canvas");
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().zoom)).toBeGreaterThan(0.05);
  const point = await canvas.evaluate(element => { const rect = element.getBoundingClientRect(), zoom = Number(element.getAttribute("data-zoom"));
    return { x: rect.x + Number(element.getAttribute("data-pan-x")) + 180 * zoom, y: rect.y + Number(element.getAttribute("data-pan-y")) + 140 * zoom }; });
  await page.mouse.click(point.x, point.y);
  await expect(canvas).toHaveAttribute("data-map-selection-count", "1");
  if (width < 1280) await page.getByRole("button", { name: "편집 정보 패널", exact: true }).click();
  await expect(page.getByLabel("도형 속성", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "도형 삭제", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().dirty)).toBe(true);
  await page.getByRole("button", { name: "실행 취소", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().elements.some(element => element.id === "imported"))).toBe(true);
  if (width < 1280) await page.getByRole("button", { name: "편집 정보 패널", exact: true }).click();
  if (width < 1280) await page.getByRole("button", { name: "도구 및 조명 패널", exact: true }).click();
  await page.getByRole("button", { name: "타원", exact: true }).click();
  const rect = await canvas.boundingBox(); if (!rect) throw new Error("No Canvas");
  await page.mouse.move(rect.x + rect.width * 0.45, rect.y + rect.height * 0.45);
  await page.mouse.down(); await page.mouse.move(rect.x + rect.width * 0.65, rect.y + rect.height * 0.6, { steps: 8 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().elements.some(element => element.type === "ellipse"))).toBe(true);
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(() => h.requests.length).toBe(1);
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().dirty)).toBe(false);
  await h.mount();
  await expect(canvas).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().state?.floor.mapRevision)).toBe(2);
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth,
    bodyHeight: document.documentElement.scrollHeight, viewport: innerHeight }));
  expect(layout.overflow).toBe(false); expect(layout.bodyHeight).toBeLessThanOrEqual(layout.viewport);
  expect(h.elements.size).toBe(2); expect(h.state().lightSlots).toHaveLength(1); expect(h.errors).toEqual([]);
  await page.screenshot({ path: info.outputPath(`editor-${width}.png`) });
});

test("actual measured large-document fit follows layout, not the transient first box", async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1179 });
  await fixture(page, { width: 16384, height: 13222 });
  await expect.poll(() => page.evaluate(() => {
    const { zoom, viewport } = window.editorSmoke.snapshot();
    return Math.abs(zoom - Math.min((viewport.width - 48) / 16384, (viewport.height - 48) / 13222));
  })).toBeLessThan(0.00001);
});

test("eight native tool drops, text property editing, and fixture placement persist together", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const h = await fixture(page), canvas = page.getByTestId("floor-editor-canvas");
  const tools = ["사각형", "삼각형", "선", "타원", "호", "연속선", "다각형", "텍스트"];
  for (const [index, name] of tools.entries()) {
    await page.getByRole("button", { name, exact: true }).dragTo(canvas, { targetPosition: { x: 180 + index * 35, y: 200 + index * 30 } });
    await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().elements.length)).toBe(index + 1);
  }
  await page.getByRole("textbox", { name: "텍스트", exact: true }).fill("공통 도형 ABC");
  await expect(page.getByRole("textbox", { name: "텍스트", exact: true })).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().elements.find(element => element.type === "text")?.geometry)).toMatchObject({ text: "공통 도형 ABC" });
  await page.getByTestId("placement-fixture-fixture").dragTo(canvas, { targetPosition: { x: 500, y: 550 } });
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().state?.fixtures[0].placementStatus)).toBe("placed");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(() => h.requests.length).toBe(1);
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().dirty)).toBe(false);
  expect(h.elements.size).toBe(9);
  expect(h.state().fixtures[0].placementStatus).toBe("placed");
  await h.mount();
  await expect(canvas).toHaveAttribute("data-map-ready", "true");
  await page.getByRole("tablist", { name: "배치 상태" }).getByRole("tab", { name: "배치", exact: true }).click();
  await page.getByTestId("placement-fixture-fixture").click();
  await page.getByRole("button", { name: "배치 해제", exact: true }).click();
  const confirmation = page.getByRole("dialog");
  await expect(confirmation).toBeVisible();
  expect(h.state().fixtures[0].placementStatus).toBe("placed");
  await confirmation.getByRole("button", { name: "배치 해제", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().state?.fixtures[0].placementStatus)).toBe("unplaced");
  await page.getByRole("button", { name: "실행 취소", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().state?.fixtures[0].placementStatus)).toBe("placed");
  expect(h.requests).toHaveLength(1);
  expect(h.state().lightSlots).toHaveLength(1);
  expect(h.errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("eight-tools-and-fixture.png") });
});
