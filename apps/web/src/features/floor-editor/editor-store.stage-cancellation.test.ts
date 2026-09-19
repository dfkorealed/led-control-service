import { beforeEach, expect, it, vi } from "vitest";
import type { MapElement } from "@led-control/shared";
import { createMapStageClient, type MapStageClient, type PreparedMapStage } from "../../api/map-stages";
import { ApiError } from "../../api/client";
import { useFloorEditorStore } from "./editor-store";
import type { FloorEditorState } from "./editor-types";

const store = useFloorEditorStore.getState;
const lease = { leaseToken: "lease", leaseFence: 1 };
const baseline = (): FloorEditorState => ({ floor: { id: "floor", siteId: "site", name: "B1", level: 1,
  mapRevision: 3, floorPlan: null, mapDocument: { formatVersion: 1, generationId: "generation", revision: 3,
    width: 1000, height: 1000, gridSize: 10, elementCount: 1,
    manifest: { assetId: "manifest", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 } } },
  fixtures: [{ id: "fixture", name: "Light", x: 10, y: 20, ratedWatt: 40, brightness: 80, status: "online" }], objects: [], lightSlots: [] });
const element = (): MapElement => ({ id: "shape", type: "rectangle", groupId: null, layerId: "layer", zIndex: 0,
  visible: true, locked: false, provenance: null, transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
  style: { strokeColor: "#000000", fillColor: null, strokeWidth: 1, opacity: 1 },
  geometry: { origin: { x: 10, y: 10 }, width: 20, height: 30 } });
function api() {
  let handle: PreparedMapStage;
  const prepared = (payload: any, options?: any) => {
    handle = { id: `stage-${payload.expectedRevision}`, status: "ready", generationId: payload.documentChanges.generationId,
      baseRevision: payload.expectedRevision, partCount: 1, decodedBytes: 2, expiresAt: "2099-01-01T00:00:00Z", errorCode: null, result: null,
      preview: { ...store().initialState!.floor.mapDocument!, generationId: `preview-${payload.expectedRevision + 1}`, revision: payload.expectedRevision + 1 },
      intent: { ...lease, partCount: 1, decodedBytes: 2, sha256: "a".repeat(64) } };
    options?.onProgress?.({ stageId: handle.id, phase: "ready", partCount: 1, decodedBytes: 2 });
    return handle;
  };
  return {
    prepare: vi.fn<MapStageClient["prepare"]>(async (_floor, payload, source, options) => { for await (const _op of source) {} return prepared(payload, options); }),
    prepareHistory: vi.fn<MapStageClient["prepareHistory"]>(async (_floor, payload, _revision, options) => prepared(payload, options)),
    commit: vi.fn<MapStageClient["commit"]>(async () => ({ ...handle, status: "committed", result: {
      ...store().initialState!, floor: { ...store().initialState!.floor, mapRevision: handle.baseRevision + 1, mapDocument: handle.preview! },
      history: { undo: { revision: handle.baseRevision }, redo: { revision: handle.baseRevision + 1 } }
    } })),
    cancel: vi.fn<MapStageClient["cancel"]>(async () => ({ ...handle, status: "cancelled" })),
    status: vi.fn<MapStageClient["status"]>(async () => handle),
    settle: vi.fn<MapStageClient["settle"]>(async () => handle)
  } satisfies MapStageClient;
}
beforeEach(() => store().initialize(baseline(), "user"));

// Reviewer exact probes, with imports redirected to the owned working source.
it("known automatic stage can be cancelled after commit-response failure", async () => {
  const client = api();
  store().updateMapSettings({ width: 1000, height: 1000, gridSize: 20 });
  client.commit.mockRejectedValueOnce(new Error("lost commit response"));
  await expect(store().saveChanges(lease, undefined, client)).rejects.toThrow("lost commit response");
  expect(store().stageProgress!.stageId).toBe("stage-3");
  expect(await store().cancelMapStage(lease, client)).toBe("cancelled");
  expect(client.cancel).toHaveBeenCalledOnce();
});

it("cancelling history preview restores the cursors of older inline map commands", async () => {
  store().loadMapStructures(store().mapScope!, { groups: [], layers: [{ id: "layer", name: "Shapes", order: 0, locked: false, visible: true }] });
  store().loadMapElements(store().mapScope!, [element()]);
  store().applyMapTransaction({ operations: [{ kind: "update", element: { ...element(), zIndex: 2 } }] });
  const saved = baseline(); saved.floor.mapRevision = 4; saved.floor.mapDocument!.revision = 4;
  await store().saveChanges(lease, async () => saved);
  const client = api();
  await store().prepareMapStream({ scope: store().mapScope!, operations: async function* () {} }, lease, client);
  await store().saveChanges(lease, undefined, client);
  await store().prepareHistory("undo", lease, client);
  store().undo();
  expect(await store().cancelMapStage(lease, client)).toBe("cancelled");
  await store().prepareHistory("undo", lease, client);
  expect(() => store().undo()).not.toThrow();
});

