import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listFloorEditorRevisions,
  restoreFloorEditorRevision,
  saveFloorEditorState
} from "./floor-editor";

describe("floor editor atomic API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses atomic save and revision endpoints with encoded pagination", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ items: [], nextCursor: null }) });
    vi.stubGlobal("fetch", fetchMock);

    await saveFloorEditorState("floor/1", {
      expectedRevision: 4,
      fixtureUpdates: [], objectCreates: [], objectUpdates: [], objectDeletes: []
    });
    await listFloorEditorRevisions("floor/1", { cursor: 12, limit: 5 });
    await restoreFloorEditorRevision("floor/1", 3, { expectedRevision: 4 });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/floors/floor%2F1/editor-state", expect.objectContaining({ method: "PUT" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/floors/floor%2F1/editor-revisions?cursor=12&limit=5", expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/floors/floor%2F1/editor-revisions/3/restore", expect.objectContaining({ method: "POST" }));
  });
});
