import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";

const ids = {
  site: "00000000-0000-4000-8000-000000000001",
  floor: "00000000-0000-4000-8000-000000000002"
};

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
      floors: [
        {
          id: "floor-active",
          name: "B1",
          level: -1,
          status: "active",
          displayOrder: 10,
          _count: { fixtures: 3, fixtureGroups: 1 }
        },
        {
          id: "floor-archived",
          name: "Old B2",
          level: -2,
          status: "archived",
          displayOrder: 20,
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
        tariffKwhRate: 137.25
      },
      floors: [
        {
          id: "floor-active",
          name: "B1",
          level: -1,
          status: "active",
          displayOrder: 10,
          fixtureCount: 3,
          activeGroupCount: 1
        },
        {
          id: "floor-archived",
          name: "Old B2",
          level: -2,
          status: "archived",
          displayOrder: 20,
          fixtureCount: 0,
          activeGroupCount: 0
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
        tariffKwhRate: expect.objectContaining({})
      },
      select: expect.any(Object)
    });
  });

  it.each([
    [{ name: "Plant", adminUserId: "attacker" }, "unknown field"],
    [{ currency: "krw" }, "invalid currency"],
    [{ tariffKwhRate: -1 }, "negative tariff"],
    [{}, "empty patch"]
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

    await service().updateFloor(admin, ids.site, ids.floor, { name: "Basement 2", displayOrder: 20 });

    expect(siteAccess.assertManageInTransaction).toHaveBeenCalledWith(prisma, admin, ids.site);
    expect(siteAccess.assertManageInTransaction.mock.invocationCallOrder[0])
      .toBeLessThan(prisma.$queryRaw.mock.invocationCallOrder[0]);
    expect(renderSql(prisma.$queryRaw.mock.calls[0][0])).toContain('WHERE "id" = ? AND "siteId" = ?');
    expect(prisma.floor.update).toHaveBeenCalledWith({
      where: { id: ids.floor },
      data: { name: "Basement 2", displayOrder: 20 },
      select: expect.any(Object)
    });
  });

  it("returns an opaque floor 404 when the locked floor is outside the requested site", async () => {
    const { service, prisma } = createHarness({ lockedFloor: null });

    await expect(service().updateFloor(admin, ids.site, ids.floor, { name: "Hidden" })).rejects.toEqual(
      new NotFoundException("floor not found")
    );
    expect(prisma.floor.update).not.toHaveBeenCalled();
  });

  it("restores an archived floor to active through the locked floor update", async () => {
    const { service, prisma, siteAccess } = createHarness({
      lockedFloor: { ...floorRow(), status: "archived" }
    });

    await expect(service().updateFloor(admin, ids.site, ids.floor, { status: "active" })).resolves.toMatchObject({
      id: ids.floor,
      status: "active"
    });

    expect(siteAccess.assertManageInTransaction).toHaveBeenCalledWith(prisma, admin, ids.site);
    expect(prisma.floor.update).toHaveBeenCalledWith({
      where: { id: ids.floor },
      data: { status: "active" },
      select: expect.any(Object)
    });
  });

  it("rejects active-to-archived PATCH so callers cannot bypass archive safety checks", async () => {
    const { service, prisma } = createHarness();

    await expect(service().updateFloor(admin, ids.site, ids.floor, { status: "archived" }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.floor.update).not.toHaveBeenCalled();
  });

  it("rejects status active when the locked floor is already active", async () => {
    const { service, prisma } = createHarness();

    await expect(service().updateFloor(admin, ids.site, ids.floor, { status: "active" }))
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

    await expect(service().archiveFloor(admin, ids.site, ids.floor)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.floor.update).not.toHaveBeenCalled();
  });

  it("archives an empty floor without hard deleting it", async () => {
    const { service, prisma, siteAccess } = createHarness();

    await expect(service().archiveFloor(admin, ids.site, ids.floor)).resolves.toMatchObject({
      id: ids.floor,
      status: "archived"
    });

    expect(siteAccess.assertManageInTransaction).toHaveBeenCalledWith(prisma, admin, ids.site);
    expect(prisma.floor.update).toHaveBeenCalledWith({
      where: { id: ids.floor },
      data: { status: "archived" },
      select: expect.any(Object)
    });
    expect(prisma.floor.delete).not.toHaveBeenCalled();
  });
});

function createHarness(options: {
  lockedFloor?: ReturnType<typeof floorRow> | null;
  fixtureCount?: number;
  activeGroupCount?: number;
} = {}) {
  const prisma: any = {
    $queryRaw: jest.fn(async (query: TemplateStringsArray | { strings?: string[] }) => {
      if (renderSql(query).includes('FROM "Floor"')) {
        return options.lockedFloor === null ? [] : [options.lockedFloor ?? floorRow()];
      }
      return [];
    }),
    $transaction: jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma)),
    site: {
      findUnique: jest.fn(),
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
    fixture: { count: jest.fn().mockResolvedValue(options.fixtureCount ?? 0) },
    fixtureGroup: { count: jest.fn().mockResolvedValue(options.activeGroupCount ?? 0) }
  };
  const siteAccess = {
    assert: jest.fn().mockResolvedValue({ id: ids.site }),
    assertManageInTransaction: jest.fn().mockResolvedValue({ id: ids.site })
  };
  return {
    service: () => {
      const { SiteSettingsService } = require("./site-settings.service") as {
        SiteSettingsService: new (prisma: unknown, siteAccess: unknown) => any;
      };
      return new SiteSettingsService(prisma, siteAccess);
    },
    prisma,
    siteAccess
  };
}

function floorRow() {
  return {
    id: ids.floor,
    siteId: ids.site,
    name: "B2",
    level: -2,
    displayOrder: 10,
    status: "active"
  };
}

function renderSql(query: TemplateStringsArray | { strings?: string[] }) {
  if (Array.isArray(query)) return query.join("?");
  return (query as { strings?: string[] }).strings?.join("?") ?? "";
}
