import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireFloorEditorLease,
  applyFloorImportJob,
  cancelFloorImportJob,
  createFloorImportJob,
  getActiveFloorImportJob,
  getAppliedFloorImportOverlay,
  getFloorEditorState,
  getFloorImportJob,
  identifyFixture,
  listFloorImportCandidates,
  listFloorEditorRevisions,
  releaseFloorEditorLease,
  restoreFloorEditorRevision,
  saveFloorEditorState
} from "./floor-editor";

const completeApplyResult = {
  jobId: "00000000-0000-4000-8000-000000000001",
  status: "completed",
  revision: 5,
  acceptedCandidateIds: ["00000000-0000-4000-8000-000000000002"],
  renderedAssetId: "00000000-0000-4000-8000-000000000003",
  deletedObjectCount: 2,
  unplacedFixtureCount: 4,
  deletedSlotCount: 1,
  createdSlotCount: 1,
  floorPlan: {
    imageUrl: "/api/floors/floor/assets/rendered/content",
    sourceType: "image",
    originalFileUrl: "/api/floors/floor/assets/source/content",
    renderedImageUrl: "/api/floors/floor/assets/rendered/content",
    width: 640,
    height: 480,
    gridSize: 10
  }
} as const;

const completeEditorState = {
  floor: {
    id: "floor/1",
    siteId: "site-1",
    name: "B1",
    level: -1,
    mapRevision: 4,
    floorPlan: null
  },
  fixtures: [],
  lightSlots: [{ id: "slot-1", x: 120, y: 140, rotation: 0, assignedFixtureId: null }],
  objects: []
} as const;

describe("floor editor atomic API", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("sends an owned-token release with keepalive during page teardown", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ released: true }) });
    vi.stubGlobal("fetch", fetchMock);
    await releaseFloorEditorLease("floor/1", "owned-token", { keepalive: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/floors/floor%2F1/editor-lease", expect.objectContaining({
      method: "DELETE", keepalive: true, credentials: "include", body: JSON.stringify({ token: "owned-token" })
    }));
  });
  it("encodes the identify scope and retains the matching stop session", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ status: "stopped" }) });
    vi.stubGlobal("fetch", fetchMock);
    await identifyFixture("floor/1", "fixture/2", { action: "stop", sessionId: "session", leaseToken: "lease", leaseFence: 2 });
    expect(fetchMock).toHaveBeenCalledWith("/api/floors/floor%2F1/fixtures/fixture%2F2/identify", expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "stop", sessionId: "session", leaseToken: "lease", leaseFence: 2 }) }));
  });

  it("preserves light slots across get, atomic save, and revision restore responses", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(completeEditorState) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(completeEditorState) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ items: [], nextCursor: null }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ...completeEditorState, skippedFixtureIds: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    const loaded = await getFloorEditorState("floor/1");
    const saved = await saveFloorEditorState("floor/1", {
      expectedRevision: 4,
      leaseToken: "lease-token",
      leaseFence: 7,
      fixtureUpdates: [], objectCreates: [], objectUpdates: [], objectDeletes: []
    });
    await listFloorEditorRevisions("floor/1", { cursor: 12, limit: 5 });
    const restored = await restoreFloorEditorRevision("floor/1", 3, { expectedRevision: 4, leaseToken: "lease-token", leaseFence: 7 });

    expect(loaded.lightSlots).toEqual(completeEditorState.lightSlots);
    expect(saved.lightSlots).toEqual(completeEditorState.lightSlots);
    expect(restored.lightSlots).toEqual(completeEditorState.lightSlots);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/floors/floor%2F1/editor-state", expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/floors/floor%2F1/editor-state", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({
        expectedRevision: 4,
        leaseToken: "lease-token",
        leaseFence: 7,
        fixtureUpdates: [],
        objectCreates: [],
        objectUpdates: [],
        objectDeletes: []
      })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/floors/floor%2F1/editor-revisions?cursor=12&limit=5", expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/floors/floor%2F1/editor-revisions/3/restore", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ expectedRevision: 4, leaseToken: "lease-token", leaseFence: 7 })
    }));
  });

  it("uses the lease endpoint for acquisition, token renewal, and normal release", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ editable: true, token: "lease-token" }) });
    vi.stubGlobal("fetch", fetchMock);

    await acquireFloorEditorLease("floor/1");
    await acquireFloorEditorLease("floor/1", "lease-token");
    await releaseFloorEditorLease("floor/1", "lease-token");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/floors/floor%2F1/editor-lease", expect.objectContaining({
      method: "POST", body: "{}"
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/floors/floor%2F1/editor-lease", expect.objectContaining({
      method: "POST", body: JSON.stringify({ token: "lease-token" })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/floors/floor%2F1/editor-lease", expect.objectContaining({
      method: "DELETE", body: JSON.stringify({ token: "lease-token" })
    }));
  });

  it("uses encoded CAD import job endpoints and preserves the fenced apply payload", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(url.endsWith("/apply") ? completeApplyResult : { status: "queued" })
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createFloorImportJob("floor/1", { sourceAssetId: "asset-id", sourceFormat: "dxf" });
    await getActiveFloorImportJob("floor/1");
    await getAppliedFloorImportOverlay("floor/1");
    await getFloorImportJob("floor/1", "job/1");
    await listFloorImportCandidates("floor/1", "job/1");
    await applyFloorImportJob("floor/1", "job/1", {
      expectedRevision: 4,
      leaseToken: "lease-token",
      leaseFence: 7,
      confirmMapReset: true,
      candidateIds: ["candidate-1"]
    });
    await cancelFloorImportJob("floor/1", "job/1");

    const base = "/api/floors/floor%2F1/import-jobs/job%2F1";
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/floors/floor%2F1/import-jobs", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ sourceAssetId: "asset-id", sourceFormat: "dxf" })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/floors/floor%2F1/import-jobs/active", expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/floors/floor%2F1/import-jobs/applied-overlay", expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(4, base, expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(5, `${base}/candidates`, expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(6, `${base}/apply`, expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        expectedRevision: 4,
        leaseToken: "lease-token",
        leaseFence: 7,
        confirmMapReset: true,
        candidateIds: ["candidate-1"]
      })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(7, `${base}/cancel`, expect.objectContaining({ method: "POST" }));
  });

  it("rejects a CAD apply response when an atomic reset count is missing", async () => {
    const { createdSlotCount: _missing, ...incomplete } = completeApplyResult;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(completeApplyResult) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(incomplete) });
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      expectedRevision: 4, leaseToken: "lease-token", leaseFence: 7,
      confirmMapReset: true as const, candidateIds: ["00000000-0000-4000-8000-000000000002"]
    };

    await expect(applyFloorImportJob("floor-1", "job-1", input)).resolves.toEqual(completeApplyResult);
    await expect(applyFloorImportJob("floor-1", "job-1", input)).rejects.toBeDefined();
  });
});
