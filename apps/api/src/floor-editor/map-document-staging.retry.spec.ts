import { createStageActivationFixture } from "./map-document-staging.test-fixture";

describe("stage preview identity across activation rollback", () => {
  const payload = (h: ReturnType<typeof createStageActivationFixture>) => ({ ...h.lease, expectedRevision: 3,
    fixtureUpdates: [{ id: "fixture", name: "captured" }], slotAssignments: [], objectCreates: [], objectUpdates: [], objectDeletes: [],
    documentChanges: { requestId: "request", generationId: "base", operations: [] } });

  it("retains the published generation through rollback, authorized preview, retry and receipt replay", async () => {
    const h = createStageActivationFixture(); h.seed(payload(h));
    await h.service.processPending();
    const ready = await h.service.status("floor", "stage", h.user);
    expect(ready.preview?.generationId).toBe("G1");
    await h.service.commit("floor", "stage", h.user, h.intent); await h.service.processPending();
    expect(h.snapshot()).toMatchObject({ stage: { status: "failed", preparedGenerationId: "G1" }, head: { revision: 3 }, revisions: 0, audits: 0 });
    expect(h.snapshot().saved.fixtures[0].name).toBe("before");
    expect(h.discarded).toEqual([]);
    expect(await h.service.resolvePreview("floor", "stage", h.user)).toEqual(ready.preview);
    await h.service.commit("floor", "stage", h.user, h.intent);
    expect(await h.service.resolvePreview("floor", "stage", h.user)).toEqual(ready.preview);
    await h.service.processPending();
    const committed = await h.service.status("floor", "stage", h.user);
    expect(committed).toMatchObject({ status: "committed", result: { floor: { mapDocument: ready.preview } } });
    expect(h.preparations()).toBe(1);
    expect(h.snapshot()).toMatchObject({ revisions: 1, audits: 1 });
    expect(await h.service.commit("floor", "stage", h.user, h.intent)).toEqual(committed);
    await expect(h.service.resolvePreview("floor", "stage", h.user)).rejects.toThrow();
  });

  it("still discards a failed unpublished generation and fences cancelled previews", async () => {
    const h = createStageActivationFixture(); h.seed(payload(h), true);
    await h.service.processPending();
    expect(h.discarded).toEqual(["G1"]); expect(h.snapshot().stage?.preparedGenerationId).toBeNull();
    await h.service.prepare("floor", "stage", h.user, h.intent); await h.service.processPending();
    const ready = await h.service.status("floor", "stage", h.user); expect(ready.preview?.generationId).toBe("G2");
    await h.service.cancel("floor", "stage", h.user, h.lease);
    expect(h.snapshot().stage?.preparedGenerationId).toBeNull();
    await expect(h.service.resolvePreview("floor", "stage", h.user)).rejects.toThrow();
    await expect(h.service.commit("floor", "stage", h.user, h.intent)).rejects.toThrow();
  });
});
