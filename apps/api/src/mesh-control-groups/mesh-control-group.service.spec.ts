import { BadRequestException, NotFoundException } from "@nestjs/common";
import { MeshControlGroupService } from "./mesh-control-group.service";

describe("MeshControlGroupService", () => {
  const gatewayId = "00000000-0000-4000-8000-000000000001";
  const gatewayId2 = "00000000-0000-4000-8000-000000000002";
  const floorId = "00000000-0000-4000-8000-000000000003";
  const floorIdOtherSite = "00000000-0000-4000-8000-000000000004";
  const fixtureGroupId = "00000000-0000-4000-8000-000000000005";

  it("allocates the next gateway mesh group address for a floor target inside the caller transaction", async () => {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: gatewayId, siteId: "site-1", nextMeshGroupAddress: 0xc000 }]),
      meshControlGroup: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: "group-1",
          gatewayId,
          targetType: "floor",
          targetId: floorId,
          groupAddress: "0xc000",
          status: "configuring",
          configurationVersion: 1,
          lastError: null
        })
      },
      gateway: {
        update: jest.fn().mockResolvedValue({ nextMeshGroupAddress: 0xc001 })
      },
      floor: {
        findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" })
      }
    };
    const service = new MeshControlGroupService();

    await expect(service.ensureFloorGroup(tx, gatewayId, floorId)).resolves.toMatchObject({
      gatewayId,
      targetType: "floor",
      targetId: floorId,
      groupAddress: "0xc000",
      status: "configuring",
      configurationVersion: 1
    });
    expect(tx.gateway.update).toHaveBeenCalledWith({
      where: { id: gatewayId },
      data: { nextMeshGroupAddress: { increment: 1 } },
      select: { nextMeshGroupAddress: true }
    });
    expect(tx.meshControlGroup.create).toHaveBeenCalledWith({
      data: {
        gatewayId,
        targetType: "floor",
        targetId: floorId,
        groupAddress: "0xc000",
        status: "configuring",
        configurationVersion: 1
      }
    });
  });

  it("returns the existing floor group for the same gateway and target without consuming a new address", async () => {
    const existingGroup = {
      id: "group-1",
      gatewayId,
      targetType: "floor",
      targetId: floorId,
      groupAddress: "0xc010",
      status: "ready",
      configurationVersion: 2,
      lastError: null
    };
    const tx: any = {
      meshControlGroup: {
        findFirst: jest.fn().mockResolvedValue(existingGroup),
        create: jest.fn()
      },
      $queryRaw: jest.fn(),
      gateway: {
        findUnique: jest.fn().mockResolvedValue({ id: gatewayId, siteId: "site-1" }),
        update: jest.fn()
      },
      floor: {
        findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" })
      }
    };
    const service = new MeshControlGroupService();

    await expect(service.ensureFloorGroup(tx, gatewayId, floorId)).resolves.toBe(existingGroup);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.gateway.update).not.toHaveBeenCalled();
    expect(tx.meshControlGroup.create).not.toHaveBeenCalled();
  });

  it("rejects an existing group when the target site no longer matches the gateway site", async () => {
    const existingGroup = {
      id: "group-1",
      gatewayId,
      targetType: "floor",
      targetId: floorId,
      groupAddress: "0xc010",
      status: "ready",
      configurationVersion: 2,
      lastError: null
    };
    const tx: any = {
      meshControlGroup: {
        findFirst: jest.fn().mockResolvedValue(existingGroup),
        create: jest.fn()
      },
      gateway: {
        findUnique: jest.fn().mockResolvedValue({ id: gatewayId, siteId: "site-1" }),
        update: jest.fn()
      },
      $queryRaw: jest.fn(),
      floor: {
        findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-2" })
      }
    };
    const service = new MeshControlGroupService();

    await expect(service.ensureFloorGroup(tx, gatewayId, floorId)).rejects.toThrow(
      "floor does not belong to the gateway site"
    );
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.gateway.update).not.toHaveBeenCalled();
  });

  it("allocates separate groups per gateway for the same floor target", async () => {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: gatewayId2, siteId: "site-1", nextMeshGroupAddress: 0xc120 }]),
      meshControlGroup: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: "group-2",
          gatewayId: gatewayId2,
          targetType: "floor",
          targetId: floorId,
          groupAddress: "0xc120",
          status: "configuring",
          configurationVersion: 1,
          lastError: null
        })
      },
      gateway: {
        update: jest.fn().mockResolvedValue({ nextMeshGroupAddress: 0xc121 })
      },
      floor: {
        findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" })
      }
    };
    const service = new MeshControlGroupService();

    await expect(service.ensureFloorGroup(tx, gatewayId2, floorId)).resolves.toMatchObject({
      gatewayId: gatewayId2,
      targetType: "floor",
      targetId: floorId,
      groupAddress: "0xc120"
    });
  });

  it("rejects a target that does not belong to the same site as the gateway", async () => {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: gatewayId, siteId: "site-1", nextMeshGroupAddress: 0xc000 }]),
      meshControlGroup: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn()
      },
      gateway: {
        update: jest.fn()
      },
      floor: {
        findUnique: jest.fn().mockResolvedValue({ id: floorIdOtherSite, siteId: "site-2" })
      }
    };
    const service = new MeshControlGroupService();

    await expect(service.ensureFloorGroup(tx, gatewayId, floorIdOtherSite)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.ensureFloorGroup(tx, gatewayId, floorIdOtherSite)).rejects.toThrow(
      "floor does not belong to the gateway site"
    );
    expect(tx.gateway.update).not.toHaveBeenCalled();
    expect(tx.meshControlGroup.create).not.toHaveBeenCalled();
  });

  it("rejects mesh group allocation after the group address range is exhausted", async () => {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: gatewayId, siteId: "site-1", nextMeshGroupAddress: 0xff00 }]),
      meshControlGroup: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn()
      },
      gateway: {
        update: jest.fn()
      },
      floor: {
        findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" })
      }
    };
    const service = new MeshControlGroupService();

    await expect(service.ensureFloorGroup(tx, gatewayId, floorId)).rejects.toThrow(
      "mesh group address range exhausted"
    );
    expect(tx.gateway.update).not.toHaveBeenCalled();
    expect(tx.meshControlGroup.create).not.toHaveBeenCalled();
  });

  it("allocates a persistent fixture-group control group", async () => {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: gatewayId, siteId: "site-1", nextMeshGroupAddress: 0xc100 }]),
      meshControlGroup: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: "group-3",
          gatewayId,
          targetType: "fixture_group",
          targetId: fixtureGroupId,
          groupAddress: "0xc100",
          status: "configuring",
          configurationVersion: 1,
          lastError: null
        })
      },
      gateway: {
        update: jest.fn().mockResolvedValue({ nextMeshGroupAddress: 0xc101 })
      },
      fixtureGroup: {
        findUnique: jest.fn().mockResolvedValue({ id: fixtureGroupId, siteId: "site-1" })
      }
    };
    const service = new MeshControlGroupService();

    await expect(service.ensureFixtureGroup(tx, gatewayId, fixtureGroupId)).resolves.toMatchObject({
      gatewayId,
      targetType: "fixture_group",
      targetId: fixtureGroupId,
      groupAddress: "0xc100",
      status: "configuring"
    });
  });

  it("throws NotFoundException when the gateway does not exist", async () => {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      meshControlGroup: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn()
      },
      gateway: {
        update: jest.fn()
      },
      floor: {
        findUnique: jest.fn()
      }
    };
    const service = new MeshControlGroupService();

    await expect(service.ensureFloorGroup(tx, gatewayId, floorId)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.meshControlGroup.create).not.toHaveBeenCalled();
  });

  it("increments the version and resets every member when a ready group receives a new member", async () => {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "group-1", gatewayId, status: "ready", configurationVersion: 3 }]),
      meshNode: {
        findFirst: jest.fn().mockResolvedValue({ id: "node-2", gatewayId, gateway: { siteId: "site-1" } })
      },
      floor: {
        findFirst: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" }),
        findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" })
      },
      gateway: {
        findUnique: jest.fn().mockResolvedValue({ id: gatewayId, siteId: "site-1" })
      },
      fixtureGroup: {
        findMany: jest.fn().mockResolvedValue([])
      },
      meshControlGroup: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({
            id: "group-1",
            gatewayId,
            targetType: "floor",
            targetId: floorId,
            status: "ready",
            configurationVersion: 3
          })
          .mockResolvedValueOnce({
            id: "group-1",
            gatewayId,
            targetType: "floor",
            targetId: floorId,
            status: "ready",
            configurationVersion: 3,
            _count: { members: 1 }
          }),
        update: jest.fn().mockResolvedValue({
          id: "group-1",
          gatewayId,
          targetType: "floor",
          targetId: floorId,
          status: "configuring",
          configurationVersion: 4
        })
      },
      meshControlGroupMember: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        updateMany: jest.fn().mockResolvedValue({ count: 2 })
      }
    };
    const service = new MeshControlGroupService();

    await service.attachProvisionedNode(tx, {
      meshNodeId: "node-2",
      gatewayId,
      floorId,
      fixtureGroupIds: []
    });

    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.meshControlGroupMember.createMany.mock.invocationCallOrder[0]
    );
    expect(tx.meshControlGroupMember.createMany).toHaveBeenCalledWith({
      data: [{
        groupId: "group-1",
        gatewayId,
        meshNodeId: "node-2"
      }],
      skipDuplicates: true
    });
    expect(tx.meshControlGroup.update).toHaveBeenCalledWith({
      where: { id: "group-1" },
      data: {
        status: "configuring",
        configurationVersion: { increment: 1 },
        lastError: null
      }
    });
    expect(tx.meshControlGroupMember.updateMany).toHaveBeenCalledWith({
      where: { groupId: "group-1", gatewayId },
      data: {
        subscriptionStatus: "pending",
        statusVersion: 0,
        lastError: null
      }
    });
  });

  it("keeps version 1 for the first member added to an empty configuring group", async () => {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "group-1", gatewayId, status: "configuring", configurationVersion: 1 }]),
      meshNode: {
        findFirst: jest.fn().mockResolvedValue({ id: "node-1", gatewayId, gateway: { siteId: "site-1" } })
      },
      floor: {
        findFirst: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" }),
        findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" })
      },
      gateway: {
        findUnique: jest.fn().mockResolvedValue({ id: gatewayId, siteId: "site-1" })
      },
      fixtureGroup: {
        findMany: jest.fn().mockResolvedValue([])
      },
      meshControlGroup: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({
            id: "group-1",
            gatewayId,
            targetType: "floor",
            targetId: floorId,
            status: "configuring",
            configurationVersion: 1
          })
          .mockResolvedValueOnce({
            id: "group-1",
            gatewayId,
            targetType: "floor",
            targetId: floorId,
            status: "configuring",
            configurationVersion: 1,
            _count: { members: 0 }
          }),
        update: jest.fn()
      },
      meshControlGroupMember: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    };
    const service = new MeshControlGroupService();

    await service.attachProvisionedNode(tx, {
      meshNodeId: "node-1",
      gatewayId,
      floorId,
      fixtureGroupIds: []
    });

    expect(tx.meshControlGroup.update).not.toHaveBeenCalled();
    expect(tx.meshControlGroupMember.updateMany).not.toHaveBeenCalled();
  });

  it("does not mutate versions or statuses when the same member is attached again", async () => {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "group-1", gatewayId, status: "ready", configurationVersion: 3 }]),
      meshNode: {
        findFirst: jest.fn().mockResolvedValue({ id: "node-1", gatewayId, gateway: { siteId: "site-1" } })
      },
      floor: {
        findFirst: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" }),
        findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" })
      },
      gateway: {
        findUnique: jest.fn().mockResolvedValue({ id: gatewayId, siteId: "site-1" })
      },
      fixtureGroup: {
        findMany: jest.fn().mockResolvedValue([])
      },
      meshControlGroup: {
        findFirst: jest.fn().mockResolvedValue({
          id: "group-1",
          gatewayId,
          targetType: "floor",
          targetId: floorId,
          status: "ready",
          configurationVersion: 3,
          _count: { members: 2 }
        }),
        update: jest.fn()
      },
      meshControlGroupMember: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        updateMany: jest.fn()
      }
    };
    const service = new MeshControlGroupService();

    await service.attachProvisionedNode(tx, {
      meshNodeId: "node-1",
      gatewayId,
      floorId,
      fixtureGroupIds: []
    });

    expect(tx.meshControlGroupMember.createMany).toHaveBeenCalledWith({
      data: [{
        groupId: "group-1",
        gatewayId,
        meshNodeId: "node-1"
      }],
      skipDuplicates: true
    });
    expect(tx.meshControlGroup.update).not.toHaveBeenCalled();
    expect(tx.meshControlGroupMember.updateMany).not.toHaveBeenCalled();
  });

  it("re-synchronizes an in-progress group without incrementing the version when another member is added", async () => {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: "group-1", gatewayId, status: "configuring", configurationVersion: 4 }]),
      meshNode: {
        findFirst: jest.fn().mockResolvedValue({ id: "node-2", gatewayId, gateway: { siteId: "site-1" } })
      },
      floor: {
        findFirst: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" }),
        findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" })
      },
      gateway: {
        findUnique: jest.fn().mockResolvedValue({ id: gatewayId, siteId: "site-1" })
      },
      fixtureGroup: {
        findMany: jest.fn().mockResolvedValue([])
      },
      meshControlGroup: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({
            id: "group-1",
            gatewayId,
            targetType: "floor",
            targetId: floorId,
            status: "configuring",
            configurationVersion: 4
          })
          .mockResolvedValueOnce({
            id: "group-1",
            gatewayId,
            targetType: "floor",
            targetId: floorId,
            status: "configuring",
            configurationVersion: 4,
            _count: { members: 2 }
          }),
        update: jest.fn().mockResolvedValue({
          id: "group-1",
          gatewayId,
          targetType: "floor",
          targetId: floorId,
          status: "configuring",
          configurationVersion: 4
        })
      },
      meshControlGroupMember: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        updateMany: jest.fn().mockResolvedValue({ count: 2 })
      }
    };
    const service = new MeshControlGroupService();

    await service.attachProvisionedNode(tx, {
      meshNodeId: "node-2",
      gatewayId,
      floorId,
      fixtureGroupIds: []
    });

    expect(tx.meshControlGroup.update).toHaveBeenCalledWith({
      where: { id: "group-1" },
      data: {
        status: "configuring",
        lastError: null
      }
    });
    expect(tx.meshControlGroupMember.updateMany).toHaveBeenCalledWith({
      where: { groupId: "group-1", gatewayId },
      data: {
        subscriptionStatus: "pending",
        statusVersion: 0,
        lastError: null
      }
    });
  });

  it("attaches the floor group and existing fixture-group memberships in one call", async () => {
    const tx: any = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ id: "floor-group", gatewayId, status: "configuring", configurationVersion: 1 }])
        .mockResolvedValueOnce([{ id: "fixture-group-1", gatewayId, status: "configuring", configurationVersion: 1 }]),
      meshNode: {
        findFirst: jest.fn().mockResolvedValue({ id: "node-1", gatewayId, gateway: { siteId: "site-1" } })
      },
      floor: {
        findFirst: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" }),
        findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" })
      },
      gateway: {
        findUnique: jest.fn().mockResolvedValue({ id: gatewayId, siteId: "site-1" })
      },
      fixtureGroup: {
        findMany: jest.fn().mockResolvedValue([{ id: fixtureGroupId, siteId: "site-1" }]),
        findUnique: jest.fn().mockResolvedValue({ id: fixtureGroupId, siteId: "site-1" })
      },
      meshControlGroup: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({
            id: "floor-group",
            gatewayId,
            targetType: "floor",
            targetId: floorId,
            status: "configuring",
            configurationVersion: 1
          })
          .mockResolvedValueOnce({
            id: "floor-group",
            gatewayId,
            targetType: "floor",
            targetId: floorId,
            status: "configuring",
            configurationVersion: 1,
            _count: { members: 0 }
          })
          .mockResolvedValueOnce({
            id: "fixture-group-1",
            gatewayId,
            targetType: "fixture_group",
            targetId: fixtureGroupId,
            status: "configuring",
            configurationVersion: 1
          })
          .mockResolvedValueOnce({
            id: "fixture-group-1",
            gatewayId,
            targetType: "fixture_group",
            targetId: fixtureGroupId,
            status: "configuring",
            configurationVersion: 1,
            _count: { members: 0 }
          }),
        create: jest.fn(),
        update: jest.fn()
      },
      meshControlGroupMember: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        updateMany: jest.fn()
      }
    };
    const service = new MeshControlGroupService();

    await service.attachProvisionedNode(tx, {
      meshNodeId: "node-1",
      gatewayId,
      floorId,
      fixtureGroupIds: [fixtureGroupId]
    });

    expect(tx.meshControlGroupMember.createMany).toHaveBeenNthCalledWith(1, {
      data: [{ groupId: "floor-group", gatewayId, meshNodeId: "node-1" }],
      skipDuplicates: true
    });
    expect(tx.meshControlGroupMember.createMany).toHaveBeenNthCalledWith(2, {
      data: [{ groupId: "fixture-group-1", gatewayId, meshNodeId: "node-1" }],
      skipDuplicates: true
    });
  });

  it("rejects attaching a node when the floor or fixture groups are outside the gateway site", async () => {
    const tx: any = {
      meshNode: {
        findFirst: jest.fn().mockResolvedValue({ id: "node-1", gatewayId, gateway: { siteId: "site-1" } })
      },
      floor: {
        findFirst: jest.fn().mockResolvedValue(null)
      },
      fixtureGroup: {
        findMany: jest.fn()
      },
      meshControlGroup: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn()
      },
      meshControlGroupMember: {
        createMany: jest.fn(),
        updateMany: jest.fn()
      }
    };
    const service = new MeshControlGroupService();

    await expect(service.attachProvisionedNode(tx, {
      meshNodeId: "node-1",
      gatewayId,
      floorId,
      fixtureGroupIds: []
    })).rejects.toThrow("floor not found");

    tx.floor.findFirst.mockResolvedValue({ id: floorId, siteId: "site-1" });
    tx.fixtureGroup.findMany.mockResolvedValue([]);

    await expect(service.attachProvisionedNode(tx, {
      meshNodeId: "node-1",
      gatewayId,
      floorId,
      fixtureGroupIds: [fixtureGroupId]
    })).rejects.toThrow("fixture group not found");
  });

  it("returns only ready destinations and rejects missing or unready targets", async () => {
    const tx: any = {
      floor: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({ id: floorId })
          .mockResolvedValueOnce(null)
      },
      fixtureGroup: {
        findFirst: jest.fn().mockResolvedValue({ id: fixtureGroupId })
      },
      meshControlGroup: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({
            id: "mesh-group-1",
            groupAddress: "0xc000",
            configurationVersion: 3,
            status: "ready"
          })
          .mockResolvedValueOnce({
            groupAddress: "0xc001",
            status: "configuring"
          })
          .mockResolvedValueOnce(null)
      }
    };
    const service = new MeshControlGroupService();

    await expect(service.getReadyDestination(tx, {
      type: "floor",
      floorId,
      gatewayId
    })).resolves.toEqual({
      groupId: "mesh-group-1",
      groupAddress: "0xc000",
      configurationVersion: 3
    });
    await expect(service.getReadyDestination(tx, {
      type: "fixture_group",
      fixtureGroupId,
      gatewayId
    })).rejects.toThrow("mesh control group is not ready");
    await expect(service.getReadyDestination(tx, {
      type: "floor",
      floorId: "missing-floor",
      gatewayId
    })).rejects.toThrow("mesh control group target not found");
  });
});
