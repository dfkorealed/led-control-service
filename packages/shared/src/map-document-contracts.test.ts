import { describe, expect, it } from "vitest";
import {
  mapElementSchema, mapMutationSchema, mapDocumentRefSchema,
  mapMutationResultSchema, mapDocumentStateSchema, validateMapOperations,
  type MapElement, type MapShape
} from "./map-document-contracts";

const point = (x: number, y: number) => ({ x, y });
const square = (x = 0, y = 0, size = 10) => [
  point(x, y), point(x + size, y), point(x + size, y + size), point(x, y + size)
];
const shapes: MapShape[] = [
  { type: "line", geometry: { start: point(0, 0), end: point(10, 0) } },
  { type: "rectangle", geometry: { origin: point(0, 0), width: 10, height: 20 } },
  { type: "triangle", geometry: { points: [point(0, 0), point(10, 0), point(0, 10)] } },
  { type: "ellipse", geometry: { center: point(0, 0), radiusX: 10, radiusY: 5 } },
  { type: "arc", geometry: { center: point(0, 0), radius: 10, startAngle: 0, endAngle: 90, counterClockwise: true } },
  { type: "polyline", geometry: { points: [point(0, 0), point(10, 0)] } },
  { type: "polygon", geometry: { outer: square(), holes: [square(2, 2, 2)] } },
  { type: "text", geometry: { position: point(0, 0), text: "LED", width: 30, height: 12, fontSize: 12 } }
];
function element(shape: MapShape = shapes[0]): MapElement {
  return { ...shape, id: "e", groupId: null, layerId: "layer", zIndex: 0, visible: true,
    locked: false, transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    style: { strokeColor: "#123456", fillColor: null, strokeWidth: 1, opacity: 1 }, provenance: null };
}
const mutation = (operations: unknown[]) => ({
  requestId: "r", generationId: "g", baseRevision: 0, leaseToken: "lease", operations
});
const layer = { id: "layer", name: "Layer", order: 0, visible: true, locked: false };
const group = { id: "group", parentId: null, name: "Group", visible: true, locked: false };
const document = () => ({ elements: [element()], groups: [group], layers: [layer] });

