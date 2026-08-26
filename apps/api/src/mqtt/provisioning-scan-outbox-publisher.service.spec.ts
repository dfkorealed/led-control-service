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
      `sites/${payload.siteId}/gateways/${payload.gatewayId}/commands/provisioning/scan-start`, payload
    );
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
