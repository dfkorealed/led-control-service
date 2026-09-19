import { expect, test, type Page } from "@playwright/test";
import type { MapElement, MapGroup, MapLayer, MapOp } from "@led-control/shared/map-document-contracts";
import type { FloorEditorState } from "./editor-types";
import type { MapStage } from "../../api/map-stages";
import { getMapElementBounds } from "@led-control/shared/map-document-geometry";

declare global { interface Window { editorSmoke: ReturnType<typeof import("./floor-editor-smoke")["mountFloorEditorSmoke"]>;
  mountFloorEditorSmoke: typeof import("./floor-editor-smoke")["mountFloorEditorSmoke"] } }

async function fixture(page: Page, size = { width: 1200, height: 800 }, count = 1, loseCommitResponse = false) {
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
  const template = elements.get("imported")!;
  if (count > 1) {
    elements.clear();
    for (let i = 0; i < count; i++) elements.set(`bulk-${i}`, { ...template, id: `bulk-${i}`,
      geometry: { origin: { x: 100 + i % 50 * 12, y: 100 + Math.floor(i / 50) * 8 }, width: 6, height: 4 } } as MapElement);
    state.floor.mapDocument!.elementCount = count;
  }
  const stageRequests: Array<{ path: string; body: any }> = [];
  const stages = new Map<string, { receipt: MapStage; elements: Map<string, MapElement>; parts: Buffer[]; body: any; state: FloorEditorState }>();
  const history = new Map<number, { state: FloorEditorState; elements: Map<string, MapElement> }>();
  const capture = () => history.set(state.floor.mapRevision, { state: structuredClone(state), elements: new Map(elements) });
  capture();
  await page.route("**/api/floors/**", async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const stageId = path.match(/\/editor-stages\/([^/]+)/)?.[1];
    const stage = stageId ? stages.get(stageId) : undefined;
    if (path.includes("/editor-stages") && !path.includes("/map-document")) {
      const body = route.request().method() === "GET" ? null : route.request().postDataJSON();
      stageRequests.push({ path, body });
      if (path.endsWith("/editor-stages")) {
        capture();
        const id = `stage-${stages.size + 1}`, prior = body.historySource ? history.get(body.historySource.revision)! : null;
        const receipt: MapStage = { id, status: "preparing", generationId: state.floor.mapDocument!.generationId, baseRevision: state.floor.mapRevision,
          partCount: 0, decodedBytes: 0, expiresAt: "2099-01-01T00:00:00Z", errorCode: null, result: null };
        stages.set(id, { receipt, elements: new Map(prior?.elements ?? elements), parts: [], body, state: structuredClone(prior?.state ?? state) });
        return route.fulfill({ json: receipt });
      }
      if (!stage) return route.fulfill({ status: 404, json: {} });
      if (path.includes("/parts/")) {
        stage.parts[Number(path.split("/").at(-1))] = Buffer.from(body.data, "base64");
        stage.receipt.partCount = stage.parts.length; stage.receipt.decodedBytes = stage.parts.reduce((n, part) => n + part.length, 0);
      } else if (path.endsWith("/prepare")) {
        const operations: MapOp[] = stage.parts.length ? JSON.parse(Buffer.concat(stage.parts).toString("utf8")) : [];
        for (const op of operations) {
          if (op.kind === "delete") stage.elements.delete(op.id);
          else if (op.kind === "add" || op.kind === "update") stage.elements.set(op.element.id, op.element);
        }
        stage.state.fixtures = stage.state.fixtures.map(fixture => ({ ...fixture, ...stage.body.fixtureUpdates.find((patch: { id: string }) => patch.id === fixture.id) }));
        if (stage.body.floorPlan) stage.state.floor.floorPlan = { ...stage.body.floorPlan, version: 1 };
        stage.receipt.preview = { ...state.floor.mapDocument!, ...(stage.body.floorPlan ? { width: stage.body.floorPlan.width, height: stage.body.floorPlan.height, gridSize: stage.body.floorPlan.gridSize } : {}),
          generationId: stage.receipt.id, revision: state.floor.mapRevision + 1, elementCount: stage.elements.size };
        stage.receipt.status = "ready";
      } else if (path.endsWith("/commit")) {
        state = { ...stage.state, floor: { ...stage.state.floor, mapRevision: stage.receipt.preview!.revision, mapDocument: stage.receipt.preview! } };
        elements.clear(); stage.elements.forEach((value, id) => elements.set(id, value));
        stage.receipt.status = "committed"; stage.receipt.result = { ...state, history: { undo: { revision: stage.receipt.baseRevision }, redo: { revision: state.floor.mapRevision } } };
        capture();
        // Lose all three idempotent transport attempts; DELETE can still observe
        // the committed receipt when the user explicitly reconciles it.
        if (loseCommitResponse) return route.fulfill({ status: 503, json: { message: "Lost commit response" } });
      } else if (route.request().method() === "DELETE" && stage.receipt.status !== "committed") stage.receipt.status = "cancelled";
      return route.fulfill({ json: stage.receipt });
    }
    const document = stage?.receipt.preview ?? state.floor.mapDocument!;
    const canonical = stage?.elements ?? elements;
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
    if (path.endsWith("/manifest")) return route.fulfill({ json: { generationId: document.generationId, revision: document.revision, canonical: document.manifest,
      groups, layers, displayLayerBindings: [], display: { version: 2, sceneId, regionId: "manual", manifestAssetId: assetId,
        width: document.width, height: document.height, padding: 0, gridSize: document.gridSize, tileSize: 512, lodMode: "additive", primitiveCount: 0, tileCount: 0,
        byteSize: 1, sha256: hash, sourceBounds: { minX: 0, minY: 0, maxX: size.width, maxY: size.height },
        transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }, tiles: [] } } });
    if (path.endsWith("/changes")) {
      const offset = Number(url.searchParams.get("cursor") ?? 0), values = [...canonical.values()];
      return route.fulfill({ json: { generationId: document.generationId, revision: document.revision,
        operations: values.slice(offset, offset + 128).map(element => ({ kind: "add", element })), nextCursor: offset + 128 < values.length ? String(offset + 128) : null } });
    }
    if (path.endsWith("/elements")) {
      expect(route.request().postDataJSON().ids.length).toBeLessThanOrEqual(128);
      return route.fulfill({ json: route.request().postDataJSON().ids.flatMap((id: string) => canonical.has(id) ? [canonical.get(id)] : []) });
    }
    if (path.endsWith("/selection")) {
      const query = route.request().postDataJSON(), offset = Number(query.cursor ?? 0);
      expect(query.limit).toBeLessThanOrEqual(128);
      const ids = [...canonical.values()].filter(element => {
        const box = getMapElementBounds(element), range = query.bounds;
        return (!query.layerId || element.layerId === query.layerId) && (!query.groupId || element.groupId === query.groupId)
          && (!range || box.minX <= range.maxX && box.maxX >= range.minX && box.minY <= range.maxY && box.maxY >= range.minY);
      }).map(element => element.id);
      return route.fulfill({ json: { generationId: document.generationId, revision: document.revision, ids: ids.slice(offset, offset + 128), nextCursor: offset + 128 < ids.length ? String(offset + 128) : null } });
    }
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
  return { errors, requests, stageRequests, elements, layers, mount, state: () => state };
}