describe("common map elements", () => {
  it.each(shapes)("accepts neutral $type geometry without requiring CAD provenance", (shape) => {
    expect(mapElementSchema.parse(element(shape))).toEqual(element(shape));
  });
  it("preserves optional import provenance and text including whitespace", () => {
    const value = { ...element(shapes[7]), provenance: { importJobId: "job", sourceId: "source" } };
    expect(mapElementSchema.parse(value).provenance).toEqual(value.provenance);
    expect(mapElementSchema.safeParse(element({ type: "text", geometry: {
      position: point(0, 0), text: "", width: 0, height: 0, fontSize: 12
    } })).success).toBe(true);
  });
  it.each(["cad", "hatch", "circle"])("rejects the non-neutral type %s", (type) => {
    expect(mapElementSchema.safeParse({ ...element(), type }).success).toBe(false);
  });
  it("rejects client bounds, extra fields and duplicate geometry rotation", () => {
    for (const extra of [{ bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } }, { sourceType: "LINE" }]) {
      expect(mapElementSchema.safeParse({ ...element(), ...extra }).success).toBe(false);
    }
    const rectangle = element(shapes[1]);
    expect(mapElementSchema.safeParse({ ...rectangle, geometry: { ...rectangle.geometry, rotation: 90 } }).success).toBe(false);
    expect(mapElementSchema.safeParse({ ...element(), transform: { ...element().transform, pivot: point(0, 0) } }).success).toBe(false);
    expect(mapElementSchema.safeParse({ ...element(), style: { ...element().style, dash: [] } }).success).toBe(false);
    expect(mapElementSchema.safeParse({ ...element(), provenance: { importJobId: "j", sourceId: "s", extra: true } }).success).toBe(false);
  });
  it.each([NaN, Infinity, -Infinity])("rejects non-finite numeric input %s", (value) => {
    expect(mapElementSchema.safeParse(element({ type: "line", geometry: { start: point(value, 0), end: point(1, 1) } })).success).toBe(false);
    expect(mapElementSchema.safeParse({ ...element(), zIndex: value }).success).toBe(false);
    expect(mapElementSchema.safeParse({ ...element(), transform: { ...element().transform, x: value } }).success).toBe(false);
  });
  it.each([0, -1])("rejects non-positive dimensions %s", (value) => {
    for (const shape of [
      { type: "rectangle", geometry: { origin: point(0, 0), width: value, height: 1 } },
      { type: "ellipse", geometry: { center: point(0, 0), radiusX: 1, radiusY: value } },
      { type: "arc", geometry: { center: point(0, 0), radius: value, startAngle: 0, endAngle: 90, counterClockwise: true } },
      { type: "text", geometry: { position: point(0, 0), text: "a", width: 1, height: 1, fontSize: value } }
    ]) expect(mapElementSchema.safeParse({ ...element(), ...shape }).success).toBe(false);
  });
  it("rejects degenerate lines, triangles and polylines", () => {
    for (const shape of [
      { type: "line", geometry: { start: point(1, 1), end: point(1, 1) } },
      { type: "triangle", geometry: { points: [point(0, 0), point(1, 1), point(2, 2)] } },
      { type: "polyline", geometry: { points: [point(1, 1), point(1, 1)] } }
    ]) expect(mapElementSchema.safeParse({ ...element(), ...shape }).success).toBe(false);
  });
  it("rejects invalid transforms, style, identifiers and malformed Unicode", () => {
    for (const transform of [{ scaleX: 0 }, { scaleY: -1 }, { scaleX: 101 }, { rotation: 361 }]) {
      expect(mapElementSchema.safeParse({ ...element(), transform: { ...element().transform, ...transform } }).success).toBe(false);
    }
    for (const style of [{ strokeWidth: -1 }, { opacity: 1.01 }, { fillColor: "red" }]) {
      expect(mapElementSchema.safeParse({ ...element(), style: { ...element().style, ...style } }).success).toBe(false);
    }
    for (const id of ["", " ", "x".repeat(513), "\ud800"]) {
      expect(mapElementSchema.safeParse({ ...element(), id }).success).toBe(false);
    }
    expect(mapElementSchema.safeParse({ ...element(), id: "x".repeat(512) }).success).toBe(true);
    expect(mapElementSchema.safeParse({ ...element(), style: { ...element().style, fillColor: "#AABBCCDD" } }).success).toBe(true);
  });
  it("enforces total point and text budgets without truncation", () => {
    const points = Array.from({ length: 65_536 }, (_, x) => point(x, 0));
    expect(mapElementSchema.safeParse(element({ type: "polyline", geometry: { points } })).success).toBe(true);
    expect(mapElementSchema.safeParse(element({ type: "polyline", geometry: { points: [...points, point(65_536, 0)] } })).success).toBe(false);
    const text = (value: string) => element({ type: "text", geometry: { position: point(0, 0), text: value, width: 1, height: 1, fontSize: 1 } });
    expect(mapElementSchema.safeParse(text("x".repeat(65_536))).success).toBe(true);
    expect(mapElementSchema.safeParse(text("x".repeat(65_537))).success).toBe(false);
    expect(mapElementSchema.safeParse(text("\ud800")).success).toBe(false);
    expect(mapElementSchema.safeParse(element({ type: "polygon", geometry: {
      outer: square(), holes: Array.from({ length: 16_384 }, () => square(1, 1, 1))
    } })).success).toBe(false);
  });
  it("rejects finite inputs whose transformed bounds overflow", () => {
    expect(mapElementSchema.safeParse({ ...element(), transform: { ...element().transform, scaleX: 100 },
      geometry: { start: point(1e308, 0), end: point(1e308, 1) } }).success).toBe(false);
  });
});

