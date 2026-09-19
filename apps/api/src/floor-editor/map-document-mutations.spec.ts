import { MapElement, MapOp } from "@led-control/shared";
import { planMapChanges } from "./map-document-mutations";

const layer = { id: "map", name: "Map", order: 0, locked: false, visible: true };
const group = { id: "g", name: "Group", parentId: null, locked: false, visible: true };
const element = (id = "a"): MapElement => ({ id, type: "rectangle", geometry: { origin: { x: 20, y: 20 }, width: 20, height: 20 },
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, groupId: null, layerId: "map", zIndex: 0,
  visible: true, locked: false, style: { strokeWidth: 1, strokeColor: "#000000", fillColor: null, opacity: 1 }, provenance: null });
const plan = (operations: MapOp[], elements: MapElement[] = [element()], groups = [group], layers = [layer]) =>
  planMapChanges({ width: 1200, height: 800, elementCount: elements.length }, { elements, groups, layers }, operations);

describe("normal sparse map mutation plan", () => {
  it("builds exact inverse and bounds without mutating originals", () => {
    const original = element();
    const next = { ...original, transform: { ...original.transform, x: 50 } };
    const result = plan([{ kind: "update", element: next }], [original]);
    expect(result.inverse).toEqual([{ kind: "update", element: original }]);
    expect(result.changedBounds).toHaveLength(2);
    expect(original.transform.x).toBe(0);
    expect(result.elementCount).toBe(1);
  });
  it("supports no geometry operations for the same atomic revision", () => {
    expect(plan([])).toMatchObject({ operations: [], inverse: [], elementCount: 1 });
  });
  it("rejects missing references and nonexistent updates/deletes", () => {
    for (const operations of [[{ kind: "delete", id: "missing" }], [{ kind: "add", element: { ...element("b"), layerId: "missing" } }]]) {
      expect(() => plan(operations as MapOp[])).toThrow();
    }
  });
  it("requires descendants to be deleted together and makes an exact structure inverse", () => {
    const child = { ...element(), groupId: "g" };
    expect(() => plan([{ kind: "group.delete", id: "g" }], [child])).toThrow();
    const result = plan([{ kind: "delete", id: "a" }, { kind: "group.delete", id: "g" }], [child]);
    expect(result.inverse).toEqual([{ kind: "group.put", group }, { kind: "add", element: child }]);
  });
  it("enforces locked ancestors and layer locks, but permits an explicit unlock alone", () => {
    expect(() => plan([{ kind: "delete", id: "a" }], [{ ...element(), groupId: "g" }], [{ ...group, locked: true }])).toThrow(/locked/);
    expect(() => plan([{ kind: "delete", id: "a" }], [element()], [group], [{ ...layer, locked: true }])).toThrow(/locked/);
    expect(() => plan([{ kind: "update", element: { ...element(), locked: false } }], [{ ...element(), locked: true }])).not.toThrow();
    expect(() => plan([{ kind: "update", element: { ...element(), zIndex: 1 } }], [{ ...element(), locked: true }])).toThrow(/locked/);
  });
  it("checks final transformed bounds and cycles", () => {
    expect(() => plan([{ kind: "add", element: { ...element("b"), transform: { ...element().transform, x: 1190 } } }])).toThrow(/bounds/);
    expect(() => plan([{ kind: "group.put", group: { ...group, parentId: "g" } }])).toThrow();
  });
});
