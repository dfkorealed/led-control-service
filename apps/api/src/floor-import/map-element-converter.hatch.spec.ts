import { mapElementSchema, MAP_ELEMENT_MAX_POINTS, type Point } from "@led-control/shared";
import { createCadMapElementConverter } from "./map-element-converter";
import { buildCadScene, type CadSemanticEntity } from "./cad-scene-builder";
import { decodeCadSceneTile } from "./cad-scene-codec";
import { resolveCadHatchRegions } from "./cad-hatch-geometry";

const points = (pairs: number[][]): Point[] => pairs.map(([x, y]) => ({ x, y }));
const square = (x: number, y: number, size: number) => points([[x, y], [x + size, y], [x + size, y + size], [x, y + size]]);
const area = (ring: Point[]) => Math.abs(ring.reduce((sum, p, i) => {
  const q = ring[(i + 1) % ring.length], origin = ring[0];
  return sum + (p.x - origin.x) * (q.y - origin.y) - (q.x - origin.x) * (p.y - origin.y);
}, 0)) / 2;
const contains = (ring: Point[], point: Point) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};

// Independent area oracle: integrate even-odd scanline widths between every
// vertex/intersection Y. Width is linear within each slab, so midpoint integration is exact.
function parityArea(ring: Point[]) {
  const local = ring.map(p => ({ x: p.x - ring[0].x, y: p.y - ring[0].y }));
  const edges = local.map((a, i) => ({ a, b: local[(i + 1) % local.length] }));
  const ys = new Set(local.map(p => p.y));
  for (const { a, b } of edges) for (const { a: c, b: d } of edges) {
    const ux = b.x - a.x, uy = b.y - a.y, vx = d.x - c.x, vy = d.y - c.y;
    const determinant = ux * vy - uy * vx;
    if (determinant === 0) continue;
    const t = ((c.x - a.x) * vy - (c.y - a.y) * vx) / determinant;
    const s = ((c.x - a.x) * uy - (c.y - a.y) * ux) / determinant;
    if (t > 0 && t < 1 && s > 0 && s < 1) ys.add(a.y + t * uy);
  }
  const sorted = [...ys].sort((a, b) => a - b);
  let result = 0;
  for (let i = 1; i < sorted.length; i++) {
    const y = (sorted[i - 1] + sorted[i]) / 2;
    const xs = edges.filter(({ a, b }) => (a.y > y) !== (b.y > y))
      .map(({ a, b }) => a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y)).sort((a, b) => a - b);
    for (let j = 0; j < xs.length; j += 2) result += (xs[j + 1] - xs[j]) * (sorted[i] - sorted[i - 1]);
  }
  return result;
}

function semantic(rings: Point[][]): CadSemanticEntity {
  const sourceEntityId = "5:E71D75:827B85:8A871";
  return {
    source: {
      entity: { type: "hatch", sourceEntityId, layer: "FILL", loops: rings.map(ring => ({
        type: "polyline", closed: true, vertices: ring.map(p => ({ ...p, z: 0, bulge: 0 }))
      })) },
      sourceEntityId, matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, blockName: null, insertLayer: null
    },
    primitives: rings.map((ring, index) => ({
      type: "polyline", elementId: `ring-${index}`, groupId: "hatch-group", layerName: "FILL", sourceType: "HATCH",
      bounds: { minX: Math.min(...ring.map(p => p.x)), minY: Math.min(...ring.map(p => p.y)),
        maxX: Math.max(...ring.map(p => p.x)), maxY: Math.max(...ring.map(p => p.y)) },
      clipBounds: null, style: { strokeColor: "#111111", fillColor: null, strokeWidth: 1, opacity: 1 },
      geometry: { points: ring, closed: true }
    })),
    transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }
  };
}

function convert(rings: Point[][]) {
  const converter = createCadMapElementConverter({ importJobId: "test", regionBounds: { minX: 0, minY: 0, maxX: 16384, maxY: 16384 } });
  const elements = converter.convertSemanticEntity(semantic(rings));
  elements.forEach(element => mapElementSchema.parse(element));
  const metadata = converter.getMetadata();
  expect(metadata.elementCount).toBe(elements.length);
  expect(metadata.unconvertedEntityCounts).toEqual({});
  expect(metadata.unsupportedEntityCounts).toEqual({});
  expect(new Set(elements.map(e => e.id)).size).toBe(elements.length);
  expect(new Set(elements.map(e => e.groupId)).size).toBe(1);
  elements.forEach(element => {
    expect(["polygon", "polyline"]).toContain(element.type);
    expect(element.provenance?.sourceId).toBe("5:E71D75:827B85:8A871");
  });
  return elements.filter(element => element.type === "polygon");
}

