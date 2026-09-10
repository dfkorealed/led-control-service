import "reflect-metadata";
import { BadRequestException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { RolesGuard } from "../access/roles.guard";
import { rolesMetadataKey } from "../access/roles.decorator";
import { AuthenticatedUser } from "../auth/auth.types";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { SetupController } from "./setup.controller";
import { SetupService } from "./setup.service";

describe("SetupController", () => {
  const user = { organizationId: "organization-1" } as AuthenticatedUser;

  function createController() {
    const setupService = {
      completeInitialSite: jest.fn().mockRejectedValue(new BadRequestException("siteId is required")),
      addFloors: jest.fn().mockRejectedValue(new BadRequestException("siteId is required"))
    };

    return {
      controller: new SetupController(setupService as unknown as SetupService),
      setupService
    };
  }

  it("requires the assigned admin role for every setup route", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, SetupController)).toEqual(
      expect.arrayContaining([SessionAuthGuard, RolesGuard])
    );
    expect(Reflect.getMetadata(rolesMetadataKey, SetupController)).toEqual(["admin"]);
  });

  it("passes a null initial site body to service validation without a raw TypeError", async () => {
    const { controller, setupService } = createController();

    await expect(controller.createInitialSite(user, null as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(setupService.completeInitialSite).toHaveBeenCalledWith(user, null);
  });

  it("passes a null add floors body to service validation without a raw TypeError", async () => {
    const { controller, setupService } = createController();

    await expect(controller.addFloors(user, null as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(setupService.addFloors).toHaveBeenCalledWith(user, null);
  });

  it("returns the caller-scoped dashboard response from both setup routes", async () => {
    const { controller, setupService } = createController();
    const dashboard = {
      site: { id: "site-1" },
      capabilities: { read: true, control: true, manage: true, commission: true }
    };
    setupService.completeInitialSite.mockResolvedValueOnce(dashboard);
    setupService.addFloors.mockResolvedValueOnce(dashboard);

    await expect(controller.createInitialSite(user, { siteId: "site-1" } as any)).resolves.toEqual(dashboard);
    await expect(controller.addFloors(user, { siteId: "site-1" } as any)).resolves.toEqual(dashboard);
  });
});
