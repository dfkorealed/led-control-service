import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  CAD_SCENE_MAX_POINTS_PER_PRIMITIVE,
  CAD_SCENE_MAX_TILE_BYTE_SIZE,
  CAD_SCENE_TILE_SIZE,
  cadSceneManifestSchema,
  type CadScenePrimitive
} from "@led-control/shared";
import type { CadDetectedRegion } from "./cad-region-detector";
import { buildCadScene, type BuiltCadScene } from "./cad-scene-builder";
import { decodeCadSceneTile } from "./cad-scene-codec";
import type { CadPoint, NormalizedCadDocument, NormalizedCadEntity } from "./cad-types";

const sceneId = "00000000-0000-4000-8000-000000000101";
const point = (x: number, y: number): CadPoint => ({ x, y, z: 0 });
const vertex = (x: number, y: number, bulge = 0) => ({ ...point(x, y), bulge });

function document(entities: NormalizedCadEntity[], blocks: NormalizedCadDocument["blocks"] = []): NormalizedCadDocument {
  return {
    version: 1,
    bounds: { minX: 0, minY: 0, maxX: 2_000, maxY: 2_000 },
    blocks,
    entities
  };
}

function region(bounds = { minX: 0, minY: 0, maxX: 1_000, maxY: 1_000 }): CadDetectedRegion {
  return {
    regionId: "region-main",
    bounds,
    primitiveCount: 1,
    textCount: 0,
    lightCandidateCount: 0,
    area: (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY)
  };
}

function decodedOccurrences(scene: BuiltCadScene): Array<{
  primitive: CadScenePrimitive;
  lod: number;
  tileX: number;
  tileY: number;
}> {
  return scene.tiles.flatMap(tile => decodeCadSceneTile(tile.payload, tile.descriptor).map(primitive => ({
    primitive,
    lod: tile.descriptor.lod,
    tileX: tile.descriptor.tileX,
    tileY: tile.descriptor.tileY
  })));
}

function uniquePrimitives(scene: BuiltCadScene): CadScenePrimitive[] {
  return [...new Map(decodedOccurrences(scene).map(({ primitive }) => [primitive.elementId, primitive])).values()];
}

function unionBounds(primitives: readonly CadScenePrimitive[]) {
  return primitives.reduce((bounds, primitive) => ({
    minX: Math.min(bounds.minX, primitive.bounds.minX),
    minY: Math.min(bounds.minY, primitive.bounds.minY),
    maxX: Math.max(bounds.maxX, primitive.bounds.maxX),
    maxY: Math.max(bounds.maxY, primitive.bounds.maxY)
  }), {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY
  });
}