test("U10c R1: committed cancel updates host ACK and the next fixture draft", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const h = await fixture(page, { width: 1200, height: 800 }, 129, true), canvas = page.getByTestId("floor-editor-canvas");
  await page.getByRole("tab", { name: "레이어", exact: true }).click();
  await page.getByRole("button", { name: "Map", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-map-selection-count", "129");
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  await page.getByRole("button", { name: "도형 삭제", exact: true }).click();
  await expect(page.getByText("대량 편집 준비 완료 · 저장 대기", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "확대", exact: true }).click();
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(() => h.state().floor.mapRevision).toBe(2);
  const cancel = page.getByRole("button", { name: "대량 편집 취소", exact: true });
  await expect(cancel).toBeEnabled();
  const before = await page.evaluate(() => window.editorSmoke.snapshot());
  await cancel.click();
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().savedCount)).toBe(1);
  const after = await page.evaluate(() => window.editorSmoke.snapshot());
  expect(after.cachedRevision).toBe(2); expect(after.historyCount).toBe(before.historyCount);
  expect(after.zoom).toBe(before.zoom); expect(after.pan).toEqual(before.pan); expect(after.dirty).toBe(false);
  await page.getByTestId("placement-fixture-fixture").dragTo(canvas, { targetPosition: { x: 350, y: 300 } });
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().state?.fixtures[0].placementStatus)).toBe("placed");
  const draft = await page.evaluate(async () => {
    window.dispatchEvent(new Event("pagehide"));
    const path = "/src/features/floor-editor/editor-drafts.ts";
    const { loadEditorDraft, editorDraftGeneration } = await import(/* @vite-ignore */ path);
    return loadEditorDraft(`smoke-user:${editorDraftGeneration()}:admin`, window.editorSmoke.snapshot().state);
  });
  expect(draft?.fixtures[0].placementStatus).toBe("placed");
  const commits = h.stageRequests.filter(r => r.path.endsWith("/commit"));
  expect(commits).toHaveLength(3);
  expect(commits.every(r => JSON.stringify(r) === JSON.stringify(commits[0]))).toBe(true);
  expect(h.errors).toEqual([]);
});

