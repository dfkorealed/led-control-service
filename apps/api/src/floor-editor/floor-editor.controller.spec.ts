import { BadRequestException } from "@nestjs/common";
import { FloorEditorController } from "./floor-editor.controller";

describe("FloorEditorController", () => {
  const user = {
    id: "operator-1",
    organizationId: "service-provider-1",
    organizationType: "service_provider",
    loginId: "fixture_user",
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
      restoreEditorRevision: jest.fn()
    };
    const leaseService = { acquire: jest.fn(), release: jest.fn() };
    const controller = new FloorEditorController(service as never, leaseService as never);

    await controller.getEditorState("floor-1", user);
    await (controller as any).saveEditorState(
      "floor-1",
      { expectedRevision: 3, leaseToken: "lease-token", leaseFence: 7 },
      user
    );
    await (controller as any).listEditorRevisions("floor-1", { cursor: "2", limit: "20" }, user);
    await (controller as any).restoreEditorRevision(
      "floor-1",
      "2",
      { expectedRevision: 3, leaseToken: "lease-token", leaseFence: 7 },
      user
    );
    await (controller as any).acquireLease("floor-1", { token: "lease-token" }, user);
    await (controller as any).releaseLease("floor-1", { token: "lease-token", force: false }, user);

    expect(service.getEditorState).toHaveBeenCalledWith("floor-1", user);
    expect(service.saveEditorState).toHaveBeenCalledWith(user, "floor-1", {
      expectedRevision: 3,
      leaseToken: "lease-token",
      leaseFence: 7
    });
    expect(service.listEditorRevisions).toHaveBeenCalledWith(user, "floor-1", { cursor: "2", limit: "20" });
    expect(service.restoreEditorRevision).toHaveBeenCalledWith(user, "floor-1", "2", {
      expectedRevision: 3,
      leaseToken: "lease-token",
      leaseFence: 7
    });
    expect(leaseService.acquire).toHaveBeenCalledWith("floor-1", user, "lease-token");
    expect(leaseService.release).toHaveBeenCalledWith("floor-1", user, false, "lease-token");
  });

  it.each(["2147483648", "1e100", "0", "1.5"])(
    "forwards raw restore revision %s for access-aware service validation",
    (revision) => {
      const service = { restoreEditorRevision: jest.fn() };
      const controller = new FloorEditorController(service as never, service as never);

      controller.restoreEditorRevision("floor-1", revision, { expectedRevision: 0 }, user);

      expect(service.restoreEditorRevision).toHaveBeenCalledWith(user, "floor-1", revision, { expectedRevision: 0 });
    }
  );

  it("defaults missing lease bodies while rejecting a JSON null body with a controlled validation error", () => {
    const leaseService = { acquire: jest.fn(), release: jest.fn() };
    const controller = new FloorEditorController({} as never, leaseService as never);

    controller.acquireLease("floor-1", undefined as never, user);
    controller.releaseLease("floor-1", undefined as never, user);

    expect(leaseService.acquire).toHaveBeenCalledWith("floor-1", user, undefined);
    expect(leaseService.release).toHaveBeenCalledWith("floor-1", user, false, undefined);
    expect(() => controller.acquireLease("floor-1", null as never, user)).toThrow(BadRequestException);
  });

  it("removes legacy per-object mutation handlers once atomic editor save is authoritative", () => {
    const controller = new FloorEditorController({} as never, {} as never);

    expect("updateFloorPlan" in controller).toBe(false);
    expect("updateFixture" in controller).toBe(false);
    expect("createObject" in controller).toBe(false);
    expect("updateObject" in controller).toBe(false);
    expect("deleteObject" in controller).toBe(false);
  });
});
