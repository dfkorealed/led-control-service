import { describe, expect, it } from "vitest";
import type { MapElement, MapElementOp, MapOp } from "@led-control/shared";
import { applyMapOps } from "./map-element-commands";
import { MapElementHistory, MapElementHistoryCapacityError } from "./map-element-history";

const MAX_BYTES = 32 * 1_024 * 1_024;
const forward = (id = "group"): MapOp[] => [{
  kind: "group.put", group: { id, name: id, parentId: null, locked: false, visible: true }
}];
const inverse = (id = "group"): MapOp[] => [{ kind: "group.delete", id }];
const bytes = (f: MapOp[], i: MapOp[]) =>
  new TextEncoder().encode(JSON.stringify(f)).byteLength + new TextEncoder().encode(JSON.stringify(i)).byteLength;

function textElement(id: string, text = "text"): MapElement {
  return {
    id, type: "text", geometry: { position: { x: 0, y: 0 }, text, width: 100, height: 20, fontSize: 12 },
    groupId: "group", layerId: "layer", zIndex: 0, visible: true, locked: false,
    style: { strokeColor: "#123456", fillColor: null, strokeWidth: 1, opacity: 1 },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, provenance: null
  };
}

function largeBatch(count: number): MapOp[] {
  const text = "\uac00".repeat(65_536);
  return Array.from({ length: count }, (_, index) => ({ kind: "add", element: textElement(`text-${index}`, text) }));
}

