import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBulkMap } from "../../../../api/src/floor-editor/map-document-bulk";
import { createMapDocumentSource } from "../../api/map-document";
import { EditorLayersPanel } from "./EditorLayersPanel";
import { useMapEditor } from "./use-map-editor";
import { useFloorEditorStore } from "./editor-store";
import { createMapElementFromDrag } from "./map-element-tools";
import type { MapElement, MapOp } from "@led-control/shared/map-document-contracts";

vi.mock("../../api/map-document", () => ({ createMapDocumentSource: vi.fn() }));
const store = useFloorEditorStore.getState;
const groups = [
  { id: "parent", name: "Parent", parentId: null, visible: true, locked: false },
  { id: "child", name: "Child", parentId: "parent", visible: true, locked: false },
  { id: "grandchild", name: "Grandchild", parentId: "child", visible: true, locked: false }
];
const layers = [{ id: "map", name: "Map", order: 0, visible: true, locked: false }];
const elements = groups.map((group, i) => ({ ...createMapElementFromDrag("rectangle", { x: 100 + i * 50, y: 100 }, { x: 120 + i * 50, y: 120 }, group.id + "-shape")!, groupId: group.id }));
const ref = { formatVersion: 1 as const, generationId: "gen", revision: 1, width: 1200, height: 800, gridSize: 10, elementCount: 3,
  manifest: { assetId: "canonical", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 } };
const base = { floor: { id: "floor", siteId: "site", name: "F", level: 1, mapRevision: 1, floorPlan: null, mapDocument: ref }, fixtures: [], objects: [], lightSlots: [] };
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "map-ungroup-ui-"));
  store().reset(); store().initialize(structuredClone(base), "user");
  store().loadMapStructures(store().mapScope!, { groups, layers });
  vi.mocked(createMapDocumentSource).mockReturnValue({ scopeKey: "ungroup", getElements: async (_ref: unknown, ids: readonly string[]) => elements.filter(e => ids.includes(e.id)),
    getSelection: async () => ({ generationId: "gen", revision: 1, ids: elements.map(e => e.id), nextCursor: null }) } as unknown as ReturnType<typeof createMapDocumentSource>);
});
afterEach(async () => { cleanup(); vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
async function* stream<T>(items: T[]) { yield* items; }
async function checkpoint(originals: MapElement[], operations: MapOp[], structures = groups) {
  const result = await prepareBulkMap(await mkdtemp(join(directory, "checkpoint-")), stream(originals), stream(operations), { ...ref, groups: structures, layers });
  const retained = []; for await (const e of result.elements()) retained.push(e);
  return { elements: retained, groups: result.groups, layers: result.layers };
}
function Panel() { return <EditorLayersPanel readOnly={false} mapEditor={useMapEditor({ floorId: "floor", authScope: "user", readOnly: false })} />; }

it("saves UI parent ungroup through the backend checkpoint without losing descendants, then undoes and reloads", async () => {
  render(<Panel />);
  fireEvent.click(screen.getByRole("button", { name: "Parent 해제" }));
  await waitFor(() => expect(store().mapGroups.has("parent")).toBe(false));
  const operations = store().prepareSave({ leaseToken: "lease", leaseFence: 1 }).payload.documentChanges!.operations;
  expect(operations).toEqual(expect.arrayContaining([
    { kind: "group.put", group: { ...groups[1], parentId: null } }, { kind: "group.delete", id: "parent" }
  ]));
  const savedMap = await checkpoint(elements, operations);
  expect(savedMap.elements.map(e => e.id).sort()).toEqual(elements.map(e => e.id).sort());
  expect(savedMap.groups).toEqual([{ ...groups[1], parentId: null }, groups[2]]);
  const saved = { ...base, floor: { ...base.floor, mapRevision: 2, mapDocument: { ...ref, generationId: "checkpoint", revision: 2 } } };
  await act(async () => { await store().saveChanges({ leaseToken: "lease", leaseFence: 1 }, async () => saved); });
  act(() => store().undo());
  const undoMap = await checkpoint(savedMap.elements, store().mapOperations, savedMap.groups);
  expect(undoMap.elements.sort((a, b) => a.id.localeCompare(b.id))).toEqual([...elements].sort((a, b) => a.id.localeCompare(b.id)));
  expect(undoMap.groups.sort((a, b) => a.id.localeCompare(b.id))).toEqual([...groups].sort((a, b) => a.id.localeCompare(b.id)));
  act(() => { store().initialize(saved, "user"); store().loadMapStructures(store().mapScope!, savedMap); store().loadMapElements(store().mapScope!, savedMap.elements); });
  expect(store().mapElements.size).toBe(3); expect(store().mapGroups.has("child")).toBe(true);
});

it("still deletes an ordinary subtree recursively", async () => {
  const result = await checkpoint(elements, [{ kind: "group.delete", id: "parent" }]);
  expect(result.groups).toEqual([]); expect(result.elements).toEqual([]);
});
