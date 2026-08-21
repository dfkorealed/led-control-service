import { MeshGroupSyncWorker } from "./mesh-group-sync.worker";

describe("MeshGroupSyncWorker", () => {
  it("publishes only configuring groups that still have members and can republish the same version", async () => {
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
      where: { status: "configuring" },
      orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        gatewayId: true,
        groupAddress: true,
        configurationVersion: true,
        gateway: { select: { siteId: true } },
        members: {
          orderBy: [{ meshNodeId: "asc" }],
          select: {
            meshNodeId: true,
            meshNode: { select: { meshAddress: true } }
          }
        }
      }
    });
    expect(mqtt.publishMeshGroupSubscriptionSync).toHaveBeenCalledTimes(2);
    expect(mqtt.publishMeshGroupSubscriptionSync).toHaveBeenNthCalledWith(1, {
      siteId: "00000000-0000-4000-8000-000000000103",
      gatewayId: "00000000-0000-4000-8000-000000000102",
      groupId: "00000000-0000-4000-8000-000000000101",
      version: 2,
      groupAddress: "0xc000",
      members: [
        {
          meshNodeId: "00000000-0000-4000-8000-000000000104",
          meshAddress: "0x0100"
        }
      ],
      requestedAt: expect.any(String)
    });
  });
});