describe("MapElementHistory", () => {
  it("starts clean with no undo/redo or retained bytes", () => {
    const history = new MapElementHistory();
    expect([history.canUndo, history.canRedo, history.isDirty, history.byteSize]).toEqual([false, false, false, 0]);
    expect(history.undo()).toBeNull();
    expect(history.redo()).toBeNull();
  });

  it("keeps each batch as one entry and returns commands, not map snapshots", () => {
    const history = new MapElementHistory();
    const f = [...forward("a"), ...forward("b")];
    const i = [...inverse("b"), ...inverse("a")];
    history.execute(f, i);
    expect(history.isDirty).toBe(true);
    expect(history.byteSize).toBe(bytes(f, i));
    expect(history.undo()).toEqual(i);
    expect(history.isDirty).toBe(false);
    expect(history.undo()).toBeNull();
    expect(history.redo()).toEqual(f);
    expect(history.isDirty).toBe(true);
    expect(history.redo()).toBeNull();
  });

  it("supports every structure operation in a mixed element transaction", () => {
    const history = new MapElementHistory();
    const f: MapOp[] = [
      { kind: "layer.put", layer: { id: "layer", name: "Layer", order: 0, locked: false, visible: true } },
      ...forward(), { kind: "add", element: textElement("text") },
      { kind: "group.delete", id: "old-group" }, { kind: "layer.delete", id: "old-layer" }
    ];
    const i: MapOp[] = [
      { kind: "layer.put", layer: { id: "old-layer", name: "Old", order: 1, locked: false, visible: true } },
      ...forward("old-group"), { kind: "delete", id: "text" }, ...inverse(), { kind: "layer.delete", id: "layer" }
    ];
    history.execute(f, i);
    expect(history.undo()).toEqual(i);
    expect(history.redo()).toEqual(f);
  });

  it("keeps save -> undo dirty and undo -> redo exactly at the saved baseline clean", () => {
    const history = new MapElementHistory();
    history.execute(forward(), inverse());
    const size = history.byteSize;
    history.adoptSavedBaseline();
    expect(history.isDirty).toBe(false);
    expect(history.canUndo).toBe(true);
    history.undo();
    expect(history.isDirty).toBe(true);
    history.redo();
    expect(history.isDirty).toBe(false);
    expect(history.byteSize).toBe(size);
  });

  it("does not mistake a fork at the saved index for the saved state", () => {
    const history = new MapElementHistory();
    history.execute(forward("a"), inverse("a"));
    history.adoptSavedBaseline();
    history.undo();
    history.execute(forward("b"), inverse("b"));
    expect(history.canRedo).toBe(false);
    expect(history.isDirty).toBe(true);
    history.undo();
    expect(history.isDirty).toBe(true);
    history.redo();
    expect(history.isDirty).toBe(true);
  });

  it("can save at an undone position without losing redo", () => {
    const history = new MapElementHistory();
    history.execute(forward("a"), inverse("a"));
    history.execute(forward("b"), inverse("b"));
    history.undo();
    history.adoptSavedBaseline();
    expect(history.canRedo).toBe(true);
    history.redo();
    expect(history.isDirty).toBe(true);
    history.undo();
    expect(history.isDirty).toBe(false);
  });

  it("does not lose redo, bytes or the saved baseline on an empty execute", () => {
    const history = new MapElementHistory();
    history.execute(forward(), inverse());
    history.undo();
    const size = history.byteSize;
    history.execute([], []);
    expect(history.byteSize).toBe(size);
    expect(history.isDirty).toBe(false);
    expect(history.redo()).toEqual(forward());
  });

  it.each([true, false])("rejects a one-sided batch before changing history (forward empty: %s)", (emptyForward) => {
    const history = new MapElementHistory();
    history.execute(forward(), inverse());
    history.undo();
    const size = history.byteSize;
    expect(() => history.execute(emptyForward ? [] : forward(), emptyForward ? inverse() : [])).toThrow(RangeError);
    expect(history.byteSize).toBe(size);
    expect(history.isDirty).toBe(false);
    expect(history.redo()).toEqual(forward());
  });

  it("isolates nested input and undo/redo results from internal command snapshots", () => {
    const history = new MapElementHistory();
    const f: MapOp[] = [{ kind: "add", element: textElement("a") }, ...forward()];
    const i: MapOp[] = [{ kind: "update", element: textElement("a", "old") }, ...inverse()];
    const expectedF = structuredClone(f);
    const expectedI = structuredClone(i);
    history.execute(f, i);
    const size = history.byteSize;
    if (f[0].kind === "add") f[0].element.transform.x = 900;
    if (f[1].kind === "group.put") f[1].group.name = "mutated";
    if (i[0].kind === "update") i[0].element.style.opacity = 0;
    f.length = 0;
    i.length = 0;
    const undone = history.undo()!;
    expect(undone).toEqual(expectedI);
    if (undone[0].kind === "update") undone[0].element.style.opacity = 0;
    undone.pop();
    const redone = history.redo()!;
    expect(redone).toEqual(expectedF);
    if (redone[0].kind === "add") redone[0].element.transform.x = 900;
    redone.pop();
    expect(history.undo()).toEqual(expectedI);
    expect(history.redo()).toEqual(expectedF);
    expect(history.byteSize).toBe(size);
  });

  it("evicts only the oldest entry after 100 and never treats an evicted baseline as clean", () => {
    const history = new MapElementHistory();
    for (let index = 0; index < 101; index++) history.execute(forward(`${index}`), inverse(`${index}`));
    const expectedBytes = Array.from({ length: 100 }, (_, index) => bytes(forward(`${index + 1}`), inverse(`${index + 1}`)))
      .reduce((sum, size) => sum + size, 0);
    expect(history.byteSize).toBe(expectedBytes);
    for (let index = 100; index >= 1; index--) expect(history.undo()).toEqual(inverse(`${index}`));
    expect(history.undo()).toBeNull();
    expect(history.isDirty).toBe(true);
    expect(history.byteSize).toBe(expectedBytes);
  });

  it("keeps a reachable saved boundary correct after count eviction", () => {
    const history = new MapElementHistory();
    history.execute(forward("saved"), inverse("saved"));
    history.adoptSavedBaseline();
    for (let index = 0; index < 100; index++) history.execute(forward(`${index}`), inverse(`${index}`));
    for (let index = 0; index < 100; index++) history.undo();
    expect(history.isDirty).toBe(false);
    expect(history.canUndo).toBe(false);
    history.execute(forward("fork"), inverse("fork"));
    expect(history.isDirty).toBe(true);
    expect(history.byteSize).toBe(bytes(forward("fork"), inverse("fork")));
    history.undo();
    expect(history.isDirty).toBe(false);
  });

  it("counts decoded UTF-8 bytes of both directions and evicts by budget below 100 entries", () => {
    const history = new MapElementHistory();
    const f = largeBatch(30);
    const i: MapOp[] = f.map((op) => op.kind === "add" ? { kind: "update", element: op.element } : op);
    const entryBytes = bytes(f, i);
    expect(entryBytes * 2).toBeLessThan(MAX_BYTES);
    expect(entryBytes * 3).toBeGreaterThan(MAX_BYTES);
    history.execute(f, i);
    history.adoptSavedBaseline();
    history.execute(f, i);
    history.execute(f, i);
    expect(history.byteSize).toBe(entryBytes * 2);
    history.undo();
    history.undo();
    expect(history.undo()).toBeNull();
    expect(history.isDirty).toBe(false);
  });

  it.each(["forward", "inverse"] as const)("rejects oversized %s with a typed error before eviction or losing redo", (direction) => {
    const history = new MapElementHistory();
    history.execute(forward(), inverse());
    history.adoptSavedBaseline();
    history.undo();
    const size = history.byteSize;
    const oversized = largeBatch(171);
    const f = direction === "forward" ? oversized : forward();
    const i = direction === "inverse" ? oversized : inverse();
    const run = () => history.execute(f, i);
    expect(run).toThrow(MapElementHistoryCapacityError);
    expect(run).toThrow(expect.objectContaining({
      code: "MAP_HISTORY_ENTRY_TOO_LARGE", maxBytes: MAX_BYTES, requiredBytes: bytes(f, i)
    }));
    expect(history.byteSize).toBe(size);
    expect(history.canUndo).toBe(false);
    expect(history.isDirty).toBe(true);
    expect(history.redo()).toEqual(forward());
    expect(history.isDirty).toBe(false);
  });

  it("accepts exactly 32 MiB, evicts older entries, and rejects one extra byte atomically", () => {
    const history = new MapElementHistory();
    const f: MapOp[] = Array.from({ length: 512 }, (_, index) => ({
      kind: "add", element: textElement(`boundary-${index}`, "")
    }));
    const i: MapOp[] = f.map((op) => ({ kind: "delete", id: op.kind === "add" ? op.element.id : "" }));
    let remaining = MAX_BYTES - bytes(f, i);
    for (const op of f) {
      if (op.kind !== "add" || op.element.type !== "text") throw new Error("Invalid test fixture");
      const length = Math.min(remaining, 65_536);
      op.element.geometry.text = "x".repeat(length);
      remaining -= length;
    }
    expect(remaining).toBe(0);
    expect(bytes(f, i)).toBe(MAX_BYTES);
    history.execute(forward(), inverse());
    history.execute(f, i);
    history.adoptSavedBaseline();
    expect(history.byteSize).toBe(MAX_BYTES);

    const last = f[f.length - 1];
    if (last.kind !== "add" || last.element.type !== "text") throw new Error("Invalid test fixture");
    last.element.geometry.text += "x";
    expect(() => history.execute(f, i)).toThrow(expect.objectContaining({ requiredBytes: MAX_BYTES + 1 }));
    expect(history.byteSize).toBe(MAX_BYTES);
    expect(history.isDirty).toBe(false);
    expect(history.undo()).toEqual(i);
    expect(history.undo()).toBeNull();
    expect(history.isDirty).toBe(true);
  });

  it("retains large local batches without imposing the ordinary HTTP operation-count limit", () => {
    const history = new MapElementHistory();
    const f = Array.from({ length: 2_001 }, (_, index) => forward(`${index}`)[0]);
    const i = Array.from({ length: 2_001 }, (_, index) => inverse(`${2_000 - index}`)[0]);
    history.execute(f, i);
    expect(history.undo()).toEqual(i);
    expect(history.redo()).toEqual(f);
  });

  it("does not implicitly adopt a saved baseline when a caller's save fails", () => {
    const history = new MapElementHistory();
    history.execute(forward(), inverse());
    // A rejected server save must leave history alone; only success adopts it.
    const size = history.byteSize;
    expect(history.isDirty).toBe(true);
    expect(history.undo()).toEqual(inverse());
    expect(history.redo()).toEqual(forward());
    expect(history.isDirty).toBe(true);
    expect(history.byteSize).toBe(size);
  });

  it("clears both directions, accounting and saved identity for a new scope", () => {
    const history = new MapElementHistory();
    history.execute(forward(), inverse());
    history.adoptSavedBaseline();
    history.undo();
    history.clear();
    expect([history.canUndo, history.canRedo, history.isDirty, history.byteSize]).toEqual([false, false, false, 0]);
    history.execute(forward("new"), inverse("new"));
    expect(history.isDirty).toBe(true);
    history.undo();
    expect(history.isDirty).toBe(false);
  });

  it("aggregates add/delete and restores multiple complete elements with one undo after save", () => {
    const history = new MapElementHistory();
    const initial = new Map<string, MapElement>();
    const add: MapElementOp[] = ["a", "b"].map((id) => ({ kind: "add", element: textElement(id) }));
    const added = applyMapOps(initial, add);
    history.execute(add, added.inverse);
    const remove: MapElementOp[] = ["a", "b"].map((id) => ({ kind: "delete", id }));
    const removed = applyMapOps(added.elements, remove);
    history.execute(remove, removed.inverse);
    history.adoptSavedBaseline();
    const restored = applyMapOps(removed.elements, history.undo()! as MapElementOp[]);
    expect(restored.elements).toEqual(added.elements);
    expect(history.isDirty).toBe(true);
    const redone = applyMapOps(restored.elements, history.redo()! as MapElementOp[]);
    expect(redone.elements.size).toBe(0);
    expect(history.isDirty).toBe(false);
  });
});