describe("HATCH even-odd boundary topology", () => {
  it.each([
    { name: "bow-tie", ring: points([[0, 0], [10, 10], [0, 10], [10, 0]]) },
    { name: "second real DWG 32-point self-crossing ring", ring: points([
      [12753.505762, 2352.505386], [12753.554865, 2352.466219], [12753.612432, 2352.441094], [12753.67454, 2352.431725],
      [12753.679068, 2352.431683], [12753.736956, 2352.43875], [12753.795428, 2352.46169], [12753.84597, 2352.498983],
      [12753.885138, 2352.548085], [12753.910262, 2352.605652], [12753.919631, 2352.66776], [12753.919674, 2352.672288],
      [12753.912606, 2352.730177], [12753.889666, 2352.788649], [12753.852374, 2352.83919], [12753.505762, 2352.986598],
      [12753.171958, 2352.851998], [12753.02455, 2352.505386], [12753.15915, 2352.171583], [12753.121858, 2352.222124],
      [12753.098918, 2352.280596], [12753.09185, 2352.338485], [12753.091893, 2352.343013], [12753.101262, 2352.405121],
      [12753.126387, 2352.462688], [12753.165554, 2352.51179], [12753.216096, 2352.549083], [12753.274568, 2352.572023],
      [12753.332456, 2352.57909], [12753.336985, 2352.579048], [12753.399093, 2352.569679], [12753.456659, 2352.544554]
    ]) }
  ])("normalizes a single $name before triangulation", ({ ring }) => {
    const elements = convert([ring]);
    const actual = elements.reduce((sum, e) => sum + area(e.geometry.outer) - e.geometry.holes.reduce((a, h) => a + area(h), 0), 0);
    expect(actual).toBeCloseTo(parityArea(ring), 10);
    expect(convert([ring])).toEqual(elements);
  });

  it("preserves the exact real-DWG outer plus exterior triangle sharing an edge", () => {
    const outer = points([[13162.551669, 11584.151332], [13170.392157, 11584.151332],
      [13172.520451, 11586.585457], [13173.287423, 11589.726532], [13172.15164, 11593.493742],
      [13169.122841, 11596.005366], [13166.471913, 11596.542042], [13165.210505, 11596.424294],
      [13161.718588, 11594.610902], [13159.810924, 11591.16958], [13159.656404, 11589.726532], [13160.123324, 11587.2473]]);
    const triangle = points([[13162.551669, 11584.151332], [13166.471913, 11582.911023], [13170.392157, 11584.151332]]);
    const elements = convert([outer, triangle]);
    expect(elements.reduce((sum, e) => sum + area(e.geometry.outer) - e.geometry.holes.reduce((a, h) => a + area(h), 0), 0))
      .toBeCloseTo(area(outer) + area(triangle), 7);
    expect(elements.some(e => contains(e.geometry.outer, { x: 13166.47, y: 11583.8 }))).toBe(true);
    expect(convert([outer, triangle])).toEqual(elements);
  });

  it.each([
    { name: "exterior shared edge", rings: [square(0, 0, 10), square(10, 0, 10)], expectedArea: 200 },
    { name: "exterior shared vertex", rings: [square(0, 0, 10), square(10, 10, 10)], expectedArea: 200 },
    { name: "interior shared-edge notch", rings: [square(0, 0, 10), points([[0, 0], [5, 0], [2, 2]])], expectedArea: 95 },
    { name: "interior vertex-touching hole", rings: [square(0, 0, 10), points([[0, 5], [3, 3], [3, 7]])], expectedArea: 94 },
    { name: "crossing outer rings", rings: [square(0, 0, 10), square(5, 0, 10)], expectedArea: 100 },
    { name: "disjoint outer rings", rings: [square(0, 0, 10), square(15, 0, 10)], expectedArea: 200 },
    { name: "intersecting holes", rings: [square(0, 0, 10), square(2, 2, 4), square(4, 4, 4)], expectedArea: 76 },
    { name: "holes sharing an edge", rings: [square(0, 0, 10), square(2, 2, 2), square(4, 2, 2)], expectedArea: 92 },
    { name: "holes sharing a vertex", rings: [square(0, 0, 10), square(2, 2, 2), square(4, 4, 2)], expectedArea: 92 },
    { name: "nested holes and island", rings: [square(0, 0, 10), square(2, 2, 6), square(3, 3, 4), square(4, 4, 2)], expectedArea: 76 }
  ])("preserves strict geometry, even-odd coverage and stable IDs for $name", ({ rings, expectedArea }) => {
    const elements = convert(rings);
    expect(elements.reduce((sum, e) => sum + area(e.geometry.outer) - e.geometry.holes.reduce((a, h) => a + area(h), 0), 0)).toBeCloseTo(expectedArea, 8);
    // Independent off-grid probes detect changed coverage even when total area happens to match.
    for (let x = 0.137; x < 25; x += 0.71) for (let y = 0.293; y < 20; y += 0.83) {
      const p = { x, y };
      const expected = rings.filter(ring => contains(ring, p)).length % 2;
      const actual = elements.filter(e => contains(e.geometry.outer, p) && !e.geometry.holes.some(hole => contains(hole, p))).length;
      expect(actual).toBe(expected);
    }
    expect(convert(rings)).toEqual(elements);
    expect(new Set(convert(rings.map(ring => [...ring].reverse())).map(e => e.id))).toEqual(new Set(elements.map(e => e.id)));
  });

  it("keeps subpixel boundaries without integer quantization", () => {
    const outer = square(10000, 10000, 10);
    const attached = points([[10010, 10000], [10010 + 1e-8, 10000], [10010 + 1e-8, 10010], [10010, 10010]]);
    const elements = convert([outer, attached]);
    expect(Math.max(...elements.flatMap(e => e.geometry.outer.map(p => p.x)))).toBe(10010 + 1e-8);
    expect(elements.reduce((sum, e) => sum + area(e.geometry.outer), 0)).toBeCloseTo(100 + area(attached), 10);
  });

  it("fails explicitly on empty even-odd area and bounded clipping inputs", () => {
    expect(() => convert([square(0, 0, 10), square(0, 0, 10)])).toThrow(/empty even-odd/);
    expect(() => resolveCadHatchRegions([Array.from({ length: MAP_ELEMENT_MAX_POINTS + 1 }, (_, i) => ({ x: i, y: i % 2 }))]))
      .toThrow(/point limit/);
  });

  it("binds split HATCH fill and real boundaries to canonical IDs without artificial stroked diagonals", () => {
    const rings = [square(10, 10, 10), points([[10, 15], [13, 13], [13, 17]]), square(40, 10, 10)];
    const input = semantic(rings).source.entity;
    const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const adapter = createCadMapElementConverter({ importJobId: "test", regionBounds: bounds });
    const elements: ReturnType<typeof adapter.convertSemanticEntity> = [];
    const scene = buildCadScene({ version: 1, bounds, entities: [input], blocks: [] }, {
      regionId: "r", bounds, primitiveCount: 3, textCount: 0, lightCandidateCount: 0, area: 10000
    }, { sceneId: "00000000-0000-4000-8000-000000000101", onSemanticEntity: value => {
      const converted = adapter.convertSemanticEntity(value);
      elements.push(...converted);
      return converted;
    } });
    const primitives = scene.tiles.flatMap(tile => decodeCadSceneTile(tile.payload, tile.descriptor));
    expect(new Set(primitives.map(p => p.elementId))).toEqual(new Set(elements.map(e => e.id)));
    expect(elements.some(e => e.type === "polyline")).toBe(true);
    const fills = elements.filter(e => e.type === "polygon" && e.style.strokeColor === null);
    expect(fills.length).toBeGreaterThan(1);
    for (const fill of fills) {
      const display = primitives.filter(p => p.elementId === fill.id);
      expect(display.length).toBeGreaterThan(0);
      expect(display.every(p => p.type === "triangle" && p.style.strokeColor === null)).toBe(true);
    }
    for (const primitive of primitives) expect(primitive.groupId).toBe(elements.find(e => e.id === primitive.elementId)!.groupId);
  });
});
