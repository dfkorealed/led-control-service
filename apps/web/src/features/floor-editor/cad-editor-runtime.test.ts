import { describe, expect, it, vi } from "vitest";
import type { CadElementOverride, CadScenePrimitive, CadSceneTile } from "@led-control/shared";
import { buildCadGeometryBatches } from "../cad-scene/cad-scene-worker";
import type { DecodedCadSceneTile } from "../cad-scene/cad-scene-worker";
import { clipCadTextQuad } from "../cad-scene/CadSceneRenderer";
import {
  applyCadElementOverrides,
  createCadOverrideWorker,
  editorTransformToCadCamera,
  findCadEditableElement,
  mergeCadEditableElements,
  pickPersistedCadElement,
  resolveCadTileContentPath
} from "./cad-editor-runtime";

const descriptor: CadSceneTile = {
  version: 1,
  sceneId: "00000000-0000-4000-8000-000000000001",
  tileX: 2,
  tileY: 3,
  lod: 1,
  part: 4,
  assetId: "00000000-0000-4000-8000-000000000002",
  primitiveCount: 2,
  byteSize: 128,
  sha256: "0".repeat(64),
  bounds: { minX: 0, minY: 0, maxX: 512, maxY: 512 }
};

function decodedTile(): DecodedCadSceneTile {
  return {
    descriptor,
    byteSize: 128,
    batches: [{
      styleKey: JSON.stringify(["WALL", "stroke", "#111111", 1, 2]),
      layerName: "WALL",
      color: "#111111",
      opacity: 1,
      positions: new Float32Array([10, 10, 20, 10, 30, 30, 40, 30]),
      indices: new Uint32Array([0, 1, 1, 2, 3, 3]),
      spans: [
        { elementId: "cad-element-00000000000000000000000000000001", groupId: "group-1", indexStart: 0, indexCount: 3 },
        { elementId: "cad-element-00000000000000000000000000000002", groupId: null, indexStart: 3, indexCount: 3 }
      ]
    }],
    textBatches: [],
    pickEntries: [
      {
        elementId: "cad-element-00000000000000000000000000000001",
        groupId: "group-1",
        layerName: "WALL",
        bounds: { minX: 10, minY: 10, maxX: 20, maxY: 20 },
        zOrder: 1,
        pointStart: 0,
        pointCount: 2,
        closed: false,
        filled: false,
        strokeWidth: 2
      },
      {
        elementId: "cad-element-00000000000000000000000000000002",
        groupId: null,
        layerName: "WALL",
        bounds: { minX: 30, minY: 30, maxX: 40, maxY: 40 },
        zOrder: 2,
        pointStart: 2,
        pointCount: 2,
        closed: false,
        filled: false,
        strokeWidth: 2
      }
    ],
    pickPoints: new Float32Array([10, 10, 20, 10, 30, 30, 40, 30]),
    spatialIndex: { cellSize: 64, buckets: { "0:0": new Uint32Array([0, 1]) } },
    memory: { cpuBytes: 1024, gpuBytes: 1024, textAtlasBytes: 0 }
  };
}

function nativeTile(primitives: CadScenePrimitive[], bounds = descriptor.bounds): DecodedCadSceneTile {
  return {
    ...buildCadGeometryBatches(primitives),
    descriptor: { ...descriptor, bounds, primitiveCount: primitives.length },
    byteSize: 128
  };
}

function nativeRectangle(): CadScenePrimitive {
  return {
    elementId: descriptorElementId(), groupId: "group-1", layerName: "WALL", sourceType: "LWPOLYLINE",
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, clipBounds: null,
    style: { strokeColor: "#111111", fillColor: null, strokeWidth: 2, opacity: 0.5 },
    type: "rectangle", geometry: { origin: { x: 0, y: 0 }, width: 10, height: 10, rotation: 0 }
  };
}

function elementOverride(patch: Partial<CadElementOverride>): Map<string, CadElementOverride> {
  return new Map([[descriptorElementId(), {
    elementId: descriptorElementId(), hidden: false, transform: null,
    strokeColor: null, fillColor: null, strokeWidth: null, text: null, ...patch
  }]]);
}

