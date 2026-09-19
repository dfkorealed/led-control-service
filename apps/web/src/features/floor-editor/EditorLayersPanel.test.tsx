import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EditorLayersPanel } from "./EditorLayersPanel";
import { useMapEditor } from "./use-map-editor";
import { useFloorEditorStore } from "./editor-store";
import { createMapElementFromDrag } from "./map-element-tools";

vi.mock("../../api/map-document", () => ({ createMapDocumentSource: () => ({ scopeKey: "test", getElements: async () => [],
  getSelection: async () => ({ generationId: "gen", revision: 1, ids: [], nextCursor: null }) }) }));
afterEach(cleanup);
it("adds and hides layers, groups selected shapes, then ungroups without geometry changes", async () => {
  const store = useFloorEditorStore.getState;
  store().initialize({ floor: { id: "floor", siteId: "site", name: "Floor", level: 1, mapRevision: 1, floorPlan: null,
    mapDocument: { formatVersion: 1, generationId: "gen", revision: 1, width: 1200, height: 800, gridSize: 10, elementCount: 0,
      manifest: { assetId: "manifest", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 } } }, fixtures: [], objects: [], lightSlots: [] }, "user");
  store().loadMapStructures(store().mapScope!, { groups: [], layers: [{ id: "map", name: "Map", order: 0, visible: true, locked: false }] });
  const element = createMapElementFromDrag("rectangle", { x: 20, y: 20 }, { x: 60, y: 60 }, "one")!;
  store().applyMapTransaction({ operations: [{ kind: "add", element }] }); store().selectMapElements(["one"]);
  function Panel() { const map = useMapEditor({ floorId: "floor", authScope: "user", readOnly: false }); return <EditorLayersPanel readOnly={false} mapEditor={map} />; }
  render(<Panel />);
  fireEvent.click(screen.getByRole("button", { name: "레이어 추가" }));
  expect(store().mapLayers.size).toBe(2);
  fireEvent.click(screen.getByRole("button", { name: "Map 숨기기" }));
  expect(store().mapLayers.get("map")!.visible).toBe(false);
  act(() => store().undo());
  await waitFor(() => expect(screen.getByRole("button", { name: "그룹 만들기" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "그룹 만들기" }));
  await waitFor(() => expect(store().mapGroups.size).toBe(1));
  fireEvent.click(screen.getByRole("button", { name: "그룹 1 해제" }));
  await waitFor(() => expect(store().mapGroups.size).toBe(0));
  expect(store().mapElements.get("one")!.geometry).toEqual(element.geometry);
  expect(store().mapElements.get("one")!.groupId).toBeNull();
});