test("U10c R2: shift pick retains the full streamed layer for deletion", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const h = await fixture(page, { width: 1200, height: 800 }, 129), canvas = page.getByTestId("floor-editor-canvas");
  h.layers.push({ id: "other", name: "Other", order: 1, visible: true, locked: false });
  h.elements.set("extra", { ...h.elements.get("bulk-0")!, id: "extra", layerId: "other",
    geometry: { origin: { x: 850, y: 150 }, width: 40, height: 40 } } as MapElement);
  h.state().floor.mapDocument!.elementCount = 130;
  await h.mount(); await expect(canvas).toHaveAttribute("data-map-ready", "true");
  await page.getByRole("tab", { name: "레이어", exact: true }).click();
  await page.getByRole("button", { name: "Map", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-map-selection-count", "129");
  const point = await canvas.evaluate(element => {
    const rect = element.getBoundingClientRect(), zoom = Number(element.getAttribute("data-zoom"));
    return { x: rect.x + Number(element.getAttribute("data-pan-x")) + 870 * zoom, y: rect.y + Number(element.getAttribute("data-pan-y")) + 170 * zoom };
  });
  await page.keyboard.down("Shift"); await page.mouse.click(point.x, point.y); await page.keyboard.up("Shift");
  await expect(canvas).toHaveAttribute("data-map-selection-count", "130");
  expect((await page.evaluate(() => window.editorSmoke.snapshot().selection)).elementIds).toEqual(["extra"]);
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  await page.getByRole("button", { name: "도형 삭제", exact: true }).click();
  await expect(page.getByText("대량 편집 준비 완료 · 저장 대기", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(() => h.elements.size).toBe(0);
  expect(h.errors).toEqual([]);
});

test("U10c: large layer delete uses private preview explicit save and external undo", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const h = await fixture(page, { width: 1200, height: 800 }, 2500), canvas = page.getByTestId("floor-editor-canvas");
  await page.getByRole("tab", { name: "레이어", exact: true }).click();
  await page.getByRole("button", { name: "Map", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-map-selection-count", "2500");
  await expect(canvas).toHaveAttribute("data-promoted-count", "0");
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  await page.getByRole("button", { name: "도형 삭제", exact: true }).click();
  await expect(page.getByText("대량 편집 준비 완료 · 저장 대기", { exact: true })).toBeVisible();
  expect(h.stageRequests.filter(request => request.path.endsWith("/commit"))).toHaveLength(0);
  expect(h.elements.size).toBe(2500);
  expect(await page.evaluate(() => window.editorSmoke.snapshot().state?.floor.mapRevision)).toBe(1);
  await expect(canvas).toHaveAttribute("data-map-ready", "true");
  await page.getByRole("button", { name: "대량 편집 취소", exact: true }).click();
  await expect(page.getByText("대량 편집 준비 완료 · 저장 대기", { exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().dirty)).toBe(false);
  expect(h.elements.size).toBe(2500);
  await page.getByRole("tab", { name: "레이어", exact: true }).click();
  await page.getByRole("button", { name: "Map", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-map-selection-count", "2500");
  await page.getByRole("tab", { name: "속성", exact: true }).click();
  await page.getByRole("button", { name: "도형 삭제", exact: true }).click();
  await expect(page.getByText("대량 편집 준비 완료 · 저장 대기", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(() => h.state().floor.mapRevision).toBe(2);
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().dirty)).toBe(false);
  expect(h.elements.size).toBe(0);
  await page.getByRole("button", { name: "실행 취소", exact: true }).click();
  await expect(page.getByText("대량 편집 준비 완료 · 저장 대기", { exact: true })).toBeVisible();
  expect(h.elements.size).toBe(0);
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(() => h.state().floor.mapRevision).toBe(3);
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().dirty)).toBe(false);
  expect(h.elements.size).toBe(2500);
  expect(h.requests).toHaveLength(0);
  expect(h.errors).toEqual([]);
});

test("U10c: mobile mixed marquee moves in one undo and selection fit stays bounded", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const h = await fixture(page, { width: 1200, height: 800 }, 65), canvas = page.getByTestId("floor-editor-canvas");
  h.state().fixtures[0] = { ...h.state().fixtures[0], placementStatus: "placed", x: 403, y: 207 };
  await h.mount(); await expect(canvas).toHaveAttribute("data-map-ready", "true");
  const point = (x: number, y: number) => canvas.evaluate((element, p) => {
    const rect = element.getBoundingClientRect(), zoom = Number(element.getAttribute("data-zoom"));
    return { x: rect.x + Number(element.getAttribute("data-pan-x")) + p.x * zoom, y: rect.y + Number(element.getAttribute("data-pan-y")) + p.y * zoom };
  }, { x, y });
  const a = await point(80, 80), b = await point(720, 230);
  await page.keyboard.down("Shift"); await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 5 }); await page.mouse.up(); await page.keyboard.up("Shift");
  await expect(canvas).toHaveAttribute("data-map-selection-count", "65");
  await page.getByRole("button", { name: "선택 맞춤", exact: true }).click();
  expect(await page.evaluate(() => window.editorSmoke.snapshot().zoom)).toBeGreaterThan(0.4);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().state?.fixtures[0].x)).toBe(413);
  expect(await page.evaluate(() => window.editorSmoke.snapshot().state?.fixtures[0].y)).toBe(207);
  expect(await page.evaluate(() => window.editorSmoke.snapshot().operations.filter(op => op.kind === "update").length)).toBe(65);
  await page.getByRole("button", { name: "실행 취소", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().operations.length)).toBe(0);
  expect(await page.evaluate(() => window.editorSmoke.snapshot().state?.fixtures[0].x)).toBe(403);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
  expect(h.errors).toEqual([]);
});

