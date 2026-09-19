import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireFloorEditorLease,
  applyFloorImportJob,
  cancelFloorImportJob,
  createFloorImportJob,
  getActiveFloorImportJob,
  getAppliedFloorImportOverlay,
  getCadSceneState,
  getCadSceneManifest,
  getCadSceneTile,
  getFloorEditorState,
  getFloorImportJob,
  identifyFixture,
  listFloorImportCandidates,
  listFloorEditorRevisions,
  releaseFloorEditorLease,
  restoreFloorEditorRevision,
  saveFloorEditorState,
  updateCadScene
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
  it("uses the existing full envelope and validates converted GET/PUT document references", async () => {
    const document = { formatVersion: 1, generationId: "generation", revision: 4, width: 16384,
      height: 8192, gridSize: 80, elementCount: 0,
      manifest: { assetId: "manifest", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 } };
    const loaded = { ...completeEditorState, floor: { ...completeEditorState.floor, mapDocument: document } };
    const saved = { ...loaded, floor: { ...loaded.floor, mapRevision: 5, mapDocument: { ...document, revision: 5 } } };
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => loaded })
      .mockResolvedValueOnce({ ok: true, json: async () => saved });
    vi.stubGlobal("fetch", fetchMock);
    expect(await getFloorEditorState("floor/1")).toEqual(loaded);
    const payload = { expectedRevision: 4, leaseToken: "token", leaseFence: 2, fixtureUpdates: [], slotAssignments: [],
      objectCreates: [], objectUpdates: [], objectDeletes: [],
      documentChanges: { requestId: "retry-me", generationId: "generation", operations: [] } };
    expect(await saveFloorEditorState("floor/1", payload)).toEqual(saved);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(payload);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/floors/floor%2F1/editor-state");
  });

  it("does not turn an invalid optional document into an empty legacy document", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true,
      json: async () => ({ ...completeEditorState, floor: { ...completeEditorState.floor, mapDocument: { generationId: "broken" } } }) }));
    await expect(getFloorEditorState("floor/1")).rejects.toBeDefined();
  });

  it("rejects mixed legacy writes and over-budget full envelopes before sending", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const payload = { expectedRevision: 4, leaseToken: "token", leaseFence: 2, fixtureUpdates: [], slotAssignments: [],
      objectCreates: [], objectUpdates: [], objectDeletes: ["old"],
      documentChanges: { requestId: "retry-me", generationId: "generation", operations: [] } };
    await expect(saveFloorEditorState("floor/1", payload)).rejects.toBeDefined();
    await expect(saveFloorEditorState("floor/1", { ...payload, objectDeletes: [], leaseToken: "x".repeat(1048576) })).rejects.toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("sends an owned-token release with keepalive during page teardown", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ released: true }) });
    vi.stubGlobal("fetch", fetchMock);
    await releaseFloorEditorLease("floor/1", "owned-token", { keepalive: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/floors/floor%2F1/editor-lease", expect.objectContaining({
      method: "DELETE", keepalive: true, credentials: "include", body: JSON.stringify({ token: "owned-token" })
    }));
  });

  it("loads and atomically updates the scoped CAD scene state", async () => {
    const controller = new AbortController();
    const state = { revision: 8, scene: {
      id: "00000000-0000-4000-8000-000000000001", version: 1,
      sourceImportJobId: "00000000-0000-4000-8000-000000000002",
      width: 16_384, height: 8_192, tileSize: 512, primitiveCount: 0, tileCount: 0,
      manifestAssetId: "00000000-0000-4000-8000-000000000003",
      manifestContentPath: "/floors/floor/scene/manifest/content",
      tileContentPathTemplate: "/floors/floor/scene/tiles/{lod}/{tileX}/{tileY}/{part}/content",
      statePath: "/sites/site/floors/floor/cad-scene"
    }, overrides: [], layers: [] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(state) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ...state, revision: 9 }) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCadSceneState("site/1", "floor/1", { signal: controller.signal })).resolves.toEqual(state);
    await expect(updateCadScene("site/1", "floor/1", {
      expectedRevision: 8,
      leaseToken: "lease-token",
      leaseFence: 7,
      overrideMutations: [],
      layerMutations: [{
        layerName: "WALL",
        visible: false,
        locked: false,
        locator: { tileX: 0, tileY: 0, lod: 0, part: 0 }
      }]
    }, { signal: controller.signal })).resolves.toMatchObject({ revision: 9 });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/sites/site%2F1/floors/floor%2F1/cad-scene",
      expect.objectContaining({ credentials: "include", signal: controller.signal })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/sites/site%2F1/floors/floor%2F1/cad-scene",
      expect.objectContaining({ method: "PUT", credentials: "include", signal: controller.signal })
    );
  });

  it("validates a CAD manifest and loads binary tiles with an abort signal", async () => {
    const manifest = {
      version: 1,
      sceneId: "00000000-0000-4000-8000-000000000001",
      regionId: "region-1",
      manifestAssetId: "00000000-0000-4000-8000-000000000002",
      width: 16_384,
      height: 8_192,
      padding: 328,
      gridSize: 80,
      tileSize: 512,
      lodMode: "additive",
      primitiveCount: 0,
      tileCount: 0,
      byteSize: 1,
      sha256: "0".repeat(64),
      sourceBounds: { minX: 0, minY: 0, maxX: 2, maxY: 1 },
      transform: { scaleX: 7_536, scaleY: -7_536, translateX: 656, translateY: 7_864 },
      tiles: []
    };
    const bytes = new Uint8Array([1, 2, 3]);
    const controller = new AbortController();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest)))
      .mockResolvedValueOnce(new Response(bytes));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCadSceneManifest("/floors/floor/import-jobs/job/scene/manifest/content", controller.signal))
      .resolves.toMatchObject({ sceneId: manifest.sceneId, tileSize: 512 });
    await expect(getCadSceneTile("/floors/floor/import-jobs/job/scene/tiles/0/0/0/0/content", controller.signal))
      .resolves.toEqual(bytes);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/floors/floor/import-jobs/job/scene/manifest/content", {
      credentials: "same-origin",
      signal: controller.signal
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/floors/floor/import-jobs/job/scene/tiles/0/0/0/0/content", {
      credentials: "same-origin",
      signal: controller.signal
    });
  });
  it("rejects malformed CAD state before passing it to the editor", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ revision: 1, scene: {}, overrides: [], layers: [] }) }));
    await expect(getCadSceneState("site", "floor")).rejects.toThrow();
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
      fixtureUpdates: [], slotAssignments: [], objectCreates: [], objectUpdates: [], objectDeletes: []
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
        slotAssignments: [],
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

  it("accepts full-floor CAD apply counts and the final PostgreSQL Int revision", async () => {
    const largeResult = {
      ...completeApplyResult,
      revision: 2_147_483_647,
      deletedObjectCount: 2_001,
      unplacedFixtureCount: 1_001
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(largeResult)
    }));

    await expect(applyFloorImportJob("floor-1", "job-1", {
      expectedRevision: 2_147_483_646,
      leaseToken: "lease-token",
      leaseFence: 7,
      confirmMapReset: true,
      candidateIds: []
    })).resolves.toEqual(largeResult);
  });
});