describe("polygon topology", () => {
  const parse = (outer: ReturnType<typeof square>, holes: ReturnType<typeof square>[] = []) =>
    mapElementSchema.safeParse(element({ type: "polygon", geometry: { outer, holes } })).success;
  it("accepts either winding and multiple disjoint interior rings", () => {
    expect(parse(square(), [square(1, 1, 2).reverse(), square(6, 6, 2)])).toBe(true);
    expect(parse(square().reverse(), [square(1, 1, 2)])).toBe(true);
  });
  it.each([
    [point(0, 0), point(1, 1)],
    [point(0, 0), point(1, 1), point(2, 2)],
    [point(0, 0), point(4, 4), point(0, 4), point(4, 0)],
    [point(0, 0), point(5, 0), point(3, 0), point(3, 5), point(0, 5)],
    [...square(), point(0, 0)],
    [point(0, 0), point(5, 0), point(5, 5), point(0, 5), point(5, 0)]
  ].map((outer) => [outer]))("rejects malformed or self-intersecting rings %#", (outer) => {
    expect(parse(outer)).toBe(false);
    expect(parse(square(-10, -10, 30), [outer])).toBe(false);
  });
  it("rejects exterior, touching, crossing, overlapping and nested holes", () => {
    for (const holes of [[square(12, 1, 1)], [square(0, 1, 1)], [square(9, 1, 2)],
      [square(1, 1, 4), square(3, 3, 4)], [square(1, 1, 6), square(2, 2, 1)],
      [square(1, 1, 2), square(3, 1, 2)]]) expect(parse(square(), holes)).toBe(false);
  });
  it("rejects a hole crossing a concave exterior even when all hole vertices are inside", () => {
    const outer = [point(0, 0), point(10, 0), point(10, 10), point(7, 10), point(7, 3), point(3, 3), point(3, 10), point(0, 10)];
    expect(parse(outer, [[point(1, 1), point(9, 1), point(9, 8), point(1, 8)]])).toBe(false);
  });
  it("fails explicitly within a bounded work budget for adversarial valid rings", () => {
    const outer = [point(0, 0), point(10, 0)];
    for (let y = 1; y <= 4_000; y++) {
      outer.push(point(y % 2 ? 10 : 1, y), point(y % 2 ? 1 : 10, y));
    }
    outer.push(point(0, 4_001));
    const result = mapElementSchema.safeParse(element({ type: "polygon", geometry: { outer, holes: [] } }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.message.includes("검증 연산 한도"))).toBe(true);
  });
});