it("repeated preview cancel restores inline undo/redo cursors after a new branch", async () => {
  store().loadMapStructures(store().mapScope!, { groups: [], layers: [{ id: "layer", name: "Shapes", order: 0, locked: false, visible: true }] });
  store().loadMapElements(store().mapScope!, [element()]);
  store().applyMapTransaction({ operations: [{ kind: "update", element: { ...element(), zIndex: 2 } }] });
  const saved = baseline(); saved.floor.mapRevision = 4; saved.floor.mapDocument!.revision = 4;
  await store().saveChanges(lease, async () => saved);
  const client = api();
  await store().prepareMapStream({ scope: store().mapScope!, operations: async function* () {} }, lease, client);
  await store().saveChanges(lease, undefined, client);
  const savedPast = store().past, capsule = savedPast[0].mapCommand!.history;
  const commits = client.commit.mock.calls.length;
  for (let repeat = 0; repeat < 2; repeat++) {
    await store().prepareHistory("undo", lease, client);
    store().undo(); expect(store().mapElements.get("shape")!.zIndex).toBe(0);
    store().redo(); expect(store().mapElements.get("shape")!.zIndex).toBe(2);
    store().undo();
    store().updateFixture("fixture", { name: "preview branch" });
    expect(store().future).toHaveLength(0);
    expect(await store().cancelMapStage(lease, client)).toBe("cancelled");
    expect(store().past).toBe(savedPast);
    expect(capsule.canUndo).toBe(true); expect(capsule.canRedo).toBe(false);
    expect(store().state!.fixtures[0].name).toBe("Light");
    expect(store().isDirty).toBe(false);
  }
  expect(client.commit).toHaveBeenCalledTimes(commits);
});

it.each(["cancelled", "expired"] as const)("confirmed automatic %s clears only the save intent and keeps the local draft", async status => {
  const client = api();
  store().updateMapSettings({ width: 1000, height: 1000, gridSize: 20 });
  client.commit.mockRejectedValueOnce(new Error("lost commit response"));
  await expect(store().saveChanges(lease, undefined, client)).rejects.toThrow();
  const originalRequest = client.prepare.mock.calls[0][1].documentChanges!.requestId;
  store().updateFixture("fixture", { name: "newer" });
  const current = store().state, past = store().past;
  client.cancel.mockResolvedValueOnce({ ...await client.status("floor", "stage-3"), status });
  expect(await store().cancelMapStage(lease, client)).toBe("cancelled");
  expect(store().state).toBe(current); expect(store().past).toBe(past);
  expect(store().initialState!.floor.mapRevision).toBe(3);
  expect(store().stageProgress).toBeNull(); expect(store().isDirty).toBe(true);
  await store().saveChanges(lease, undefined, client);
  expect(client.prepare).toHaveBeenCalledTimes(2);
  expect(client.prepare.mock.calls[1][1].documentChanges!.requestId).not.toBe(originalRequest);
});

async function lostAutomaticSave(client: ReturnType<typeof api>) {
  store().updateMapSettings({ width: 1000, height: 1000, gridSize: 20 });
  client.commit.mockRejectedValueOnce(new Error("lost commit response"));
  await expect(store().saveChanges(lease, undefined, client)).rejects.toThrow();
  const handle = await client.status("floor", "stage-3");
  const saved = baseline();
  saved.floor = { ...saved.floor, mapRevision: 4, mapDocument: handle.preview!, floorPlan: store().state!.floor.floorPlan };
  return { ...handle, status: "committed" as const, result: { ...saved, history: { undo: { revision: 3 }, redo: { revision: 4 } } } };
}

it("already-committed automatic cancellation rebases its receipt without another commit", async () => {
  const client = api(), receipt = await lostAutomaticSave(client);
  store().updateFixture("fixture", { name: "after capture" });
  client.cancel.mockResolvedValueOnce(receipt);
  expect(await store().cancelMapStage(lease, client)).toBe("committed");
  expect(client.commit).toHaveBeenCalledTimes(1);
  expect(store().initialState!.floor.mapRevision).toBe(4);
  expect(store().initialState!.fixtures[0].name).toBe("Light");
  expect(store().state!.fixtures[0].name).toBe("after capture");
  expect(store().isDirty).toBe(true); expect(store().stageProgress).toBeNull();
  expect(store().isSaving).toBe(false); expect(store().isPreparingMapStage).toBe(false);
});

