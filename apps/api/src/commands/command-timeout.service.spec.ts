import { CommandTimeoutService } from "./command-timeout.service";
import { OutboxPublisherService } from "../mqtt/outbox-publisher.service";

describe("CommandTimeoutService", () => {
  const now = new Date("2026-07-11T00:16:00.000Z");
  const pendingDispatch = { id: "pending-1", commandId: "command-1", status: "pending" };
  const availableOutboxWhere = {
    dispatchId: pendingDispatch.id,
    publishedAt: null,
    deadLetteredAt: null,
    OR: [{ lockedBy: null }, { leaseExpiresAt: { lte: now } }]
  };

  it("fails closed when a pending dispatch has no available outbox row", async () => {
    const prisma = createPrisma({ dispatches: [pendingDispatch], outboxClaimCount: 0 });
    const service = new CommandTimeoutService(prisma as never);

    await expect(service.closeExpired(now)).resolves.toEqual({ timedOut: 0 });

    expect(prisma.mqttOutbox.updateMany).toHaveBeenCalledWith({
      where: availableOutboxWhere,
      data: timeoutOutboxData(now)
    });
    expect(prisma.commandDispatch.updateMany).not.toHaveBeenCalled();
    expect(prisma.commandFixtureResult.updateMany).not.toHaveBeenCalled();
    expect(prisma.command.updateMany).not.toHaveBeenCalled();
  });

  it("does not close a pending dispatch claimed by a publisher after the initial query", async () => {
    const prisma = createPrisma({ dispatches: [pendingDispatch], outboxClaimCount: 0 });
    const service = new CommandTimeoutService(prisma as never);

    await expect(service.closeExpired(now)).resolves.toEqual({ timedOut: 0 });

    expect(prisma.mqttOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ OR: [{ lockedBy: null }, { leaseExpiresAt: { lte: now } }] })
    }));
    expect(prisma.commandDispatch.updateMany).not.toHaveBeenCalled();
  });

  it("claims an expired publisher lease before timing out a pending dispatch", async () => {
    const prisma = createPrisma({ dispatches: [pendingDispatch], outboxClaimCount: 1, dispatchUpdateCount: 1 });
    const service = new CommandTimeoutService(prisma as never);

    await expect(service.closeExpired(now)).resolves.toEqual({ timedOut: 1 });

    expect(prisma.mqttOutbox.updateMany).toHaveBeenCalledWith({
      where: availableOutboxWhere,
      data: timeoutOutboxData(now)
    });
    expect(prisma.mqttOutbox.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.commandDispatch.updateMany.mock.invocationCallOrder[0]
    );
    expect(prisma.commandDispatch.updateMany).toHaveBeenCalledWith({
      where: { id: pendingDispatch.id, status: "pending" },
      data: timeoutDispatchData(now)
    });
    expect(prisma.commandFixtureResult.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.command.updateMany).toHaveBeenCalledTimes(1);
  });

  it("prevents a publisher claim after the pending timeout wins the outbox row", async () => {
    let deadLettered = false;
    const prisma = createPrisma({ dispatches: [pendingDispatch], outboxClaimCount: 1, dispatchUpdateCount: 1 });
    prisma.mqttOutbox.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (where.OR && !deadLettered) {
        deadLettered = Boolean(data.deadLetteredAt);
        return { count: 1 };
      }
      return { count: 0 };
    });
    const service = new CommandTimeoutService(prisma as never);

    await expect(service.closeExpired(now)).resolves.toEqual({ timedOut: 1 });

    const claimTx = {
      $queryRaw: jest.fn().mockImplementation(async () => deadLettered ? [] : [{ id: "outbox-1" }]),
      mqttOutbox: {
        updateMany: jest.fn(),
        findMany: jest.fn()
      }
    };
    const claimPrisma = {
      $transaction: jest.fn(async (callback: (tx: typeof claimTx) => Promise<unknown>) => callback(claimTx))
    };
    const publisher = new OutboxPublisherService(claimPrisma as never, {} as never, { workerId: "worker-1" });

    await expect(publisher.claimBatch(now)).resolves.toEqual([]);
    expect(claimTx.mqttOutbox.updateMany).not.toHaveBeenCalled();
  });

  it("rolls back the outbox dead-letter claim when the pending dispatch update loses its race", async () => {
    const prisma = createPrisma({ dispatches: [pendingDispatch], outboxClaimCount: 1, dispatchUpdateCount: 0 });
    let rolledBack = false;
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => Promise<unknown>) => {
      try {
        return await callback(prisma);
      } catch {
        rolledBack = true;
        return false;
      }
    });
    const service = new CommandTimeoutService(prisma as never);

    await expect(service.closeExpired(now)).resolves.toEqual({ timedOut: 0 });

    expect(rolledBack).toBe(true);
    expect(prisma.commandFixtureResult.updateMany).not.toHaveBeenCalled();
    expect(prisma.command.updateMany).not.toHaveBeenCalled();
  });

  it("closes published and accepted dispatches without claiming their outbox", async () => {
    const dispatches = [
      { id: "published-1", commandId: "command-1", status: "published" },
      { id: "accepted-1", commandId: "command-2", status: "accepted" }
    ];
    const prisma = createPrisma({ dispatches, dispatchUpdateCount: 1 });
    const service = new CommandTimeoutService(prisma as never);
    const terminalNow = new Date("2026-07-11T00:01:00.000Z");

    await expect(service.closeExpired(terminalNow)).resolves.toEqual({ timedOut: 2 });

    expect(prisma.mqttOutbox.updateMany).not.toHaveBeenCalled();
    expect(prisma.commandFixtureResult.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.command.updateMany).toHaveBeenCalledTimes(2);
  });
});

function createPrisma(options: {
  dispatches: Array<{ id: string; commandId: string; status: string }>;
  outboxClaimCount?: number;
  dispatchUpdateCount?: number;
}) {
  const prisma: any = {
    commandDispatch: {
      findMany: jest.fn().mockResolvedValue(options.dispatches),
      updateMany: jest.fn().mockResolvedValue({ count: options.dispatchUpdateCount ?? 0 })
    },
    commandFixtureResult: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    command: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    mqttOutbox: { updateMany: jest.fn().mockResolvedValue({ count: options.outboxClaimCount ?? 0 }) }
  };
  prisma.$transaction = jest.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma));
  return prisma;
}

function timeoutOutboxData(now: Date) {
  return {
    deadLetteredAt: now,
    lastError: "command timed out before delivery",
    lockedBy: null,
    lockedAt: null,
    leaseExpiresAt: null
  };
}

function timeoutDispatchData(now: Date) {
  return {
    status: "timed_out",
    completedAt: now,
    errorCode: "COMMAND_TIMEOUT",
    errorMessage: "gateway command deadline exceeded"
  };
}
