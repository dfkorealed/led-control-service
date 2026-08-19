import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { RolesGuard } from "../access/roles.guard";
import { rolesMetadataKey } from "../access/roles.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import type { AuthenticatedUser } from "../auth/auth.types";
import { RegistrationController } from "./registration.controller";

describe("RegistrationController", () => {
  it("requires the operator role for every registration route", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, RegistrationController)).toEqual(
      expect.arrayContaining([SessionAuthGuard, RolesGuard])
    );
    expect(Reflect.getMetadata(rolesMetadataKey, RegistrationController)).toEqual(["operator"]);
  });

  it("passes a validated batch registration request to the service", async () => {
    const registerBatch = jest.fn().mockResolvedValue({ items: [] });
    const controller = new RegistrationController({ registerBatch } as never);
    const user = { id: "00000000-0000-4000-8000-000000000002", role: "operator" } as AuthenticatedUser;
    const body = {
      mode: "batch",
      defaults: { namePrefix: "B2-L", startNumber: 1, digits: 3, ratedWatt: "40.00", size: 20 },
      nodes: [{
        nodeId: "22222222-2222-4222-8222-222222222222",
        placement: { mode: "auto" }
      }]
    };

    await expect(controller.registerBatch(
      "11111111-1111-4111-8111-111111111111",
      body,
      user
    )).resolves.toEqual({ items: [] });
    expect(registerBatch).toHaveBeenCalledWith(user, "11111111-1111-4111-8111-111111111111", body);
  });
});