it.each(["failed GET", "processing"])("automatic cancellation preserves an uncertain intent after %s", async outcome => {
  const client = api(), receipt = await lostAutomaticSave(client);
  const request = vi.fn().mockRejectedValueOnce(new ApiError("DELETE failed", 409, null));
  if (outcome === "failed GET") request.mockRejectedValueOnce(new ApiError("GET denied", 403, null));
  else request.mockResolvedValueOnce({ ...receipt, status: "processing", result: null });
  client.cancel.mockImplementation(createMapStageClient({ request }).cancel);
  const current = store().state, originalHandle = client.commit.mock.calls[0][1];
  await expect(store().cancelMapStage(lease, client)).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[0][1].method).toBe("DELETE");
  expect(request.mock.calls[1][1].method).toBeUndefined();
  expect(store().state).toBe(current); expect(store().isDirty).toBe(true);
  expect(store().isPreparingMapStage).toBe(false);
  client.commit.mockResolvedValueOnce(receipt);
  await store().saveChanges(lease, undefined, client);
  expect(client.prepare).toHaveBeenCalledTimes(1);
  expect(client.commit.mock.calls[1][1]).toBe(originalHandle);
});

it.each(["cancelled", "committed"] as const)("ignores a late automatic %s cancellation response after scope switch", async status => {
  const client = api(), receipt = await lostAutomaticSave(client);
  let resolve!: (value: typeof receipt) => void;
  client.cancel.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const cancelling = store().cancelMapStage(lease, client);
  const other = baseline(); other.floor.id = "other-floor";
  store().initialize(other, "other-user");
  resolve({ ...receipt, status } as typeof receipt);
  expect(await cancelling).toBe("stale");
  expect(store().state).toBe(other); expect(store().mapScope!.authScope).toBe("other-user");
  expect(store().isPreparingMapStage).toBe(false); expect(store().stageProgress).toBeNull();
  expect(client.commit).toHaveBeenCalledTimes(1);
});

it("ignores a late automatic cancellation failure after an auth switch", async () => {
  const client = api(); await lostAutomaticSave(client);
  let reject!: (error: Error) => void;
  client.cancel.mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail; }));
  const cancelling = store().cancelMapStage(lease, client);
  store().initialize(baseline(), "another-user");
  reject(new Error("old scope GET failed"));
  expect(await cancelling).toBe("stale");
  expect(store().mapScope!.authScope).toBe("another-user");
  expect(store().isDirty).toBe(false); expect(store().isPreparingMapStage).toBe(false);
});

it("cancelling an external redo preview restores future inline command cursors", async () => {
  const client = api();
  await store().prepareMapStream({ scope: store().mapScope!, operations: async function* () {} }, lease, client);
  await store().saveChanges(lease, undefined, client);
  store().loadMapStructures(store().mapScope!, { groups: [], layers: [{ id: "layer", name: "Shapes", order: 0, locked: false, visible: true }] });
  store().loadMapElements(store().mapScope!, [element()]);
  store().applyMapTransaction({ operations: [{ kind: "update", element: { ...element(), zIndex: 2 } }] });
  const saveInline = () => store().saveChanges(lease, async () => {
    const state = store().state!, revision = state.floor.mapRevision + 1;
    return { ...state, floor: { ...state.floor, mapRevision: revision, mapDocument: { ...state.floor.mapDocument!, revision } } };
  });
  await saveInline(); store().undo(); await saveInline();
  await store().prepareHistory("undo", lease, client); await store().saveChanges(lease, undefined, client);
  const future = store().future, capsule = future[0].mapCommand!.history;
  const commits = client.commit.mock.calls.length;
  for (let repeat = 0; repeat < 2; repeat++) {
    await store().prepareHistory("redo", lease, client);
    store().redo(); expect(store().mapElements.get("shape")!.zIndex).toBe(2);
    await store().cancelMapStage(lease, client);
    expect(store().future).toBe(future);
    expect(capsule.canRedo).toBe(true); expect(capsule.canUndo).toBe(false);
  }
  expect(client.commit).toHaveBeenCalledTimes(commits);
});

it("blocks another preview while a known automatic intent remains unresolved even after local undo", async () => {
  const client = api(); await lostAutomaticSave(client);
  store().undo(); expect(store().isDirty).toBe(false);
  await expect(store().prepareMapStream({ scope: store().mapScope!, operations: async function* () {} }, lease, client))
    .rejects.toMatchObject({ code: "MAP_STAGE_BASE_DIRTY" });
  expect(client.prepare).toHaveBeenCalledTimes(1);
  expect(await store().cancelMapStage(lease, client)).toBe("cancelled");
  expect(store().isDirty).toBe(false);
});

it("committed reconciliation preserves a later settings undo against the new document dimensions", async () => {
  const client = api(), receipt = await lostAutomaticSave(client);
  receipt.result.floor.mapDocument = { ...receipt.result.floor.mapDocument!, gridSize: 20 };
  store().undo(); expect(store().isDirty).toBe(false);
  client.cancel.mockResolvedValueOnce(receipt);
  expect(await store().cancelMapStage(lease, client)).toBe("committed");
  expect(store().initialState!.floor.mapDocument!.gridSize).toBe(20);
  expect(store().prepareSave(lease).payload.floorPlan).toMatchObject({ width: 1000, height: 1000, gridSize: 10 });
  expect(store().isDirty).toBe(true); expect(client.commit).toHaveBeenCalledTimes(1);
});
