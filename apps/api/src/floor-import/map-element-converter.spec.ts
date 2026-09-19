import { CAD_SCENE_MAX_POINTS_PER_PRIMITIVE, mapDocumentStateSchema, mapElementSchema, getMapElementBounds, transformMapPoint, type MapElement } from "@led-control/shared";
import { convertCadMapElements, createCadMapElementConverter, type CadMapConversionMetadata } from "./map-element-converter";
import { parseAsciiDxf } from "./dxf-document-parser";
import { buildCadScene } from "./cad-scene-builder";
import { decodeCadSceneTile } from "./cad-scene-codec";
import type { NormalizedCadDocument, NormalizedCadEntity } from "./cad-types";

const sceneId = "00000000-0000-4000-8000-000000000101";
const bounds = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
const point = (x: number, y: number) => ({ x, y, z: 0 });
const vertex = (x: number, y: number) => ({ ...point(x, y), bulge: 0 });
const document = (entities: NormalizedCadEntity[], blocks: NormalizedCadDocument["blocks"] = []): NormalizedCadDocument => ({ version: 1, bounds, entities, blocks });
const pair = (code: number, value: string | number) => `${code}\n${value}\n`;
const dxf = (...entities: Array<[number, string | number]>) => [
  pair(0, "SECTION"), pair(2, "ENTITIES"), ...entities.map(([c, v]) => pair(c, v)), pair(0, "ENDSEC"), pair(0, "EOF")
].join("");
async function convert(input: NormalizedCadDocument, extra = {}) {
  const elements: MapElement[] = [];
  let metadata: CadMapConversionMetadata | undefined;
  for await (const element of convertCadMapElements(input, {
    sceneId, importJobId: "job-1", regionBounds: bounds,
    onMetadata: value => { metadata = value; }, ...extra
  })) elements.push(mapElementSchema.parse(element));
  expect(metadata).toBeDefined();
  mapDocumentStateSchema.parse({ elements, groups: metadata!.groups, layers: metadata!.layers });
  return { elements, metadata: metadata! };
}

