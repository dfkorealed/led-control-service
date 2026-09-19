import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MapOp } from "@led-control/shared";
import type { MapStageClient, PreparedMapStage } from "../../api/map-stages";
import { useFloorEditorStore } from "./editor-store";
import type { FloorEditorState } from "./editor-types";
import { loadEditorDraft, saveEditorDraft } from "./editor-drafts";

const store = useFloorEditorStore.getState;
const lease = { leaseToken: "lease", leaseFence: 1 };
const baseline = (): FloorEditorState => ({ floor: { id: "floor", siteId: "site", name: "B1", level: 1,
  mapRevision: 3, floorPlan: null, mapDocument: { formatVersion: 1, generationId: "generation", revision: 3,
    width: 1000, height: 1000, gridSize: 10, elementCount: 500000,
    manifest: { assetId: "manifest", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 } } },
  fixtures: [{ id: "fixture", name: "Light", x: 10, y: 20, ratedWatt: 40, brightness: 80, status: "online" }], objects: [], lightSlots: [] });
const preview = { ...baseline().floor.mapDocument!, generationId: "prepared", revision: 4 };
function client() {
  const stage: PreparedMapStage = { id: "stage", status: "ready", generationId: "generation", baseRevision: 3,
    partCount: 1, decodedBytes: 10, expiresAt: "2099-01-01T00:00:00Z", errorCode: null, result: null, preview,
    intent: { ...lease, partCount: 1, decodedBytes: 10, sha256: "a".repeat(64) } };
  const saved = baseline(); saved.floor = { ...saved.floor, mapRevision: 4, mapDocument: preview };
  return { prepare: vi.fn<MapStageClient["prepare"]>(async (_floor, _payload, source) => { for await (const _op of source) {} return stage; }),
    prepareHistory: vi.fn<MapStageClient["prepareHistory"]>().mockResolvedValue(stage), commit: vi.fn<MapStageClient["commit"]>().mockResolvedValue({ ...stage, status: "committed",
      result: { ...saved, history: { undo: { revision: 3 }, redo: { revision: 4 } } } }),
    cancel: vi.fn<MapStageClient["cancel"]>().mockResolvedValue({ ...stage, status: "cancelled" }),
    status: vi.fn<MapStageClient["status"]>().mockResolvedValue(stage), settle: vi.fn<MapStageClient["settle"]>().mockResolvedValue(stage) } satisfies MapStageClient;
}
beforeEach(() => store().initialize(baseline(), "user"));
describe("durable map editor stages", () => {
  it("prepares a lazy 500k selection without canonical arrays or live commit", async () => {
    let count = 0;
    async function* operations(): AsyncGenerator<MapOp> { for (let i = 0; i < 500000; i++) { count++; yield { kind: "delete", id: `shape-${i}` }; } }
    const api = client();
    await store().prepareMapStream({ scope: store().mapScope!, operations }, lease, api);
    expect(count).toBe(500000); expect(api.commit).not.toHaveBeenCalled();
    expect(store().pendingMapStage?.preview).toEqual(preview);
    expect(store().mapElements.size).toBe(0); expect(store().mapOperations).toEqual([]);
    expect(store().isDirty).toBe(true); expect(store().state!.floor.mapRevision).toBe(3);
    expect(store().past).toHaveLength(1);
    await store().saveChanges(lease, undefined, api);
    expect(store().isDirty).toBe(false); expect(store().state!.floor.mapRevision).toBe(4);
    expect(store().past).toHaveLength(1); expect(store().pendingMapStage).toBeNull();
  });

  it("keeps fixture edits made after capture while a durable commit is pending", async () => {
    const api = client();
    await store().prepareMapStream({ scope: store().mapScope!, operations: async function* () { yield { kind: "delete", id: "shape" }; } }, lease, api);
    let resolve!: (value: any) => void;
    const result = await api.commit("floor", { id: "stage", intent: lease });
    api.commit.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const saving = store().saveChanges(lease, undefined, api);
    store().updateFixture("fixture", { name: "after capture" });
    resolve(result); await saving;
    expect(store().state!.fixtures[0].name).toBe("after capture"); expect(store().isDirty).toBe(true);
  });

  it("previews external undo without saving and commits only on explicit save", async () => {
    const api = client();
    await store().prepareMapStream({ scope: store().mapScope!, operations: async function* () { yield { kind: "delete", id: "shape" }; },
      fixtureUpdates: [{ id: "fixture", name: "Combined" }] }, lease, api);
    const result = await api.commit("floor", { id: "stage", intent: lease }); result.result!.fixtures[0].name = "Combined";
    api.commit.mockResolvedValue(result); await store().saveChanges(lease, undefined, api);
    api.commit.mockClear();
    api.prepareHistory.mockResolvedValue({ ...await api.prepareHistory("floor", {} as never, 3), baseRevision: 4,
      generationId: "prepared", preview: { ...preview, revision: 5, generationId: "undo-preview" } });
    await store().prepareHistory("undo", lease, api);
    expect(api.prepareHistory.mock.calls.at(-1)![2]).toBe(3);
    expect(api.commit).not.toHaveBeenCalled(); expect(store().state!.fixtures[0].name).toBe("Light");
    expect(store().future).toHaveLength(1); expect(store().isDirty).toBe(true);
  });

  it("routes dimension checkpoint through stage, keeps undo and new generation", async () => {
    expect(store().updateMapSettings({ width: 2000, height: 1500, gridSize: 20 })).toBeNull();
    expect(store().prepareSave(lease).reason).toBe("checkpoint");
    const api = client(); const result = await api.commit("floor", { id: "stage", intent: lease });
    result.result!.floor.mapDocument = { ...preview, width: 2000, height: 1500, gridSize: 20 };
    result.result!.floor.floorPlan = store().state!.floor.floorPlan;
    api.commit.mockResolvedValue(result);
    await store().saveChanges(lease, undefined, api);
    expect(api.prepare).toHaveBeenCalledOnce(); expect(store().isDirty).toBe(false);
    store().undo(); expect(store().prepareSave(lease).payload.floorPlan).toMatchObject({ width: 1000, height: 1000, gridSize: 10 });
  });

  it("ignores stale prepare after floor/auth switch and retains failed draft", async () => {
    const api = client(); let resolve!: (value: any) => void;
    const ready = await api.prepareHistory("floor", {} as never, 3);
    api.prepare.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const preparing = store().prepareMapStream({ scope: store().mapScope!, operations: async function* () {} }, lease, api);
    store().initialize(baseline(), "another-user"); resolve(ready);
    expect(await preparing).toBe("stale"); expect(store().pendingMapStage).toBeNull();
    store().updateMapSettings({ width: 1000, height: 1000, gridSize: 20 });
    api.prepare.mockRejectedValue(new Error("offline"));
    await expect(store().saveChanges(lease, undefined, api)).rejects.toThrow("offline");
    expect(store().isDirty).toBe(true); expect(store().isSaving).toBe(false);
  });

  it("retries failed stream preparation with the same request, changes ID for a new stream", async () => {
    const api = client(), transaction = { scope: store().mapScope!, operations: async function* (): AsyncGenerator<MapOp> { yield { kind: "delete", id: "shape" }; },
      fixtureUpdates: [{ id: "fixture", name: "Combined" }] };
    api.prepare.mockRejectedValueOnce(new Error("lost response"));
    await expect(store().prepareMapStream(transaction, lease, api)).rejects.toThrow("lost response");
    expect(store().state!.fixtures[0].name).toBe("Combined");
    expect(store().exportMapDraft()).toBeNull();
    await expect(store().saveChanges(lease, undefined, api)).rejects.toMatchObject({ code: "MAP_STAGE_NOT_READY" });
    await store().prepareMapStream(transaction, lease, api);
    const first = api.prepare.mock.calls[0][1];
    expect(api.prepare.mock.calls[1][1]).toEqual(first);
    await store().cancelMapStage(lease, api);
    await store().prepareMapStream({ ...transaction, scope: store().mapScope!, operations: async function* () {} }, lease, api);
    expect(api.prepare.mock.calls[2][1].documentChanges!.requestId).not.toBe(first.documentChanges!.requestId);
  });

  it("recovers ready-stage references and newer local edits without serializing credentials", async () => {
    const api = client();
    await store().prepareMapStream({ scope: store().mapScope!, operations: async function* () {}, fixtureUpdates: [{ id: "fixture", name: "Prepared" }] }, lease, api);
    store().updateFixture("fixture", { name: "Newer" });
    const draft = store().exportMapDraft()!;
    expect(JSON.stringify(draft)).not.toContain("leaseToken");
    expect(saveEditorDraft("user", baseline(), store().state!, draft)).toBe(true);
    const recovered = loadEditorDraft("user", baseline())!;
    store().initialize(baseline(), "user");
    expect(() => store().recoverDraft(recovered)).toThrow();
    await store().recoverStageDraft(recovered, lease, api);
    expect(store().pendingMapStage?.stageId).toBe("stage");
    const receipt = await api.commit("floor", { id: "stage", intent: lease }); receipt.result!.fixtures[0].name = "Prepared";
    api.commit.mockResolvedValue(receipt); await store().saveChanges(lease, undefined, api);
    expect(store().state!.fixtures[0].name).toBe("Newer"); expect(store().isDirty).toBe(true);
  });

  it("rejects expired/cross-scope stage drafts without changing the live state", async () => {
    const api = client();
    await store().prepareMapStream({ scope: store().mapScope!, operations: async function* () {} }, lease, api);
    const recovered = { ...store().state!, commonMapDraft: store().exportMapDraft()! };
    store().initialize(baseline(), "other");
    await expect(store().recoverStageDraft(recovered, lease, api)).rejects.toThrow();
    store().initialize(baseline(), "user"); api.status.mockResolvedValue({ ...await api.status("floor", "stage"), status: "expired" });
    await expect(store().recoverStageDraft(recovered, lease, api)).rejects.toThrow();
    expect(store().isDirty).toBe(false); expect(store().pendingMapStage).toBeNull();
  });

  it("keeps post-preview map edits dirty after stage ACK and undoes them", async () => {
    const api = client();
    await store().prepareMapStream({ scope: store().mapScope!, operations: async function* () {} }, lease, api);
    const scope = store().mapScope!;
    store().loadMapStructures(scope, { groups: [], layers: [{ id: "layer", name: "Shapes", visible: true, locked: false, order: 0 }] });
    const shape = { id: "added", type: "rectangle" as const, groupId: null, layerId: "layer", visible: true, locked: false, zIndex: 0, provenance: null,
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }, style: { strokeColor: "#000000", fillColor: null, strokeWidth: 1, opacity: 1 },
      geometry: { origin: { x: 10, y: 10 }, width: 20, height: 20 } };
    store().applyMapTransaction({ operations: [{ kind: "add", element: shape }] });
    await store().saveChanges(lease, undefined, api);
    expect(store().mapOperations).toEqual([{ kind: "add", element: shape }]); expect(store().isDirty).toBe(true);
    store().undo(); expect(store().mapOperations).toEqual([]); expect(store().isDirty).toBe(false);
  });

  it("cancels in-flight upload, ignores its late ready and never commits", async () => {
    const api = client(); const ready = await api.prepareHistory("floor", {} as never, 3);
    let resolve!: (value: any) => void;
    api.prepare.mockImplementationOnce(async (_floor, _body, _source, options) => {
      options?.onProgress?.({ stageId: "upload", phase: "uploading", partCount: 1, decodedBytes: 524288 });
      return new Promise(done => { resolve = done; });
    });
    const preparing = store().prepareMapStream({ scope: store().mapScope!, operations: async function* () {},
      fixtureUpdates: [{ id: "fixture", name: "Prepared" }] }, lease, api);
    expect(store().isPreparingMapStage).toBe(true);
    expect(await store().cancelMapStage(lease, api)).toBe("cancelled");
    resolve(ready); expect(await preparing).toBe("stale");
    expect(store().pendingMapStage).toBeNull(); expect(store().state!.fixtures[0].name).toBe("Light");
    expect(store().isPreparingMapStage).toBe(false); expect(api.commit).not.toHaveBeenCalled();
  });

  it("preserves failed cancellation and permits exact prepare retry", async () => {
    const api = client(), transaction = { scope: store().mapScope!, operations: async function* (): AsyncGenerator<MapOp> { yield { kind: "delete", id: "shape" }; } };
    api.prepare.mockImplementationOnce(async (_f, _b, _s, options) => { options?.onProgress?.({ stageId: "upload", phase: "uploading", partCount: 1, decodedBytes: 1 }); throw new Error("offline"); });
    await expect(store().prepareMapStream(transaction, lease, api)).rejects.toThrow("offline");
    api.cancel.mockRejectedValueOnce(new Error("status unknown"));
    await expect(store().cancelMapStage(lease, api)).rejects.toThrow("status unknown");
    await store().prepareMapStream(transaction, lease, api);
    expect(api.prepare.mock.calls[1][1]).toEqual(api.prepare.mock.calls[0][1]);
    expect(store().pendingMapStage).not.toBeNull(); expect(api.commit).not.toHaveBeenCalled();
  });

  it("retries lost commit with its captured request and preserves newer fixture edits", async () => {
    const api = client(); store().updateMapSettings({ width: 1000, height: 1000, gridSize: 20 });
    api.commit.mockRejectedValueOnce(new Error("lost commit"));
    await expect(store().saveChanges(lease, undefined, api)).rejects.toThrow("lost commit");
    store().updateFixture("fixture", { name: "Newer" });
    await store().saveChanges(lease, undefined, api);
    expect(api.prepare).toHaveBeenCalledOnce(); expect(api.commit.mock.calls[0][1]).toEqual(api.commit.mock.calls[1][1]);
    expect(store().state!.fixtures[0].name).toBe("Newer"); expect(store().isDirty).toBe(true);
  });

  it("commits external undo then prepares redo by the original durable revision", async () => {
    const api = client();
    await store().prepareMapStream({ scope: store().mapScope!, operations: async function* () {} }, lease, api);
    await store().saveChanges(lease, undefined, api);
    for (const [direction, target] of [["undo", 3], ["redo", 4]] as const) {
      const current = store().initialState!, nextRef = { ...current.floor.mapDocument!, generationId: `preview-${direction}`, revision: current.floor.mapRevision + 1 };
      const handle: PreparedMapStage = { ...await api.prepareHistory("floor", {} as never, 1), intent: lease,
        generationId: current.floor.mapDocument!.generationId, baseRevision: current.floor.mapRevision, preview: nextRef };
      api.prepareHistory.mockResolvedValue(handle);
      await store().prepareHistory(direction, lease, api);
      expect(api.prepareHistory.mock.calls.at(-1)![2]).toBe(target);
      api.commit.mockResolvedValue({ ...handle, status: "committed", result: { ...current,
        floor: { ...current.floor, mapRevision: nextRef.revision, mapDocument: nextRef },
        history: { undo: { revision: current.floor.mapRevision }, redo: { revision: nextRef.revision } } } });
      await store().saveChanges(lease, undefined, api);
      expect(store().isDirty).toBe(false);
    }
    expect(store().past).toHaveLength(1); expect(store().future).toHaveLength(0);
    expect(store().state!.floor.mapRevision).toBe(6);
  });
});
