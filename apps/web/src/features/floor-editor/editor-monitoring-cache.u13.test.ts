import { QueryClient } from "@tanstack/react-query";
import type { FloorMapSnapshot } from "@led-control/shared";
import { describe, expect, it } from "vitest";
import type { FloorEditorState } from "./editor-types";
import { synchronizeMonitoringCaches } from "./editor-monitoring-cache";

const key = ["floor-map", "site", "floor"];
function saved(revision: number, generationId = "generation"): FloorEditorState {
  return { floor: { id: "floor", siteId: "site", name: "B1", level: 1, mapRevision: revision,
    floorPlan: null, mapDocument: { formatVersion: 1, generationId, revision, width: 1600, height: 900,
      gridSize: 10, elementCount: 0, manifest: { assetId: "manifest", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 } } },
    fixtures: [], lightSlots: [], objects: [] };
}

describe("U13 confirmed monitoring snapshots", () => {
  it("does not let a late confirmed response downgrade an already adopted revision or generation", () => {
    const client = new QueryClient();
    synchronizeMonitoringCaches(client, saved(5, "replacement"));
    synchronizeMonitoringCaches(client, saved(4));
    expect(client.getQueryData<FloorMapSnapshot>(key)).toMatchObject({ revision: 5,
      width: 1600, height: 900, mapDocument: { generationId: "replacement", revision: 5 } });
  });

  it("owns the saved reference, leaves drafts unpublished and isolates another floor", () => {
    const client = new QueryClient(); const state = saved(3);
    synchronizeMonitoringCaches(client, state);
    state.floor.mapDocument!.manifest.sha256 = "b".repeat(64);
    state.floor.mapDocument!.elementCount = 99;
    expect(client.getQueryData<FloorMapSnapshot>(key)?.mapDocument).toMatchObject({ elementCount: 0,
      manifest: { sha256: "a".repeat(64) } });
    const next = saved(4); next.floor.id = "other";
    synchronizeMonitoringCaches(client, next);
    expect(client.getQueryData<FloorMapSnapshot>(key)?.revision).toBe(3);
    expect(client.getQueryData<FloorMapSnapshot>(["floor-map", "site", "other"])?.revision).toBe(4);
  });

  it("publishes saved deletion and saved undo references without a legacy display or local geometry", () => {
    const client = new QueryClient();
    synchronizeMonitoringCaches(client, saved(4));
    expect(client.getQueryData<FloorMapSnapshot>(key)).toMatchObject({ objects: [], floorPlan: null,
      mapDocument: { revision: 4, elementCount: 0 } });
    const undo = saved(5); undo.floor.mapDocument!.elementCount = 1;
    synchronizeMonitoringCaches(client, undo);
    expect(client.getQueryData<FloorMapSnapshot>(key)?.mapDocument).toMatchObject({ revision: 5, elementCount: 1 });
  });
});
