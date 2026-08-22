import { NotFoundException } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { CommandStatusService } from "./command-status.service";

describe("CommandStatusService", () => {
  const user: AuthenticatedUser = {
    id: "user-1", organizationId: "org-1", organizationType: "customer", email: "admin@example.com", name: "Admin", role: "admin", status: "active"
  };

  it("returns gateway dispatches and fixture results within the user's organization", async () => {
    const prisma: any = {
      command: {
        findUnique: jest.fn().mockResolvedValue({
          id: "command-1",
          siteId: "site-1",
          targetType: "group",
          targetId: null,
          targetFixtureIds: ["fixture-1"],
          brightness: 70,
          status: "pending",
          errorMessage: null,
          createdAt: new Date("2026-07-12T00:00:00.000Z"),
          updatedAt: new Date("2026-07-12T00:00:02.000Z"),
          dispatches: [
            {
              id: "dispatch-1",
              deliveryMode: "mesh_group",
              destinationAddress: "0xc000",
              status: "completed",
              publishedAt: new Date("2026-07-12T00:00:01.000Z"),
              acceptedAt: new Date("2026-07-12T00:00:01.500Z"),
              completedAt: new Date("2026-07-12T00:00:02.000Z"),
              errorCode: null,
              errorMessage: null,
              gateway: { id: "gateway-1", name: "B2 Gateway" },
              fixtureResults: [
                {
                  fixtureId: "fixture-1",
                  status: "succeeded",
                  brightness: 70,
                  faultCode: null,
                  errorMessage: null,
                  occurredAt: new Date("2026-07-12T00:00:02.000Z"),
                  fixture: { name: "B2-L01" }
                }
              ]
            }
          ]
        })
      }
    };
    const siteAccess = { assert: jest.fn().mockResolvedValue({ id: "site-1" }) };
    const service = new (CommandStatusService as any)(prisma, siteAccess);

    await expect(service.getCommand(user, "command-1")).resolves.toMatchObject({
      id: "command-1",
      stage: "completed",
      dispatchCount: 1,
      completedFixtureCount: 1,
      totalFixtureCount: 1,
      targetId: null,
      targetFixtureIds: ["fixture-1"],
      dispatches: [
        {
          deliveryMode: "mesh_group",
          destinationAddress: "0xc000",
          gateway: { id: "gateway-1", name: "B2 Gateway" },
          results: [{ fixtureId: "fixture-1", fixtureName: "B2-L01", status: "succeeded" }]
        }
      ]
    });
    expect(siteAccess.assert).toHaveBeenCalledWith(user, "site-1", "read");
  });

  it("does not reveal a command outside the user's organization", async () => {
    const prisma: any = { command: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new (CommandStatusService as any)(prisma, { assert: jest.fn() });

    await expect(service.getCommand(user, "command-other")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("reports partial failure when terminal fixture results are mixed", async () => {
    const prisma: any = {
      command: {
        findUnique: jest.fn().mockResolvedValue({
          id: "command-1",
          siteId: "site-1",
          targetType: "group",
          targetId: "group-1",
          brightness: 70,
          status: "failed",
          errorMessage: "one or more gateway dispatches failed",
          createdAt: new Date(),
          updatedAt: new Date(),
          dispatches: [
            {
              id: "dispatch-1",
              status: "failed",
              publishedAt: new Date(),
              acceptedAt: new Date(),
              completedAt: new Date(),
              errorCode: null,
              errorMessage: null,
              gateway: { id: "gateway-1", name: "Gateway" },
              fixtureResults: [
                { fixtureId: "f1", status: "succeeded", fixture: { name: "L1" } },
                { fixtureId: "f2", status: "failed", fixture: { name: "L2" } }
              ]
            }
          ]
        })
      }
    };

    const siteAccess = { assert: jest.fn().mockResolvedValue({ id: "site-1" }) };
    await expect(new (CommandStatusService as any)(prisma, siteAccess).getCommand(user, "command-1")).resolves.toMatchObject({
      stage: "partial_failed",
      completedFixtureCount: 2,
      totalFixtureCount: 2
    });
  });

  it("does not reveal a command at an inaccessible site", async () => {
    const prisma: any = {
      command: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue({ siteId: "other-site" })
      }
    };
    const service = new (CommandStatusService as any)(prisma, {
      assert: jest.fn().mockRejectedValue(new NotFoundException("site not found"))
    });

    await expect(service.getCommand(user, "command-other")).rejects.toThrow("command not found");
  });

  it("returns the same public 404 response for absent and inaccessible commands", async () => {
    const absentService = new (CommandStatusService as any)(
      { command: { findUnique: jest.fn().mockResolvedValue(null) } },
      { assert: jest.fn() }
    );
    const inaccessibleService = new (CommandStatusService as any)(
      { command: { findUnique: jest.fn().mockResolvedValue({ siteId: "other-site" }) } },
      { assert: jest.fn().mockRejectedValue(new NotFoundException("site not found")) }
    );

    const absent = await absentService.getCommand(user, "missing-command").catch((error: unknown) => error);
    const inaccessible = await inaccessibleService.getCommand(user, "other-command").catch((error: unknown) => error);

    expect(absent).toBeInstanceOf(NotFoundException);
    expect(inaccessible).toBeInstanceOf(NotFoundException);
    expect(inaccessible.getResponse()).toEqual(absent.getResponse());
  });
});
