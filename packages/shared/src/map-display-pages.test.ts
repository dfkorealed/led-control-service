import { describe, expect, it } from "vitest";
import { mapDisplayFragmentSignature, validateMapDisplayPageContent } from "./map-display-pages";
import type { OrderedMapDisplayPrimitive } from "./map-display-contracts";

const p: OrderedMapDisplayPrimitive = { type: "triangle", elementId: "e", groupId: null, layerName: "raw",
  sourceType: "polygon", zIndex: 0, fragmentOrder: 0, bounds: { minX: 0, minY: 0, maxX: 2, maxY: 2 }, clipBounds: null,
  style: { fillColor: "#ff0000", strokeColor: null, strokeWidth: 1, opacity: 0.5 },
  geometry: { points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }] } };
const key = { zIndex: 0, elementId: "e", fragmentOrder: 0 };
const page = { layerId: "canonical", sequence: 0, primitiveStart: 0, primitiveCount: 1, firstKey: key, lastKey: key };
const tile = { primitiveCount: 1, pages: [page] };
const layer = (name: string) => name === "raw" ? "canonical" : undefined;

describe("ordered page content", () => {
  it("checks content against ranges and canonical layer bindings", () => {
    expect(() => validateMapDisplayPageContent(tile, [p], layer)).not.toThrow();
    for (const patch of [{ layerName: "other" }, { elementId: "wrong" }, { zIndex: 1 }, { fragmentOrder: 1 }]) {
      expect(() => validateMapDisplayPageContent(tile, [{ ...p, ...patch }], layer)).toThrow();
    }
    expect(() => validateMapDisplayPageContent(tile, [], layer)).toThrow();
    expect(() => validateMapDisplayPageContent({ ...tile, pages: [] }, [p], layer)).toThrow();
    expect(() => validateMapDisplayPageContent({ ...tile, pages: [{ ...page, primitiveStart: 1 }] }, [p], layer)).toThrow();
  });
  it("rejects unsorted content even when the endpoints are forged consistently", () => {
    const last = { ...key, fragmentOrder: 1 };
    expect(() => validateMapDisplayPageContent({ primitiveCount: 2, pages: [{ ...page, primitiveCount: 2,
      firstKey: last, lastKey: key }] }, [{ ...p, fragmentOrder: 1 }, p], layer)).toThrow(/order/);
  });
  it("validates declared canonical fill continuation and path scratch counts", () => {
    const group = { id: "fill-e", elementId: "e", phase: "fill" as const, sequence: 0, final: true, pointCount: 3,
      style: { fillColor: "#ff0000", opacity: 0.5 } };
    const grouped = { ...tile, pages: [{ ...page, paintGroup: group }] };
    expect(() => validateMapDisplayPageContent(grouped, [p], layer)).not.toThrow();
    expect(() => validateMapDisplayPageContent({ ...tile, pages: [{ ...page, paintGroup: { ...group, pointCount: 4 } }] }, [p], layer)).toThrow(/point count/);
    expect(() => validateMapDisplayPageContent(grouped, [{ ...p, style: { ...p.style, strokeColor: "#ff0000" } }], layer)).toThrow(/fill group/);
  });
  it.each([{ fillColor: "#0000ff" }, { opacity: 1 }])("rejects changed continuation style across logical and physical boundaries %j", patch => {
    const group = { id: "fill-e", elementId: "e", phase: "fill" as const, sequence: 0, final: false, pointCount: 3,
      style: { fillColor: "#ff0000", opacity: 0.5 } };
    const first = { ...page, paintGroup: group };
    const second = { ...page, sequence: 1, firstKey: { ...key, fragmentOrder: 1 }, lastKey: { ...key, fragmentOrder: 1 },
      paintGroup: { ...group, sequence: 1, final: true } };
    const unchanged = { ...p, fragmentOrder: 1 };
    const changed = { ...unchanged, style: { ...p.style, ...patch } };
    expect(() => validateMapDisplayPageContent({ primitiveCount: 2, pages: [first, { ...second, primitiveStart: 1 }] }, [p, unchanged], layer)).not.toThrow();
    expect(() => validateMapDisplayPageContent({ primitiveCount: 2, pages: [first, { ...second, primitiveStart: 1 }] }, [p, changed], layer)).toThrow(/fill group/);
    expect(() => validateMapDisplayPageContent({ primitiveCount: 1, pages: [first] }, [p], layer)).not.toThrow();
    expect(() => validateMapDisplayPageContent({ primitiveCount: 1, pages: [second] }, [unchanged], layer)).not.toThrow();
    expect(() => validateMapDisplayPageContent({ primitiveCount: 1, pages: [second] }, [changed], layer)).toThrow(/fill group/);
  });
  it("identifies exact copied geometry independent of property insertion order, excluding only clip/bounds", () => {
    const copy = { ...p, bounds: { minX: 1, minY: 0, maxX: 2, maxY: 2 },
      clipBounds: { minX: 1, minY: 0, maxX: 512, maxY: 512 },
      geometry: { points: p.geometry.points.map(({ x, y }) => ({ y, x })) as typeof p.geometry.points } };
    expect(mapDisplayFragmentSignature(copy)).toBe(mapDisplayFragmentSignature(p));
    expect(mapDisplayFragmentSignature({ ...p, style: { ...p.style, opacity: 1 } })).not.toBe(mapDisplayFragmentSignature(p));
  });
});
