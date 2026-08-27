import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { FixtureGroupsService } from "./fixture-groups.service";

const ids = {
  site: "00000000-0000-4000-8000-000000000001",
  otherSite: "00000000-0000-4000-8000-000000000002",
  floor: "00000000-0000-4000-8000-000000000003",
  otherFloor: "00000000-0000-4000-8000-000000000004",
  gateway: "00000000-0000-4000-8000-000000000005",
  otherGateway: "00000000-0000-4000-8000-000000000006",
  group: "00000000-0000-4000-8000-000000000007",
  meshGroup: "00000000-0000-4000-8000-000000000008",
  meshGroupNew: "00000000-0000-4000-8000-000000000014",
  fixtureA: "00000000-0000-4000-8000-000000000009",
  fixtureB: "00000000-0000-4000-8000-000000000010",
  fixtureC: "00000000-0000-4000-8000-000000000011",
  nodeA: "00000000-0000-4000-8000-000000000012",
  nodeB: "00000000-0000-4000-8000-000000000013"
};

const admin: AuthenticatedUser = {
  id: "admin-1",
  organizationId: "customer-1",
  organizationType: "customer",
  loginId: "fixture_user",
  name: "Admin",
  role: "admin",
  status: "active"
};

const operator: AuthenticatedUser = {
  ...admin,
  id: "operator-1",
  organizationId: "provider-1",
  organizationType: "service_provider",
  loginId: "fixture_user",
  role: "operator"
};

const viewer: AuthenticatedUser = { ...admin, id: "viewer-1", role: "viewer" };

const input = {
  name: "B2 entrance",
  floorId: ids.floor,
  gatewayId: ids.gateway,
  fixtureIds: [ids.fixtureB, ids.fixtureA]
};