test("U10c: whole bbox resize transforms all 65 originals once", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const h = await fixture(page, { width: 1200, height: 800 }, 65), canvas = page.getByTestId("floor-editor-canvas");
  await page.getByRole("tab", { name: "레이어", exact: true }).click();
  await page.getByRole("button", { name: "Map", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-map-selection-count", "65");
  const point = (x: number, y: number) => canvas.evaluate((element, p) => {
    const rect = element.getBoundingClientRect(), zoom = Number(element.getAttribute("data-zoom"));
    return { x: rect.x + Number(element.getAttribute("data-pan-x")) + p.x * zoom, y: rect.y + Number(element.getAttribute("data-pan-y")) + p.y * zoom };
  }, { x, y });
  const start = await point(694, 112), end = await point(753.4, 113.2);
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 6 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().operations.filter(op => op.kind === "update").length)).toBe(65);
  const transforms = await page.evaluate(() => window.editorSmoke.snapshot().elements.map(element => element.transform));
  expect(transforms).toHaveLength(65);
  for (const transform of transforms) { expect(transform.scaleX).toBeCloseTo(1.1, 2); expect(transform.scaleY).toBeCloseTo(1.1, 2); }
  await page.getByRole("button", { name: "실행 취소", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().operations.length)).toBe(0);
  await expect(canvas).toHaveAttribute("data-map-selection-count", "65");
  const center = await point(397, 106), top = await point(397, 100);
  const startRotate = { x: top.x, y: top.y - 50 };
  const radius = center.y - startRotate.y;
  const endRotate = { x: center.x + radius * Math.sin(Math.PI / 12), y: center.y - radius * Math.cos(Math.PI / 12) };
  await page.mouse.move(startRotate.x, startRotate.y); await page.mouse.down(); await page.mouse.move(endRotate.x, endRotate.y, { steps: 8 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().operations.filter(op => op.kind === "update").length)).toBe(65);
  for (const transform of await page.evaluate(() => window.editorSmoke.snapshot().elements.map(element => element.transform))) expect(transform.rotation).toBeCloseTo(15, 0);
  expect(h.errors).toEqual([]);
});

