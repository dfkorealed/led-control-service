import { CommandTimeoutService } from "./command-timeout.service";
import { OutboxPublisherService } from "../mqtt/outbox-publisher.service";
import { Logger } from "@nestjs/common";
import { AutomationSnapshotService } from "../automation/automation-snapshot.service";
import { AutomationClock } from "../automation/automation-clock";

describe("CommandTimeoutService", () => {
  const now = new Date("2026-07-11T00:16:00.000Z");
  const pendingDispatch = { id: "pending-1", commandId: "command-1", status: "pending" };
  const availableOutboxWhere = {
    dispatchId: pendingDispatch.id,
    publishedAt: null,
    deadLetteredAt: null,
    OR: [{ lockedBy: null }, { leaseExpiresAt: { lte: now } }]
  };

  it("takes the shared mutation lock before claiming outbox and dispatch rows", async () => {
    const prisma = createPrisma({ dispatches: [pendingDispatch], outboxClaimCount: 1, dispatchUpdateCount: 1 });
    await expect(createTimeoutService(prisma).closeExpired(now)).resolves.toEqual({ timedOut: 1 });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(prisma.mqttOutbox.updateMany.mock.invocationCallOrder[0]);
    expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(prisma.commandDispatch.updateMany.mock.invocationCallOrder[0]);
  });

  it.each([
    ["pending", "not_applied", "DELIVERY_TIMEOUT"],
    ["published", "unknown", "ACCEPTANCE_TIMEOUT"],
    ["accepted", "unknown", "STATUS_TIMEOUT"]
  ])("classifies %s dimming timeout as %s", async (status, outcome, errorCode) => {
    const prisma = createPrisma({
      dispatches: [{ id: "dispatch", commandId: "command", status, kind: "dimming", command: { outcome: "pending" } }],
      outboxClaimCount: 1, dispatchUpdateCount: 1
    });
    await expect(createTimeoutService(prisma).closeExpired(now)).resolves.toEqual({ timedOut: 1 });
    expect(prisma.commandDispatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ errorCode }) }));
    expect(prisma.command.updateMany).toHaveBeenCalledWith({
      where: { id: "command", status: "pending", outcome: "pending" },
      data: { status: "failed", outcome, errorMessage: "one or more gateway dispatches timed out" }
    });
  });

  it.each(["pending", "published", "accepted"])("closes %s status checks without altering the original unknown outcome", async (status) => {
    const prisma = createPrisma({
      dispatches: [{ id: "check", commandId: "command", status, kind: "status_check", command: { outcome: "unknown" } }],
      outboxClaimCount: 1, dispatchUpdateCount: 1
    });
    await expect(createTimeoutService(prisma).closeExpired(now)).resolves.toEqual({ timedOut: 1 });
    expect(prisma.commandFixtureResult.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { dispatchId: "check", status: "pending" } }));
    expect(prisma.command.updateMany).not.toHaveBeenCalled();
  });

  it("preserves a legacy null outcome while closing its pending command", async () => {
    const prisma = createPrisma({
      dispatches: [{ ...pendingDispatch, kind: "dimming", command: { outcome: null } }],
      outboxClaimCount: 1, dispatchUpdateCount: 1
    });
    await createTimeoutService(prisma).closeExpired(now);
    expect(prisma.command.updateMany).toHaveBeenCalledWith({
      where: { id: "command-1", status: "pending", outcome: null },
      data: { status: "failed", errorMessage: "one or more gateway dispatches timed out" }
    });
  });

  it("fails closed when a pending dispatch has no available outbox row", async () => {
    const prisma = createPrisma({ dispatches: [pendingDispatch], outboxClaimCount: 0 });
    const service = createTimeoutService(prisma);

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
    const service = createTimeoutService(prisma);

    await expect(service.closeExpired(now)).resolves.toEqual({ timedOut: 0 });

    expect(prisma.mqttOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ OR: [{ lockedBy: null }, { leaseExpiresAt: { lte: now } }] })
    }));
    expect(prisma.commandDispatch.updateMany).not.toHaveBeenCalled();
  });

  it("claims an expired publisher lease before timing out a pending dispatch", async () => {
    const prisma = createPrisma({ dispatches: [pendingDispatch], outboxClaimCount: 1, dispatchUpdateCount: 1 });
    const service = createTimeoutService(prisma);

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
    const service = createTimeoutService(prisma);

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
    const service = createTimeoutService(prisma);

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
    const service = createTimeoutService(prisma);
    const terminalNow = new Date("2026-07-11T00:01:00.000Z");

    await expect(service.closeExpired(terminalNow)).resolves.toEqual({ timedOut: 2 });

    expect(prisma.mqttOutbox.updateMany).not.toHaveBeenCalled();
    expect(prisma.commandFixtureResult.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.command.updateMany).toHaveBeenCalledTimes(2);
  });

  it("does not overlap a slow scheduled timeout batch", async () => {
    jest.useFakeTimers();
    const pendingFind = deferred<Array<typeof pendingDispatch>>();
    const prisma = createPrisma({ dispatches: [] });
    prisma.commandDispatch.findMany
      .mockReturnValueOnce(pendingFind.promise)
      .mockResolvedValue([]);
    const service = createTimeoutService(prisma);

    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(3_000);
      expect(prisma.commandDispatch.findMany).toHaveBeenCalledTimes(1);

      pendingFind.resolve([]);
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(1_000);
      expect(prisma.commandDispatch.findMany).toHaveBeenCalledTimes(2);
    } finally {
      pendingFind.resolve([]);
      await service.stopAndDrain();
      jest.useRealTimers();
    }
  });

  it("contains scheduled Prisma failures and logs only their recognized error kind", async () => {
    jest.useFakeTimers();
    const unhandledRejection = jest.fn();
    const loggerError = jest.spyOn(Logger.prototype, "error").mockImplementation();
    process.on("unhandledRejection", unhandledRejection);
    const prisma = createPrisma({ dispatches: [] });
    prisma.commandDispatch.findMany.mockRejectedValueOnce({ code: "P1001", detail: "database-secret" });
    const service = createTimeoutService(prisma);

    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);

      expect(unhandledRejection).not.toHaveBeenCalled();
      expect(loggerError).toHaveBeenCalledWith("command timeout batch failed (error=P1001)");
      expect(loggerError.mock.calls.flat().join(" ")).not.toContain("database-secret");
    } finally {
      await service.stopAndDrain();
      process.off("unhandledRejection", unhandledRejection);
      loggerError.mockRestore();
      jest.useRealTimers();
    }
  });

  it("drains the active timeout batch before shutdown resolves", async () => {
    jest.useFakeTimers();
    const pendingFind = deferred<Array<typeof pendingDispatch>>();
    const prisma = createPrisma({ dispatches: [] });
    prisma.commandDispatch.findMany.mockReturnValueOnce(pendingFind.promise);
    const service = createTimeoutService(prisma);
    let stopped = false;

    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      const stopping = service.onModuleDestroy().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);

      pendingFind.resolve([]);
      await stopping;
      await jest.advanceTimersByTimeAsync(2_000);
      expect(prisma.commandDispatch.findMany).toHaveBeenCalledTimes(1);
    } finally {
      pendingFind.resolve([]);
      await service.stopAndDrain();
      jest.useRealTimers();
    }
  });
});

function createPrisma(options: {
  dispatches: Array<{ id: string; commandId: string; status: string; kind?: string; command?: { outcome: string | null } }>;
  outboxClaimCount?: number;
  dispatchUpdateCount?: number;
}) {
  const prisma: any = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    commandDispatch: {
      findMany: jest.fn().mockResolvedValue(options.dispatches.map((dispatch) => ({ kind: "dimming", command: { outcome: null }, ...dispatch }))),
      updateMany: jest.fn().mockResolvedValue({ count: options.dispatchUpdateCount ?? 0 })
    },
    commandFixtureResult: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    command: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    mqttOutbox: { updateMany: jest.fn().mockResolvedValue({ count: options.outboxClaimCount ?? 0 }) }
  };
  prisma.$transaction = jest.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma));
  return prisma;
}

function createTimeoutService(prisma: any) {
  return new CommandTimeoutService(prisma, new AutomationSnapshotService(new AutomationClock()));
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
    errorCode: "DELIVERY_TIMEOUT",
    errorMessage: "gateway command deadline exceeded"
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((value) => { resolve = value; });
  return { promise, resolve };
}
