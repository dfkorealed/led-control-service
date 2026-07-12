import { CommandDispatchService } from "./command-dispatch.service";
import { CommandsService } from "./commands.service";

const ids = {
  command: "11111111-1111-4111-8111-111111111111",
  site: "22222222-2222-4222-8222-222222222222",
  target: "33333333-3333-4333-8333-333333333333",
  user: "44444444-4444-4444-8444-444444444444",
  gateway: "55555555-5555-4555-8555-555555555555",
  dispatch: "66666666-6666-4666-8666-666666666666"
};

describe("CommandsService", () => {
  it("stores command, gateway dispatch, fixture result and outbox in one transaction", async () => {
    const command = {
      id: ids.command,
      siteId: ids.site,
      targetType: "fixture",
      targetId: ids.target,
      brightness: 75,
      requestedBy: ids.user,
      createdAt: new Date("2026-07-01T00:00:00.000Z")
    };
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: ids.user, organizationId: "org-1", role: "operator" }) },
      fixture: {
        findFirst: jest.fn().mockResolvedValue({
          id: ids.target,
          status: "online",
          meshNode: { gatewayId: ids.gateway, gateway: { lastHeartbeatAt: new Date() } }
        })
      },
      command: { create: jest.fn().mockResolvedValue(command) },
      gateway: {
        update: jest.fn().mockResolvedValue({ id: ids.gateway, siteId: ids.site, nextCommandSequence: 1n })
      },
      commandDispatch: { create: jest.fn().mockResolvedValue({ id: ids.dispatch }) },
      commandFixtureResult: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
      mqttOutbox: { create: jest.fn().mockResolvedValue({ id: "outbox-1" }) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const service = new CommandsService(prisma, new CommandDispatchService());

    await expect(
      service.createDimmingCommand({
        siteId: ids.site,
        targetType: "fixture",
        targetId: ids.target,
        brightness: 75,
        requestedBy: ids.user
      })
    ).resolves.toEqual({ ...command, dispatchCount: 1 });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.gateway.update).toHaveBeenCalledWith({
      where: { id: ids.gateway },
      data: { nextCommandSequence: { increment: 1 } },
      select: { id: true, siteId: true, nextCommandSequence: true }
    });
    expect(prisma.commandFixtureResult.createMany).toHaveBeenCalledWith({
      data: [{ dispatchId: ids.dispatch, fixtureId: ids.target }]
    });
    expect(prisma.mqttOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        dispatchId: ids.dispatch,
        topic: `sites/${ids.site}/gateways/${ids.gateway}/commands/dimming`,
        payload: expect.objectContaining({ commandId: ids.command, gatewayId: ids.gateway, targetFixtureIds: [ids.target] })
      })
    });
  });

  it("rejects viewer users before resolving targets", async () => {
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: ids.user, organizationId: "org-1", role: "viewer" }) },
      fixture: { findFirst: jest.fn() },
      $transaction: jest.fn()
    };
    const service = new CommandsService(prisma, new CommandDispatchService());

    await expect(
      service.createDimmingCommand({
        siteId: ids.site,
        targetType: "fixture",
        targetId: ids.target,
        brightness: 75,
        requestedBy: ids.user
      })
    ).rejects.toThrow("viewer users cannot control lights");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["unmapped", { id: ids.target, status: "online", meshNode: null }, "fixture is not mapped to a gateway"],
    [
      "gateway offline",
      { id: ids.target, status: "online", meshNode: { gatewayId: ids.gateway, gateway: { lastHeartbeatAt: null } } },
      "gateway is offline"
    ],
    [
      "fixture fault",
      { id: ids.target, status: "fault", meshNode: { gatewayId: ids.gateway, gateway: { lastHeartbeatAt: new Date() } } },
      "fixture is in fault state"
    ]
  ])("rejects an %s fixture before creating a command", async (_case, fixture, message) => {
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: ids.user, organizationId: "org-1", role: "operator" }) },
      fixture: { findFirst: jest.fn().mockResolvedValue(fixture) },
      $transaction: jest.fn()
    };
    const service = new CommandsService(prisma, new CommandDispatchService());

    await expect(
      service.createDimmingCommand({
        siteId: ids.site,
        targetType: "fixture",
        targetId: ids.target,
        brightness: 75,
        requestedBy: ids.user
      })
    ).rejects.toThrow(message);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a group when any fixture cannot be controlled", async () => {
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: ids.user, organizationId: "org-1", role: "operator" }) },
      fixtureGroup: {
        findFirst: jest.fn().mockResolvedValue({
          groupFixtures: [
            {
              fixtureId: "fixture-online",
              fixture: {
                name: "L1",
                status: "online",
                meshNode: { gatewayId: ids.gateway, gateway: { lastHeartbeatAt: new Date() } }
              }
            },
            { fixtureId: "fixture-unmapped", fixture: { name: "L2", status: "online", meshNode: null } }
          ]
        })
      },
      $transaction: jest.fn()
    };
    const service = new CommandsService(prisma, new CommandDispatchService());

    await expect(
      service.createDimmingCommand({
        siteId: ids.site,
        targetType: "group",
        targetId: ids.target,
        brightness: 75,
        requestedBy: ids.user
      })
    ).rejects.toThrow("group contains uncontrollable fixture: L2");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