test("U10c: map size checkpoint remains visible and saves through stage", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const h = await fixture(page), canvas = page.getByTestId("floor-editor-canvas");
  await page.getByLabel("맵 너비", { exact: true }).fill("1500");
  await page.getByRole("button", { name: "맵 설정 적용", exact: true }).click();
  await expect(canvas).toHaveAttribute("data-map-width", "1500");
  await expect(page.getByLabel("맵 너비", { exact: true })).toHaveValue("1,500");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(() => h.state().floor.mapRevision).toBe(2);
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().dirty)).toBe(false);
  expect(h.state().floor.mapDocument?.width).toBe(1500);
  expect(h.requests).toHaveLength(0);
  expect(h.errors).toEqual([]);
});

test('reviewer: normal save preserves undo and the user camera', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const h = await fixture(page), canvas = page.getByTestId('floor-editor-canvas');
  await page.getByRole('button', { name: '타원', exact: true }).dragTo(canvas, { targetPosition: { x: 300, y: 300 } });
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().elements.length)).toBe(1);
  await page.getByRole('button', { name: '확대', exact: true }).click();
  const before = await page.evaluate(() => ({ zoom: window.editorSmoke.snapshot().zoom, pan: window.editorSmoke.snapshot().pan }));
  await expect(page.getByRole('button', { name: '실행 취소', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(() => h.requests.length).toBe(1);
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().dirty)).toBe(false);
  await expect(page.getByRole('button', { name: '저장', exact: true })).toBeDisabled();
  await expect.soft(page.getByRole('button', { name: '실행 취소', exact: true })).toBeEnabled({ timeout: 2000 });
  const after = await page.evaluate(() => ({ zoom: window.editorSmoke.snapshot().zoom, pan: window.editorSmoke.snapshot().pan }));
  expect.soft(after).toEqual(before);
  expect(h.errors).toEqual([]);
});