describe("map operations and document contracts", () => {
  it("accepts all element and structure operations with namespaced IDs", () => {
    expect(mapMutationSchema.safeParse(mutation([
      { kind: "add", element: element() }, { kind: "update", element: { ...element(), id: "e2" } },
      { kind: "delete", id: "e3" }, { kind: "group.put", group: { ...group, id: "e" } },
      { kind: "group.delete", id: "g2" }, { kind: "layer.put", layer: { ...layer, id: "e" } },
      { kind: "layer.delete", id: "l2" }
    ])).success).toBe(true);
  });
  it("rejects duplicate target IDs across kinds in the same namespace", () => {
    for (const operations of [
      [{ kind: "add", element: element() }, { kind: "delete", id: "e" }],
      [{ kind: "update", element: element() }, { kind: "update", element: element() }],
      [{ kind: "group.put", group }, { kind: "group.delete", id: "group" }],
      [{ kind: "layer.put", layer }, { kind: "layer.delete", id: "layer" }]
    ]) expect(mapMutationSchema.safeParse(mutation(operations)).success).toBe(false);
  });
  it("rejects empty operations, negative/exhausted revisions and extra envelope fields", () => {
    const valid = mutation([{ kind: "delete", id: "e" }]);
    for (const value of [mutation([]), { ...valid, baseRevision: -1 }, { ...valid, baseRevision: 2_147_483_647 },
      { ...valid, bounds: [] }, { ...valid, requestId: "" }, { ...valid, leaseToken: "" },
      mutation([{ kind: "delete", id: "e", element: element() }])]) {
      expect(mapMutationSchema.safeParse(value).success).toBe(false);
    }
  });
  it("enforces 2000 operations and the full UTF-8 1 MiB envelope", () => {
    const operations = Array.from({ length: 2_000 }, (_, i) => ({ kind: "delete", id: `e${i}` }));
    expect(mapMutationSchema.safeParse(mutation(operations)).success).toBe(true);
    expect(mapMutationSchema.safeParse(mutation([...operations, { kind: "delete", id: "extra" }])).success).toBe(false);
    const large = Array.from({ length: 8 }, (_, i) => ({ kind: "add", element: { ...element({ type: "text", geometry: {
      position: point(0, 0), text: "\uac00".repeat(65_536), width: 1, height: 1, fontSize: 1
    } }), id: `e${i}` } }));
    expect(mapElementSchema.safeParse(large[0].element).success).toBe(true);
    expect(mapMutationSchema.safeParse(mutation(large)).success).toBe(false);
  });
  it("validates final document references and rejects group cycles and duplicate IDs", () => {
    expect(mapDocumentStateSchema.safeParse(document()).success).toBe(true);
    for (const value of [
      { ...document(), layers: [] },
      { ...document(), elements: [{ ...element(), groupId: "missing" }] },
      { ...document(), groups: [{ ...group, parentId: "missing" }] },
      { ...document(), groups: [{ ...group, parentId: "group" }] },
      { ...document(), groups: [{ ...group, parentId: "b" }, { ...group, id: "b", parentId: "group" }] },
      { ...document(), elements: [element(), element()] },
      { ...document(), groups: [group, group] }, { ...document(), layers: [layer, layer] }
    ]) expect(mapDocumentStateSchema.safeParse(value).success).toBe(false);
  });
  it("checks operation existence and final references without mutating its document", () => {
    const state = document();
    for (const operations of [
      [{ kind: "add", element: element() }], [{ kind: "update", element: { ...element(), id: "missing" } }],
      [{ kind: "delete", id: "missing" }], [{ kind: "group.delete", id: "missing" }],
      [{ kind: "layer.delete", id: "layer" }], [{ kind: "layer.delete", id: "missing" }]
    ]) expect(() => validateMapOperations(state, operations)).toThrow();
    expect(() => validateMapOperations(state, [
      { kind: "layer.delete", id: "layer" }, { kind: "delete", id: "e" }
    ])).not.toThrow();
    expect(() => validateMapOperations(state, [
      { kind: "update", element: { ...element(), layerId: "new" } },
      { kind: "layer.put", layer: { ...layer, id: "new" } }
    ])).not.toThrow();
    expect(state).toEqual(document());
  });
  it("validates document assets, logical sizes, generations and derived bounds", () => {
    const ref = { formatVersion: 1, generationId: "g", revision: 0, width: 16_384, height: 1_024,
      gridSize: 80, elementCount: 1, manifest: { assetId: "asset", sha256: "a".repeat(64), byteSize: 100, decodedByteSize: 200 } };
    expect(mapDocumentRefSchema.safeParse(ref).success).toBe(true);
    for (const value of [{ ...ref, width: 32_769 }, { ...ref, height: 511 }, { ...ref, elementCount: 1_000_001 },
      { ...ref, formatVersion: 2 }, { ...ref, gridSize: 0 }, { ...ref, manifest: { ...ref.manifest, sha256: "invalid" } },
      { ...ref, manifest: { ...ref.manifest, decodedByteSize: 0 } }]) {
      expect(mapDocumentRefSchema.safeParse(value).success).toBe(false);
    }
    expect(mapMutationResultSchema.safeParse({ document: ref, changedBounds: [{ minX: 0, minY: 0, maxX: 1, maxY: 0 }] }).success).toBe(true);
    expect(mapMutationResultSchema.safeParse({ document: ref, changedBounds: [{ minX: 1, minY: 0, maxX: 0, maxY: 1 }] }).success).toBe(false);
  });
});
