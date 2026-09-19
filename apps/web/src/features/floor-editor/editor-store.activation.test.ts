import { afterEach, expect, it } from "vitest";
import type { MapStageClient, MapStage, PreparedMapStage } from "../../api/map-stages";
import { useFloorEditorStore } from "./editor-store";
import { createMapElementFromDrag } from "./map-element-tools";

// Load the API fixture in its own TS/decorator context. The web application does
// not depend on the API DI graph; this test bridges only the actual receipts.
const fixturePath = "../../../../api/src/floor-editor/map-document-staging.test-fixture.ts";
const { createStageActivationFixture } = await import(/* @vite-ignore */ fixturePath);
const store = useFloorEditorStore.getState;
afterEach(() => store().reset());

it.each(["save", "committed cancel", "foreign generation"])("validates actual retry ACK via %s while preserving newer edits", async mode => {
  const h = createStageActivationFixture();
  store().initialize(h.initial, "user");
  let loseCommittedReceipt = mode === "committed cancel";
  const status = () => h.service.status("floor", "stage", h.user) as Promise<MapStage>;
  const client: MapStageClient = {
    prepare: async (_floor, payload, operations) => {
      for await (const _op of operations) { /* The checkpoint IO double is geometry-independent. */ }
      h.seed(payload); await h.service.processPending();
      return { ...await status(), intent: h.intent } as PreparedMapStage;
    },
    prepareHistory: async () => { throw new Error("not used"); },
    status, settle: status,
    commit: async () => {
      await h.service.commit("floor", "stage", h.user, h.intent); await h.service.processPending();
      const receipt = await status();
      if (receipt.status !== "committed") throw new Error(receipt.errorCode!);
      if (loseCommittedReceipt) { loseCommittedReceipt = false; throw new Error("lost committed receipt"); }
      if (mode === "foreign generation") return { ...receipt, result: { ...receipt.result!, floor: { ...receipt.result!.floor,
        mapDocument: { ...receipt.result!.floor.mapDocument!, generationId: "foreign" } } } };
      return receipt;
    },
    cancel: async () => {
      try { return await h.service.cancel("floor", "stage", h.user, h.lease); }
      catch { return status(); }
    }
  };
  await store().prepareMapStream({ scope: store().mapScope!, operations: async function* () {},
    fixtureUpdates: [{ id: "fixture", name: "captured" }] }, h.lease, client);
  const preview = store().pendingMapStage!.preview;
  store().loadMapStructures(store().mapScope!, { groups: [], layers: [{ id: "map", name: "Map", order: 0, visible: true, locked: false }] });
  const added = createMapElementFromDrag("rectangle", { x: 100, y: 100 }, { x: 120, y: 120 }, "post-preview")!;
  store().applyMapTransaction({ operations: [{ kind: "add", element: added }], fixtureUpdates: [{ id: "fixture", name: "newer" }] });
  await expect(store().saveChanges(h.lease, undefined, client)).rejects.toThrow("stage_preparation_failed");
  expect(h.snapshot().stage).toMatchObject({ payloadHash: h.intent.sha256, expectedPartCount: h.intent.partCount, expectedDecodedBytes: BigInt(h.intent.decodedBytes) });
  expect(store().initialState!.floor.mapRevision).toBe(3);
  if (mode === "foreign generation") {
    await expect(store().saveChanges(h.lease, undefined, client)).rejects.toMatchObject({ code: "MAP_SAVE_RESPONSE_INVALID" });
    expect(store().initialState!.floor.mapRevision).toBe(3); expect(store().isDirty).toBe(true);
    expect(store().pendingMapStage!.preview).toEqual(preview);
    return;
  }
  if (mode === "save") await expect(store().saveChanges(h.lease, undefined, client)).resolves.toBe("saved");
  else {
    await expect(store().saveChanges(h.lease, undefined, client)).rejects.toThrow("lost committed receipt");
    await expect(store().cancelMapStage(h.lease, client)).resolves.toBe("committed");
  }
  expect(h.preparations()).toBe(1);
  expect(store().initialState!.floor.mapDocument).toEqual(preview);
  expect(store().initialState!.fixtures[0].name).toBe("captured");
  expect(store().state!.fixtures[0].name).toBe("newer");
  expect(store().mapOperations).toEqual([{ kind: "add", element: added }]);
  expect(store().isDirty).toBe(true); expect(store().pendingMapStage).toBeNull();
  expect(h.snapshot()).toMatchObject({ revisions: 1, audits: 1 });
  store().undo();
  expect(store().isDirty).toBe(false); expect(store().state!.fixtures[0].name).toBe("captured");
});
