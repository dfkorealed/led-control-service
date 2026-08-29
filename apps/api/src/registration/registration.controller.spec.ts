import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { RolesGuard } from "../access/roles.guard";
import { rolesMetadataKey } from "../access/roles.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import type { AuthenticatedUser } from "../auth/auth.types";
import { RegistrationController } from "./registration.controller";

describe("RegistrationController", () => {
  it("requires the assigned admin role for every registration route", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, RegistrationController)).toEqual(
      expect.arrayContaining([SessionAuthGuard, RolesGuard])
    );
    expect(Reflect.getMetadata(rolesMetadataKey, RegistrationController)).toEqual(["admin"]);
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

  it("delegates scan retry to the lifecycle service", async () => {
    const retryScan = jest.fn().mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111" });
    const controller = new RegistrationController({ retryScan } as never);
    const user = { id: "00000000-0000-4000-8000-000000000002", role: "operator" } as AuthenticatedUser;

    await controller.retryScan("11111111-1111-4111-8111-111111111111", user);

    expect(retryScan).toHaveBeenCalledWith(user, "11111111-1111-4111-8111-111111111111");
  });

  it("delegates active session lookup with the requested site", async () => {
    const listActiveSessions = jest.fn().mockResolvedValue([]);
    const controller = new RegistrationController({ listActiveSessions } as never);
    const user = { id: "00000000-0000-4000-8000-000000000002", role: "admin" } as AuthenticatedUser;

    await expect(controller.listActiveSessions("00000000-0000-4000-8000-000000000003", user))
      .resolves.toEqual([]);

    expect(listActiveSessions).toHaveBeenCalledWith(
      user,
      "00000000-0000-4000-8000-000000000003"
    );
  });

  it("delegates reconciliation exclusion and session cancellation", async () => {
    const excludeNode = jest.fn().mockResolvedValue({ id: "node-1", status: "failed" });
    const cancelSession = jest.fn().mockResolvedValue({ id: "session-1", status: "cancelled", discoveredNodes: [] });
    const controller = new RegistrationController({ excludeNode, cancelSession } as never);
    const user = { id: "00000000-0000-4000-8000-000000000002", role: "admin" } as AuthenticatedUser;

    await expect(controller.excludeNode("session-1", "node-1", user))
      .resolves.toEqual({ id: "node-1", status: "failed" });
    await expect(controller.cancelSession("session-1", user))
      .resolves.toEqual({ id: "session-1", status: "cancelled", discoveredNodes: [] });

    expect(excludeNode).toHaveBeenCalledWith(user, "session-1", "node-1");
    expect(cancelSession).toHaveBeenCalledWith(user, "session-1");
  });
});
