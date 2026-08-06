import { FloorEditorController } from "./floor-editor.controller";

describe("FloorEditorController", () => {
  const user = {
    id: "operator-1",
    organizationId: "service-provider-1",
    organizationType: "service_provider",
    email: "operator@example.com",
    name: "Operator",
    role: "operator",
    status: "active"
  } as const;

  it("passes the authenticated user to editor state and mutating service methods", async () => {
    const service = {
      getEditorState: jest.fn(),
      saveEditorState: jest.fn(),
      listEditorRevisions: jest.fn(),
      restoreEditorRevision: jest.fn(),
      updateFloorPlan: jest.fn(),
      updateFixture: jest.fn(),
      createObject: jest.fn(),
      updateObject: jest.fn(),
      deleteObject: jest.fn()
    };
    const controller = new FloorEditorController(service as never);

    await controller.getEditorState("floor-1", user);
    await (controller as any).saveEditorState("floor-1", { expectedRevision: 3 }, user);
    await (controller as any).listEditorRevisions("floor-1", { cursor: "2", limit: "20" }, user);
    await (controller as any).restoreEditorRevision("floor-1", "2", { expectedRevision: 3 }, user);
    await controller.updateFloorPlan("floor-1", { imageUrl: "https://assets.example/floor.png" }, user);
    await controller.updateFixture("fixture-1", { x: 100 }, user);
    await controller.createObject({ floorId: "floor-1", type: "text", x: 1, y: 2 }, user);
    await controller.updateObject("object-1", { x: 3 }, user);
    await controller.deleteObject("object-1", user);

    expect(service.getEditorState).toHaveBeenCalledWith("floor-1", user);
    expect(service.saveEditorState).toHaveBeenCalledWith(user, "floor-1", { expectedRevision: 3 });
    expect(service.listEditorRevisions).toHaveBeenCalledWith(user, "floor-1", { cursor: "2", limit: "20" });
    expect(service.restoreEditorRevision).toHaveBeenCalledWith(user, "floor-1", 2, { expectedRevision: 3 });
    expect(service.updateFloorPlan).toHaveBeenCalledWith("floor-1", { imageUrl: "https://assets.example/floor.png" }, user);
    expect(service.updateFixture).toHaveBeenCalledWith("fixture-1", { x: 100 }, user);
    expect(service.createObject).toHaveBeenCalledWith({ floorId: "floor-1", type: "text", x: 1, y: 2 }, user);
    expect(service.updateObject).toHaveBeenCalledWith("object-1", { x: 3 }, user);
    expect(service.deleteObject).toHaveBeenCalledWith("object-1", user);
  });
});
