import { describe, expect, it } from "vitest";
import type { MapElement, MapElementOp, MapShape } from "@led-control/shared";
import { applyMapOps, MapElementIdentityError } from "./map-element-commands";

function element(id = "a", shape: MapShape = {
  type: "line", geometry: { start: { x: 1, y: 2 }, end: { x: 5, y: 8 } }
}): MapElement {
  return {
    id, groupId: "group", layerId: "layer", zIndex: 3, visible: true, locked: false,
    transform: { x: 10, y: 20, scaleX: 2, scaleY: 3, rotation: 45 },
    style: { strokeColor: "#123456", fillColor: "#abcdef", strokeWidth: 2, opacity: 0.5 },
    provenance: { importJobId: "import", sourceId: "source" }, ...shape
  };
}

const shapes: MapShape[] = [
  { type: "line", geometry: { start: { x: 0, y: 0 }, end: { x: 1, y: 2 } } },
  { type: "rectangle", geometry: { origin: { x: 1, y: 2 }, width: 10, height: 20 } },
  { type: "triangle", geometry: { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }] } },
  { type: "ellipse", geometry: { center: { x: 3, y: 4 }, radiusX: 4, radiusY: 2 } },
  { type: "arc", geometry: { center: { x: 2, y: 3 }, radius: 4, startAngle: 10, endAngle: 180, counterClockwise: true } },
  { type: "polyline", geometry: { points: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 9, y: 2 }] } },
  { type: "polygon", geometry: {
    outer: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
    holes: [[{ x: 2, y: 2 }, { x: 2, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 2 }]]
  } },
  { type: "text", geometry: { position: { x: 1, y: 2 }, text: "label", width: 40, height: 20, fontSize: 12 } }
];

describe("applyMapOps", () => {
  it("preserves an empty input for an empty batch", () => {
    const input = new Map<string, MapElement>();
    expect(applyMapOps(input, [])).toEqual({ elements: input, inverse: [] });
    expect(applyMapOps(input, []).elements).toBe(input);
  });

  it("adds without changing the input and produces a delete inverse", () => {
    const input = new Map<string, MapElement>();
    const added = element();
    const result = applyMapOps(input, [{ kind: "add", element: added }]);
    expect(input.size).toBe(0);
    expect(result.elements.get("a")).toEqual(added);
    expect(result.inverse).toEqual([{ kind: "delete", id: "a" }]);
    expect(applyMapOps(result.elements, result.inverse).elements.size).toBe(0);
  });

  it.each(shapes)("restores full $type geometry and metadata after delete", (shape) => {
    const before = element("a", shape);
    const input = new Map([[before.id, before]]);
    const result = applyMapOps(input, [{ kind: "delete", id: before.id }]);
    expect(input.get("a")).toEqual(before);
    expect(result.elements.has("a")).toBe(false);
    expect(result.inverse).toEqual([{ kind: "add", element: before }]);
    expect(applyMapOps(result.elements, result.inverse).elements).toEqual(input);
  });

  it("replaces the full element and restores absent optional provenance and group", () => {
    const before = { ...element(), groupId: null, provenance: null };
    const replacement = element("a", shapes[6]);
    const input = new Map([["a", before]]);
    const result = applyMapOps(input, [{ kind: "update", element: replacement }]);
    expect(result.elements.get("a")).toEqual(replacement);
    expect(result.inverse).toEqual([{ kind: "update", element: before }]);
    expect(applyMapOps(result.elements, result.inverse).elements).toEqual(input);
  });

  it("reverses a mixed aggregate batch in command order", () => {
    const a = element("a");
    const b = element("b");
    const updated = { ...b, groupId: "new-group", zIndex: 100 };
    const c = element("c");
    const input = new Map([[a.id, a], [b.id, b]]);
    const operations: MapElementOp[] = [
      { kind: "delete", id: a.id }, { kind: "update", element: updated }, { kind: "add", element: c }
    ];
    const original = structuredClone(operations);
    const result = applyMapOps(input, operations);
    expect(result.inverse).toEqual([
      { kind: "delete", id: c.id }, { kind: "update", element: b }, { kind: "add", element: a }
    ]);
    expect(applyMapOps(result.elements, result.inverse).elements).toEqual(input);
    expect(operations).toEqual(original);
  });

  it("supports sequential local commands for the same identity", () => {
    const a = element();
    const changed = { ...a, visible: false };
    const result = applyMapOps(new Map(), [
      { kind: "add", element: a }, { kind: "update", element: changed }, { kind: "delete", id: a.id }
    ]);
    expect(result.elements.size).toBe(0);
    expect(result.inverse).toEqual([
      { kind: "add", element: changed }, { kind: "update", element: a }, { kind: "delete", id: a.id }
    ]);
    expect(applyMapOps(result.elements, result.inverse).elements.size).toBe(0);
  });

  it.each([
    { operation: { kind: "add", element: element() }, present: true, code: "MAP_ELEMENT_EXISTS" },
    { operation: { kind: "update", element: element() }, present: false, code: "MAP_ELEMENT_MISSING" },
    { operation: { kind: "delete", id: "a" }, present: false, code: "MAP_ELEMENT_MISSING" }
  ] as const)("rejects $code for $operation.kind without partial changes", ({ operation, present, code }) => {
    const input = new Map<string, MapElement>(present ? [["a", element()]] : []);
    const original = structuredClone(input);
    const run = () => applyMapOps(input, [{ kind: "add", element: element("valid-first") }, operation]);
    expect(run).toThrow(MapElementIdentityError);
    expect(run).toThrow(expect.objectContaining({ code, elementId: "a" }));
    expect(input).toEqual(original);
  });

  it("only needs the loaded subset and shares untouched canonical elements", () => {
    const untouched = element("untouched");
    const input = new Map([["a", element()], [untouched.id, untouched]]);
    const result = applyMapOps(input, [{ kind: "delete", id: "a" }]);
    // Group/layer records and the other 499,998 elements are deliberately absent.
    expect(result.elements.get(untouched.id)).toBe(untouched);
    expect(result.elements.size).toBe(1);
  });

  it("detaches changed elements and inverse payloads from caller-owned data", () => {
    const before = element();
    const replacement = element();
    const result = applyMapOps(new Map([["a", before]]), [{ kind: "update", element: replacement }]);
    before.style.opacity = 0;
    replacement.transform.x = 999;
    expect(result.elements.get("a")!.transform.x).toBe(10);
    expect(result.inverse[0]).toMatchObject({ element: { style: { opacity: 0.5 } } });
    result.elements.get("a")!.style.strokeWidth = 20;
    expect(replacement.style.strokeWidth).toBe(2);
  });
});
