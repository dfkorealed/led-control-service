import { MeshGroupSyncWorker } from "./mesh-group-sync.worker";

describe("MeshGroupSyncWorker", () => {
  it("publishes complete desired membership, including an empty set, and can republish the same version", async () => {
    const prisma: any = {
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
    const worker = new MeshGroupSyncWorker(prisma, mqtt as never);

    await worker.runOnce();
    await worker.runOnce();

    expect(prisma.meshControlGroup.findMany).toHaveBeenCalledWith({
      where: { status: { in: ["configuring", "retiring"] } },
      orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        gatewayId: true,
        groupAddress: true,
        configurationVersion: true,
        gateway: { select: { siteId: true } },
        members: {
          where: { desired: true },
          orderBy: [{ meshNodeId: "asc" }],
          select: {
            meshNodeId: true,
            meshNode: { select: { meshAddress: true } }
          }
        }
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
      requestedAt: expect.any(String)
    });
    expect(mqtt.publishMeshGroupSubscriptionSync).toHaveBeenNthCalledWith(2, expect.objectContaining({
      groupId: "00000000-0000-4000-8000-000000000201",
      desiredMembers: []
    }));
  });

  it("publishes the empty cloud desired set for a retiring group until the delete ACK arrives", async () => {
    const prisma: any = {
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
    const worker = new MeshGroupSyncWorker(prisma, mqtt as never);

    await worker.runOnce();

    expect(prisma.meshControlGroup.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: { in: ["configuring", "retiring"] } }
    }));
    expect(mqtt.publishMeshGroupSubscriptionSync).toHaveBeenCalledWith(expect.objectContaining({
      groupId: "00000000-0000-4000-8000-000000000301",
      version: 6,
      desiredMembers: []
    }));
  });

  it("logs and continues publishing later groups when an earlier group publish fails", async () => {
    const prisma: any = {
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
    const worker = new MeshGroupSyncWorker(prisma, mqtt as never);
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
