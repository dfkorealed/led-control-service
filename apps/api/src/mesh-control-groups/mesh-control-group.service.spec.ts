import { BadRequestException, NotFoundException } from "@nestjs/common";
import { MeshControlGroupService } from "./mesh-control-group.service";

describe("MeshControlGroupService", () => {
  const siteId = "00000000-0000-4000-8000-000000000000";
  const gatewayId = "00000000-0000-4000-8000-000000000001";
  const gatewayId2 = "00000000-0000-4000-8000-000000000002";
  const floorId = "00000000-0000-4000-8000-000000000003";
  const floorIdOtherSite = "00000000-0000-4000-8000-000000000004";
  const fixtureGroupId = "00000000-0000-4000-8000-000000000005";
  const resyncInput = {
    siteId,
    gatewayId,
    eventId: "00000000-0000-4000-8000-000000000006",
    occurredAt: "2026-08-23T09:00:00.000Z",
    reason: "state_missing" as const
  };

  it("allocates the next gateway mesh group address for a floor target inside the caller transaction", async () => {
    const tx: any = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ id: gatewayId, siteId: "site-1", nextMeshGroupAddress: 0xc000 }])
        .mockResolvedValueOnce([{
          id: "group-1",
          gatewayId,
          targetType: "floor",
          targetId: floorId,
          groupAddress: "0xc000",
          status: "configuring",
          configurationVersion: 1,
          lastError: null
        }]),
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
    expect(tx.meshControlGroup.create).not.toHaveBeenCalled();
    expect(renderSqlCall(tx.$queryRaw.mock.calls[1])).toContain("ON CONFLICT");
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
      $queryRaw: jest.fn().mockResolvedValue([{
        id: gatewayId,
        siteId: "site-1",
        nextMeshGroupAddress: 0xc020
      }]),
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
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.gateway.update).not.toHaveBeenCalled();
    expect(tx.meshControlGroup.create).not.toHaveBeenCalled();
  });

  it("locks the gateway before looking up an existing control group", async () => {
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
      $queryRaw: jest.fn().mockResolvedValue([{
        id: gatewayId,
        siteId: "site-1",
        nextMeshGroupAddress: 0xc020
      }]),
      meshControlGroup: {
        findFirst: jest.fn().mockResolvedValue(existingGroup)
      },
      gateway: {
        findUnique: jest.fn().mockResolvedValue({ id: gatewayId, siteId: "site-1" })
      },
      floor: {
        findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-1" })
      }
    };
    const service = new MeshControlGroupService();

    await expect(service.ensureFloorGroup(tx, gatewayId, floorId)).resolves.toBe(existingGroup);

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(renderSqlCall(tx.$queryRaw.mock.calls[0])).toContain('FROM "Gateway"');
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.meshControlGroup.findFirst.mock.invocationCallOrder[0]
    );
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
      $queryRaw: jest.fn().mockResolvedValue([{
        id: gatewayId,
        siteId: "site-1",
        nextMeshGroupAddress: 0xc020
      }]),
      floor: {
        findUnique: jest.fn().mockResolvedValue({ id: floorId, siteId: "site-2" })
      }
    };
    const service = new MeshControlGroupService();

    await expect(service.ensureFloorGroup(tx, gatewayId, floorId)).rejects.toThrow(
      "floor does not belong to the gateway site"
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.gateway.update).not.toHaveBeenCalled();
  });

  it("allocates separate groups per gateway for the same floor target", async () => {
    const tx: any = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ id: gatewayId2, siteId: "site-1", nextMeshGroupAddress: 0xc120 }])
        .mockResolvedValueOnce([{
          id: "group-2",
          gatewayId: gatewayId2,
          targetType: "floor",
          targetId: floorId,
          groupAddress: "0xc120",
          status: "configuring",
          configurationVersion: 1,
          lastError: null
        }]),
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
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ id: gatewayId, siteId: "site-1", nextMeshGroupAddress: 0xc100 }])
        .mockResolvedValueOnce([{
          id: "group-3",
          gatewayId,
          targetType: "fixture_group",
          targetId: fixtureGroupId,
          groupAddress: "0xc100",
          status: "configuring",
          configurationVersion: 1,
          lastError: null
        }]),
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

  it("uses a conflict-safe insert so a concurrent target winner does not abort the transaction", async () => {
    const winner = {
      id: "group-winner",
      gatewayId,
      targetType: "fixture_group",
      targetId: fixtureGroupId,
      groupAddress: "0xc100",
      status: "configuring",
      configurationVersion: 1,
      lastError: null
    };
    const tx: any = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ id: gatewayId, siteId: "site-1", nextMeshGroupAddress: 0xc100 }])
        .mockResolvedValueOnce([]),
      meshControlGroup: {
        findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(winner),
        create: jest.fn()
      },
      gateway: { update: jest.fn().mockResolvedValue({ nextMeshGroupAddress: 0xc101 }) },
      fixtureGroup: { findUnique: jest.fn().mockResolvedValue({ id: fixtureGroupId, siteId: "site-1" }) }
    };
    const service = new MeshControlGroupService();

    await expect(service.ensureFixtureGroup(tx, gatewayId, fixtureGroupId)).resolves.toBe(winner);
    expect(tx.meshControlGroup.findFirst).toHaveBeenCalledTimes(2);
    expect(tx.meshControlGroup.create).not.toHaveBeenCalled();
    expect(renderSqlCall(tx.$queryRaw.mock.calls[1])).toContain("ON CONFLICT");
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
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ id: gatewayId, siteId: "site-1", nextMeshGroupAddress: 0xc020 }])
        .mockResolvedValue([{ id: "group-1", gatewayId, status: "ready", configurationVersion: 3 }]),
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

    expect(renderSqlCall(tx.$queryRaw.mock.calls[0])).toContain('FROM "Gateway"');
    expect(renderSqlCall(tx.$queryRaw.mock.calls[1])).toContain('FROM "MeshControlGroup"');
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$queryRaw.mock.invocationCallOrder[1]
    );
    expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
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
        operationPlanVersion: 0,
        lastError: null
      }
    });
    expect(tx.meshControlGroupMember.updateMany).toHaveBeenCalledWith({
      where: { groupId: "group-1", gatewayId },
      data: {
        subscriptionStatus: "pending",
        statusVersion: 0,
        operationId: null,
        operation: null,
        lastError: null
      }
    });
  });

  it("increments the version when the first desired member is added to a configuring group", async () => {
    const tx: any = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ id: gatewayId, siteId: "site-1", nextMeshGroupAddress: 0xc020 }])
        .mockResolvedValue([{ id: "group-1", gatewayId, status: "configuring", configurationVersion: 1 }]),
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

    expect(tx.meshControlGroup.update).toHaveBeenCalledWith({
      where: { id: "group-1" },
      data: {
        status: "configuring",
        configurationVersion: { increment: 1 },
        operationPlanVersion: 0,
        lastError: null
      }
    });
    expect(tx.meshControlGroupMember.updateMany).toHaveBeenCalledWith({
      where: { groupId: "group-1", gatewayId },
      data: {
        subscriptionStatus: "pending",
        statusVersion: 0,
        operationId: null,
        operation: null,
        lastError: null
      }
    });
  });

  it("does not mutate versions or statuses when the same member is attached again", async () => {
    const tx: any = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ id: gatewayId, siteId: "site-1", nextMeshGroupAddress: 0xc020 }])
        .mockResolvedValue([{ id: "group-1", gatewayId, status: "ready", configurationVersion: 3 }]),
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

  it("increments the version when another desired member is added to an in-progress group", async () => {
    const tx: any = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ id: gatewayId, siteId: "site-1", nextMeshGroupAddress: 0xc020 }])
        .mockResolvedValue([{ id: "group-1", gatewayId, status: "configuring", configurationVersion: 4 }]),
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
        configurationVersion: { increment: 1 },
        operationPlanVersion: 0,
        lastError: null
      }
    });
    expect(tx.meshControlGroupMember.updateMany).toHaveBeenCalledWith({
      where: { groupId: "group-1", gatewayId },
      data: {
        subscriptionStatus: "pending",
        statusVersion: 0,
        operationId: null,
        operation: null,
        lastError: null
      }
    });
  });

  it("attaches the floor group and existing fixture-group memberships in one call", async () => {
    const tx: any = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ id: gatewayId, siteId: "site-1", nextMeshGroupAddress: 0xc020 }])
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

  it("accepts the production limit of 15 unique fixture groups plus the floor group", async () => {
    const fixtureGroupIds = Array.from({ length: 15 }, (_, index) => `fixture-group-${index + 1}`);
    const tx = createCapacityAttachTx(gatewayId, floorId, fixtureGroupIds);
    const service = new MeshControlGroupService();

    await expect(service.attachProvisionedNode(tx as never, {
      meshNodeId: "node-1",
      gatewayId,
      floorId,
      fixtureGroupIds
    })).resolves.toBeUndefined();

    expect(tx.meshControlGroupMember.createMany).toHaveBeenCalledTimes(16);
  });

  it("deduplicates fixture group IDs before applying the production subscription limit", async () => {
    const fixtureGroupIds = Array.from({ length: 15 }, (_, index) => `fixture-group-${index + 1}`);
    const sortedFixtureGroupIds = [...fixtureGroupIds].sort();
    const tx = createCapacityAttachTx(gatewayId, floorId, fixtureGroupIds);
    const service = new MeshControlGroupService();

    await expect(service.attachProvisionedNode(tx as never, {
      meshNodeId: "node-1",
      gatewayId,
      floorId,
      fixtureGroupIds: [...fixtureGroupIds, fixtureGroupIds[0]]
    })).resolves.toBeUndefined();

    expect(tx.fixtureGroup.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: sortedFixtureGroupIds } })
    }));
    expect(tx.meshControlGroupMember.createMany).toHaveBeenCalledTimes(16);
  });

  it("rejects 16 unique fixture groups before acquiring locks or writing memberships", async () => {
    const tx: any = {
      $queryRaw: jest.fn(),
      meshNode: { findFirst: jest.fn() },
      meshControlGroupMember: { createMany: jest.fn() }
    };
    const service = new MeshControlGroupService();

    await expect(service.attachProvisionedNode(tx, {
      meshNodeId: "node-1",
      gatewayId,
      floorId,
      fixtureGroupIds: Array.from({ length: 16 }, (_, index) => `fixture-group-${index + 1}`)
    })).rejects.toThrow("a node can belong to at most 15 fixture groups");

    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.meshNode.findFirst).not.toHaveBeenCalled();
    expect(tx.meshControlGroupMember.createMany).not.toHaveBeenCalled();
  });

  it("rejects attaching a node when the floor or fixture groups are outside the gateway site", async () => {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{
        id: gatewayId,
        siteId: "site-1",
        nextMeshGroupAddress: 0xc020
      }]),
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

  it("increments every gateway group version exactly once for a new full resync", async () => {
    const tx: any = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ id: gatewayId }])
        .mockResolvedValueOnce([{ eventId: resyncInput.eventId }])
        .mockResolvedValueOnce([
          { id: "group-configuring", configurationVersion: 2 },
          { id: "group-failed", configurationVersion: 5 },
          { id: "group-ready", configurationVersion: 7 }
        ]),
      meshControlGroup: {
        updateMany: jest.fn().mockResolvedValue({ count: 3 })
      },
      meshControlGroupMember: {
        updateMany: jest.fn().mockResolvedValue({ count: 6 })
      }
    };
    const service = new MeshControlGroupService();

    await expect(service.resetGatewayGroupsForResync(tx, resyncInput)).resolves.toEqual({
      groupCount: 3,
      memberCount: 6
    });

    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    const gatewaySql = renderSqlCall(tx.$queryRaw.mock.calls[0]);
    const groupsSql = renderSqlCall(tx.$queryRaw.mock.calls[2]);
    expect(gatewaySql).toContain('FROM "Gateway"');
    expect(gatewaySql).toContain('"siteId" =');
    expect(gatewaySql).toContain("FOR UPDATE");
    expect(groupsSql).toContain('FROM "MeshControlGroup"');
    expect(groupsSql).toContain('ORDER BY "id"');
    expect(groupsSql).toContain("FOR UPDATE");
    expect(groupsSql).not.toContain('"status" =');
    expect(tx.meshControlGroup.updateMany).toHaveBeenCalledWith({
      where: {
        gatewayId,
        id: { in: ["group-configuring", "group-failed", "group-ready"] }
      },
      data: {
        status: "configuring",
        configurationVersion: { increment: 1 },
        operationPlanVersion: 0,
        fullReconciliationRequired: true,
        lastError: null
      }
    });
    expect(tx.meshControlGroupMember.updateMany).toHaveBeenCalledWith({
      where: {
        gatewayId,
        groupId: { in: ["group-configuring", "group-failed", "group-ready"] }
      },
      data: {
        subscriptionStatus: "pending",
        statusVersion: 0,
        operationId: null,
        operation: null,
        lastError: null
      }
    });
  });

  it.each(["first_run", "state_missing", "state_corrupt"] as const)(
    "marks every non-retired group for full-state reconciliation after %s",
    async (reason) => {
      const tx: any = {
        $queryRaw: jest.fn()
          .mockResolvedValueOnce([{ id: gatewayId }])
          .mockResolvedValueOnce([{ eventId: resyncInput.eventId }])
          .mockResolvedValueOnce([{ id: "group-ready", configurationVersion: 7, status: "ready" }]),
        meshControlGroup: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        meshControlGroupMember: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
      };
      const service = new MeshControlGroupService();

      await service.resetGatewayGroupsForResync(tx, { ...resyncInput, reason });

      expect(tx.meshControlGroup.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ fullReconciliationRequired: true })
      }));
    }
  );

  it("does not clear an unfinished full-state reconciliation during a normal startup resync", async () => {
    const tx: any = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ id: gatewayId }])
        .mockResolvedValueOnce([{ eventId: resyncInput.eventId }])
        .mockResolvedValueOnce([{ id: "group-ready", configurationVersion: 7, status: "ready" }]),
      meshControlGroup: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      meshControlGroupMember: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    const service = new MeshControlGroupService();

    await service.resetGatewayGroupsForResync(tx, { ...resyncInput, reason: "startup" });

    expect(tx.meshControlGroup.updateMany.mock.calls[0][0].data).not.toHaveProperty("fullReconciliationRequired");
  });

  it("preserves retiring groups and excludes retired groups during reconnect resync", async () => {
    const tx: any = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ id: gatewayId }])
        .mockResolvedValueOnce([{ eventId: resyncInput.eventId }])
        .mockResolvedValueOnce([
          { id: "group-configuring", configurationVersion: 2, status: "configuring" },
          { id: "group-ready", configurationVersion: 3, status: "ready" },
          { id: "group-failed", configurationVersion: 4, status: "failed" },
          { id: "group-retiring", configurationVersion: 5, status: "retiring" }
        ]),
      meshControlGroup: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      meshControlGroupMember: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    const service = new MeshControlGroupService();

    await service.resetGatewayGroupsForResync(tx, resyncInput);

    expect(renderSqlCall(tx.$queryRaw.mock.calls[2])).toContain('"status" <> \'retired\'');
    expect(tx.meshControlGroup.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        gatewayId,
        id: { in: ["group-configuring", "group-ready", "group-failed"] }
      },
      data: {
        status: "configuring",
        configurationVersion: { increment: 1 },
        operationPlanVersion: 0,
        fullReconciliationRequired: true,
        lastError: null
      }
    });
    expect(tx.meshControlGroup.updateMany).toHaveBeenNthCalledWith(2, {
      where: { gatewayId, id: { in: ["group-retiring"] } },
      data: {
        status: "retiring",
        configurationVersion: { increment: 1 },
        operationPlanVersion: 0,
        fullReconciliationRequired: true,
        lastError: null
      }
    });
    expect(tx.meshControlGroupMember.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        gatewayId,
        groupId: { in: ["group-configuring", "group-ready", "group-failed", "group-retiring"] }
      }
    }));
  });

  it("persists delete-old and add-new operations for one replaced node before publishing", async () => {
    const nodeId = "00000000-0000-4000-8000-000000000021";
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{
        id: "group-1",
        gatewayId,
        groupAddress: "0xc000",
        configurationVersion: 4,
        operationPlanVersion: 3,
        status: "configuring",
        siteId
      }]),
      meshControlGroupMember: {
        findMany: jest.fn().mockResolvedValue([{
          meshNodeId: nodeId,
          meshNode: { meshAddress: "0x0101" }
        }])
      },
      meshControlGroupAppliedMember: {
        findMany: jest.fn().mockResolvedValue([{
          meshNodeId: nodeId,
          meshAddress: "0x0100"
        }])
      },
      meshControlGroupExpectedOperation: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
        findMany: jest.fn().mockImplementation(async () => {
          const operations = tx.meshControlGroupExpectedOperation.createMany.mock.calls[0][0].data;
          return operations.map((operation: object) => ({ ...operation, status: "pending", lastError: null }));
        })
      },
      meshControlGroup: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    };
    const service = new MeshControlGroupService();

    const payload = await service.prepareSubscriptionSync(tx, {
      groupId: "group-1",
      gatewayId,
      configurationVersion: 4,
      requestedAt: "2026-08-26T10:00:00.000Z"
    });

    const operations = tx.meshControlGroupExpectedOperation.createMany.mock.calls[0][0].data;
    expect(operations).toEqual([
      expect.objectContaining({ action: "delete", meshNodeId: nodeId, meshAddress: "0x0100", configurationVersion: 4 }),
      expect.objectContaining({ action: "add", meshNodeId: nodeId, meshAddress: "0x0101", configurationVersion: 4 })
    ]);
    expect(operations[0].operationId).not.toBe(operations[1].operationId);
    expect(payload).toMatchObject({
      version: 4,
      desiredMembers: [{ meshNodeId: nodeId, meshAddress: "0x0101" }],
      expectedOperations: [
        expect.objectContaining({ operationId: operations[0].operationId, action: "delete", meshAddress: "0x0100" }),
        expect.objectContaining({ operationId: operations[1].operationId, action: "add", meshAddress: "0x0101" })
      ]
    });
  });

  it("creates a full-state add plan when gateway state is lost but cloud applied state already matches", async () => {
    const nodeId = "00000000-0000-4000-8000-000000000021";
    const createMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{
        id: "group-1",
        gatewayId,
        groupAddress: "0xc000",
        configurationVersion: 8,
        operationPlanVersion: 0,
        fullReconciliationRequired: true,
        status: "configuring",
        siteId
      }]),
      meshControlGroupMember: {
        findMany: jest.fn().mockResolvedValue([{
          meshNodeId: nodeId,
          meshNode: { meshAddress: "0x0100" }
        }])
      },
      meshControlGroupAppliedMember: {
        findMany: jest.fn().mockResolvedValue([{ meshNodeId: nodeId, meshAddress: "0x0100" }])
      },
      meshControlGroupExpectedOperation: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany,
        findMany: jest.fn().mockImplementation(async () => {
          const call = createMany.mock.calls[0];
          return call ? call[0].data : [];
        })
      },
      meshControlGroup: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    };
    const service = new MeshControlGroupService();

    const payload = await service.prepareSubscriptionSync(tx, {
      groupId: "group-1",
      gatewayId,
      configurationVersion: 8,
      requestedAt: "2026-08-26T10:00:00.000Z"
    });

    expect(createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        action: "add",
        meshNodeId: nodeId,
        meshAddress: "0x0100",
        configurationVersion: 8
      })]
    });
    expect(payload).toMatchObject({
      reconciliationMode: "full_state",
      desiredMembers: [{ meshNodeId: nodeId, meshAddress: "0x0100" }],
      expectedOperations: [expect.objectContaining({ action: "add", meshNodeId: nodeId })]
    });
  });

  it("does not reset ready progress when the same resync event is delivered again", async () => {
    const tx: any = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ id: gatewayId }])
        .mockResolvedValueOnce([{ eventId: resyncInput.eventId }])
        .mockResolvedValueOnce([{ id: "group-ready", configurationVersion: 7 }])
        .mockResolvedValueOnce([{ id: gatewayId }])
        .mockResolvedValueOnce([]),
      meshControlGroup: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      meshControlGroupMember: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 })
      }
    };
    const service = new MeshControlGroupService();

    await service.resetGatewayGroupsForResync(tx, resyncInput);
    expect(tx.meshControlGroup.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ configurationVersion: { increment: 1 } })
    }));
    // The worker and subscription result handler can make this version ready
    // before MQTT redelivers the original QoS 1 event.
    tx.meshControlGroup.updateMany.mockClear();
    tx.meshControlGroupMember.updateMany.mockClear();
    await service.resetGatewayGroupsForResync(tx, resyncInput);

    expect(tx.meshControlGroup.updateMany).not.toHaveBeenCalled();
    expect(tx.meshControlGroupMember.updateMany).not.toHaveBeenCalled();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(5);
    const eventInsertSql = renderSqlCall(tx.$queryRaw.mock.calls[1]);
    expect(eventInsertSql).toContain('INSERT INTO "ProcessedGatewayEvent"');
    expect(eventInsertSql).toContain("ON CONFLICT DO NOTHING");
    expect(eventInsertSql).toContain("RETURNING");
  });

  it("fails closed before writes when a group configuration version is exhausted", async () => {
    const tx: any = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ id: gatewayId }])
        .mockResolvedValueOnce([{ eventId: resyncInput.eventId }])
        .mockResolvedValueOnce([{ id: "group-max", configurationVersion: 2_147_483_647 }]),
      meshControlGroup: {
        updateMany: jest.fn()
      },
      meshControlGroupMember: {
        updateMany: jest.fn()
      }
    };
    const service = new MeshControlGroupService();

    await expect(service.resetGatewayGroupsForResync(tx, resyncInput)).rejects.toThrow(
      "mesh control group configuration version exhausted"
    );

    expect(tx.meshControlGroup.updateMany).not.toHaveBeenCalled();
    expect(tx.meshControlGroupMember.updateMany).not.toHaveBeenCalled();
  });

  it("propagates member reset failures so the caller transaction can roll back version increments", async () => {
    const resetError = new Error("member reset failed");
    const tx: any = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ id: gatewayId }])
        .mockResolvedValueOnce([{ eventId: resyncInput.eventId }])
        .mockResolvedValueOnce([{ id: "group-ready", configurationVersion: 7 }]),
      meshControlGroup: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      meshControlGroupMember: {
        updateMany: jest.fn().mockRejectedValue(resetError)
      }
    };
    const service = new MeshControlGroupService();

    await expect(service.resetGatewayGroupsForResync(tx, resyncInput)).rejects.toBe(resetError);

    expect(tx.meshControlGroup.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ configurationVersion: { increment: 1 } })
    }));
  });

  it("ignores a resync request outside the site and gateway boundary", async () => {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      meshControlGroup: { updateMany: jest.fn() },
      meshControlGroupMember: { updateMany: jest.fn() }
    };
    const service = new MeshControlGroupService();

    await expect(service.resetGatewayGroupsForResync(tx, resyncInput)).resolves.toEqual({
      groupCount: 0,
      memberCount: 0
    });

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.meshControlGroup.updateMany).not.toHaveBeenCalled();
    expect(tx.meshControlGroupMember.updateMany).not.toHaveBeenCalled();
  });
});

