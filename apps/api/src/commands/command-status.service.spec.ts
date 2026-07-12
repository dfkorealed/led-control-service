import { NotFoundException } from "@nestjs/common";
import { CommandStatusService } from "./command-status.service";

describe("CommandStatusService", () => {
  it("returns gateway dispatches and fixture results within the user's organization", async () => {
    const prisma: any = {
      command: {
        findFirst: jest.fn().mockResolvedValue({
          id: "command-1",
          siteId: "site-1",
          targetType: "group",
          targetId: "group-1",
          brightness: 70,
          status: "pending",
          errorMessage: null,
          createdAt: new Date("2026-07-12T00:00:00.000Z"),
          updatedAt: new Date("2026-07-12T00:00:02.000Z"),
          dispatches: [
            {
              id: "dispatch-1",
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
    const service = new CommandStatusService(prisma);

    await expect(service.getCommand("command-1", "org-1")).resolves.toMatchObject({
      id: "command-1",
      stage: "completed",
      dispatchCount: 1,
      completedFixtureCount: 1,
      totalFixtureCount: 1,
      dispatches: [
        {
          gateway: { id: "gateway-1", name: "B2 Gateway" },
          results: [{ fixtureId: "fixture-1", fixtureName: "B2-L01", status: "succeeded" }]
        }
      ]
    });
    expect(prisma.command.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "command-1", site: { organizationId: "org-1" } } })
    );
  });

  it("does not reveal a command outside the user's organization", async () => {
    const prisma: any = { command: { findFirst: jest.fn().mockResolvedValue(null) } };
    const service = new CommandStatusService(prisma);

    await expect(service.getCommand("command-other", "org-1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("reports partial failure when terminal fixture results are mixed", async () => {
    const prisma: any = {
      command: {
        findFirst: jest.fn().mockResolvedValue({
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

    await expect(new CommandStatusService(prisma).getCommand("command-1", "org-1")).resolves.toMatchObject({
      stage: "partial_failed",
      completedFixtureCount: 2,
      totalFixtureCount: 2
    });
  });
});
