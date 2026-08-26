import { MeshGroupSyncWorker } from "./mesh-group-sync.worker";

describe("MeshGroupSyncWorker", () => {
  it("waits for the active publish and starts no later group or tick after stop", async () => {
    jest.useFakeTimers();
    const activePublish = deferred<void>();
    const prisma: any = {
      $transaction: jest.fn(async (callback: (tx: object) => Promise<unknown>) => callback({})),
      meshControlGroup: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "00000000-0000-4000-8000-000000000101",
            gatewayId: "00000000-0000-4000-8000-000000000102",
            configurationVersion: 1
          },
          {
            id: "00000000-0000-4000-8000-000000000201",
            gatewayId: "00000000-0000-4000-8000-000000000202",
            configurationVersion: 1
          }
        ])
      }
    };
    const mqtt = {
      publishMeshGroupSubscriptionSync: jest.fn()
        .mockImplementationOnce(() => activePublish.promise)
        .mockResolvedValue(undefined)
    };
    const meshGroups = {
      prepareSubscriptionSync: jest.fn(async (_tx: unknown, input: { groupId: string; gatewayId: string }) => ({
        siteId: "00000000-0000-4000-8000-000000000301",
        gatewayId: input.gatewayId,
        groupId: input.groupId,
        version: 1,
        groupAddress: "0xc000",
        desiredMembers: [],
        expectedOperations: [],
        requestedAt: "2026-08-26T00:00:00.000Z"
      }))
    };
    const worker = new MeshGroupSyncWorker(prisma, mqtt as never, meshGroups as never);

    try {
      worker.onModuleInit();
      await jest.advanceTimersByTimeAsync(10_000);
      expect(mqtt.publishMeshGroupSubscriptionSync).toHaveBeenCalledTimes(1);

      const stopping = worker.stopAndDrain();
      expect(worker.stopAndDrain()).toBe(stopping);
      let stopped = false;
      void stopping.then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);

      activePublish.resolve();
      await stopping;
      expect(mqtt.publishMeshGroupSubscriptionSync).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(20_000);
      await Promise.resolve();
      expect(prisma.meshControlGroup.findMany).toHaveBeenCalledTimes(1);
    } finally {
      activePublish.resolve();
      await worker.stopAndDrain?.();
      jest.useRealTimers();
    }
  });

  it("publishes complete desired membership, including an empty set, and can republish the same version", async () => {
    const prisma: any = {
      $transaction: jest.fn(async (callback: (tx: object) => Promise<unknown>) => callback({})),
      meshControlGroup: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "00000000-0000-4000-8000-000000000101",
            gatewayId: "00000000-0000-4000-8000-000000000102",
            groupAddress: "0xc000",
            configurationVersion: 2,
            gateway: { siteId: "00000000-0000-4000-8000-000000000103" },
            members: [
              { meshNodeId: "00000000-0000-4000-8000-000000000104", meshNode: { meshAddress: "0x0100" } }
            ]
          },
          {
            id: "00000000-0000-4000-8000-000000000201",
            gatewayId: "00000000-0000-4000-8000-000000000202",
            groupAddress: "0xc001",
            configurationVersion: 5,
            gateway: { siteId: "00000000-0000-4000-8000-000000000203" },
            members: []
          }
        ])
      }
    };
    const mqtt = {
      publishMeshGroupSubscriptionSync: jest.fn().mockResolvedValue(undefined)
    };
    const meshGroups = {
      prepareSubscriptionSync: jest.fn(async (_tx: unknown, input: { groupId: string }) => input.groupId.endsWith("101")
        ? {
            siteId: "00000000-0000-4000-8000-000000000103",
            gatewayId: "00000000-0000-4000-8000-000000000102",
            groupId: input.groupId,
            version: 2,
            groupAddress: "0xc000",
            desiredMembers: [{ meshNodeId: "00000000-0000-4000-8000-000000000104", meshAddress: "0x0100" }],
            expectedOperations: [{ operationId: "00000000-0000-4000-8000-000000000105", action: "add", meshNodeId: "00000000-0000-4000-8000-000000000104", meshAddress: "0x0100" }],
            requestedAt: "2026-08-26T00:00:00.000Z"
          }
        : {
            siteId: "00000000-0000-4000-8000-000000000203",
            gatewayId: "00000000-0000-4000-8000-000000000202",
            groupId: input.groupId,
            version: 5,
            groupAddress: "0xc001",
            desiredMembers: [],
            expectedOperations: [],
            requestedAt: "2026-08-26T00:00:00.000Z"
          })
    };
    const worker = new MeshGroupSyncWorker(prisma, mqtt as never, meshGroups as never);

    await worker.runOnce();
    await worker.runOnce();

    expect(prisma.meshControlGroup.findMany).toHaveBeenCalledWith({
      where: { status: { in: ["configuring", "retiring"] } },
      orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        gatewayId: true,
        configurationVersion: true
      }
    });
    expect(mqtt.publishMeshGroupSubscriptionSync).toHaveBeenCalledTimes(4);
    expect(mqtt.publishMeshGroupSubscriptionSync).toHaveBeenNthCalledWith(1, {
      siteId: "00000000-0000-4000-8000-000000000103",
      gatewayId: "00000000-0000-4000-8000-000000000102",
      groupId: "00000000-0000-4000-8000-000000000101",
      version: 2,
      groupAddress: "0xc000",
      desiredMembers: [
        {
          meshNodeId: "00000000-0000-4000-8000-000000000104",
          meshAddress: "0x0100"
        }
      ],
      expectedOperations: [{
        operationId: "00000000-0000-4000-8000-000000000105",
        action: "add",
        meshNodeId: "00000000-0000-4000-8000-000000000104",
        meshAddress: "0x0100"
      }],
      requestedAt: "2026-08-26T00:00:00.000Z"
    });
    expect(mqtt.publishMeshGroupSubscriptionSync).toHaveBeenNthCalledWith(2, expect.objectContaining({
      groupId: "00000000-0000-4000-8000-000000000201",
      desiredMembers: []
    }));
  });

  it("publishes the empty cloud desired set for a retiring group until the delete ACK arrives", async () => {
    const prisma: any = {
      $transaction: jest.fn(async (callback: (tx: object) => Promise<unknown>) => callback({})),
      meshControlGroup: {
        findMany: jest.fn().mockResolvedValue([{
          id: "00000000-0000-4000-8000-000000000301",
          gatewayId: "00000000-0000-4000-8000-000000000302",
          groupAddress: "0xc002",
          configurationVersion: 6,
          gateway: { siteId: "00000000-0000-4000-8000-000000000303" },
          members: []
        }])
      }
    };
    const mqtt = { publishMeshGroupSubscriptionSync: jest.fn().mockResolvedValue(undefined) };
    const meshGroups = {
      prepareSubscriptionSync: jest.fn().mockResolvedValue({
        siteId: "00000000-0000-4000-8000-000000000303",
        gatewayId: "00000000-0000-4000-8000-000000000302",
        groupId: "00000000-0000-4000-8000-000000000301",
        version: 6,
        groupAddress: "0xc002",
        desiredMembers: [],
        expectedOperations: [{
          operationId: "00000000-0000-4000-8000-000000000304",
          action: "delete",
          meshNodeId: "00000000-0000-4000-8000-000000000305",
          meshAddress: "0x0100"
        }],
        requestedAt: "2026-08-26T00:00:00.000Z"
      })
    };
    const worker = new MeshGroupSyncWorker(prisma, mqtt as never, meshGroups as never);

    await worker.runOnce();

    expect(prisma.meshControlGroup.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: { in: ["configuring", "retiring"] } }
    }));
    expect(mqtt.publishMeshGroupSubscriptionSync).toHaveBeenCalledWith(expect.objectContaining({
      groupId: "00000000-0000-4000-8000-000000000301",
      version: 6,
      desiredMembers: [],
      expectedOperations: [expect.objectContaining({ action: "delete" })]
    }));
  });

  it("logs and continues publishing later groups when an earlier group publish fails", async () => {
    const prisma: any = {
      $transaction: jest.fn(async (callback: (tx: object) => Promise<unknown>) => callback({})),
      meshControlGroup: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "00000000-0000-4000-8000-000000000101",
            gatewayId: "00000000-0000-4000-8000-000000000102",
            groupAddress: "0xc000",
            configurationVersion: 2,
            gateway: { siteId: "00000000-0000-4000-8000-000000000103" },
            members: [
              { meshNodeId: "00000000-0000-4000-8000-000000000104", meshNode: { meshAddress: "0x0100" } }
            ]
          },
          {
            id: "00000000-0000-4000-8000-000000000201",
            gatewayId: "00000000-0000-4000-8000-000000000202",
            groupAddress: "0xc001",
            configurationVersion: 5,
            gateway: { siteId: "00000000-0000-4000-8000-000000000203" },
            members: [
              { meshNodeId: "00000000-0000-4000-8000-000000000204", meshNode: { meshAddress: "0x0101" } }
            ]
          }
        ])
      }
    };
    const mqtt = {
      publishMeshGroupSubscriptionSync: jest.fn()
        .mockRejectedValueOnce(new Error("broker rejected publish"))
        .mockResolvedValueOnce(undefined)
    };
    const meshGroups = {
      prepareSubscriptionSync: jest.fn(async (_tx: unknown, input: { groupId: string; gatewayId: string; configurationVersion: number; requestedAt: string }) => ({
        siteId: input.groupId.endsWith("101") ? "00000000-0000-4000-8000-000000000103" : "00000000-0000-4000-8000-000000000203",
        gatewayId: input.gatewayId,
        groupId: input.groupId,
        version: input.configurationVersion,
        groupAddress: input.groupId.endsWith("101") ? "0xc000" : "0xc001",
        desiredMembers: [],
        expectedOperations: [],
        requestedAt: input.requestedAt
      }))
    };
    const worker = new MeshGroupSyncWorker(prisma, mqtt as never, meshGroups as never);
    const logger = jest.spyOn((worker as any).logger, "error").mockImplementation(() => undefined);

    await worker.runOnce();

    expect(mqtt.publishMeshGroupSubscriptionSync).toHaveBeenCalledTimes(2);
    expect(mqtt.publishMeshGroupSubscriptionSync).toHaveBeenNthCalledWith(2, expect.objectContaining({
      groupId: "00000000-0000-4000-8000-000000000201",
      gatewayId: "00000000-0000-4000-8000-000000000202"
    }));
    expect(logger).toHaveBeenCalledWith(
      "mesh control group sync publish failed",
      expect.objectContaining({
        groupId: "00000000-0000-4000-8000-000000000101",
        gatewayId: "00000000-0000-4000-8000-000000000102",
        version: 2
      })
    );
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((value) => { resolve = value; });
  return { promise, resolve };
}
