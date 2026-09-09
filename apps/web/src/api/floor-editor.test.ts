import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireFloorEditorLease,
  identifyFixture,
  listFloorEditorRevisions,
  releaseFloorEditorLease,
  restoreFloorEditorRevision,
  saveFloorEditorState
} from "./floor-editor";

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

  it("uses atomic save and revision endpoints with encoded pagination", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ items: [], nextCursor: null }) });
    vi.stubGlobal("fetch", fetchMock);

    await saveFloorEditorState("floor/1", {
      expectedRevision: 4,
      leaseToken: "lease-token",
      leaseFence: 7,
      fixtureUpdates: [], objectCreates: [], objectUpdates: [], objectDeletes: []
    });
    await listFloorEditorRevisions("floor/1", { cursor: 12, limit: 5 });
    await restoreFloorEditorRevision("floor/1", 3, { expectedRevision: 4, leaseToken: "lease-token", leaseFence: 7 });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/floors/floor%2F1/editor-state", expect.objectContaining({
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
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/floors/floor%2F1/editor-revisions?cursor=12&limit=5", expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/floors/floor%2F1/editor-revisions/3/restore", expect.objectContaining({
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
});