describe("FixtureGroupsService", () => {
  it("keeps viewer access read-only while operator and admin can manage an accessible site", async () => {
    const { service, siteAccess } = createHarness();
    siteAccess.assert.mockRejectedValueOnce(new ForbiddenException("site capability denied"));

    await expect(service.create(viewer, ids.site, input)).rejects.toThrow("site capability denied");
    expect(siteAccess.assert).toHaveBeenCalledWith(viewer, ids.site, "manage");

    await service.list(operator, ids.site);
    await service.list(admin, ids.site);
    expect(siteAccess.assert).toHaveBeenCalledWith(operator, ids.site, "read");
    expect(siteAccess.assert).toHaveBeenCalledWith(admin, ids.site, "read");
  });

  it("returns the same site-not-found boundary for a group outside an accessible site", async () => {
    const { service, prisma } = createHarness({ existingGroup: null });

    await expect(service.update(admin, ids.site, ids.group, input)).rejects.toEqual(new NotFoundException("fixture group not found"));
    expect(prisma.meshControlGroup.updateMany).not.toHaveBeenCalled();
  });

  it("checks site access before parsing malformed create input", async () => {
    const { service, prisma, siteAccess } = createHarness();
    siteAccess.assert.mockRejectedValue(new NotFoundException("site not found"));

    await expect(service.create(admin, ids.otherSite, { fixtureIds: [] })).rejects.toEqual(
      new NotFoundException("site not found")
    );
    expect(siteAccess.assert).toHaveBeenCalledWith(admin, ids.otherSite, "manage");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("creates a whole desired membership set at version one after stable floor, gateway, and fixture locks", async () => {
    const { service, prisma, meshGroups } = createHarness({ fixtures: fixtureRows([ids.fixtureA, ids.fixtureB]) });

    await expect(service.create(admin, ids.site, input)).resolves.toMatchObject({
      id: ids.group,
      lifecycleStatus: "active",
      fixtureCount: 2,
      meshControlGroup: { status: "configuring", version: 1, error: null }
    });

    expect(lockStatements(prisma).slice(0, 3)).toEqual([
      expect.stringContaining('FROM "Floor"'),
      expect.stringContaining('FROM "Gateway"'),
      expect.stringContaining('FROM "Fixture"')
    ]);
    expect(prisma.groupFixture.createMany).toHaveBeenCalledWith({
      data: [{ groupId: ids.group, fixtureId: ids.fixtureA }, { groupId: ids.group, fixtureId: ids.fixtureB }]
    });
    expect(meshGroups.ensureFixtureGroup).toHaveBeenCalledWith(prisma, ids.gateway, ids.group);
    expect(prisma.meshControlGroupMember.upsert).toHaveBeenCalledTimes(2);
  });

  it("rejects a fixture selection that crosses the requested floor or gateway boundary", async () => {
    const { service } = createHarness({
      fixtures: [
        ...fixtureRows([ids.fixtureA]),
        { id: ids.fixtureB, floorId: ids.otherFloor, meshNodeId: ids.nodeB, meshNode: { gatewayId: ids.gateway } }
      ]
    });

    await expect(service.create(admin, ids.site, input)).rejects.toThrow("fixtures must belong to the selected floor and gateway");
  });

  it("rejects a fixture without a controllable mesh node before mutating desired membership", async () => {
    const { service, prisma } = createHarness({
      fixtures: [{ id: ids.fixtureA, floorId: ids.floor, meshNodeId: null, meshNode: null }, ...fixtureRows([ids.fixtureB])]
    });

    await expect(service.create(admin, ids.site, input)).rejects.toThrow("fixtures must be controllable");
    expect(prisma.fixtureGroup.create).not.toHaveBeenCalled();
  });

  it("enforces the fifteen active-or-retiring group membership limit before changing a group", async () => {
    const { service, prisma } = createHarness({
      fixtures: fixtureRows([ids.fixtureA, ids.fixtureB]),
      activeMemberships: Array.from({ length: 15 }, (_, index) => ({ fixtureId: ids.fixtureA, groupId: `group-${index}` }))
    });

    await expect(service.create(admin, ids.site, input)).rejects.toThrow(
      "a fixture cannot belong to more than 15 active or retiring fixture groups"
    );
    expect(prisma.fixtureGroup.create).not.toHaveBeenCalled();
  });

  it("replaces the entire desired set and increments the existing mesh group version", async () => {
    const { service, prisma, meshGroups } = createHarness({
      fixtures: fixtureRows([ids.fixtureA, ids.fixtureC]),
      existingGroup: activeGroup(),
      meshGroup: { id: ids.meshGroup, gatewayId: ids.gateway, configurationVersion: 4, status: "ready" }
    });
    const replacement = { ...input, fixtureIds: [ids.fixtureA, ids.fixtureC] };

    await expect(service.update(admin, ids.site, ids.group, replacement)).resolves.toMatchObject({
      id: ids.group,
      fixtureCount: 2,
      meshControlGroup: { status: "configuring", version: 5 }
    });

    expect(lockStatements(prisma)[0]).toContain('FROM "FixtureGroup"');
    expect(prisma.groupFixture.deleteMany).toHaveBeenCalledWith({ where: { groupId: ids.group } });
    expect(prisma.meshControlGroup.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: ids.meshGroup },
      data: expect.objectContaining({ configurationVersion: { increment: 1 }, status: "configuring" })
    }));
    expect(meshGroups.ensureFixtureGroup).not.toHaveBeenCalled();
    expect(prisma.meshControlGroupMember.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { groupId: ids.meshGroup, gatewayId: ids.gateway },
      data: expect.objectContaining({ desired: false, subscriptionStatus: "pending" })
    }));
  });

  it.each(["update", "remove", "resync"] as const)(
    "recovers a valid legacy active group without a mesh control group during %s",
    async (operation) => {
      const { service, prisma, meshGroups } = createHarness({
        fixtures: fixtureRows([ids.fixtureA, ids.fixtureB]),
        existingGroup: activeGroup(),
        meshGroup: null
      });

      if (operation === "update") await service.update(admin, ids.site, ids.group, input);
      if (operation === "remove") await service.remove(admin, ids.site, ids.group);
      if (operation === "resync") await service.resync(admin, ids.site, ids.group);

      expect(meshGroups.ensureFixtureGroup).toHaveBeenCalledWith(expect.anything(), ids.gateway, ids.group);
      if (operation === "resync") {
        expect(prisma.meshControlGroupMember.upsert).toHaveBeenCalledTimes(2);
      }
    }
  );

  it("moves a group to a new gateway while retiring the old gateway subscription set", async () => {
    const movedInput = { ...input, gatewayId: ids.otherGateway };
    const { service, prisma, meshGroups } = createHarness({
      fixtures: fixtureRows([ids.fixtureA, ids.fixtureB], ids.otherGateway),
      existingGroup: activeGroup(),
      meshGroup: { id: ids.meshGroup, gatewayId: ids.gateway, configurationVersion: 4, status: "ready" }
    });

    await expect(service.update(admin, ids.site, ids.group, movedInput)).resolves.toMatchObject({
      gatewayId: ids.otherGateway,
      lifecycleStatus: "active",
      meshControlGroup: { status: "configuring" }
    });

    expect(prisma.meshControlGroup.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: ids.meshGroup },
      data: expect.objectContaining({ status: "retiring", configurationVersion: { increment: 1 } })
    }));
    expect(meshGroups.ensureFixtureGroup).toHaveBeenCalledWith(prisma, ids.otherGateway, ids.group);
    const gatewayLockIds = prisma.$queryRaw.mock.calls
      .map(([query]: [{ values?: unknown[] }]) => query)
      .filter((query: { strings?: string[] }) => query.strings?.join("?").includes('FROM "Gateway"'))
      .map((query: { values?: unknown[] }) => query.values?.[0]);
    expect(gatewayLockIds).toEqual([ids.gateway, ids.otherGateway]);
    expect(prisma.meshControlGroupMember.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { groupId: ids.meshGroup, gatewayId: ids.gateway },
      data: expect.objectContaining({ desired: false })
    }));
  });

  it("moves deletion to retiring with an empty desired set without deleting historical dispatch references", async () => {
    const { service, prisma } = createHarness({
      existingGroup: activeGroup(),
      meshGroup: { id: ids.meshGroup, gatewayId: ids.gateway, configurationVersion: 4, status: "ready" }
    });

    await expect(service.remove(admin, ids.site, ids.group)).resolves.toEqual({
      id: ids.group,
      lifecycleStatus: "retiring",
      meshControlGroup: { status: "retiring", version: 5, error: null }
    });

    expect(prisma.fixtureGroup.delete).not.toHaveBeenCalled();
    expect(prisma.meshControlGroup.delete).not.toHaveBeenCalled();
    expect(prisma.fixtureGroup.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: ids.group },
      data: { lifecycleStatus: "retiring" }
    }));
    expect(prisma.meshControlGroupMember.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ desired: false, subscriptionStatus: "pending" })
    }));
  });

  it("resyncs the unchanged desired set after a failure by incrementing its version", async () => {
    const { service, prisma } = createHarness({
      existingGroup: activeGroup(),
      meshGroup: { id: ids.meshGroup, gatewayId: ids.gateway, configurationVersion: 8, status: "failed" }
    });

    await expect(service.resync(operator, ids.site, ids.group)).resolves.toMatchObject({
      id: ids.group,
      meshControlGroup: { status: "configuring", version: 9, error: null }
    });
    expect(prisma.meshControlGroupMember.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { groupId: ids.meshGroup, gatewayId: ids.gateway },
      data: expect.objectContaining({ subscriptionStatus: "pending", statusVersion: 0, lastError: null })
    }));
  });

  it("rejects invalid lifecycle groups as read-only legacy data", async () => {
    const { service } = createHarness({ existingGroup: { ...activeGroup(), lifecycleStatus: "invalid" } });

    await expect(service.resync(admin, ids.site, ids.group)).rejects.toThrow("fixture group is read-only");
    await expect(service.remove(admin, ids.site, ids.group)).rejects.toThrow("fixture group is read-only");
  });

  it("rejects malformed desired membership input without opening a transaction", async () => {
    const { service, prisma } = createHarness();
    await expect(service.create(admin, ids.site, { ...input, fixtureIds: [] })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

function createHarness(options: {
  fixtures?: Array<{ id: string; floorId: string; meshNodeId: string | null; meshNode: { gatewayId: string } | null }>;
  activeMemberships?: Array<{ fixtureId: string; groupId: string }>;
  existingGroup?: ReturnType<typeof activeGroup> | null;
  meshGroup?: { id: string; gatewayId: string; configurationVersion: number; status: string } | null;
} = {}) {
  const prisma: any = {
    $queryRaw: jest.fn(async (query: TemplateStringsArray | { strings?: string[] }) => {
      const sql = renderSql(query);
      if (sql.includes('FROM "FixtureGroup"')) return options.existingGroup === null ? [] : [options.existingGroup ?? activeGroup()];
      if (sql.includes('FROM "Floor"')) return [{ id: ids.floor, siteId: ids.site }];
      if (sql.includes('FROM "Gateway"')) return [{ id: ids.gateway, siteId: ids.site }];
      if (sql.includes('FROM "Fixture"')) return options.fixtures ?? fixtureRows([ids.fixtureA, ids.fixtureB]);
      if (sql.includes('FROM "GroupFixture"')) {
        return (options.fixtures ?? fixtureRows([ids.fixtureA, ids.fixtureB])).map((fixture) => ({
          meshNodeId: fixture.meshNodeId,
          gatewayId: fixture.meshNode?.gatewayId
        }));
      }
      if (sql.includes('FROM "MeshControlGroup"')) return options.meshGroup === null ? [] : [options.meshGroup ?? { id: ids.meshGroup, gatewayId: ids.gateway, configurationVersion: 1, status: "configuring" }];
      return [];
    }),
    $transaction: jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma)),
    fixtureGroup: {
      create: jest.fn().mockResolvedValue(activeGroup()),
      update: jest.fn().mockResolvedValue(activeGroup()),
      delete: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([])
    },
    meshControlGroup: {
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn()
    },
    meshControlGroupMember: {
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 2 })
    },
    groupFixture: {
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
      findMany: jest.fn().mockResolvedValue(options.activeMemberships ?? []),
      count: jest.fn().mockResolvedValue(2)
    }
  };
  const siteAccess = { assert: jest.fn().mockResolvedValue({ id: ids.site }) };
  const meshGroups = {
    ensureFixtureGroup: jest.fn(async (_tx: unknown, gatewayId: string) => ({
      id: gatewayId === ids.otherGateway ? ids.meshGroupNew : ids.meshGroup,
      gatewayId,
      configurationVersion: 1,
      status: "configuring"
    }))
  };
  const service = new FixtureGroupsService(prisma, siteAccess as never, meshGroups as never);
  return { service, prisma, siteAccess, meshGroups };
}

function fixtureRows(fixtureIds: string[], gatewayId = ids.gateway) {
  return fixtureIds.map((id, index) => ({
    id,
    floorId: ids.floor,
    meshNodeId: index === 0 ? ids.nodeA : ids.nodeB,
    meshNode: { gatewayId }
  }));
}

function activeGroup() {
  return {
    id: ids.group,
    siteId: ids.site,
    floorId: ids.floor,
    gatewayId: ids.gateway,
    name: "B2 entrance",
    lifecycleStatus: "active"
  };
}

function lockStatements(prisma: { $queryRaw: jest.Mock }) {
  return prisma.$queryRaw.mock.calls
    .map(([query]: [TemplateStringsArray | { strings?: string[] }]) => renderSql(query))
    .filter((sql: string) => sql.includes("FOR UPDATE"));
}

function renderSql(query: TemplateStringsArray | { strings?: string[] }) {
  if (Array.isArray(query)) return query.join("?");
  return (query as { strings?: string[] }).strings?.join("?") ?? "";
}
