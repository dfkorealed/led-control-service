import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EditorPropertiesPanel } from "./EditorPropertiesPanel";
import { MapSelectionProperties } from "./MapSelectionProperties";
import { useMapEditor, type MapEditorController } from "./use-map-editor";
import { useFloorEditorStore } from "./editor-store";
import { createMapElementFromDrag } from "./map-element-tools";

vi.mock("../../api/map-document", () => ({ createMapDocumentSource: () => ({ scopeKey: "coordinates",
  getSelection: async () => ({ generationId: "gen", revision: 1, ids: [], nextCursor: null }), getElements: async () => [] }) }));
const store = useFloorEditorStore.getState;
const lease = { leaseToken: "lease", leaseFence: 1 };
afterEach(() => { cleanup(); store().reset(); });
function setup(size: number, mixed: boolean | "shapes" = false, readOnly = false) {
  store().initialize({ floor: { id: "floor", siteId: "site", name: "F", level: 1, mapRevision: 1, floorPlan: null,
    mapDocument: { formatVersion: 1, generationId: "gen", revision: 1, width: 1204, height: 800, gridSize: 10, elementCount: 0,
      manifest: { assetId: "canonical", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 } } },
    fixtures: [{ id: "light", name: "Light", x: 207, y: 213, size, ratedWatt: 40, brightness: 80, status: "online", placementStatus: "placed" }],
    objects: [], lightSlots: [{ id: "slot", x: 207, y: 213, rotation: 0, assignedFixtureId: "light" }] }, "user");
  store().loadMapStructures(store().mapScope!, { groups: [], layers: [{ id: "map", name: "Map", order: 0, visible: true, locked: false }] });
  if (mixed) {
    const shape = createMapElementFromDrag("rectangle", { x: 103, y: 107 }, { x: 183, y: 147 }, "shape")!;
    store().applyMapTransaction({ operations: [{ kind: "add", element: shape }] });
    store().selectMapElements([shape.id]);
  }
  if (mixed === "shapes") {
    const shape = createMapElementFromDrag("rectangle", { x: 203, y: 207 }, { x: 283, y: 247 }, "shape2")!;
    store().applyMapTransaction({ operations: [{ kind: "add", element: shape }] });
    store().selectMapElements([shape.id], true);
  } else store().selectFixtures(["light"], true);
  let controller!: MapEditorController;
  function Panel() {
    const editor = useMapEditor({ floorId: "floor", authScope: "user", readOnly });
    controller = editor;
    return mixed ? editor.bounds && <MapSelectionProperties key={JSON.stringify(editor.bounds)} editor={editor} readOnly={readOnly} /> : <EditorPropertiesPanel readOnly={readOnly} mapEditor={editor} />;
  }
  render(<Panel />);
  return () => controller;
}
function number(label: string, value: number) {
  const input = screen.getByRole("textbox", { name: label });
  fireEvent.focus(input); fireEvent.change(input, { target: { value: String(value) } }); fireEvent.blur(input);
}
it.each([20, 30].flatMap(size => ["X", "Y"].map(axis => ({ size, axis }))))("center $axis input preserves the other axis for size $size, including slots and atomic undo/save", async ({ size, axis }) => {
  setup(size);
  const original = structuredClone(store().state!);
  await act(async () => number(axis, 302));
  await waitFor(() => expect(store().state!.fixtures[0]).toMatchObject(axis === "X" ? { x: 300, y: 213 } : { x: 207, y: 300 }));
  expect(store().past).toHaveLength(1);
  expect(store().state!.lightSlots[0].assignedFixtureId).toBeNull();
  expect(store().prepareSave(lease).payload).toMatchObject({ fixtureUpdates: [axis === "X" ? { id: "light", x: 300 } : { id: "light", y: 300 }], slotAssignments: [{ slotId: "slot", assignedFixtureId: null }] });
  act(() => store().undo());
  expect(store().state!.fixtures).toEqual(original.fixtures);
  expect(store().state!.lightSlots).toEqual(original.lightSlots);
  act(() => store().redo());
  expect(store().state!.fixtures[0]).toMatchObject(axis === "X" ? { x: 300, y: 213 } : { x: 207, y: 300 });
});
it.each([false, true])("clamps only the changed center axis to a non-grid map boundary (snap=%s)", async snap => {
  setup(30); act(() => store().setSnap(snap));
  await act(async () => number("X", 1300));
  await waitFor(() => expect(store().state!.fixtures[0]).toMatchObject({ x: 1204, y: 213 }));
});
it.each(["X", "Y"])("snap-off center $axis input preserves the exact value and the other axis", async axis => {
  setup(30); act(() => store().setSnap(false));
  await act(async () => number(axis, 303));
  await waitFor(() => expect(store().state!.fixtures[0]).toMatchObject(axis === "X" ? { x: 303, y: 213 } : { x: 207, y: 303 }));
});
it.each(["readOnly", "locked"])("does not move a %s fixture or release its slot", async mode => {
  const editor = setup(30, false, mode === "readOnly");
  if (mode === "locked") act(() => store().toggleFixtureLock(["light"]));
  expect(screen.getByRole("textbox", { name: "X" })).toBeDisabled();
  await act(async () => { await editor().setFixtureCoordinate("x", 302); });
  expect(store().state!.fixtures[0]).toMatchObject({ x: 207, y: 213 });
  expect(store().state!.lightSlots[0].assignedFixtureId).toBe("light");
});
it.each(["X", "Y"])("mixed numeric $axis changes only that bbox axis while preserving relative spacing", async axis => {
  setup(30, true);
  await screen.findByRole("textbox", { name: `선택 ${axis}` });
  await waitFor(() => expect(screen.getByRole("textbox", { name: "선택 X" })).toHaveValue("103"));
  const past = store().past.length;
  await act(async () => { number(`선택 ${axis}`, 302); fireEvent.click(screen.getByRole("button", { name: "선택 변환 적용" })); });
  await waitFor(() => expect(store().state!.fixtures[0]).toMatchObject(axis === "X" ? { x: 404, y: 213 } : { x: 207, y: 406 }));
  expect(store().mapElements.get("shape")!.transform).toMatchObject(axis === "X" ? { x: 197, y: 0 } : { x: 0, y: 193 });
  expect(store().past).toHaveLength(past + 1);
  act(() => store().undo());
  expect(store().state!.fixtures[0]).toMatchObject({ x: 207, y: 213 });
});
it.each(["X", "Y"])("shape-only group numeric $axis leaves the untouched off-grid axis unchanged", async axis => {
  setup(30, "shapes");
  await screen.findByRole("textbox", { name: `선택 ${axis}` });
  await waitFor(() => expect(screen.getByRole("textbox", { name: "선택 X" })).toHaveValue("103"));
  await act(async () => { number(`선택 ${axis}`, 302); fireEvent.click(screen.getByRole("button", { name: "선택 변환 적용" })); });
  await waitFor(() => expect(store().mapElements.get("shape")!.transform).toMatchObject(axis === "X" ? { x: 197, y: 0 } : { x: 0, y: 193 }));
  expect(store().mapElements.get("shape2")!.transform).toMatchObject(axis === "X" ? { x: 197, y: 0 } : { x: 0, y: 193 });
  expect(store().state!.fixtures[0]).toMatchObject({ x: 207, y: 213 });
  expect(store().state!.lightSlots[0].assignedFixtureId).toBe("light");
});
