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
        update: jest.fn()
      },
      floor: {
        findUnique: jest.fn()
      }
    };
    const service = new MeshControlGroupService();

    await expect(service.ensureFloorGroup(tx, gatewayId, floorId)).resolves.toBe(existingGroup);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.gateway.update).not.toHaveBeenCalled();
    expect(tx.meshControlGroup.create).not.toHaveBeenCalled();
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
});
