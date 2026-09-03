import { Logger } from "@nestjs/common";
import { ProvisioningDeviceOutboxPublisherService } from "./provisioning-device-outbox-publisher.service";

const now = new Date("2026-09-03T00:00:00.000Z");
const payload = {
  commandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sessionId: "11111111-1111-4111-8111-111111111111",
  siteId: "22222222-2222-4222-8222-222222222222",
  gatewayId: "33333333-3333-4333-8333-333333333333",
  nodeId: "44444444-4444-4444-8444-444444444444",
  deviceUuid: "esp32h2-demo-001",
  meshAddress: "0x0100",
  requestedAt: now.toISOString()
};
const record = {
  id: payload.commandId,
  sessionId: payload.sessionId,
  nodeId: payload.nodeId,
  topic: `sites/${payload.siteId}/gateways/${payload.gatewayId}/commands/provisioning/provision-device`,
  payload,
  attempts: 0,
  createdAt: now
};

describe("ProvisioningDeviceOutboxPublisherService", () => {
  it("claims only available rows with a lease and SKIP LOCKED", async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: record.id }]),
      provisioningDeviceOutbox: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([{ ...record, lockedBy: "worker-1" }])
      }
    };
    const prisma: any = { $transaction: jest.fn(async (callback: (value: any) => Promise<unknown>) => callback(tx)) };
    const service = new ProvisioningDeviceOutboxPublisherService(prisma, {} as never, {
      workerId: "worker-1",
      clock: () => now
    });

    await expect(service.claimBatch(now)).resolves.toEqual([expect.objectContaining({ id: record.id })]);

    expect(tx.$queryRaw.mock.calls[0][0].strings.join("")).toContain("FOR UPDATE SKIP LOCKED");
    expect(tx.provisioningDeviceOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [record.id] }, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
      data: { lockedBy: "worker-1", lockedAt: now, leaseExpiresAt: new Date(now.getTime() + 30_000) }
    });
  });

  it("allows only one worker to claim the same available row", async () => {
    let lease: { lockedBy: string; expiresAt: Date } | null = null;
    const createPrisma = (workerId: string) => {
      const tx = {
        $queryRaw: jest.fn().mockImplementation(() => (
          lease && lease.expiresAt > now ? [] : [{ id: record.id }]
        )),
        provisioningDeviceOutbox: {
          updateMany: jest.fn().mockImplementation(() => {
            if (lease && lease.expiresAt > now) return { count: 0 };
            lease = { lockedBy: workerId, expiresAt: new Date(now.getTime() + 30_000) };
            return { count: 1 };
          }),
          findMany: jest.fn().mockImplementation(() => (
            lease?.lockedBy === workerId ? [{ ...record, lockedBy: workerId }] : []
          ))
        }
      };
      return {
        prisma: { $transaction: jest.fn(async (callback: (value: any) => Promise<unknown>) => callback(tx)) } as any,
        tx
      };
    };
    const first = createPrisma("worker-1");
    const second = createPrisma("worker-2");
    const firstWorker = new ProvisioningDeviceOutboxPublisherService(first.prisma, {} as never, {
      workerId: "worker-1",
      clock: () => now
    });
    const secondWorker = new ProvisioningDeviceOutboxPublisherService(second.prisma, {} as never, {
      workerId: "worker-2",
      clock: () => now
    });

    await expect(firstWorker.claimBatch(now)).resolves.toHaveLength(1);
    await expect(secondWorker.claimBatch(now)).resolves.toEqual([]);

    expect(first.tx.provisioningDeviceOutbox.updateMany).toHaveBeenCalledTimes(1);
    expect(second.tx.provisioningDeviceOutbox.updateMany).not.toHaveBeenCalled();
  });

  it("publishes a current provisioning node and records broker PUBACK", async () => {
    const prisma: any = {
      discoveredMeshNode: {
        findUnique: jest.fn().mockResolvedValue({
          id: payload.nodeId,
          sessionId: payload.sessionId,
          deviceUuid: payload.deviceUuid,
          meshAddress: payload.meshAddress,
          status: "provisioning",
          session: { siteId: payload.siteId, gatewayId: payload.gatewayId, status: "active" }
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      provisioningDeviceOutbox: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(1)
      }
    };
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn().mockResolvedValue(undefined) };
    const service = new ProvisioningDeviceOutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1",
      clock: () => now,
      random: () => 0
    });

    await service.publishClaimed(record as never);

    expect(mqtt.publishTopic).toHaveBeenCalledWith(record.topic, payload, { timeoutMs: 10_000 });
    expect(prisma.provisioningDeviceOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: record.id,
        lockedBy: "worker-1",
        publishedAt: null,
        deadLetteredAt: null,
        leaseExpiresAt: { gt: now }
      },
      data: { publishedAt: now, lastError: null, lockedBy: null, lockedAt: null, leaseExpiresAt: null }
    }));
  });

  it.each([
    ["command id", { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }],
    ["topic scope", { topic: `sites/${payload.siteId}/gateways/55555555-5555-4555-8555-555555555555/commands/provisioning/provision-device` }]
  ])("rejects an outbox row with conflicting %s identity before publish", async (_case, override) => {
    const prisma: any = {
      discoveredMeshNode: {
        findUnique: jest.fn().mockResolvedValue({
          id: payload.nodeId,
          sessionId: payload.sessionId,
          deviceUuid: payload.deviceUuid,
          meshAddress: payload.meshAddress,
          status: "provisioning",
          session: { siteId: payload.siteId, gatewayId: payload.gatewayId, status: "active" }
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      provisioningDeviceOutbox: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(1)
      }
    };
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn() };
    const service = new ProvisioningDeviceOutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1",
      clock: () => now
    });

    await service.publishClaimed({ ...record, ...override } as never);

    expect(mqtt.publishTopic).not.toHaveBeenCalled();
    expect(prisma.provisioningDeviceOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deadLetteredAt: now, lastError: "provisioning command identity conflict" })
    }));
    expect(prisma.discoveredMeshNode.updateMany).toHaveBeenCalledWith({
      where: {
        id: payload.nodeId,
        sessionId: payload.sessionId,
        status: "provisioning",
        session: { status: "active" }
      },
      data: {
        status: "reconcile_required",
        errorMessage: "조명 등록 명령을 전송하지 못했습니다. 장비 상태를 확인해 주세요."
      }
    });
  });

  it("dead-letters a command at the 15 minute age limit before MQTT publish", async () => {
    const prisma: any = {
      discoveredMeshNode: {
        findUnique: jest.fn().mockResolvedValue({
          id: payload.nodeId,
          sessionId: payload.sessionId,
          deviceUuid: payload.deviceUuid,
          meshAddress: payload.meshAddress,
          status: "provisioning",
          session: { siteId: payload.siteId, gatewayId: payload.gatewayId, status: "active" }
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      provisioningDeviceOutbox: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(1)
      }
    };
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn().mockResolvedValue(undefined) };
    const service = new ProvisioningDeviceOutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1",
      clock: () => now
    });

    await service.publishClaimed({
      ...record,
      createdAt: new Date(now.getTime() - 15 * 60_000)
    } as never);

    expect(mqtt.publishTopic).not.toHaveBeenCalled();
    expect(prisma.provisioningDeviceOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        deadLetteredAt: now,
        lastError: "provisioning command expired before publish"
      })
    }));
    expect(prisma.discoveredMeshNode.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "reconcile_required" })
    }));
  });

  it.each([
    ["node identity changed", {
      status: "provisioning",
      deviceUuid: "esp32h2-replaced",
      sessionStatus: "active",
      shouldReconcile: true
    }],
    ["node is already terminal", {
      status: "provisioned",
      deviceUuid: payload.deviceUuid,
      sessionStatus: "active",
      shouldReconcile: false
    }],
    ["session is already terminal", {
      status: "provisioning",
      deviceUuid: payload.deviceUuid,
      sessionStatus: "completed",
      shouldReconcile: false
    }]
  ])("dead-letters a stale row when %s and preserves terminal state", async (_case, state) => {
    const prisma: any = {
      discoveredMeshNode: {
        findUnique: jest.fn().mockResolvedValue({
          id: payload.nodeId,
          sessionId: payload.sessionId,
          deviceUuid: state.deviceUuid,
          meshAddress: payload.meshAddress,
          status: state.status,
          session: { siteId: payload.siteId, gatewayId: payload.gatewayId, status: state.sessionStatus }
        }),
        updateMany: jest.fn().mockResolvedValue({ count: state.shouldReconcile ? 1 : 0 })
      },
      provisioningDeviceOutbox: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn()
      }
    };
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn() };
    const service = new ProvisioningDeviceOutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1",
      clock: () => now
    });

    await service.publishClaimed(record as never);

    expect(mqtt.publishTopic).not.toHaveBeenCalled();
    expect(prisma.provisioningDeviceOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        deadLetteredAt: now,
        lastError: "node is no longer awaiting provisioning"
      })
    }));
    expect(prisma.discoveredMeshNode.updateMany).toHaveBeenCalledWith({
      where: {
        id: payload.nodeId,
        sessionId: payload.sessionId,
        status: "provisioning",
        session: { status: "active" }
      },
      data: {
        status: "reconcile_required",
        errorMessage: "조명 등록 명령을 전송하지 못했습니다. 장비 상태를 확인해 주세요."
      }
    });
  });

  it("does not publish when the claimed lease expired before renewal", async () => {
    const expiredAt = new Date(now.getTime() - 1);
    const prisma: any = {
      discoveredMeshNode: {
        findUnique: jest.fn().mockResolvedValue({
          id: payload.nodeId,
          sessionId: payload.sessionId,
          deviceUuid: payload.deviceUuid,
          meshAddress: payload.meshAddress,
          status: "provisioning",
          session: { siteId: payload.siteId, gatewayId: payload.gatewayId, status: "active" }
        })
      },
      provisioningDeviceOutbox: {
        updateMany: jest.fn().mockImplementation(({ where }: any) => ({
          count: where.leaseExpiresAt?.gt && expiredAt > where.leaseExpiresAt.gt ? 1 : 0
        })),
        count: jest.fn().mockResolvedValue(1)
      }
    };
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn().mockResolvedValue(undefined) };
    const service = new ProvisioningDeviceOutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1",
      clock: () => now
    });

    await service.publishClaimed(record as never);

    expect(mqtt.publishTopic).not.toHaveBeenCalled();
    expect(prisma.provisioningDeviceOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ leaseExpiresAt: { gt: now } })
    }));
  });

  it("does not publish after another worker reclaims the row before renewal", async () => {
    const prisma: any = {
      discoveredMeshNode: {
        findUnique: jest.fn().mockResolvedValue({
          id: payload.nodeId,
          sessionId: payload.sessionId,
          deviceUuid: payload.deviceUuid,
          meshAddress: payload.meshAddress,
          status: "provisioning",
          session: { siteId: payload.siteId, gatewayId: payload.gatewayId, status: "active" }
        })
      },
      provisioningDeviceOutbox: {
        updateMany: jest.fn().mockImplementation(({ where }: any) => ({
          count: where.lockedBy === "worker-2" ? 1 : 0
        })),
        count: jest.fn()
      }
    };
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn() };
    const service = new ProvisioningDeviceOutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1",
      clock: () => now
    });

    await service.publishClaimed(record as never);

    expect(prisma.provisioningDeviceOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ lockedBy: "worker-1" })
    }));
    expect(mqtt.publishTopic).not.toHaveBeenCalled();
  });

  it("backs off a failed publish without changing the provisioning node", async () => {
    const prisma: any = {
      discoveredMeshNode: {
        findUnique: jest.fn().mockResolvedValue({
          id: payload.nodeId,
          sessionId: payload.sessionId,
          deviceUuid: payload.deviceUuid,
          meshAddress: payload.meshAddress,
          status: "provisioning",
          session: { siteId: payload.siteId, gatewayId: payload.gatewayId, status: "active" }
        }),
        updateMany: jest.fn()
      },
      provisioningDeviceOutbox: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(1)
      }
    };
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn().mockRejectedValue(new Error("broker unavailable")) };
    const service = new ProvisioningDeviceOutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1",
      clock: () => now,
      random: () => 0
    });

    await service.publishClaimed(record as never);

    expect(prisma.provisioningDeviceOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ attempts: 1, nextAttemptAt: new Date(now.getTime() + 1_000), lockedBy: null })
    }));
    expect(prisma.discoveredMeshNode.updateMany).not.toHaveBeenCalled();
  });

  it("dead-letters an exhausted publish and preserves pending node evidence for reconciliation", async () => {
    const prisma: any = {
      provisioningDeviceOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      discoveredMeshNode: {
        findUnique: jest.fn().mockResolvedValue({
          id: payload.nodeId,
          sessionId: payload.sessionId,
          deviceUuid: payload.deviceUuid,
          meshAddress: payload.meshAddress,
          status: "provisioning",
          session: { siteId: payload.siteId, gatewayId: payload.gatewayId, status: "active" }
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    };
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = { publishTopic: jest.fn().mockRejectedValue(new Error("broker unavailable")) };
    const service = new ProvisioningDeviceOutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1",
      clock: () => now,
      random: () => 0
    });

    await service.publishClaimed({ ...record, attempts: 9 } as never);

    expect(prisma.provisioningDeviceOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ attempts: 10, deadLetteredAt: now, lockedBy: null })
    }));
    expect(prisma.discoveredMeshNode.updateMany).toHaveBeenCalledWith({
      where: {
        id: payload.nodeId,
        sessionId: payload.sessionId,
        status: "provisioning",
        session: { status: "active" }
      },
      data: {
        status: "reconcile_required",
        errorMessage: "조명 등록 명령을 전송하지 못했습니다. 장비 상태를 확인해 주세요."
      }
    });
  });

  it("does not transition the node when the lease expires before terminal deadletter", async () => {
    let currentTime = now;
    let leaseExpiresAt = new Date(now.getTime() + 30_000);
    const prisma: any = {
      discoveredMeshNode: {
        findUnique: jest.fn().mockResolvedValue({
          id: payload.nodeId,
          sessionId: payload.sessionId,
          deviceUuid: payload.deviceUuid,
          meshAddress: payload.meshAddress,
          status: "provisioning",
          session: { siteId: payload.siteId, gatewayId: payload.gatewayId, status: "active" }
        }),
        updateMany: jest.fn()
      },
      provisioningDeviceOutbox: {
        updateMany: jest.fn().mockImplementation(({ where, data }: any) => {
          const ownsLiveLease = !where.leaseExpiresAt?.gt || leaseExpiresAt > where.leaseExpiresAt.gt;
          if (!ownsLiveLease) return { count: 0 };
          if (data.leaseExpiresAt) leaseExpiresAt = data.leaseExpiresAt;
          return { count: 1 };
        }),
        count: jest.fn().mockResolvedValue(1)
      }
    };
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = {
      publishTopic: jest.fn().mockImplementation(() => {
        currentTime = new Date(now.getTime() + 31_000);
        return Promise.reject(new Error("broker unavailable"));
      })
    };
    const service = new ProvisioningDeviceOutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1",
      clock: () => currentTime,
      random: () => 0
    });

    await service.publishClaimed({ ...record, attempts: 9 } as never);

    expect(mqtt.publishTopic).toHaveBeenCalledTimes(1);
    expect(prisma.provisioningDeviceOutbox.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ leaseExpiresAt: { gt: currentTime } }),
      data: expect.objectContaining({ deadLetteredAt: currentTime })
    }));
    expect(prisma.discoveredMeshNode.updateMany).not.toHaveBeenCalled();
  });

  it("does not transition the node after another worker reclaims during publish", async () => {
    let lockedBy = "worker-1";
    const prisma: any = {
      discoveredMeshNode: {
        findUnique: jest.fn().mockResolvedValue({
          id: payload.nodeId,
          sessionId: payload.sessionId,
          deviceUuid: payload.deviceUuid,
          meshAddress: payload.meshAddress,
          status: "provisioning",
          session: { siteId: payload.siteId, gatewayId: payload.gatewayId, status: "active" }
        }),
        updateMany: jest.fn()
      },
      provisioningDeviceOutbox: {
        updateMany: jest.fn().mockImplementation(({ where }: any) => ({
          count: where.lockedBy === lockedBy ? 1 : 0
        })),
        count: jest.fn().mockResolvedValue(1)
      }
    };
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const mqtt = {
      publishTopic: jest.fn().mockImplementation(() => {
        lockedBy = "worker-2";
        return Promise.reject(new Error("broker unavailable"));
      })
    };
    const service = new ProvisioningDeviceOutboxPublisherService(prisma, mqtt as never, {
      workerId: "worker-1",
      clock: () => now,
      random: () => 0
    });

    await service.publishClaimed({ ...record, attempts: 9 } as never);

    expect(mqtt.publishTopic).toHaveBeenCalledTimes(1);
    expect(prisma.provisioningDeviceOutbox.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ lockedBy: "worker-1" }),
      data: expect.objectContaining({ deadLetteredAt: now })
    }));
    expect(prisma.discoveredMeshNode.updateMany).not.toHaveBeenCalled();
  });

  it("contains scheduler failures and drains an active publish before stopping", async () => {
    jest.useFakeTimers();
    const active = deferred<void>();
    const loggerError = jest.spyOn(Logger.prototype, "error").mockImplementation();
    const service = new ProvisioningDeviceOutboxPublisherService({} as never, {} as never, {
      workerId: "worker-1",
      pollMs: 1_000
    });
    jest.spyOn(service, "claimBatch")
      .mockRejectedValueOnce(Object.assign(new Error("private payload"), { code: "P2028" }))
      .mockResolvedValueOnce([record] as never);
    jest.spyOn(service, "publishClaimed").mockReturnValue(active.promise);

    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      expect(loggerError).toHaveBeenCalledWith(expect.stringContaining("error=P2028"));

      await jest.advanceTimersByTimeAsync(1_000);
      const stopping = service.stopAndDrain();
      let stopped = false;
      void stopping.then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);

      active.resolve();
      await stopping;
      await jest.advanceTimersByTimeAsync(2_000);
      expect(service.publishClaimed).toHaveBeenCalledTimes(1);
    } finally {
      active.resolve();
      await service.stopAndDrain();
      loggerError.mockRestore();
      jest.useRealTimers();
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((value) => { resolve = value; });
  return { promise, resolve };
}
