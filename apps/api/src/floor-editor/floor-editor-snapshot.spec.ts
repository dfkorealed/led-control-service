import { buildFloorEditorSnapshot } from "./floor-editor-snapshot";

describe("buildFloorEditorSnapshot CAD compatibility", () => {
  it("captures CAD scene identity with the floor plan dimensions", () => {
    const snapshot = buildFloorEditorSnapshot({
      floorPlan: {
        imageUrl: "",
        sourceType: "cad",
        originalFileUrl: null,
        renderedImageUrl: null,
        width: 8192,
        height: 4096,
        gridSize: 40
      },
      fixtures: [],
      mapObjects: [],
      lightSlots: [],
      cadScene: {
        id: "00000000-0000-4000-8000-000000000101",
        width: 8192,
        height: 4096
      }
    });

    expect(snapshot.floorPlan).toEqual(expect.objectContaining({
      sourceType: "cad",
      width: 8192,
      height: 4096
    }));
    expect(snapshot).toMatchObject({
      cadScene: {
        id: "00000000-0000-4000-8000-000000000101",
        width: 8192,
        height: 4096
      }
    });
  });
});
