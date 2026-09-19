import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMapDocumentSource } from "../../api/map-document";
import { useMapEditor } from "./use-map-editor";
import { useFloorEditorStore } from "./editor-store";
import { createMapElementFromDrag } from "./map-element-tools";
import type { FloorEditorState } from "./editor-types";
import { mapStageClient } from "../../api/map-stages";

vi.mock("../../api/map-document", () => ({ createMapDocumentSource: vi.fn() }));
const store = useFloorEditorStore.getState;
const ref = { formatVersion: 1 as const, generationId: "gen", revision: 1, width: 1200, height: 800, gridSize: 10, elementCount: 2500,
  manifest: { assetId: "canonical", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 } };
const base: FloorEditorState = { floor: { id: "floor", siteId: "site", name: "F", level: 1, mapRevision: 1, floorPlan: null, mapDocument: ref },
  fixtures: [{ id: "fixture", name: "F", x: 403, y: 407, ratedWatt: 40, brightness: 100, status: "online" }], objects: [], lightSlots: [] };
const elements = Array.from({ length: 2500 }, (_, index) => ({ ...createMapElementFromDrag("rectangle", { x: 100, y: 100 }, { x: 120, y: 120 }, `s${index}`)!, groupId: "group" }));
function mount() {
  return renderHook(() => useMapEditor({ floorId: "floor", authScope: "user", readOnly: false, lease: { leaseToken: "lease", leaseFence: 1 } }));
}
beforeEach(() => {
  store().reset();
  store().initialize(structuredClone(base), "user");
  store().loadMapStructures(store().mapScope!, { layers: [{ id: "map", name: "Map", order: 0, visible: true, locked: false }],
    groups: [{ id: "group", name: "Group", parentId: null, visible: true, locked: false }] });
  vi.mocked(createMapDocumentSource).mockReturnValue({ scopeKey: "test", getSelection: vi.fn(async (document, query) => {
    const start = Number(query.cursor ?? 0);
    return { generationId: document.generationId, revision: document.revision, ids: elements.slice(start, start + 128).map(element => element.id),
      nextCursor: start + 128 < elements.length ? String(start + 128) : null };
  }), getElements: vi.fn(async (_document, ids: string[]) => ids.map(id => elements[Number(id.slice(1))])) } as unknown as ReturnType<typeof createMapDocumentSource>);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("streamed map editor controller", () => {
  it("summarizes a complete large group and streams every delete without storing all originals", async () => {
    store().selectMapGroups(["group"]);
    const view = mount();
    await waitFor(() => expect(view.result.current.selectionCount).toBe(2500));
    expect(view.result.current.selection).toHaveLength(0);
    expect(view.result.current.bounds).toEqual({ minX: 100, minY: 100, maxX: 120, maxY: 120 });
    const ids: string[] = [];
    vi.spyOn(store(), "prepareMapStream").mockImplementation(async transaction => {
      for await (const op of transaction.operations()) if (op.kind === "delete") ids.push(op.id);
      return "ready";
    });
    await act(async () => { await view.result.current.remove(); });
    expect(ids).toEqual(elements.map(element => element.id));
    expect(store().mapOperations).toHaveLength(0);
  });

  it("moves fixtures and common elements in one undo and fits their combined bounds", async () => {
    store().selectMapElements(["s0"]); store().selectFixtures(["fixture"], true);
    const view = mount();
    await waitFor(() => expect(view.result.current.selectionCount).toBe(1));
    const before = store().past.length;
    await act(async () => { await view.result.current.move({ x: 10, y: 20 }); });
    expect(store().past).toHaveLength(before + 1);
    expect(store().state?.fixtures[0]).toMatchObject({ x: 413, y: 427 });
    expect(store().mapOperations[0]).toMatchObject({ kind: "update", element: { transform: { x: 10, y: 20 } } });
    act(() => store().undo());
    expect(store().state?.fixtures[0]).toMatchObject({ x: 403, y: 407 });
    expect(store().mapOperations).toHaveLength(0);
    // maxX는 동기 복구된 조명만으로도 일치한다. 도형의 비동기 undo 조회까지
    // 끝난 전체 bounds를 기다려 중간 좌표로 fitSelection을 호출하지 않는다.
    await waitFor(() => expect(view.result.current.bounds).toEqual({ minX: 100, minY: 100, maxX: 413, maxY: 417 }));
    act(() => { store().setViewport({ width: 800, height: 600 }); view.result.current.fitSelection(); });
    expect(store().zoom).toBeCloseTo(552 / 317);
  });

  it("prepares a mixed stream with the real store then switches only the source to its private preview", async () => {
    store().selectMapGroups(["group"]); store().selectFixtures(["fixture"], true);
    const view = mount();
    await waitFor(() => expect(view.result.current.selectionCount).toBe(2500));
    let count = 0;
    const prepare = vi.spyOn(mapStageClient, "prepare").mockImplementation(async (_floor, body, operations) => {
      expect(body.fixtureUpdates).toEqual([expect.objectContaining({ id: "fixture", x: 413, y: 427 })]);
      for await (const operation of operations) { expect(operation.kind).toBe("update"); count++; }
      return { id: "stage", status: "ready", generationId: "gen", baseRevision: 1, partCount: 1, decodedBytes: 1,
        expiresAt: new Date(Date.now() + 60000).toISOString(), errorCode: null, result: null,
        preview: { ...ref, generationId: "preview", revision: 2 }, intent: { leaseToken: "lease", leaseFence: 1 } };
    });
    await act(async () => { await view.result.current.move({ x: 10, y: 20 }); });
    expect(prepare).toHaveBeenCalledTimes(1); expect(count).toBe(2500);
    expect(store().state?.fixtures[0]).toMatchObject({ x: 413, y: 427 });
    expect(store().state?.floor.mapDocument).toEqual(ref);
    expect(view.result.current.document).toMatchObject({ generationId: "preview", revision: 2 });
    expect(createMapDocumentSource).toHaveBeenLastCalledWith({ floorId: "floor", authScope: "user", stageId: "stage" });
  });

  it("rejects invalid full-target transforms before staging any mixed fixture changes", async () => {
    store().selectMapGroups(["group"]); store().selectFixtures(["fixture"], true);
    const view = mount();
    await waitFor(() => expect(view.result.current.selectionCount).toBe(2500));
    const prepare = vi.spyOn(mapStageClient, "prepare");
    await act(async () => { await view.result.current.move({ x: -200, y: 0 }); });
    expect(prepare).not.toHaveBeenCalled();
    expect(store().state?.fixtures[0].x).toBe(403);
    expect(store().isDirty).toBe(false);
    expect(view.result.current.error).toContain("맵 범위");
  });

  it("retains the exact failed factory for retry and keeps failure visible after unconfirmed cancel", async () => {
    store().selectMapGroups(["group"]);
    const view = mount();
    await waitFor(() => expect(view.result.current.selectionCount).toBe(2500));
    const prepare = vi.spyOn(store(), "prepareMapStream").mockRejectedValue(new Error("다시 시도해주세요."));
    await act(async () => { await view.result.current.remove(); });
    expect(view.result.current.retryStage).not.toBeNull();
    await act(async () => { await view.result.current.retryStage?.(); });
    expect(prepare.mock.calls[0][0]).toBe(prepare.mock.calls[1][0]);
    vi.spyOn(store(), "cancelMapStage").mockRejectedValue(new Error("취소를 확인하지 못했습니다."));
    await act(async () => { await view.result.current.cancelStage(); });
    expect(view.result.current.error).toContain("취소를 확인");
    expect(view.result.current.retryStage).not.toBeNull();
  });

  it("cancels local full-target validation before creating a server stage", async () => {
    store().selectMapGroups(["group"]);
    const view = mount();
    await waitFor(() => expect(view.result.current.selectionCount).toBe(2500));
    const source = vi.mocked(createMapDocumentSource).mock.results.at(-1)!.value;
    let release!: (values: typeof elements) => void;
    vi.mocked(source.getElements).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const prepare = vi.spyOn(mapStageClient, "prepare");
    let moving!: Promise<void>;
    act(() => { moving = view.result.current.move({ x: 10, y: 10 }); });
    await waitFor(() => expect(release).toBeDefined());
    expect(view.result.current.preparing).toBe(true);
    await act(async () => { await view.result.current.cancelStage(); release([]); await moving; });
    expect(prepare).not.toHaveBeenCalled();
    expect(view.result.current.preparing).toBe(false);
    expect(view.result.current.error).toBeNull();
    expect(store().isDirty).toBe(false);
  });
});