describe("CAD editor runtime", () => {
  it("forwards display quality and overrides before metadata is removed, without promoting display geometry", async () => {
    const quality = { zoomBand: 0.125, maxErrorPixels: 0.5, excludedIds: [descriptorElementId()] };
    const decoded = { ...decodedTile(), ...buildCadGeometryBatches([nativeRectangle()], quality) };
    const worker = { decode: vi.fn(async () => decoded), destroy: vi.fn() };
    const overrides = elementOverride({ strokeColor: "#ff0000", strokeWidth: 4 });
    const onDecoded = vi.fn();
    const wrapped = createCadOverrideWorker(worker, () => overrides, onDecoded);
    const payload = new Uint8Array();
    expect(await wrapped.decode(payload, descriptor, quality)).toBe(decoded);
    expect(worker.decode).toHaveBeenCalledWith(payload, descriptor, { ...quality, overrides: [...overrides.values()] });
    expect(onDecoded).not.toHaveBeenCalled();
    expect(decoded.pickEntries).toHaveLength(0);
  });

  it("remembers exact source geometry before applying overrides for editable elements", async () => {
    const decoded = nativeTile([nativeRectangle()]);
    const worker = { decode: vi.fn(async () => decoded), destroy: vi.fn() };
    const onDecoded = vi.fn();
    const wrapped = createCadOverrideWorker(worker, () => elementOverride({ strokeColor: "#ff0000", strokeWidth: 4 }), onDecoded);
    const payload = new Uint8Array();
    const result = await wrapped.decode(payload, descriptor);
    expect(worker.decode).toHaveBeenCalledWith(payload, descriptor);
    expect(onDecoded).toHaveBeenCalledWith(decoded);
    expect(result.batches[0].color).toBe("#ff0000");
    expect(decoded.batches[0].color).toBe("#111111");
  });

  it("returns raw exact source for promotion instead of applying an existing transform twice", async () => {
    const decoded = nativeTile([nativeRectangle()]);
    const worker = { decode: vi.fn(async () => decoded), destroy: vi.fn() };
    const onDecoded = vi.fn();
    const wrapped = createCadOverrideWorker(worker, () => elementOverride({
      strokeColor: "#ff0000", strokeWidth: 4,
      transform: { translateX: 100, translateY: 200, scaleX: 2, scaleY: 1, rotation: 90 }
    }), onDecoded);
    const source = await wrapped.decodeSource!(new Uint8Array(), descriptor);
    expect(source).toBe(decoded);
    expect([...source.pickPoints]).toEqual([0, 0, 10, 0, 10, 10, 0, 10]);
    expect(source.batches[0].color).toBe("#111111");
    expect(onDecoded).toHaveBeenCalledWith(decoded);
  });

  it("keeps every same-ID polyline fragment when applying color and stroke width", () => {
    const base = nativeRectangle();
    const primitives: CadScenePrimitive[] = [
      { ...base, type: "polyline", geometry: { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], closed: false } },
      { ...base, type: "polyline", geometry: { points: [{ x: 10, y: 0 }, { x: 10, y: 10 }], closed: false } }
    ];
    const tile = nativeTile(primitives);
    const result = applyCadElementOverrides(tile, elementOverride({ strokeColor: "#ff0000", strokeWidth: 2 }));
    expect([...result.batches[0].positions]).toEqual([0, 1, 0, -1, 10, -1, 10, 1, 9, 0, 11, 0, 11, 10, 9, 10]);
    expect(result.batches[0].spans.map(span => span.indexCount)).toEqual([6, 6]);
    expect(result.batches[0].color).toBe("#ff0000");
    expect(result.pickEntries).toHaveLength(2);
    expect(primitives[0].type).toBe("polyline");
    expect(tile.batches[0].color).toBe("#111111");
  });

  it("creates a newly enabled fill, clips it to its tile, and marks the interior pickable", () => {
    const bounds = { minX: 0, minY: 0, maxX: 5, maxY: 10 };
    const primitive = { ...nativeRectangle(), bounds, clipBounds: bounds };
    const tile = nativeTile([primitive], bounds);
    const result = applyCadElementOverrides(tile, elementOverride({ fillColor: "#ff0000" }));
    const fill = result.batches.find(batch => JSON.parse(batch.styleKey)[1] === "fill");
    expect(fill).toBeDefined();
    expect(fill!.color).toBe("#ff0000");
    expect(fill!.opacity).toBe(0.5);
    expect(fill!.indices).toHaveLength(6);
    expect(Math.min(...fill!.positions)).toBe(0);
    expect(Math.max(...fill!.positions.filter((_, index) => index % 2 === 0))).toBe(5);
    expect(result.pickEntries[0].filled).toBe(true);
    expect(tile.pickEntries[0].filled).toBe(false);
    expect(primitive.type).toBe("rectangle");
    expect(primitive.style.fillColor).toBeNull();
  });

  it("clips rebuilt strokes before transforming without inventing a tile-boundary edge", () => {
    const bounds = { minX: 0, minY: 0, maxX: 5, maxY: 10 };
    const primitive = { ...nativeRectangle(), bounds, clipBounds: bounds };
    const result = applyCadElementOverrides(nativeTile([primitive], bounds), elementOverride({
      strokeWidth: 4,
      transform: { translateX: 20, translateY: 30, scaleX: 1, scaleY: 1, rotation: 90 }
    }));
    const stroke = result.batches[0];
    expect(stroke.indices).toHaveLength(18);
    expect(Math.min(...stroke.positions.filter((_, index) => index % 2 === 0))).toBe(8);
    expect(Math.max(...stroke.positions.filter((_, index) => index % 2 === 0))).toBe(22);
    expect(Math.max(...stroke.positions.filter((_, index) => index % 2 === 1))).toBe(35);
  });

  it.each([null, "#111111"])("creates a newly enabled stroke from absent/zero-width source %s", strokeColor => {
    const primitive = nativeRectangle();
    primitive.style = { ...primitive.style, fillColor: "#00ff00", strokeColor, strokeWidth: 0 };
    const result = applyCadElementOverrides(nativeTile([primitive]), elementOverride({ strokeColor: "#ff0000", strokeWidth: 4 }));
    const stroke = result.batches.find(batch => JSON.parse(batch.styleKey)[1] === "stroke");
    expect(stroke).toBeDefined();
    expect(stroke!.indices).toHaveLength(24);
    expect(stroke!.color).toBe("#ff0000");
    expect(stroke!.opacity).toBe(0.5);
    expect(result.pickEntries[0].strokeWidth).toBe(4);
  });

  it("keeps fill editing available when a closed native shape spans multiple tiles", () => {
    const primitive = nativeRectangle();
    const left = nativeTile([primitive]);
    const right = nativeTile([primitive]);
    right.descriptor = { ...right.descriptor, tileX: 3 };
    const element = findCadEditableElement([left, right], descriptorElementId(), new Map())!;
    expect(element.fragments).toHaveLength(2);
    expect(element.closed).toBe(true);
  });

  it("keeps all-closed merged fragments fillable without closing mixed open fragments", () => {
    const first = findCadEditableElement([nativeTile([nativeRectangle()])], descriptorElementId(), new Map())!;
    const primitive = nativeRectangle();
    const second = findCadEditableElement([nativeTile([{
      ...primitive, type: "triangle", geometry: { points: [{ x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }] }
    }])], descriptorElementId(), new Map())!;
    const merged = mergeCadEditableElements(first, second);
    expect(merged.fragments).toHaveLength(2);
    expect(merged.closed).toBe(true);
    expect(mergeCadEditableElements(first, { ...second, fragments: second.fragments.map(fragment => ({ ...fragment, closed: false })) }).closed).toBe(false);
  });

  it.each([0, 90])("moves clipped text and its clipping bounds together at %i degrees", rotation => {
    const tile = decodedTile();
    const elementId = tile.pickEntries[0].elementId;
    tile.batches = [];
    tile.pickEntries = [{ ...tile.pickEntries[0], pointCount: 0,
      bounds: { minX: 500, minY: 80, maxX: 512, maxY: 100 } }];
    tile.pickPoints = new Float32Array();
    tile.textBatches = [{
      styleKey: "text", layerName: "WALL", color: "#123456", opacity: 1,
      entries: [{ elementId, groupId: null, text: "edge", position: { x: 500, y: 100 },
        width: 24, height: 20, rotation: 0, fontSize: 16,
        bounds: tile.pickEntries[0].bounds,
        clipBounds: { minX: 0, minY: 0, maxX: 512, maxY: 512 } }]
    }];
    const override: CadElementOverride = {
      elementId, hidden: false,
      transform: { translateX: 2500, translateY: 2500, scaleX: 2, scaleY: 1, rotation },
      strokeColor: null, fillColor: null, strokeWidth: null, text: null
    };
    const text = applyCadElementOverrides(tile, new Map([[elementId, override]])).textBatches[0].entries[0];
    expect(text.clipBounds).toEqual(rotation === 0
      ? { minX: 2500, minY: 2500, maxX: 3524, maxY: 3012 }
      : { minX: 1988, minY: 2500, maxX: 2500, maxY: 3524 });
    const vertices = clipCadTextQuad(text);
    expect(vertices).toHaveLength(4);
    expect(Math.max(...vertices.map(vertex => vertex.u))).toBeCloseTo(0.5);
    expect(Math.min(...vertices.map(vertex => vertex.u))).toBeCloseTo(0);
    expect(tile.textBatches[0].entries[0].clipBounds).toEqual({ minX: 0, minY: 0, maxX: 512, maxY: 512 });

    tile.textBatches[0].entries[0].clipBounds = null;
    expect(applyCadElementOverrides(tile, new Map([[elementId, override]])).textBatches[0].entries[0].clipBounds).toBeNull();
  });

  it("converts the shared editor pan and zoom to the exact Pixi camera", () => {
    expect(editorTransformToCadCamera({ x: -100, y: -50 }, 2, { width: 800, height: 600 }))
      .toEqual({ centerX: 250, centerY: 175, zoom: 2, viewportWidth: 800, viewportHeight: 600 });
  });

  it("resolves a descriptor into the authenticated tile content path", () => {
    expect(resolveCadTileContentPath(
      "/floors/f/scene/tiles/{lod}/{tileX}/{tileY}/{part}/content",
      descriptor
    )).toBe("/floors/f/scene/tiles/1/2/3/4/content");
  });

  it("resolves only the picked element and its exact evidence locator", () => {
    const element = findCadEditableElement(
      [decodedTile()],
      "cad-element-00000000000000000000000000000001",
      new Map()
    );

    expect(element).toMatchObject({
      elementId: "cad-element-00000000000000000000000000000001",
      groupId: "group-1",
      layerName: "WALL",
      locator: { tileX: 2, tileY: 3, lod: 1, part: 4 },
      points: [{ x: 10, y: 10 }, { x: 20, y: 10 }],
      fragments: [{ points: [{ x: 10, y: 10 }, { x: 20, y: 10 }], closed: false }],
      strokeColor: "#111111",
      strokeWidth: 2
    });
  });

  it("unions every visible tile fragment while retaining the representative evidence locator", () => {
    const second = decodedTile();
    second.descriptor = {
      ...descriptor,
      tileX: 3,
      part: 0,
      bounds: { minX: 512, minY: 0, maxX: 1024, maxY: 512 }
    };
    second.pickEntries = [{
      ...second.pickEntries[0],
      bounds: { minX: 512, minY: 10, maxX: 540, maxY: 20 },
      pointStart: 0,
      pointCount: 2
    }];
    second.pickPoints = new Float32Array([512, 10, 540, 10]);
    second.batches[0] = {
      ...second.batches[0],
      positions: new Float32Array([512, 10, 540, 10]),
      indices: new Uint32Array([0, 1]),
      spans: [{
        elementId: "cad-element-00000000000000000000000000000001",
        groupId: "group-1",
        indexStart: 0,
        indexCount: 2
      }]
    };

    const element = findCadEditableElement(
      [second, decodedTile()],
      "cad-element-00000000000000000000000000000001",
      new Map(),
      { tileX: 2, tileY: 3, lod: 1, part: 4 }
    );

    expect(element).toMatchObject({
      locator: { tileX: 2, tileY: 3, lod: 1, part: 4 },
      bounds: { minX: 10, minY: 10, maxX: 540, maxY: 20 }
    });
    expect(element?.fragments).toHaveLength(2);
  });

  it("preserves rotated text origin, box, rotation and bounds for promotion", () => {
    const tile = decodedTile();
    tile.batches = [];
    tile.pickEntries = [{
      ...tile.pickEntries[0],
      bounds: { minX: 100, minY: 150, maxX: 180, maxY: 220 },
      pointCount: 0
    }];
    tile.pickPoints = new Float32Array();
    tile.textBatches = [{
      styleKey: JSON.stringify(["TEXT", "text", "#123456", 1]),
      layerName: "TEXT",
      color: "#123456",
      opacity: 1,
      entries: [{
        elementId: tile.pickEntries[0].elementId,
        groupId: "group-1",
        text: "B2",
        position: { x: 120, y: 210 },
        width: 80,
        height: 20,
        rotation: 30,
        fontSize: 16,
        bounds: { minX: 100, minY: 150, maxX: 180, maxY: 220 },
        clipBounds: null
      }]
    }];

    expect(findCadEditableElement([tile], tile.pickEntries[0].elementId, new Map())?.textGeometry).toEqual({
      position: { x: 120, y: 210 },
      width: 80,
      height: 20,
      rotation: 30,
      bounds: { minX: 100, minY: 150, maxX: 180, maxY: 220 }
    });
  });

  it("rebatches transform, color, and hidden overrides without creating scene nodes", () => {
    const overrides = new Map<string, CadElementOverride>([
      ["cad-element-00000000000000000000000000000001", {
        elementId: "cad-element-00000000000000000000000000000001",
        hidden: false,
        transform: { translateX: 10, translateY: 5, scaleX: 2, scaleY: 1, rotation: 90 },
        strokeColor: "#ff0000",
        fillColor: null,
        strokeWidth: null,
        text: null
      }],
      ["cad-element-00000000000000000000000000000002", {
        elementId: "cad-element-00000000000000000000000000000002",
        hidden: true,
        transform: null,
        strokeColor: null,
        fillColor: null,
        strokeWidth: null,
        text: null
      }]
    ]);

    const transformed = applyCadElementOverrides(decodedTile(), overrides);

    expect(transformed.batches).toHaveLength(1);
    expect(transformed.batches[0]).toMatchObject({ color: "#ff0000", layerName: "WALL" });
    expect([...transformed.batches[0].positions]).toEqual([0, 25, 0, 45]);
    expect(transformed.pickEntries).toHaveLength(1);
    expect([...transformed.pickPoints]).toEqual([0, 25, 0, 45]);
  });

  it("rebuilds stroke mesh geometry when strokeWidth is overridden", () => {
    const overrides = new Map<string, CadElementOverride>([[
      "cad-element-00000000000000000000000000000001",
      {
        elementId: "cad-element-00000000000000000000000000000001",
        hidden: false,
        transform: null,
        strokeColor: null,
        fillColor: null,
        strokeWidth: 10,
        text: null
      }
    ]]);

    const transformed = applyCadElementOverrides(decodedTile(), overrides);
    const firstSpan = transformed.batches.flatMap((batch) => batch.spans)
      .find((span) => span.elementId === "cad-element-00000000000000000000000000000001")!;
    const batch = transformed.batches.find((candidate) => candidate.spans.includes(firstSpan))!;

    expect([...batch.positions]).toEqual([10, 15, 10, 5, 20, 5, 20, 15]);
    expect([...batch.indices]).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it("picks a moved persisted override at its destination independently of its source tile", () => {
    const element = findCadEditableElement([decodedTile()], descriptorElementId(), new Map())!;
    element.override = {
      elementId: element.elementId,
      hidden: false,
      transform: { translateX: 500, translateY: 300, scaleX: 1, scaleY: 1, rotation: 0 },
      strokeColor: null,
      fillColor: null,
      strokeWidth: null,
      text: null
    };

    expect(pickPersistedCadElement([element], { x: 515, y: 310 }, 8)).toBe(element);
    expect(pickPersistedCadElement([element], { x: 15, y: 10 }, 8)).toBeNull();
  });

  it("uses exact moved geometry, layer visibility, and z-order after the AABB coarse check", () => {
    const low = findCadEditableElement([decodedTile()], descriptorElementId(), new Map())!;
    low.override = {
      elementId: low.elementId,
      hidden: false,
      transform: { translateX: 500, translateY: 300, scaleX: 1, scaleY: 1, rotation: 0 },
      strokeColor: null,
      fillColor: null,
      strokeWidth: null,
      text: null
    };
    const high = {
      ...low,
      elementId: "cad-element-00000000000000000000000000000002",
      zOrder: low.zOrder + 10,
      override: { ...low.override, elementId: "cad-element-00000000000000000000000000000002" }
    };

    expect(pickPersistedCadElement([high, low], { x: 515, y: 318 }, 2)).toBeNull();
    expect(pickPersistedCadElement([low, high], { x: 515, y: 310 }, 2)).toBe(high);
    expect(pickPersistedCadElement([low, high], { x: 515, y: 310 }, 2, () => false)).toBeNull();
    high.override = { ...high.override!, hidden: true };
    expect(pickPersistedCadElement([low, high], { x: 515, y: 310 }, 2)).toBe(low);
  });
});

function descriptorElementId() {
  return "cad-element-00000000000000000000000000000001";
}
