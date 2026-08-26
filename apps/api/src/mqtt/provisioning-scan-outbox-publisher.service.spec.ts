import { Logger } from "@nestjs/common";
import { ProvisioningScanOutboxPublisherService } from "./provisioning-scan-outbox-publisher.service";

const payload = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  scanCorrelationId: "22222222-2222-4222-8222-222222222222",
  scanAttempt: 1,
  siteId: "33333333-3333-4333-8333-333333333333",
  gatewayId: "44444444-4444-4444-8444-444444444444",
  floorId: "55555555-5555-4555-8555-555555555555",
  requestedAt: "2026-08-26T00:00:00.000Z"
};

describe("ProvisioningScanOutboxPublisherService", () => {
  it("contains an initial claim failure, recovers on the next tick, and stops after destroy", async () => {
    jest.useFakeTimers();
    const unhandledRejection = jest.fn();
    const loggerError = jest.spyOn(Logger.prototype, "error").mockImplementation();
    process.on("unhandledRejection", unhandledRejection);
    const service = new ProvisioningScanOutboxPublisherService({} as never, {} as never, {
      workerId: "scan-outbox-worker", pollMs: 1_000
    });
    const claimBatch = jest.spyOn(service, "claimBatch")
      .mockRejectedValueOnce(Object.assign(new Error("payload-secret"), { code: "P2028" }))
      .mockResolvedValue([]);

    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);

      expect(unhandledRejection).not.toHaveBeenCalled();
      expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("worker=scan-outbox-worker, error=P2028"));
      expect(loggerError.mock.calls.flat().join(" ")).not.toContain("payload-secret");

      await jest.advanceTimersByTimeAsync(1_000);
      expect(claimBatch).toHaveBeenCalledTimes(2);

      const stopping = service.stopAndDrain();
      expect(service.stopAndDrain()).toBe(stopping);
      await stopping;
      await jest.advanceTimersByTimeAsync(2_000);
      expect(claimBatch).toHaveBeenCalledTimes(2);
    } finally {
      await service.stopAndDrain();
      process.off("unhandledRejection", unhandledRejection);
      loggerError.mockRestore();
      jest.useRealTimers();
    }
  });

  it("redacts untrusted error codes, names, and messages from scheduler logs", async () => {
    jest.useFakeTimers();
    const loggerError = jest.spyOn(Logger.prototype, "error").mockImplementation();
    const service = new ProvisioningScanOutboxPublisherService({} as never, {} as never, {
      workerId: "scan-outbox-worker", pollMs: 1_000
    });
    jest.spyOn(service, "claimBatch")
      .mockRejectedValueOnce(Object.assign(new Error("message-secret"), {
        code: "P2028-code-secret",
        name: "name-secret-with-code"
      }))
      .mockRejectedValueOnce(Object.assign(new Error("other-message-secret"), { name: "name-secret-without-code" }));

    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(1_000);

      expect(loggerError).toHaveBeenNthCalledWith(1, expect.stringContaining("error=UNEXPECTED_ERROR"));
      expect(loggerError).toHaveBeenNthCalledWith(2, expect.stringContaining("error=UNEXPECTED_ERROR"));
      const logs = loggerError.mock.calls.flat().join(" ");
      expect(logs).not.toContain("P2028-code-secret");
      expect(logs).not.toContain("name-secret");
      expect(logs).not.toContain("message-secret");
    } finally {
      await service.stopAndDrain();
      loggerError.mockRestore();
      jest.useRealTimers();
    }
  });

  it("does not overlap a slow scheduled claim", async () => {
    jest.useFakeTimers();
    const pendingClaim = deferred<[]>();
    const service = new ProvisioningScanOutboxPublisherService({} as never, {} as never, {
      workerId: "scan-outbox-worker", pollMs: 1_000
    });
    const claimBatch = jest.spyOn(service, "claimBatch")
      .mockReturnValueOnce(pendingClaim.promise)
      .mockResolvedValue([]);

    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(3_000);
      expect(claimBatch).toHaveBeenCalledTimes(1);

      pendingClaim.resolve([]);
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(1_000);
      expect(claimBatch).toHaveBeenCalledTimes(2);
    } finally {
      pendingClaim.resolve([]);
      await service.stopAndDrain();
      jest.useRealTimers();
    }
  });

  it("waits for an in-flight publish on destroy without starting another publish", async () => {
    jest.useFakeTimers();
    const activePublish = deferred<void>();
    const service = new ProvisioningScanOutboxPublisherService({} as never, {} as never, {
      workerId: "scan-outbox-worker", pollMs: 1_000
    });
    const records = ["outbox-1", "outbox-2"].map((id) => ({
      id,
      sessionId: payload.sessionId,
      scanAttempt: payload.scanAttempt,
      topic: `sites/${payload.siteId}/gateways/${payload.gatewayId}/commands/provisioning/scan-start`,
      payload,
      attempts: 0,
      createdAt: new Date("2026-08-26T00:00:00.000Z")
    }));
    const claimBatch = jest.spyOn(service, "claimBatch").mockResolvedValue(records as never);
    const publishClaimed = jest.spyOn(service, "publishClaimed")
      .mockReturnValueOnce(activePublish.promise)
      .mockResolvedValue(undefined);
    let destroyCompleted = false;

    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      expect(publishClaimed).toHaveBeenCalledTimes(1);

      const destroying = service.stopAndDrain().then(() => { destroyCompleted = true; });
      await Promise.resolve();
      const completedBeforeRelease = destroyCompleted;
      await jest.advanceTimersByTimeAsync(3_000);

      activePublish.resolve();
      await destroying;
      await jest.advanceTimersByTimeAsync(0);

      expect({
        completedBeforeRelease,
        claimCalls: claimBatch.mock.calls.length,
        publishCalls: publishClaimed.mock.calls.length
      }).toEqual({ completedBeforeRelease: false, claimCalls: 1, publishCalls: 1 });
    } finally {
      activePublish.resolve();
      await service.stopAndDrain();
      jest.useRealTimers();
    }
  });

  it("transitions a leased pending scan to scanning before publishing its strict scan-start payload", async () => {
    const now = new Date("2026-08-26T00:00:00.000Z");
    const prisma: any = {
      provisioningSession: {
        findUnique: jest.fn().mockResolvedValue({
          id: payload.sessionId, status: "active", scanStatus: "pending",
          scanCorrelationId: payload.scanCorrelationId, scanAttempt: payload.scanAttempt
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      provisioningScanOutbox: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(1)
      }
    };
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn().mockResolvedValue(undefined) };
    const service = new ProvisioningScanOutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1", clock: () => now, random: () => 0
    });

    await service.publishClaimed({
      id: "outbox-1", sessionId: payload.sessionId, scanAttempt: 1,
      topic: `sites/${payload.siteId}/gateways/${payload.gatewayId}/commands/provisioning/scan-start`,
      payload, attempts: 0, createdAt: now
    });

    expect(prisma.provisioningSession.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: payload.sessionId, scanStatus: "pending", scanCorrelationId: payload.scanCorrelationId, scanAttempt: 1 }),
      data: { scanStatus: "scanning", scanStartedAt: now }
    });
    expect(mqtt.publishTopic).toHaveBeenCalledWith(
      `sites/${payload.siteId}/gateways/${payload.gatewayId}/commands/provisioning/scan-start`, payload,
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    );
  });

  it("times out a stalled MQTT callback before its lease expires and releases the record for backoff", async () => {
    jest.useFakeTimers();
    try {
      const now = new Date("2026-08-26T00:00:00.000Z");
      const prisma: any = {
        provisioningSession: {
          findUnique: jest.fn().mockResolvedValue({
            id: payload.sessionId, status: "active", scanStatus: "scanning",
            scanCorrelationId: payload.scanCorrelationId, scanAttempt: payload.scanAttempt
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 })
        },
        provisioningScanOutbox: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          count: jest.fn().mockResolvedValue(1)
        }
      };
      prisma.$queryRaw = jest.fn().mockResolvedValue([]);
      prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
      const mqtt = { publishTopic: jest.fn(() => new Promise<void>(() => undefined)) };
      const service = new ProvisioningScanOutboxPublisherService(prisma, mqtt as never, {
        workerId: "worker-1", clock: () => now, random: () => 0, publishTimeoutMs: 100
      });

      const publishing = service.publishClaimed({
        id: "outbox-1", sessionId: payload.sessionId, scanAttempt: 1,
        topic: `sites/${payload.siteId}/gateways/${payload.gatewayId}/commands/provisioning/scan-start`,
        payload, attempts: 0, createdAt: now
      });
      await jest.advanceTimersByTimeAsync(100);
      await publishing;

      expect(mqtt.publishTopic).toHaveBeenCalledWith(expect.any(String), payload, { timeoutMs: 100 });
      expect(prisma.provisioningScanOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ attempts: 1, nextAttemptAt: new Date(now.getTime() + 1_000), lockedBy: null })
      }));
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not reclaim a leased scan while its bounded publish is still pending", async () => {
    const now = new Date("2026-08-26T00:00:00.000Z");
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      provisioningScanOutbox: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn()
      }
    };
    const prisma: any = { $transaction: jest.fn(async (callback: (value: any) => Promise<unknown>) => callback(tx)) };
    const service = new ProvisioningScanOutboxPublisherService(prisma, {} as never, {
      workerId: "worker-2", clock: () => now, publishTimeoutMs: 10_000
    });

    await expect(service.claimBatch(new Date(now.getTime() + 9_999))).resolves.toEqual([]);

    expect(tx.$queryRaw.mock.calls[0][0].strings.join("")).toContain('"leaseExpiresAt" <=');
    expect(tx.provisioningScanOutbox.updateMany).not.toHaveBeenCalled();
  });

  it("reclaims an expired lease after a crash and retries the same correlation and attempt", async () => {
    const now = new Date("2026-08-26T00:00:31.000Z");
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "outbox-1" }]),
      provisioningScanOutbox: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([{ id: "outbox-1", lockedBy: "worker-2", sessionId: payload.sessionId, scanAttempt: 1, payload }])
      }
    };
    const prisma: any = { $transaction: jest.fn(async (callback: (value: any) => Promise<unknown>) => callback(tx)) };
    const service = new ProvisioningScanOutboxPublisherService(prisma, {} as never, { workerId: "worker-2", clock: () => now });

    await expect(service.claimBatch(now)).resolves.toEqual([expect.objectContaining({ id: "outbox-1", lockedBy: "worker-2" })]);

    expect(tx.$queryRaw.mock.calls[0][0].strings.join("")).toContain("FOR UPDATE SKIP LOCKED");
    expect(tx.provisioningScanOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ["outbox-1"] }, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
      data: expect.objectContaining({ lockedBy: "worker-2" })
    }));
  });

  it("dead-letters exhausted scan-start publishing and transitions the same scan to failed", async () => {
    const now = new Date("2026-08-26T00:01:00.000Z");
    const prisma: any = {
      provisioningSession: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      provisioningScanOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), count: jest.fn().mockResolvedValue(1) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn().mockRejectedValue(new Error("broker unavailable")) };
    const service = new ProvisioningScanOutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1", clock: () => now, random: () => 0
    });

    await service.publishClaimed({
      id: "outbox-1", sessionId: payload.sessionId, scanAttempt: 1,
      topic: `sites/${payload.siteId}/gateways/${payload.gatewayId}/commands/provisioning/scan-start`,
      payload, attempts: 2, createdAt: new Date("2026-08-26T00:00:00.000Z")
    });

    expect(prisma.provisioningScanOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ attempts: 3, deadLetteredAt: now, lockedBy: null })
    }));
    expect(prisma.provisioningSession.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: payload.sessionId, scanStatus: { in: ["pending", "scanning"] }, scanAttempt: 1 }),
      data: {
        scanStatus: "failed", scanCompletedAt: now,
        scanFailureCode: "scan_start_publish_failed",
        scanFailureMessage: "조명 검색 명령을 전송하지 못했습니다. 다시 시도해 주세요."
      }
    });
  });

  it("does not publish an outbox record after its scan has already reached a terminal state", async () => {
    const now = new Date("2026-08-26T00:01:00.000Z");
    const prisma: any = {
      provisioningSession: { findUnique: jest.fn().mockResolvedValue({
        id: payload.sessionId, status: "active", scanStatus: "completed",
        scanCorrelationId: payload.scanCorrelationId, scanAttempt: payload.scanAttempt
      }) },
      provisioningScanOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), count: jest.fn() }
    };
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn() };
    const service = new ProvisioningScanOutboxPublisherService(prisma, mqtt as never, { workerId: "worker-1", clock: () => now });

    await service.publishClaimed({
      id: "outbox-1", sessionId: payload.sessionId, scanAttempt: 1,
      topic: `sites/${payload.siteId}/gateways/${payload.gatewayId}/commands/provisioning/scan-start`,
      payload, attempts: 0, createdAt: now
    });

    expect(mqtt.publishTopic).not.toHaveBeenCalled();
    expect(prisma.provisioningScanOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deadLetteredAt: now, lastError: "scan is no longer active" })
    }));
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((value) => { resolve = value; });
  return { promise, resolve };
}
