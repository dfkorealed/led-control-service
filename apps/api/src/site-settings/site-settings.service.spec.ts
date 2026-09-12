import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";

const ids = {
  site: "00000000-0000-4000-8000-000000000001",
  floor: "00000000-0000-4000-8000-000000000002"
};
const updatedAt = new Date("2026-09-12T03:00:00.000Z");

const admin: AuthenticatedUser = {
  id: "admin-1",
  organizationId: "customer-1",
  organizationType: "customer",
  loginId: "settings_admin",
  name: "Admin",
  role: "admin",
  mustChangePassword: false,
  status: "active"
};

describe("SiteSettingsService", () => {
  it("returns admin settings with every floor and active resource counts in operational order", async () => {
    const { service, prisma, siteAccess } = createHarness();
    prisma.site.findUnique.mockResolvedValue({
      id: ids.site,
      name: "Seoul Plant",
      address: "1 Light Road",
      timeZone: "Asia/Seoul",
      currency: "KRW",
      tariffKwhRate: "137.25",
      updatedAt,
      floors: [
        {
          id: "floor-active",
          name: "B1",
          level: -1,
          status: "active",
          displayOrder: 10,
          updatedAt,
          _count: { fixtures: 3, fixtureGroups: 1 }
        },
        {
          id: "floor-archived",
          name: "Old B2",
          level: -2,
          status: "archived",
          displayOrder: 20,
          updatedAt,
          _count: { fixtures: 0, fixtureGroups: 0 }
        }
      ]
    });

    await expect(service().getSettings(admin, ids.site)).resolves.toEqual({
      site: {
        id: ids.site,
        name: "Seoul Plant",
        address: "1 Light Road",
        timeZone: "Asia/Seoul",
        currency: "KRW",
        tariffKwhRate: 137.25,
        updatedAt: updatedAt.toISOString()
      },
      floors: [
        {
          id: "floor-active",
          name: "B1",
          level: -1,
          status: "active",
          displayOrder: 10,
          fixtureCount: 3,
          activeGroupCount: 1,
          updatedAt: updatedAt.toISOString()
        },
        {
          id: "floor-archived",
          name: "Old B2",
          level: -2,
          status: "archived",
          displayOrder: 20,
          fixtureCount: 0,
          activeGroupCount: 0,
          updatedAt: updatedAt.toISOString()
        }
      ]
    });

    expect(siteAccess.assert).toHaveBeenCalledWith(admin, ids.site, "manage");
    expect(prisma.site.findUnique).toHaveBeenCalledWith({
      where: { id: ids.site },
      select: expect.objectContaining({
        id: true,
        floors: expect.objectContaining({
          orderBy: [{ displayOrder: "asc" }, { level: "asc" }, { id: "asc" }],
          select: expect.objectContaining({
            _count: {
              select: {
                fixtures: true,
                fixtureGroups: { where: { lifecycleStatus: "active" } }
              }
            }
          })
        })
      })
    });
  });

  it("does not query settings when manage access hides another tenant", async () => {
    const { service, prisma, siteAccess } = createHarness();
    siteAccess.assert.mockRejectedValue(new NotFoundException("site not found"));

    await expect(service().getSettings(admin, "other-site")).rejects.toEqual(
      new NotFoundException("site not found")
    );
    expect(prisma.site.findUnique).not.toHaveBeenCalled();
  });

  it("updates only strict site settings after transaction-local manage reauthorization", async () => {
    const { service, prisma, siteAccess } = createHarness();

    await expect(service().updateSite(admin, ids.site, {
      expectedUpdatedAt: updatedAt.toISOString(),
      name: "Seoul Plant",
      address: "1 Light Road",
      timeZone: "Asia/Seoul",
      currency: "KRW",
      tariffKwhRate: 137.25
    })).resolves.toMatchObject({
      id: ids.site,
      name: "Seoul Plant",
      currency: "KRW",
      tariffKwhRate: 137.25
    });

    expect(siteAccess.assert).toHaveBeenCalledWith(admin, ids.site, "manage");
    expect(siteAccess.assertManageInTransaction).toHaveBeenCalledWith(prisma, admin, ids.site);
    expect(prisma.site.update).toHaveBeenCalledWith({
      where: { id: ids.site },
      data: {
        name: "Seoul Plant",
        address: "1 Light Road",
        timeZone: "Asia/Seoul",
        currency: "KRW",
        tariffKwhRate: expect.objectContaining({}),
        updatedAt: expect.any(Date)
      },
      select: expect.any(Object)
    });
  });

  it("locks the site row before checking its version and updating settings", async () => {
    const { service, prisma, siteAccess } = createHarness();

    await service().updateSite(admin, ids.site, {
      expectedUpdatedAt: updatedAt.toISOString(),
      name: "Locked Plant"
    });

    expect(siteAccess.assertManageInTransaction.mock.invocationCallOrder[0])
      .toBeLessThan(prisma.$queryRaw.mock.invocationCallOrder[0]);
    expect(renderSql(prisma.$queryRaw.mock.calls[0][0]).replace(/\s+/g, " ").trim()).toContain(
      'SELECT "id", "updatedAt" FROM "Site" WHERE "id" = ? FOR UPDATE'
    );
    expect(prisma.$queryRaw.mock.invocationCallOrder[0])
      .toBeLessThan(prisma.site.update.mock.invocationCallOrder[0]);
    expect(prisma.site.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a stale site settings mutation after transaction-local row authorization", async () => {
    const { service, prisma } = createHarness();

    await expect(service().updateSite(admin, ids.site, {
      expectedUpdatedAt: "2026-09-12T02:59:59.000Z",
      name: "Stale"
    })).rejects.toEqual(new ConflictException({ code: "settings_version_conflict" }));
    expect(prisma.site.update).not.toHaveBeenCalled();
  });

  it.each([
    [{ expectedUpdatedAt: updatedAt.toISOString(), name: "Plant", adminUserId: "attacker" }, "unknown field"],
    [{ expectedUpdatedAt: updatedAt.toISOString(), currency: "krw" }, "invalid currency"],
    [{ expectedUpdatedAt: updatedAt.toISOString(), tariffKwhRate: -1 }, "negative tariff"],
    [{ expectedUpdatedAt: updatedAt.toISOString() }, "empty patch"],
    [{ name: "Plant" }, "missing expectedUpdatedAt"]
  ])("rejects strict site settings input: %s (%s)", async (body, _label) => {
    const { service, prisma } = createHarness();

    await expect(service().updateSite(admin, ids.site, body)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("checks site capability before parsing a malformed settings request", async () => {
    const { service, prisma, siteAccess } = createHarness();
    siteAccess.assert.mockRejectedValue(new NotFoundException("site not found"));

    await expect(service().updateSite(admin, ids.site, { adminUserId: "attacker" })).rejects.toEqual(
      new NotFoundException("site not found")
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("does not allow a viewer to manage site settings", async () => {
    const { service, prisma, siteAccess } = createHarness();
    const viewer = { ...admin, id: "viewer-1", role: "viewer" as const };
    siteAccess.assert.mockRejectedValue(new ForbiddenException("site capability denied"));

    await expect(service().updateSite(viewer, ids.site, { name: "Denied" })).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("creates a floor with an active lifecycle and explicit display order", async () => {
    const { service, prisma, siteAccess } = createHarness();

    await expect(service().createFloor(admin, ids.site, {
      name: "B2",
      level: -2,
      displayOrder: 10
    })).resolves.toMatchObject({
      id: ids.floor,
      siteId: ids.site,
      name: "B2",
      level: -2,
      displayOrder: 10,
      status: "active"
    });

    expect(siteAccess.assertManageInTransaction).toHaveBeenCalledWith(prisma, admin, ids.site);
    expect(prisma.floor.create).toHaveBeenCalledWith({
      data: { siteId: ids.site, name: "B2", level: -2, displayOrder: 10, status: "active" },
      select: expect.any(Object)
    });
  });

  it("updates a floor only after the site row and tenant-scoped floor row are locked", async () => {
    const { service, prisma, siteAccess } = createHarness();

    await service().updateFloor(admin, ids.site, ids.floor, {
      expectedUpdatedAt: updatedAt.toISOString(),
      name: "Basement 2",
      displayOrder: 20
    });

    expect(siteAccess.assertManageInTransaction).toHaveBeenCalledWith(prisma, admin, ids.site);
    expect(siteAccess.assertManageInTransaction.mock.invocationCallOrder[0])
      .toBeLessThan(prisma.$queryRaw.mock.invocationCallOrder[0]);
    expect(renderSql(prisma.$queryRaw.mock.calls[0][0])).toContain('WHERE "id" = ? AND "siteId" = ?');
    expect(prisma.floor.update).toHaveBeenCalledWith({
      where: { id: ids.floor },
      data: { name: "Basement 2", displayOrder: 20, updatedAt: expect.any(Date) },
      select: expect.any(Object)
    });
  });

  it("updates every fixture floorName dimension in the floor rename transaction", async () => {
    const { service, prisma, energyDimensions } = createHarness();
    prisma.fixture.findMany.mockResolvedValue([{
      id: "fixture-1",
      siteId: ids.site,
      floorId: ids.floor,
      name: "L1",
      ratedWatt: "40.00",
      energyTrackingStartedAt: new Date("2026-01-01T00:00:00.000Z")
    }]);

    await service().updateFloor(admin, ids.site, ids.floor, {
      name: "Basement 2",
      expectedUpdatedAt: updatedAt.toISOString()
    });

    expect(energyDimensions.ensureFixtureDimensions).toHaveBeenCalledWith(
      prisma,
      [expect.objectContaining({ fixtureId: "fixture-1", floorName: "Basement 2" })],
      expect.any(Date)
    );
    const effectiveAt = energyDimensions.ensureFixtureDimensions.mock.calls[0][2];
    expect(prisma.floor.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ updatedAt: effectiveAt })
    }));
    expect(energyDimensions.ensureFixtureDimensions.mock.invocationCallOrder[0])
      .toBeLessThan(prisma.floor.update.mock.invocationCallOrder[0]);
  });

  it("does not rewrite fixture dimensions when the floor name is unchanged", async () => {
    const { service, prisma, energyDimensions } = createHarness();

    await service().updateFloor(admin, ids.site, ids.floor, {
      name: "B2",
      expectedUpdatedAt: updatedAt.toISOString()
    });

    expect(prisma.fixture.findMany).not.toHaveBeenCalled();
    expect(energyDimensions.ensureFixtureDimensions).not.toHaveBeenCalled();
  });

  it("rejects a stale floor mutation after locking the tenant-scoped floor row", async () => {
    const { service, prisma } = createHarness();

    await expect(service().updateFloor(admin, ids.site, ids.floor, {
      name: "Stale",
      expectedUpdatedAt: "2026-09-12T02:59:59.000Z"
    })).rejects.toEqual(new ConflictException({ code: "settings_version_conflict" }));
    expect(prisma.floor.update).not.toHaveBeenCalled();
  });

  it("returns an opaque floor 404 when the locked floor is outside the requested site", async () => {
    const { service, prisma } = createHarness({ lockedFloor: null });

    await expect(service().updateFloor(admin, ids.site, ids.floor, {
      expectedUpdatedAt: updatedAt.toISOString(), name: "Hidden"
    })).rejects.toEqual(
      new NotFoundException("floor not found")
    );
    expect(prisma.floor.update).not.toHaveBeenCalled();
  });

  it("restores an archived floor to active through the locked floor update", async () => {
    const { service, prisma, siteAccess } = createHarness({
      lockedFloor: { ...floorRow(), status: "archived" }
    });

    await expect(service().updateFloor(admin, ids.site, ids.floor, {
      expectedUpdatedAt: updatedAt.toISOString(), status: "active"
    })).resolves.toMatchObject({
      id: ids.floor,
      status: "active"
    });

    expect(siteAccess.assertManageInTransaction).toHaveBeenCalledWith(prisma, admin, ids.site);
    expect(prisma.floor.update).toHaveBeenCalledWith({
      where: { id: ids.floor },
      data: { status: "active", updatedAt: expect.any(Date) },
      select: expect.any(Object)
    });
  });

  it("rejects active-to-archived PATCH so callers cannot bypass archive safety checks", async () => {
    const { service, prisma } = createHarness();

    await expect(service().updateFloor(admin, ids.site, ids.floor, {
      expectedUpdatedAt: updatedAt.toISOString(), status: "archived"
    }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.floor.update).not.toHaveBeenCalled();
  });

  it("rejects status active when the locked floor is already active", async () => {
    const { service, prisma } = createHarness();

    await expect(service().updateFloor(admin, ids.site, ids.floor, {
      expectedUpdatedAt: updatedAt.toISOString(), status: "active"
    }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.floor.update).not.toHaveBeenCalled();
  });

  it.each([
    [1, 0, "fixture"],
    [0, 1, "active fixture group"]
  ])("blocks floor archive when it contains %s fixtures and %s active groups (%s)", async (
    fixtureCount,
    activeGroupCount
  ) => {
    const { service, prisma } = createHarness({ fixtureCount, activeGroupCount });

    await expect(service().archiveFloor(admin, ids.site, ids.floor, {
      expectedUpdatedAt: updatedAt.toISOString()
    })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.floor.update).not.toHaveBeenCalled();
  });

  it("archives an empty floor without hard deleting it", async () => {
    const { service, prisma, siteAccess } = createHarness();

    await expect(service().archiveFloor(admin, ids.site, ids.floor, {
      expectedUpdatedAt: updatedAt.toISOString()
    })).resolves.toMatchObject({
      id: ids.floor,
      status: "archived"
    });

    expect(siteAccess.assertManageInTransaction).toHaveBeenCalledWith(prisma, admin, ids.site);
    expect(prisma.floor.update).toHaveBeenCalledWith({
      where: { id: ids.floor },
      data: { status: "archived", updatedAt: expect.any(Date) },
      select: expect.any(Object)
    });
    expect(prisma.floor.delete).not.toHaveBeenCalled();
  });

  it("blocks floor archive while an active registration session exists", async () => {
    const { service, prisma } = createHarness({ activeSessionCount: 1 });

    await expect(service().archiveFloor(admin, ids.site, ids.floor, {
      expectedUpdatedAt: updatedAt.toISOString()
    })).rejects.toEqual(new ConflictException({ code: "floor_has_active_registration" }));
    expect(prisma.provisioningSession.count).toHaveBeenCalledWith({
      where: { siteId: ids.site, floorId: ids.floor, status: "active" }
    });
    expect(prisma.floor.update).not.toHaveBeenCalled();
  });

  it("rejects stale and malformed archive requests before floor mutation", async () => {
    const { service, prisma } = createHarness();

    await expect(service().archiveFloor(admin, ids.site, ids.floor, {
      expectedUpdatedAt: "2026-09-12T02:59:59.000Z"
    })).rejects.toEqual(new ConflictException({ code: "settings_version_conflict" }));
    await expect(service().archiveFloor(admin, ids.site, ids.floor, {}))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.floor.update).not.toHaveBeenCalled();
  });
});

function createHarness(options: {
  lockedFloor?: ReturnType<typeof floorRow> | null;
  fixtureCount?: number;
  activeGroupCount?: number;
  activeSessionCount?: number;
} = {}) {
  const prisma: any = {
    $queryRaw: jest.fn(async (query: TemplateStringsArray | { strings?: string[] }) => {
      if (renderSql(query).includes('FROM "Site"')) {
        return [{ id: ids.site, updatedAt }];
      }
      if (renderSql(query).includes('FROM "Floor"')) {
        return options.lockedFloor === null ? [] : [options.lockedFloor ?? floorRow()];
      }
      return [];
    }),
    $transaction: jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma)),
    site: {
      findUnique: jest.fn().mockResolvedValue({ updatedAt }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: ids.site,
        name: "Old Plant",
        address: null,
        timeZone: "Asia/Seoul",
        currency: "KRW",
        tariffKwhRate: null,
        ...data
      }))
    },
    floor: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: ids.floor, ...data })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...floorRow(), ...data })),
      delete: jest.fn()
    },
    fixture: {
      count: jest.fn().mockResolvedValue(options.fixtureCount ?? 0),
      findMany: jest.fn().mockResolvedValue([])
    },
    fixtureGroup: { count: jest.fn().mockResolvedValue(options.activeGroupCount ?? 0) },
    provisioningSession: { count: jest.fn().mockResolvedValue(options.activeSessionCount ?? 0) }
  };
  const siteAccess = {
    assert: jest.fn().mockResolvedValue({ id: ids.site }),
    assertManageInTransaction: jest.fn().mockResolvedValue({ id: ids.site })
  };
  const energyDimensions = { ensureFixtureDimensions: jest.fn().mockResolvedValue(undefined) };
  return {
    service: () => {
      const { SiteSettingsService } = require("./site-settings.service") as {
        SiteSettingsService: new (prisma: unknown, siteAccess: unknown, energyDimensions: unknown) => any;
      };
      return new SiteSettingsService(prisma, siteAccess, energyDimensions);
    },
    prisma,
    siteAccess,
    energyDimensions
  };
}

function floorRow() {
  return {
    id: ids.floor,
    siteId: ids.site,
    name: "B2",
    level: -2,
    displayOrder: 10,
    status: "active",
    updatedAt
  };
}

function renderSql(query: TemplateStringsArray | { strings?: string[] }) {
  if (Array.isArray(query)) return query.join("?");
  return (query as { strings?: string[] }).strings?.join("?") ?? "";
}