function renderSqlCall(call: readonly unknown[]) {
  const query = call[0] as { strings?: readonly string[] } | readonly string[];
  const strings = Array.isArray(query) ? query : (query as { strings?: readonly string[] }).strings;
  return strings ? strings.join("?") : "";
}

function createCapacityAttachTx(gatewayId: string, floorId: string, fixtureGroupIds: string[]) {
  const lockedGroup = {
    id: "locked-group",
    gatewayId,
    status: "configuring",
    configurationVersion: 1
  };
  const tx: any = {
    $queryRaw: jest.fn()
      .mockResolvedValueOnce([{ id: gatewayId, siteId: "site-1", nextMeshGroupAddress: 0xc000 }])
      .mockResolvedValue([lockedGroup]),
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
      findMany: jest.fn().mockResolvedValue(fixtureGroupIds.map((id) => ({ id, siteId: "site-1" }))),
      findUnique: jest.fn().mockResolvedValue({ siteId: "site-1" })
    },
    meshControlGroup: {
      findFirst: jest.fn(({ where }: { where: Record<string, string> }) => Promise.resolve({
        id: where.targetType === "floor" ? "floor-group" : `mesh-${where.targetId}`,
        gatewayId,
        targetType: where.targetType,
        targetId: where.targetId,
        groupAddress: "0xc000",
        status: "configuring",
        configurationVersion: 1
      }))
    },
    meshControlGroupMember: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn()
    }
  };
  return tx;
}