describe("canonical CAD map conversion", () => {
  it("resolves every compact binary pick directly to canonical ID/group, including HATCH hole/island rings", () => {
    const input = document([
      { type: "line", sourceEntityId: "L", layer: "WALL", start: point(-100, 500), end: point(1100, 500) },
      { type: "ellipse", sourceEntityId: "E", layer: "CURVE", center: point(400, 400), majorAxis: point(10, 5), axisRatio: 0.5, normalZ: 1, startParameter: 0, endParameter: 2 * Math.PI },
      { type: "ellipse", sourceEntityId: "EA", layer: "CURVE", center: point(450, 450), majorAxis: point(10, 5), axisRatio: 0.5, normalZ: 1, startParameter: 0.5, endParameter: Math.PI },
      { type: "lwpolyline", sourceEntityId: "R", layer: "WALL", closed: true, vertices: [vertex(500, 500), vertex(520, 500), vertex(520, 510), vertex(500, 510)] },
      { type: "lwpolyline", sourceEntityId: "T", layer: "WALL", closed: true, vertices: [vertex(550, 500), vertex(570, 500), vertex(550, 510)] },
      ...["I1", "I2"].map((sourceEntityId, i): NormalizedCadEntity => ({ type: "insert", sourceEntityId, layer: "LIGHT", blockName: "B", position: point(200 + i * 100, 200), rotation: 30, scale: { x: -2, y: 3, z: 1 }, attributes: [] })),
      { type: "hatch", sourceEntityId: "H", layer: "FILL", loops: [
        { type: "polyline", closed: true, vertices: [vertex(10, 10), vertex(110, 10), vertex(110, 110), vertex(10, 110)] },
        { type: "polyline", closed: true, vertices: [vertex(30, 30), vertex(90, 30), vertex(90, 90), vertex(30, 90)] },
        { type: "polyline", closed: true, vertices: [vertex(50, 50), vertex(70, 50), vertex(70, 70), vertex(50, 70)] }
      ] },
      { type: "dimension", sourceEntityId: "D", layer: "DIM", blockName: null, definitionPoint: point(20, 20), blockPosition: point(0, 0), textPosition: point(25, 21), extensionStart: point(20, 20), extensionEnd: point(30, 20), rotation: 0, text: "10" }
    ], [{ name: "B", basePoint: point(0, 0), entities: [
      { type: "circle", sourceEntityId: "C", layer: "0", center: point(0, 0), radius: 2 },
      { type: "arc", sourceEntityId: "A", layer: "0", center: point(10, 10), radius: 2, startAngle: 20, endAngle: 200 }
    ] }]);
    const adapter = createCadMapElementConverter({ importJobId: "job", regionBounds: bounds });
    const canonical = new Map<string, MapElement>();
    const scene = buildCadScene(input, { regionId: "r", bounds, primitiveCount: 1, textCount: 0, lightCandidateCount: 0, area: 1e6 }, {
      sceneId, onSemanticEntity: semantic => {
        const elements = adapter.convertSemanticEntity(semantic);
        elements.forEach(element => canonical.set(element.id, element));
        return elements;
      }
    });
    const primitives = scene.tiles.flatMap(tile => decodeCadSceneTile(tile.payload, tile.descriptor));
    expect(new Set(scene.tiles.map(tile => tile.descriptor.lod))).toEqual(new Set([0, 1, 2]));
    expect(primitives.length).toBeGreaterThan(canonical.size);
    expect(scene.manifest.version).toBe(1);
    for (const primitive of primitives) {
      expect(canonical.has(primitive.elementId)).toBe(true);
      expect(primitive.groupId).toBe(canonical.get(primitive.elementId)!.groupId);
    }
    const polygonIds = [...canonical.values()].filter(element => element.type === "polygon").map(element => element.id);
    expect(new Set(primitives.filter(p => p.sourceType === "HATCH").map(p => p.elementId))).toEqual(new Set(polygonIds));
    expect(adapter.getMetadata()).toMatchObject({ displayLayerBindings: expect.arrayContaining(
      ["WALL", "CURVE", "LIGHT", "FILL", "DIM"].map(layerName => ({ layerName, layerId: adapter.getMetadata().layers.find(layer => layer.name === layerName)!.id }))
    ) });
  });

  it("preserves null canonical group and source ID across tile-clipped maximum-size polylines", () => {
    const input = document([{ type: "lwpolyline", sourceEntityId: "P", layer: "PATH", closed: false,
      vertices: Array.from({ length: CAD_SCENE_MAX_POINTS_PER_PRIMITIVE }, (_, i) => vertex(10 + i / 100, 10 + (i % 2) / 100)) }]);
    const adapter = createCadMapElementConverter({ importJobId: "job", regionBounds: bounds });
    const canonical: MapElement[] = [];
    const scene = buildCadScene(input, { regionId: "r", bounds, primitiveCount: 1, textCount: 0, lightCandidateCount: 0, area: 1e6 }, {
      sceneId, simplifyTolerance: 0, onSemanticEntity: semantic => {
        const elements = adapter.convertSemanticEntity(semantic);
        canonical.push(...elements);
        return elements;
      }
    });
    expect(canonical).toHaveLength(1);
    expect(canonical[0].groupId).toBeNull();
    const primitives = scene.tiles.flatMap(tile => decodeCadSceneTile(tile.payload, tile.descriptor));
    expect(primitives.length).toBeGreaterThan(1);
    expect(new Set(primitives.map(p => p.elementId))).toEqual(new Set([canonical[0].id]));
    expect(new Set(primitives.map(p => p.groupId))).toEqual(new Set([null]));
  });

  it("keeps one full crossing line per source, without display deduplication or tile fragments", async () => {
    const input = document(["A", "B"].map(sourceEntityId => ({ type: "line", sourceEntityId, layer: "WALL", start: point(-100, 500), end: point(1100, 500) })));
    const first = await convert(input);
    const second = await convert(input);
    expect(first.elements).toEqual(second.elements);
    expect(first.elements).toHaveLength(2);
    expect(new Set(first.elements.map(e => e.id)).size).toBe(2);
    expect(first.elements[0]).toMatchObject({ type: "line", provenance: { importJobId: "job-1", sourceId: "A" }, geometry: { start: { x: -1244.8, y: 8192 }, end: { x: 17628.8, y: 8192 } } });
  });

  it("retains unsimplified open and closed geometry and the ordinary eight-type contract", async () => {
    const input = document([
      { type: "lwpolyline", sourceEntityId: "open", layer: "0", closed: false, vertices: [vertex(1, 1), vertex(2, 1.001), vertex(3, 1)] },
      { type: "lwpolyline", sourceEntityId: "closed", layer: "0", closed: true, vertices: [vertex(10, 10), vertex(20, 10), vertex(22, 15), vertex(20, 20), vertex(10, 20)] },
      { type: "circle", sourceEntityId: "circle", layer: "0", center: point(50, 50), radius: 10 },
      { type: "arc", sourceEntityId: "arc", layer: "0", center: point(80, 80), radius: 10, startAngle: 0, endAngle: 90 },
      { type: "text", sourceEntityId: "text", layer: "NOTE", position: point(90, 90), rotation: 30, height: 2, text: "B1 주차장" },
      { type: "lwpolyline", sourceEntityId: "rect", layer: "0", closed: true, vertices: [vertex(100, 100), vertex(120, 100), vertex(120, 110), vertex(100, 110)] },
      { type: "lwpolyline", sourceEntityId: "tri", layer: "0", closed: true, vertices: [vertex(130, 100), vertex(150, 100), vertex(130, 110)] },
      { type: "line", sourceEntityId: "line", layer: "0", start: point(1, 5), end: point(2, 6) }
    ]);
    const { elements } = await convert(input, { simplifyTolerance: 100 });
    expect(elements.map(e => e.type).sort()).toEqual(["arc", "ellipse", "line", "polygon", "polyline", "rectangle", "text", "triangle"]);
    expect(elements[0]).toMatchObject({ geometry: { points: [{ x: 343.728, y: 16040.272 }, { x: 359.456, y: 16040.256272 }, { x: 375.184, y: 16040.272 }] } });
    expect(elements.find(e => e.type === "text")).toMatchObject({ geometry: { text: "B1 주차장" } });
    expect(elements.find(e => e.type === "text")!.transform.rotation).toBeCloseTo(-30, 5);
    expect(elements.find(e => e.type === "arc")).toMatchObject({ geometry: { counterClockwise: false, startAngle: 0, endAngle: 270 } });
  });

  it("keeps distinct repeated INSERT identities, transformed geometry, inherited layers and DIMENSION groups", async () => {
    const input = document([
      ...["I1", "I2"].map((sourceEntityId, i): NormalizedCadEntity => ({ type: "insert", sourceEntityId, layer: "LIGHT", blockName: "B", position: point(100 + i * 100, 100), rotation: 90, scale: { x: -2, y: 3, z: 1 }, attributes: [] })),
      { type: "dimension", sourceEntityId: "D", layer: "DIM", blockName: null, definitionPoint: point(20, 20), blockPosition: point(0, 0), textPosition: point(25, 21), extensionStart: point(20, 20), extensionEnd: point(30, 20), rotation: 0, text: "10" }
    ], [{ name: "B", basePoint: point(1, 1), entities: [{ type: "line", sourceEntityId: "L", layer: "0", start: point(1, 1), end: point(2, 1) }] }]);
    const { elements, metadata } = await convert(input);
    expect(new Set(elements.map(e => e.id)).size).toBe(4);
    expect(elements[0].groupId).not.toBe(elements[1].groupId);
    expect(elements[2].groupId).toBe(elements[3].groupId);
    expect(metadata.groups).toHaveLength(3);
    expect(metadata.layers.map(l => l.name)).toEqual(["LIGHT", "DIM"]);
    expect(elements[0]).toMatchObject({ geometry: { start: { x: 1900.8, y: 14483.2 }, end: { x: 1900.8, y: 14514.656 } } });
  });

  it("parses real small DXF ELLIPSE/ARC/TEXT and reports unsupported input counts", async () => {
    const input = parseAsciiDxf(dxf(
      [0, "ELLIPSE"], [5, "E"], [10, 50], [20, 50], [11, 10], [21, 0], [40, 0.5], [41, 0], [42, Math.PI * 2],
      [0, "ARC"], [5, "A"], [10, 80], [20, 80], [40, 5], [50, 20], [51, 120],
      [0, "TEXT"], [5, "T"], [10, 10], [20, 10], [40, 1], [1, "주차장"],
      [0, "HELIX"], [5, "H"], [10, 0], [20, 0]
    ));
    const result = await convert(input);
    expect(result.elements.map(e => e.type)).toEqual(["ellipse", "arc", "text"]);
    expect(result.metadata.unsupportedEntityCounts).toEqual({ HELIX: 1 });
    expect(result.elements[0]).toMatchObject({ geometry: { radiusX: 157.28, radiusY: 78.64 } });
    const expected = { minX: 957.12, minY: 15190.96, maxX: 1271.68, maxY: 15348.24 };
    const actual = getMapElementBounds(result.elements[0]);
    for (const key of Object.keys(expected) as Array<keyof typeof expected>) expect(actual[key]).toBeCloseTo(expected[key], 6);
  });

  it("combines DXF HATCH nested rings into polygons with holes, preserving islands", async () => {
    const rings = [[[0, 0], [100, 0], [100, 100], [0, 100]], [[20, 20], [80, 20], [80, 80], [20, 80]], [[40, 40], [60, 40], [60, 60], [40, 60]]];
    const input = parseAsciiDxf(dxf([0, "HATCH"], [5, "H"], [91, 3], ...rings.flatMap(ring => [
      [92, 2], [93, 4], [73, 1], ...ring.flatMap(([x, y]) => [[10, x], [20, y]])
    ] as Array<[number, number]>)));
    const { elements, metadata } = await convert(input);
    expect(elements).toHaveLength(2);
    expect(elements.map(e => e.type === "polygon" ? e.geometry.holes.length : -1)).toEqual([1, 0]);
    expect(elements[0].groupId).toBe(elements[1].groupId);
    expect(metadata.groups).toHaveLength(1);
  });

  it("fails rather than silently filling over a HATCH hole that collapsed during projection", async () => {
    const input = document([{ type: "hatch", sourceEntityId: "H", layer: "0", loops: [
      { type: "polyline", closed: true, vertices: [vertex(0, 0), vertex(100, 0), vertex(100, 100), vertex(0, 100)] },
      { type: "polyline", closed: true, vertices: [vertex(20, 20), vertex(20, 20), vertex(20, 20)] }
    ] }]);
    await expect(convert(input)).rejects.toThrow(/HATCH.*ring/i);
  });

  it("fails closed on limits and propagates cancellation instead of yielding a complete subset", async () => {
    const input = document([1, 2].map(i => ({ type: "line", sourceEntityId: `L${i}`, layer: "0", start: point(i, i), end: point(i + 1, i + 1) })));
    await expect(convert(input, { maxSelectedPrimitives: 1 })).rejects.toThrow(/limit/);
    await expect(convert(input, { maxExpandedEntities: 1 })).rejects.toThrow(/limit/);
    await expect(convert(input, { checkBudget: () => { throw new Error("cancelled"); } })).rejects.toThrow("cancelled");
  });

  it("exposes full semantic geometry once before the scene builder clips or simplifies it", () => {
    const received: unknown[] = [];
    const input = document([{ type: "line", sourceEntityId: "L", layer: "0", start: point(0, 500), end: point(1000, 500) }]);
    const scene = buildCadScene(input, { regionId: "r", bounds, primitiveCount: 1, textCount: 0, lightCandidateCount: 0, area: 1e6 }, {
      sceneId, onSemanticEntity: value => { received.push(value); }
    });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ source: { sourceEntityId: "L" }, primitives: [{ type: "line", clipBounds: null, geometry: { start: { x: 328, y: 8192 }, end: { x: 16056, y: 8192 } } }] });
    expect(scene.tiles.length).toBeGreaterThan(2);
  });

  it("provides explicit bounded document seed and nested group definitions, identical through the builder hook", async () => {
    const insert = (sourceEntityId: string, blockName: string): NormalizedCadEntity => ({
      type: "insert", sourceEntityId, blockName, layer: "0", position: point(0, 0), rotation: 0,
      scale: { x: 1, y: 1, z: 1 }, attributes: []
    });
    const input = document([insert("root", "B")], [
      { name: "B", basePoint: point(0, 0), entities: [insert("nested", "C"), { type: "line", sourceEntityId: "outer", layer: "WALL", start: point(1, 1), end: point(3, 3) }] },
      { name: "C", basePoint: point(0, 0), entities: [{ type: "line", sourceEntityId: "inner", layer: "WALL", start: point(1, 1), end: point(2, 2) }] }
    ]);
    const expected = await convert(input);
    expect(expected.metadata).toMatchObject({ width: 16384, height: 16384, gridSize: 80 });
    const nested = expected.metadata.groups.find(g => g.id === expected.elements[0].groupId)!;
    expect(nested.parentId).toBe(expected.elements[1].groupId);
    const adapter = createCadMapElementConverter({ importJobId: "job-1", regionBounds: bounds });
    const elements: MapElement[] = [];
    buildCadScene(input, { regionId: "r", bounds, primitiveCount: 2, textCount: 0, lightCandidateCount: 0, area: 1e6 }, {
      sceneId, onSemanticEntity: semantic => { elements.push(...adapter.convertSemanticEntity(semantic)); }
    });
    expect(elements).toEqual(expected.elements);
    expect(adapter.getMetadata()).toEqual(expected.metadata);
    await expect(convert(input, { maxMetadataBytes: 100 })).rejects.toThrow(/metadata.*limit/i);
  });

  it("preserves analytic elliptical arcs under reflected rotated INSERTs without double projection", async () => {
    const curve: NormalizedCadEntity = { type: "ellipse", sourceEntityId: "E", layer: "0", center: point(10, 20), majorAxis: point(4, 3), axisRatio: 0.4, normalZ: 1, startParameter: 0, endParameter: Math.PI / 2 };
    const input = document([{ type: "insert", sourceEntityId: "I", layer: "CURVE", blockName: "B", position: point(100, 100), scale: { x: -2, y: 3, z: 1 }, rotation: 30, attributes: [] }], [{ name: "B", basePoint: point(0, 0), entities: [curve] }]);
    const { elements } = await convert(input);
    const arc = elements[0];
    expect(arc.type).toBe("arc");
    if (arc.type !== "arc") throw new Error("Expected arc");
    const localEndpoint = (degrees: number) => ({ x: arc.geometry.radius * Math.cos(degrees * Math.PI / 180), y: arc.geometry.radius * Math.sin(degrees * Math.PI / 180) });
    const project = (x: number, y: number) => ({ x: 328 + (100 - 2 * x * Math.cos(Math.PI / 6) - 3 * y * Math.sin(Math.PI / 6)) * 15.728,
      y: 16056 - (100 - 2 * x * Math.sin(Math.PI / 6) + 3 * y * Math.cos(Math.PI / 6)) * 15.728 });
    const start = transformMapPoint(localEndpoint(arc.geometry.startAngle), arc.transform);
    const end = transformMapPoint(localEndpoint(arc.geometry.endAngle), arc.transform);
    expect(start.x).toBeCloseTo(project(14, 23).x, 6);
    expect(start.y).toBeCloseTo(project(14, 23).y, 6);
    expect(end.x).toBeCloseTo(project(8.8, 21.6).x, 6);
    expect(end.y).toBeCloseTo(project(8.8, 21.6).y, 6);
    expect(arc.geometry.counterClockwise).toBe(true);
  });

  it("preserves a thin nonzero ellipse instead of cancelling its minor axis into a line", async () => {
    const { elements } = await convert(document([{ type: "ellipse", sourceEntityId: "thin", layer: "0", center: point(100, 100),
      majorAxis: point(10, 0), axisRatio: 1e-8, normalZ: 1, startParameter: 0, endParameter: 2 * Math.PI }]));
    expect(elements[0].type).toBe("ellipse");
    if (elements[0].type !== "ellipse") throw new Error("Expected ellipse");
    expect(elements[0].geometry.radiusY).toBeCloseTo(157.28e-8, 12);
  });

  it("reports supported-but-nondrawable POINT and degenerate geometry separately from parser unsupported counts", async () => {
    const { elements, metadata } = await convert(document([
      { type: "point", sourceEntityId: "P", layer: "0", position: point(1, 1) },
      { type: "line", sourceEntityId: "L", layer: "0", start: point(2, 2), end: point(2, 2) }
    ]));
    expect(elements).toEqual([]);
    expect(metadata.unconvertedEntityCounts).toEqual({ POINT: 1, LINE: 1 });
  });

  it("retains independent fallback DIMENSION groups under the same enclosing INSERT", async () => {
    const dimensions: NormalizedCadEntity[] = ["D1", "D2"].map((sourceEntityId, i) => ({
      type: "dimension", sourceEntityId, layer: "DIM", blockName: null, definitionPoint: point(10 + i * 20, 10),
      blockPosition: point(0, 0), textPosition: point(15 + i * 20, 11), extensionStart: point(10 + i * 20, 10),
      extensionEnd: point(20 + i * 20, 10), rotation: 0, text: "10"
    }));
    const input = document([{ type: "insert", sourceEntityId: "I", layer: "0", blockName: "B", position: point(0, 0),
      rotation: 0, scale: { x: 1, y: 1, z: 1 }, attributes: [] }], [{ name: "B", basePoint: point(0, 0), entities: dimensions }]);
    const { elements, metadata } = await convert(input);
    expect(elements[0].groupId).toBe(elements[1].groupId);
    expect(elements[2].groupId).toBe(elements[3].groupId);
    expect(elements[0].groupId).not.toBe(elements[2].groupId);
    expect(metadata.groups).toHaveLength(3);
    const parents = metadata.groups.filter(g => g.parentId !== null).map(g => g.parentId);
    expect(parents).toHaveLength(2);
    expect(new Set(parents).size).toBe(1);
  });

  it("never reports successful metadata after early iterator close or sink failure", async () => {
    const input = document([{ type: "line", sourceEntityId: "L", layer: "0", start: point(1, 1), end: point(2, 2) }]);
    const metadata = jest.fn();
    const stream = convertCadMapElements(input, { sceneId, importJobId: "job", regionBounds: bounds, onMetadata: metadata });
    await stream.next();
    await stream.return(undefined);
    expect(metadata).not.toHaveBeenCalled();
    expect(() => buildCadScene(input, { regionId: "r", bounds, primitiveCount: 1, textCount: 0, lightCandidateCount: 0, area: 1e6 }, {
      sceneId, onSemanticEntity: () => { throw new Error("sink failure"); }
    })).toThrow("sink failure");
  });

  it("does not split an oversized canonical element into partially retained fragments", async () => {
    const input = document([{ type: "lwpolyline", sourceEntityId: "oversized", layer: "0", closed: false,
      vertices: Array.from({ length: 65_537 }, (_, i) => vertex(i / 100, i % 2)) }]);
    await expect(convert(input)).rejects.toThrow();
  });

  it("keeps anonymous DIMENSION block members grouped through a real DXF parse", async () => {
    const input = parseAsciiDxf([
      pair(0, "SECTION"), pair(2, "BLOCKS"), pair(0, "BLOCK"), pair(2, "*D1"), pair(10, 1), pair(20, 1),
      pair(0, "LINE"), pair(5, "DL"), pair(10, 1), pair(20, 1), pair(11, 5), pair(21, 1),
      pair(0, "TEXT"), pair(5, "DT"), pair(10, 2), pair(20, 2), pair(40, 1), pair(1, "4"),
      pair(0, "ENDBLK"), pair(0, "ENDSEC"), pair(0, "SECTION"), pair(2, "ENTITIES"),
      pair(0, "DIMENSION"), pair(5, "D1"), pair(2, "*D1"), pair(10, 20), pair(20, 20), pair(12, 2), pair(22, 3),
      pair(0, "ENDSEC"), pair(0, "EOF")
    ].join(""));
    const { elements, metadata } = await convert(input);
    expect(elements.map(e => e.type)).toEqual(["line", "text"]);
    expect(elements[0].groupId).toBe(elements[1].groupId);
    expect(metadata.groups).toHaveLength(1);
    expect(elements[0]).toMatchObject({ geometry: { start: { x: 674.016, y: 15694.256 }, end: { x: 736.928, y: 15694.256 } } });
  });
});
