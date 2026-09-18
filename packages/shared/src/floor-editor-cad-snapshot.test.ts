import { describe, expect, it } from "vitest";
import { parseFloorEditorSnapshot } from "./schemas";

describe("CAD floor editor snapshot compatibility", () => {
  it("requires an immutable scene identity for a V2 CAD floor plan", () => {
    const snapshot = {
      version: 2 as const,
      floorPlan: {
        imageUrl: "",
        sourceType: "cad" as const,
        originalFileUrl: null,
        renderedImageUrl: null,
        width: 8192,
        height: 4096,
        gridSize: 40
      },
      fixtures: [],
      objects: [],
      lightSlots: [],
      cadScene: {
        id: "00000000-0000-4000-8000-000000000101",
        width: 8192,
        height: 4096
      }
    };

    expect(parseFloorEditorSnapshot(snapshot)).toEqual(snapshot);
    expect(() => parseFloorEditorSnapshot({ ...snapshot, cadScene: undefined })).toThrow();

    const {
      version: _version,
      cadScene: _cadScene,
      lightSlots: _lightSlots,
      ...versionlessCadSnapshot
    } = snapshot;
    expect(() => parseFloorEditorSnapshot(versionlessCadSnapshot)).toThrow();
  });
});