describe("CAD scene builder", () => {
  it("retains the existing display-only duplicate limit while canonical hooks count every source", () => {
    const input = document(["A", "B"].map(sourceEntityId => ({ type: "line", sourceEntityId, layer: "0", start: point(1, 1), end: point(2, 2) })));
    expect(buildCadScene(input, region(), { sceneId, maxSelectedPrimitives: 1 }).manifest.primitiveCount).toBe(1);
    expect(() => buildCadScene(input, region(), { sceneId, maxSelectedPrimitives: 1, onSemanticEntity: () => {} })).toThrow(/limit/);
  });

  it("does not change curved or classified display geometry when the semantic hook is enabled", () => {
    const input = document([
      { type: "lwpolyline", sourceEntityId: "bulge", layer: "0", closed: false, vertices: [vertex(100, 100, 1), vertex(200, 100)] },
      { type: "lwpolyline", sourceEntityId: "box", layer: "0", closed: true, vertices: [vertex(300, 300), vertex(350, 300), vertex(400, 300), vertex(400, 400), vertex(300, 400)] }
    ]);
    const without = buildCadScene(input, region(), { sceneId, simplifyTolerance: 100 });
    const withHook = buildCadScene(input, region(), { sceneId, simplifyTolerance: 100, onSemanticEntity: () => {} });
    expect(withHook.manifest.sha256).toBe(without.manifest.sha256);
    expect(withHook.tiles.map(tile => tile.descriptor.sha256)).toEqual(without.tiles.map(tile => tile.descriptor.sha256));
  });

  it("normalizes selected LINE, polyline, circle, arc, text, spline, and hatch boundaries into native primitives", () => {
    const input = document([
      { type: "line", sourceEntityId: "line", layer: "WALL", start: point(10, 10), end: point(20, 20) },
      {
        type: "lwpolyline", sourceEntityId: "open", layer: "PATH", closed: false,
        vertices: [vertex(30, 10), vertex(35, 15), vertex(40, 10)]
      },
      {
        type: "lwpolyline", sourceEntityId: "rectangle", layer: "WALL", closed: true,
        vertices: [vertex(50, 10), vertex(70, 10), vertex(70, 20), vertex(50, 20)]
      },
      {
        type: "polyline", sourceEntityId: "triangle", layer: "SYMBOL", closed: true,
        vertices: [vertex(80, 20), vertex(90, 10), vertex(100, 20)]
      },
      { type: "circle", sourceEntityId: "circle", layer: "SYMBOL", center: point(120, 20), radius: 10 },
      {
        type: "arc", sourceEntityId: "arc", layer: "DOOR", center: point(150, 20), radius: 10,
        startAngle: 0, endAngle: 90
      },
      {
        type: "mtext", sourceEntityId: "text", layer: "NOTE", position: point(180, 20),
        rotation: 15, height: 8, text: "B1 주차장"
      },
      {
        type: "spline", sourceEntityId: "spline", layer: "CURVE", degree: 2, closed: false,
        knots: [0, 0, 0, 1, 1, 1], weights: [],
        controlPoints: [point(220, 10), point(230, 30), point(240, 10)]
      },
      {
        type: "hatch", sourceEntityId: "hatch", layer: "FILL", loops: [
          {
            type: "polyline", closed: true,
            vertices: [vertex(260, 10), vertex(280, 10), vertex(280, 30), vertex(260, 30)]
          },
          {
            type: "edges",
            edges: [
              { type: "line", start: point(265, 15), end: point(275, 15) },
              {
                type: "arc", center: point(275, 20), radius: 5,
                startAngle: 270, endAngle: 90, counterClockwise: true
              },
              { type: "line", start: point(275, 25), end: point(265, 25) }
            ]
          }
        ]
      },
      { type: "line", sourceEntityId: "remote", layer: "WALL", start: point(1_500, 1_500), end: point(1_510, 1_510) }
    ]);

    const scene = buildCadScene(input, region(), { sceneId });
    const primitives = uniquePrimitives(scene);

    expect(scene.manifest.transform).toEqual({
      scaleX: 15.728,
      scaleY: -15.728,
      translateX: 328,
      translateY: 16_056
    });
    expect(scene.manifest).toMatchObject({
      version: 1,
      sceneId,
      regionId: "region-main",
      width: 16_384,
      height: 16_384,
      padding: 328,
      tileSize: CAD_SCENE_TILE_SIZE,
      primitiveCount: 10
    });
    expect(cadSceneManifestSchema.parse(scene.manifest)).toEqual(scene.manifest);
    expect(scene.manifest.byteSize).toBe(scene.manifestPayload.byteLength);
    expect(scene.manifest.sha256).toBe(createHash("sha256").update(scene.manifestPayload).digest("hex"));
    expect(new Set(decodedOccurrences(scene).map(({ primitive }) => primitive.elementId)).size)
      .toBe(scene.manifest.primitiveCount);
    expect(primitives.map(primitive => primitive.type).sort()).toEqual([
      "arc", "ellipse", "line", "polyline", "polyline", "polyline", "polyline",
      "rectangle", "text", "triangle"
    ]);
    expect(primitives.some(primitive => primitive.sourceType === "LINE" && primitive.layerName === "WALL")).toBe(true);
    expect(primitives.some(primitive => primitive.sourceType === "LINE" && primitive.bounds.minX > scene.manifest.width)).toBe(false);
    expect(primitives.find(primitive => primitive.sourceType === "SPLINE")).toMatchObject({
      type: "polyline",
      geometry: { closed: false, points: expect.arrayContaining([expect.objectContaining({ x: expect.any(Number) })]) }
    });
    expect(primitives.filter(primitive => primitive.sourceType === "HATCH")).toHaveLength(2);
    expect(primitives.find(primitive => primitive.type === "text")).toMatchObject({
      geometry: { text: "B1 주차장", fontSize: expect.any(Number), width: expect.any(Number) }
    });

    const lodBySourceType = new Map<string, Set<number>>();
    decodedOccurrences(scene).forEach(({ primitive, lod }) => {
      const levels = lodBySourceType.get(primitive.sourceType) ?? new Set<number>();
      levels.add(lod);
      lodBySourceType.set(primitive.sourceType, levels);
    });
    expect([...lodBySourceType.get("LINE")!]).toEqual([0]);
    expect([...lodBySourceType.get("SPLINE")!]).toEqual([1]);
    expect([...lodBySourceType.get("HATCH")!]).toEqual([2]);
  });

  it("keeps occurrence element and group IDs stable while distinguishing repeated block inserts", () => {
    const blocks: NormalizedCadDocument["blocks"] = [{
      name: "FIXTURE",
      basePoint: point(0, 0),
      entities: [{ type: "line", sourceEntityId: "child", layer: "0", start: point(0, 0), end: point(2, 2) }]
    }];
    const input = document([
      {
        type: "insert", sourceEntityId: "insert-a", layer: "LIGHTING", blockName: "FIXTURE",
        position: point(100, 100), rotation: 0, scale: { x: 1, y: 1, z: 1 }, attributes: []
      },
      {
        type: "insert", sourceEntityId: "insert-b", layer: "LIGHTING", blockName: "FIXTURE",
        position: point(200, 100), rotation: 0, scale: { x: 1, y: 1, z: 1 }, attributes: []
      }
    ], blocks);

    const first = buildCadScene(input, region(), { sceneId });
    const second = buildCadScene(input, region(), { sceneId });
    const firstPrimitives = uniquePrimitives(first).sort((left, right) => left.elementId.localeCompare(right.elementId));
    const secondPrimitives = uniquePrimitives(second).sort((left, right) => left.elementId.localeCompare(right.elementId));

    expect(firstPrimitives).toHaveLength(2);
    expect(firstPrimitives.map(primitive => primitive.elementId)).toEqual(secondPrimitives.map(primitive => primitive.elementId));
    expect(new Set(firstPrimitives.map(primitive => primitive.elementId)).size).toBe(2);
    expect(firstPrimitives.every(primitive => primitive.groupId !== null)).toBe(true);
    expect(new Set(firstPrimitives.map(primitive => primitive.groupId)).size).toBe(2);
    expect(first.tiles.map(tile => tile.payload.toString("hex")))
      .toEqual(second.tiles.map(tile => tile.payload.toString("hex")));
  });

  it("includes the canonical occurrence transform in editing identities", () => {
    const blocks: NormalizedCadDocument["blocks"] = [{
      name: "FIXTURE", basePoint: point(0, 0),
      entities: [{ type: "line", sourceEntityId: "child", layer: "0", start: point(0, 0), end: point(2, 2) }]
    }];
    const buildAt = (x: number) => buildCadScene(document([{
      type: "insert", sourceEntityId: "insert-a", layer: "LIGHTING", blockName: "FIXTURE",
      position: point(x, 100), rotation: 0, scale: { x: 1, y: 1, z: 1 }, attributes: []
    }], blocks), region(), { sceneId });

    expect(uniquePrimitives(buildAt(100))[0].elementId)
      .not.toBe(uniquePrimitives(buildAt(101))[0].elementId);
    expect(uniquePrimitives(buildAt(100))[0].groupId)
      .not.toBe(uniquePrimitives(buildAt(101))[0].groupId);
  });

  it("counts a unique crossing line once while streaming every tile occurrence", () => {
    const scene = buildCadScene(document([
      {
        type: "line", sourceEntityId: "crossing", layer: "GRID",
        start: point(0, 500), end: point(1_000, 500)
      },
      {
        type: "line", sourceEntityId: "crossing-reversed", layer: "GRID",
        start: point(1_000, 500), end: point(0, 500)
      }
    ]), region(), { sceneId });
    const occurrences = decodedOccurrences(scene);
    const ids = new Set(occurrences.map(({ primitive }) => primitive.elementId));

    expect(scene.manifest.primitiveCount).toBe(1);
    expect(ids.size).toBe(1);
    expect(new Set(occurrences.map(value => value.tileX)).size).toBeGreaterThan(1);
    for (const { primitive, tileX, tileY } of occurrences) {
      expect(primitive.clipBounds).toEqual({
        minX: tileX * CAD_SCENE_TILE_SIZE,
        minY: tileY * CAD_SCENE_TILE_SIZE,
        maxX: Math.min(scene.manifest.width, (tileX + 1) * CAD_SCENE_TILE_SIZE),
        maxY: Math.min(scene.manifest.height, (tileY + 1) * CAD_SCENE_TILE_SIZE)
      });
      expect(primitive.bounds.minX).toBeGreaterThanOrEqual(tileX * CAD_SCENE_TILE_SIZE);
      expect(primitive.bounds.maxX).toBeLessThanOrEqual((tileX + 1) * CAD_SCENE_TILE_SIZE);
      expect(primitive.bounds.minY).toBeGreaterThanOrEqual(tileY * CAD_SCENE_TILE_SIZE);
      expect(primitive.bounds.maxY).toBeLessThanOrEqual((tileY + 1) * CAD_SCENE_TILE_SIZE);
    }
  });

  it("traverses a diagonal line by occupied grid cells instead of its bounding rectangle", () => {
    const scene = buildCadScene(document([{
      type: "line",
      sourceEntityId: "diagonal",
      layer: "GRID",
      start: point(0, 0),
      end: point(1_000, 1_000)
    }]), region(), { sceneId });
    const occurrences = decodedOccurrences(scene);

    expect(occurrences.length).toBeLessThanOrEqual(70);
    expect(occurrences.length).toBeGreaterThan(20);
    expect(new Set(occurrences.map(({ primitive }) => primitive.elementId)).size).toBe(1);
    expect(scene.manifest.primitiveCount).toBe(1);
  });

  it("covers every tile crossed by a non-uniformly transformed arc", () => {
    const insertX = 498.43209562563584;
    const insertY = 503.2769582909461;
    const rotation = 14.208066900002052;
    const scaleY = 0.32480502556600044;
    const blocks: NormalizedCadDocument["blocks"] = [{
      name: "AFFINE_ARC",
      basePoint: point(0, 0),
      entities: [{
        type: "arc", sourceEntityId: "arc", layer: "0", center: point(0, 0),
        radius: 400, startAngle: 0, endAngle: 180
      }]
    }];
    const scene = buildCadScene(document([{
      type: "insert", sourceEntityId: "arc-insert", layer: "CURVE", blockName: "AFFINE_ARC",
      position: point(insertX, insertY), rotation, scale: { x: 1, y: scaleY, z: 1 }, attributes: []
    }], blocks), region(), { sceneId });
    const expectedCells = new Set<string>();
    const radians = rotation * Math.PI / 180;
    for (let step = 0; step <= 3_600; step++) {
      const angle = Math.PI * step / 3_600;
      const localX = 400 * Math.cos(angle);
      const localY = 400 * scaleY * Math.sin(angle);
      const sourceX = insertX + localX * Math.cos(radians) - localY * Math.sin(radians);
      const sourceY = insertY + localX * Math.sin(radians) + localY * Math.cos(radians);
      const mapX = sourceX * scene.manifest.transform.scaleX + scene.manifest.transform.translateX;
      const mapY = sourceY * scene.manifest.transform.scaleY + scene.manifest.transform.translateY;
      expectedCells.add(`${Math.floor(mapY / CAD_SCENE_TILE_SIZE)}:${Math.floor(mapX / CAD_SCENE_TILE_SIZE)}`);
    }
    const actualCells = new Set(scene.tiles.map(tile => `${tile.descriptor.tileY}:${tile.descriptor.tileX}`));

    expect([...expectedCells].filter(cell => !actualCells.has(cell))).toEqual([]);
  });

  it("encodes extremely flattened circles as decodable geometry", () => {
    const scene = buildCadScene(document([{
      type: "insert", sourceEntityId: "flat-circle", layer: "SYMBOL", blockName: "CIRCLE",
      position: point(500, 500), rotation: 0, scale: { x: 1, y: 1e-12, z: 1 }, attributes: []
    }], [{
      name: "CIRCLE", basePoint: point(0, 0), entities: [{
        type: "circle", sourceEntityId: "circle", layer: "0", center: point(0, 0), radius: 10
      }]
    }]), region(), { sceneId });

    expect(() => decodedOccurrences(scene)).not.toThrow();
    expect(uniquePrimitives(scene).map(primitive => primitive.type)).toEqual(["line"]);
  });

  it("replicates distant native shapes without inflating logical primitive count", () => {
    const scene = buildCadScene(document([
      {
        type: "lwpolyline", sourceEntityId: "wide-rectangle", layer: "WALL", closed: true,
        vertices: [vertex(10, 400), vertex(990, 400), vertex(990, 600), vertex(10, 600)]
      },
      { type: "circle", sourceEntityId: "wide-circle", layer: "SYMBOL", center: point(500, 500), radius: 300 }
    ]), region(), { sceneId });
    const occurrences = decodedOccurrences(scene);
    const ids = new Set(occurrences.map(value => value.primitive.elementId));

    expect(scene.manifest.primitiveCount).toBe(2);
    expect(ids.size).toBe(2);
    expect(occurrences.some(value => value.tileX === 0)).toBe(true);
    expect(occurrences.some(value => value.tileX >= 20)).toBe(true);
    expect(new Set(occurrences.map(value => value.primitive.type))).toEqual(new Set(["rectangle", "ellipse"]));
    expect(occurrences.filter(value => value.primitive.type === "rectangle").length).toBeLessThan(100);
    expect(occurrences.filter(value => value.primitive.type === "ellipse").length).toBeLessThan(100);
    for (const { primitive, tileX, tileY } of occurrences) {
      expect(primitive.clipBounds).toEqual({
        minX: tileX * CAD_SCENE_TILE_SIZE,
        minY: tileY * CAD_SCENE_TILE_SIZE,
        maxX: Math.min(scene.manifest.width, (tileX + 1) * CAD_SCENE_TILE_SIZE),
        maxY: Math.min(scene.manifest.height, (tileY + 1) * CAD_SCENE_TILE_SIZE)
      });
    }
  });

  it("keeps additive LOD semantics explicit while structural content remains loadable", () => {
    const scene = buildCadScene(document([
      { type: "line", sourceEntityId: "wall", layer: "WALL", start: point(10, 10), end: point(20, 20) },
      {
        type: "hatch", sourceEntityId: "detail", layer: "FILL", loops: [{ type: "polyline", closed: true,
          vertices: [vertex(30, 10), vertex(40, 10), vertex(40, 20), vertex(30, 20)] }]
      }
    ]), region(), { sceneId });

    expect(scene.manifest.lodMode).toBe("additive");
    const selectedLevel = 2;
    const loaded = decodedOccurrences(scene).filter(value => value.lod <= selectedLevel);
    expect(loaded.some(value => value.primitive.sourceType === "LINE")).toBe(true);
    expect(loaded.some(value => value.primitive.sourceType === "HATCH")).toBe(true);
  });

  it("preserves DIMENSION source, group, and LOD for resolved and unresolved dimensions", () => {
    const dimension = (sourceEntityId: string, blockName: string | null, y: number): NormalizedCadEntity => ({
      type: "dimension", sourceEntityId, layer: "DIM", blockName,
      definitionPoint: point(0, 0), blockPosition: point(0, 0), textPosition: point(15, y - 2),
      extensionStart: point(10, y), extensionEnd: point(20, y), rotation: 0, text: "10"
    });
    const scene = buildCadScene(document([
      dimension("resolved", "DIM_BLOCK", 20),
      dimension("unresolved", null, 40)
    ], [{
      name: "DIM_BLOCK", basePoint: point(0, 0), entities: [
        { type: "line", sourceEntityId: "dim-line", layer: "0", start: point(10, 20), end: point(20, 20) },
        { type: "text", sourceEntityId: "dim-text", layer: "0", position: point(15, 18), rotation: 0, height: 2, text: "10" }
      ]
    }]), region(), { sceneId });
    const dimensions = decodedOccurrences(scene).filter(value => value.primitive.sourceType === "DIMENSION");
    const logicalDimensions = [...new Map(
      dimensions.map(value => [value.primitive.elementId, value.primitive])
    ).values()];

    expect(dimensions.length).toBeGreaterThanOrEqual(4);
    expect(dimensions.every(value => value.lod === 2)).toBe(true);
    expect(new Set(dimensions.map(value => value.primitive.groupId)).has(null)).toBe(false);
    expect(logicalDimensions).toHaveLength(4);
    expect(new Set(logicalDimensions.map(value => value.groupId)).size).toBe(2);
  });

  it("uses full-precision normalization for large-offset source bounds", () => {
    const selected = { minX: 1_000_000_000, minY: -1_000_000_000, maxX: 1_000_001_600, maxY: -999_999_100 };
    const scene = buildCadScene(document([{
      type: "line", sourceEntityId: "large", layer: "WALL",
      start: point(selected.minX, selected.minY), end: point(selected.maxX, selected.maxY)
    }]), region(selected), { sceneId });
    const transform = scene.manifest.transform;
    const projected = [
      { x: selected.minX * transform.scaleX + transform.translateX, y: selected.maxY * transform.scaleY + transform.translateY },
      { x: selected.maxX * transform.scaleX + transform.translateX, y: selected.minY * transform.scaleY + transform.translateY }
    ];
    const expectedOffsetX = (scene.manifest.width - (selected.maxX - selected.minX) * transform.scaleX) / 2;
    const expectedOffsetY = (scene.manifest.height - (selected.maxY - selected.minY) * transform.scaleX) / 2;

    expect(projected[0].x).toBeCloseTo(expectedOffsetX, 6);
    expect(projected[0].y).toBeCloseTo(expectedOffsetY, 6);
    expect(projected[1].x).toBeCloseTo(scene.manifest.width - expectedOffsetX, 6);
    expect(projected[1].y).toBeCloseTo(scene.manifest.height - expectedOffsetY, 6);
  });

  it("includes swept cardinal extrema in arc bounds", () => {
    const scene = buildCadScene(document([{
      type: "arc", sourceEntityId: "arc-extrema", layer: "DOOR", center: point(100, 100),
      radius: 10, startAngle: 1, endAngle: 170
    }]), region(), { sceneId });
    const arcs = decodedOccurrences(scene).map(value => value.primitive)
      .filter((primitive): primitive is Extract<CadScenePrimitive, { type: "arc" }> => primitive.type === "arc");
    const scale = scene.manifest.transform.scaleX;
    const centerY = 100 * scene.manifest.transform.scaleY + scene.manifest.transform.translateY;

    expect(unionBounds(arcs).minY).toBeCloseTo(centerY - 10 * scale, 6);
  });

  it("keeps exact extrema for transformed similarity arcs and bulges", () => {
    const blocks: NormalizedCadDocument["blocks"] = [{
      name: "CURVES", basePoint: point(0, 0), entities: [
        {
          type: "arc", sourceEntityId: "rotated-arc", layer: "0", center: point(0, 0),
          radius: 10, startAngle: 0, endAngle: 180
        },
        {
          type: "lwpolyline", sourceEntityId: "rotated-bulge", layer: "0", closed: false,
          vertices: [vertex(0, 0, 1), vertex(20, 0)]
        }
      ]
    }];
    const scene = buildCadScene(document([{
      type: "insert", sourceEntityId: "curve-insert", layer: "CURVE", blockName: "CURVES",
      position: point(500, 500), rotation: -7, scale: { x: 1, y: 1, z: 1 }, attributes: []
    }], blocks), region(), { sceneId, simplifyTolerance: 0 });
    const occurrences = decodedOccurrences(scene);
    const arc = occurrences.find(value => value.primitive.sourceType === "ARC")?.primitive;
    const bulges = occurrences.filter(value => value.primitive.sourceType === "LWPOLYLINE")
      .map(value => value.primitive);
    const scale = scene.manifest.transform.scaleX;
    const radians = -7 * Math.PI / 180;
    const bulgeCenterX = (500 + 10 * Math.cos(radians)) * scale + scene.manifest.transform.translateX;

    expect(arc?.type).toBe("arc");
    const arcOccurrences = occurrences.filter(value => value.primitive.elementId === arc?.elementId)
      .map(value => value.primitive);
    expect(unionBounds(arcOccurrences).maxX).toBeCloseTo(
      (arc?.type === "arc" ? arc.geometry.center.x + arc.geometry.radius : Number.NaN),
      6
    );
    expect(unionBounds(bulges).minX).toBeCloseTo(bulgeCenterX - 10 * scale, 6);
  });

  it("simplifies collinear points, removes exact duplicate geometry, and owns a max-edge primitive once", () => {
    const scale = 15.728;
    const sourceX = (512 - 328) / scale;
    const sourceStartY = (16_056 - 400) / scale;
    const sourceEndY = (16_056 - 450) / scale;
    const boundaryScene = buildCadScene(document([{
      type: "line",
      sourceEntityId: "boundary",
      layer: "GRID",
      start: point((400 - 328) / scale, sourceStartY),
      end: point(sourceX, sourceEndY)
    }]), region(), { sceneId });

    expect(decodedOccurrences(boundaryScene)).toHaveLength(1);
    expect(decodedOccurrences(boundaryScene)[0]).toMatchObject({ tileX: 0, tileY: 0 });

    const optimized = buildCadScene(document([
      { type: "line", sourceEntityId: "duplicate-a", layer: "WALL", start: point(10, 10), end: point(20, 20) },
      { type: "line", sourceEntityId: "duplicate-b", layer: "WALL", start: point(10, 10), end: point(20, 20) },
      {
        type: "lwpolyline", sourceEntityId: "simplified", layer: "PATH", closed: false,
        vertices: [vertex(30, 10), vertex(35, 10), vertex(40, 10)]
      }
    ]), region(), { sceneId });
    const primitives = uniquePrimitives(optimized);

    expect(optimized.manifest.primitiveCount).toBe(2);
    expect(primitives.find(primitive => primitive.sourceType === "LWPOLYLINE")).toMatchObject({
      type: "polyline",
      geometry: { points: expect.arrayContaining([expect.objectContaining({ x: expect.any(Number) })]) }
    });
    const simplified = primitives.find(primitive => primitive.sourceType === "LWPOLYLINE");
    expect(simplified?.type === "polyline" && simplified.geometry.points).toHaveLength(2);
  });

  it("handles a selected polyline with more vertices than the JavaScript argument limit", () => {
    const vertexCount = 130_000;
    const vertices = Array.from({ length: vertexCount }, (_, index) => {
      const angle = index * Math.PI * 2 / vertexCount;
      return vertex(500 + 450 * Math.cos(angle), 500 + 450 * Math.sin(angle));
    });

    const scene = buildCadScene(document([{
      type: "lwpolyline",
      sourceEntityId: "large-polyline",
      layer: "BOUNDARY",
      closed: true,
      vertices
    }]), region({ minX: 0, minY: 0, maxX: 100_000, maxY: 100_000 }), {
      sceneId,
      simplifyTolerance: 0
    });

    const primitives = uniquePrimitives(scene);
    expect(scene.manifest.primitiveCount).toBe(1);
    expect(primitives).toHaveLength(1);
    expect(primitives.every(primitive =>
      primitive.type === "polyline" &&
      primitive.geometry.points.length <= CAD_SCENE_MAX_POINTS_PER_PRIMITIVE
    )).toBe(true);
  });

  it("simplifies a pathological 65k+ open polyline without recursion or slicing", () => {
    const vertices = Array.from({ length: 70_000 }, (_, index) => vertex(index, index % 2));
    const scene = buildCadScene(document([{
      type: "lwpolyline", sourceEntityId: "pathological-open", layer: "PATH", closed: false, vertices
    }]), region({ minX: 0, minY: 0, maxX: 70_000, maxY: 2_000 }), {
      sceneId, simplifyTolerance: 0.01
    });

    const occurrences = decodedOccurrences(scene);
    expect(scene.manifest.primitiveCount).toBe(1);
    expect(new Set(occurrences.map(({ primitive }) => primitive.elementId)).size).toBe(1);
    expect(occurrences.every(({ primitive }) =>
      primitive.type === "polyline" && primitive.geometry.points.length <= 2
    )).toBe(true);
  }, 30_000);

  it("shards a dense single-cell scene into deterministic bounded parts", () => {
    const primitiveCount = 30_000;
    const entities: NormalizedCadEntity[] = Array.from({ length: primitiveCount }, (_, index) => {
      const y = 48_000 + index * 0.0001;
      return {
        type: "line",
        sourceEntityId: `dense-${index}`,
        layer: `D${index.toString().padStart(6, "0")}${"X".repeat(500)}`,
        start: point(48_000, y),
        end: point(48_000.1, y + 0.01)
      };
    });
    const selectedRegion = region({ minX: 0, minY: 0, maxX: 100_000, maxY: 100_000 });

    const first = buildCadScene(document(entities), selectedRegion, {
      sceneId,
      maxExpandedEntities: primitiveCount,
      maxSelectedPrimitives: primitiveCount
    });
    const second = buildCadScene(document(entities), selectedRegion, {
      sceneId,
      maxExpandedEntities: primitiveCount,
      maxSelectedPrimitives: primitiveCount
    });

    expect(first.manifest.primitiveCount).toBe(primitiveCount);
    expect(first.tiles.length).toBeGreaterThan(1);
    expect(first.manifest.tileCount).toBe(first.tiles.length);
    expect(first.manifest.tiles).toEqual(first.tiles.map(tile => tile.descriptor));
    expect(new Set(first.tiles.map(tile => `${tile.descriptor.lod}:${tile.descriptor.tileX}:${tile.descriptor.tileY}`)).size)
      .toBe(1);
    expect(first.tiles.map(tile => tile.descriptor.part)).toEqual(
      Array.from({ length: first.tiles.length }, (_, index) => index)
    );
    expect(first.tiles.every(tile => tile.payload.byteLength <= CAD_SCENE_MAX_TILE_BYTE_SIZE)).toBe(true);
    expect(first.tiles.reduce((count, tile) => count + tile.descriptor.primitiveCount, 0)).toBe(primitiveCount);
    expect(new Set(first.tiles.map(tile => tile.descriptor.assetId)).size).toBe(first.tiles.length);
    expect(first.tiles.map(tile => tile.descriptor.assetId))
      .toEqual(second.tiles.map(tile => tile.descriptor.assetId));
    expect(first.tiles.map(tile => tile.descriptor.sha256))
      .toEqual(second.tiles.map(tile => tile.descriptor.sha256));
  }, 30_000);

  it("rejects a cell that would exceed the configured tile part limit", () => {
    const entities: NormalizedCadEntity[] = Array.from({ length: 12 }, (_, index) => ({
      type: "line" as const,
      sourceEntityId: `part-limit-${index}`,
      layer: `LIMIT-${index}-${"X".repeat(500)}`,
      start: point(48_000, 48_000 + index * 0.01),
      end: point(48_000.1, 48_000 + index * 0.01)
    }));
    const limits = {
      sceneId,
      maxTileByteSize: 1_024,
      maxTilePartsPerCell: 2
    } as Parameters<typeof buildCadScene>[2] & {
      maxTileByteSize: number;
      maxTilePartsPerCell: number;
    };

    expect(() => buildCadScene(
      document(entities),
      region({ minX: 0, minY: 0, maxX: 100_000, maxY: 100_000 }),
      limits
    )).toThrow("CAD scene tile part limit exceeded");
  });

  it("rejects a primitive that cannot fit in an empty tile part", () => {
    const limits = {
      sceneId,
      maxTileByteSize: 128
    } as Parameters<typeof buildCadScene>[2] & { maxTileByteSize: number };

    expect(() => buildCadScene(document([{
      type: "line",
      sourceEntityId: "oversized-single",
      layer: "WALL",
      start: point(10, 10),
      end: point(20, 20)
    }]), region(), limits)).toThrow("CAD scene primitive exceeds tile byte size limit");
  });

  it("rejects scenes that exceed the configured tile descriptor limit", () => {
    const entities: NormalizedCadEntity[] = [10, 100, 200].map((x, index) => ({
      type: "line" as const,
      sourceEntityId: `descriptor-limit-${index}`,
      layer: "LIMIT",
      start: point(x, 10),
      end: point(x + 1, 10)
    }));
    const limits = {
      sceneId,
      maxTilePartCount: 2
    } as Parameters<typeof buildCadScene>[2] & { maxTilePartCount: number };

    expect(() => buildCadScene(
      document(entities),
      region({ minX: 0, minY: 0, maxX: 1_000, maxY: 1_000 }),
      limits
    )).toThrow("CAD scene tile descriptor limit exceeded");
  });

  it("rejects tile output before retaining payloads beyond the global byte budget", () => {
    const limits = {
      sceneId,
      maxTotalTileBytes: 1_024
    } as Parameters<typeof buildCadScene>[2] & { maxTotalTileBytes: number };

    expect(() => buildCadScene(document([{
      type: "line",
      sourceEntityId: "budget-crossing",
      layer: "GRID",
      start: point(0, 500),
      end: point(1_000, 500)
    }]), region(), limits)).toThrow("CAD scene tile output byte limit exceeded");
  });

  it("rejects duplicate tile asset IDs returned by the asset callback", () => {
    expect(() => buildCadScene(document([{
      type: "line",
      sourceEntityId: "duplicate-assets",
      layer: "GRID",
      start: point(0, 500),
      end: point(1_000, 500)
    }]), region(), {
      sceneId,
      tileAssetId: () => sceneId
    })).toThrow("CAD scene tile assetId must be unique");
  });

  it("rejects a tile asset ID that collides with the manifest asset", () => {
    expect(() => buildCadScene(document([{
      type: "line", sourceEntityId: "manifest-collision", layer: "GRID",
      start: point(10, 10), end: point(20, 20)
    }]), region(), {
      sceneId,
      manifestAssetId: sceneId,
      tileAssetId: () => sceneId
    })).toThrow("CAD scene assetId must be unique");
  });

  it("flushes a single polyline incrementally before retaining all segment occurrences", () => {
    const scene = buildCadScene(document([{
      type: "lwpolyline", sourceEntityId: "streamed-polyline", layer: "PATH", closed: false,
      vertices: [1, 2, 3, 4, 5, 6].map(x => vertex(x, x % 2 === 0 ? 11 : 10))
    }]), region(), {
      sceneId,
      simplifyTolerance: 0,
      maxRetainedTileOccurrences: 2
    });

    expect(scene.tiles.map(tile => tile.descriptor.part)).toEqual([0, 1, 2]);
  });
});

const benchmarkIt = process.env.CAD_SCENE_BENCHMARK === "1" ? it : it.skip;

describe("CAD scene builder benchmark", () => {
  benchmarkIt("records the 300,000 primitive build budget", () => {
    const result = spawnSync("pnpm", ["exec", "tsx", "scripts/cad-scene-builder-benchmark.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, CAD_SCENE_BENCHMARK_CHILD: "1" },
      timeout: 60_000
    });
    expect(result.status).toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    const match = output.match(/CAD_BENCHMARK_RESULT=(\{[^\n]+\})/);
    expect(match).not.toBeNull();
    const measurement = JSON.parse(match![1]) as {
      primitiveCount: number;
      durationMs: number;
      buildMaxRssDeltaMb: number;
    };
    console.info(JSON.stringify(measurement));
    expect(measurement.primitiveCount).toBe(300_000);
    expect(measurement.durationMs).toBeLessThan(30_000);
    expect(measurement.buildMaxRssDeltaMb).toBeLessThan(512);
  }, 60_000);
});
