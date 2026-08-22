import { CommandTimeoutService } from "./command-timeout.service";

describe("CommandTimeoutService", () => {
  const now = new Date("2026-07-11T00:16:00.000Z");
  const activeLeaseExclusion = {
    NOT: {
      status: "pending",
      outbox: {
        is: {
          publishedAt: null,
          deadLetteredAt: null,
          lockedBy: { not: null },
          leaseExpiresAt: { gt: now }
        }
      }
    }
  };

  it("excludes an expired pending dispatch while its publisher lease is still valid", async () => {
    const prisma: any = {
      commandDispatch: { findMany: jest.fn().mockResolvedValue([]) }
    };
    const service = new CommandTimeoutService(prisma);

    await expect(service.closeExpired(now)).resolves.toEqual({ timedOut: 0 });

    expect(prisma.commandDispatch.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining(activeLeaseExclusion)
    }));
  });

  it("does not close a dispatch claimed after the initial timeout query", async () => {
    const prisma: any = {
      commandDispatch: {
        findMany: jest.fn().mockResolvedValue([
          { id: "pending-1", commandId: "command-1", status: "pending" }
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 })
      },
      commandFixtureResult: { updateMany: jest.fn() },
      mqttOutbox: { updateMany: jest.fn() },
      command: { updateMany: jest.fn() }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const service = new CommandTimeoutService(prisma);

    await expect(service.closeExpired(now)).resolves.toEqual({ timedOut: 0 });

    expect(prisma.commandDispatch.updateMany).toHaveBeenCalledWith({
      where: { id: "pending-1", status: "pending", ...activeLeaseExclusion },
      data: expect.objectContaining({ status: "timed_out" })
    });
    expect(prisma.commandFixtureResult.updateMany).not.toHaveBeenCalled();
    expect(prisma.mqttOutbox.updateMany).not.toHaveBeenCalled();
    expect(prisma.command.updateMany).not.toHaveBeenCalled();
  });

  it("normally closes an expired pending dispatch whose lease is no longer valid", async () => {
    const prisma: any = {
      commandDispatch: {
        findMany: jest.fn().mockResolvedValue([
          { id: "pending-expired-lease", commandId: "command-1", status: "pending" }
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      commandFixtureResult: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      command: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      mqttOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const service = new CommandTimeoutService(prisma);

    await expect(service.closeExpired(now)).resolves.toEqual({ timedOut: 1 });

    expect(prisma.commandDispatch.updateMany).toHaveBeenCalledWith({
      where: { id: "pending-expired-lease", status: "pending", ...activeLeaseExclusion },
      data: expect.objectContaining({ status: "timed_out" })
    });
    expect(prisma.mqttOutbox.updateMany).toHaveBeenCalledTimes(1);
  });

  it("closes published and accepted dispatches after their production deadlines", async () => {
    const prisma: any = {
      commandDispatch: {
        findMany: jest.fn().mockResolvedValue([
          { id: "published-1", commandId: "command-1", status: "published" },
          { id: "accepted-1", commandId: "command-2", status: "accepted" }
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      commandFixtureResult: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      command: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      mqttOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const service = new CommandTimeoutService(prisma);
    const now = new Date("2026-07-11T00:01:00.000Z");

    await expect(service.closeExpired(now)).resolves.toEqual({ timedOut: 2 });
    expect(prisma.commandFixtureResult.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.command.updateMany).toHaveBeenCalledTimes(2);
  });
});