test('reviewer: canceled drawing clears the common preview', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const h = await fixture(page), canvas = page.getByTestId('floor-editor-canvas');
  await page.getByRole('button', { name: '타원', exact: true }).click();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 300, box.y + 300);
  await page.mouse.down(); await page.mouse.move(box.x + 450, box.y + 400, { steps: 5 });
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().overlayCount)).toBe(1);
  await page.mouse.move(box.x - 10, box.y + 400); await page.mouse.up();
  expect(await page.evaluate(() => window.editorSmoke.snapshot().elements.length)).toBe(0);
  expect(await page.evaluate(() => window.editorSmoke.snapshot().overlayCount)).toBe(0);
  expect(h.errors).toEqual([]);
});

test('reviewer: 65-element bbox keeps all ids through move delete undo', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const h = await fixture(page), canvas = page.getByTestId('floor-editor-canvas');
  const template = h.elements.get('imported')!;
  h.elements.clear();
  for (let i = 0; i < 65; i++) h.elements.set(`box-${i}`, { ...template, id: `box-${i}`,
    geometry: { origin: { x: 100 + (i % 13) * 50, y: 100 + Math.floor(i / 13) * 50 }, width: 30, height: 30 } } as MapElement);
  h.state().floor.mapDocument!.elementCount = 65;
  await h.mount();
  await expect(canvas).toHaveAttribute('data-map-ready', 'true');
  const world = async (x: number, y: number) => canvas.evaluate((element, p) => {
    const b = element.getBoundingClientRect(), z = Number(element.getAttribute('data-zoom'));
    return { x: b.x + Number(element.getAttribute('data-pan-x')) + p.x * z,
      y: b.y + Number(element.getAttribute('data-pan-y')) + p.y * z };
  }, { x, y });
  const a = await world(80, 80), b = await world(760, 350);
  await page.keyboard.down('Shift'); await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 }); await page.mouse.up(); await page.keyboard.up('Shift');
  await expect(canvas).toHaveAttribute('data-map-selection-count', '65');
  await expect(canvas).toHaveAttribute('data-promoted-count', '0');
  const c = await world(140, 140), d = await world(180, 180);
  await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.mouse.move(d.x, d.y, { steps: 5 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().operations.filter(op => op.kind === 'update').length)).toBe(65);
  expect(await page.evaluate(() => window.editorSmoke.snapshot().elements.every(element => element.transform.x === 40 && element.transform.y === 40))).toBe(true);
  await page.keyboard.press('Delete');
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().operations.filter(op => op.kind === 'delete').length)).toBe(65);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(canvas).toHaveAttribute('data-map-selection-count', '65');
  expect(await page.evaluate(() => window.editorSmoke.snapshot().elements.length)).toBe(65);
  expect(h.state().lightSlots).toHaveLength(1);
  expect(h.errors).toEqual([]);
});

test('reviewer: polygon point completion and cancel use normal history', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const h = await fixture(page), canvas = page.getByTestId('floor-editor-canvas');
  await page.getByRole('button', { name: '다각형', exact: true }).click();
  const box = (await canvas.boundingBox())!;
  for (const [x, y] of [[350, 300], [500, 300], [450, 450]]) await page.mouse.click(box.x + x, box.y + y);
  await page.keyboard.press('Enter');
  await expect(canvas).toHaveAttribute('data-map-selection-count', '1');
  expect(await page.evaluate(() => window.editorSmoke.snapshot().elements[0].type)).toBe('polygon');
  await page.keyboard.press('Delete');
  expect(await page.evaluate(() => window.editorSmoke.snapshot().elements.length)).toBe(0);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.editorSmoke.snapshot().elements.length)).toBe(1);
  await page.getByRole('button', { name: '다각형', exact: true }).click();
  await page.mouse.click(box.x + 300, box.y + 300); await page.mouse.click(box.x + 400, box.y + 300);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.editorSmoke.snapshot().elements.length)).toBe(1);
  expect(h.errors).toEqual([]);
});

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
