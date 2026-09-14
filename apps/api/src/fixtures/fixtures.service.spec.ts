import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { FixturesService } from "./fixtures.service";

describe("FixturesService", () => {
  const user: AuthenticatedUser = {
    id: "user-1", organizationId: "org-1", organizationType: "customer", loginId: "fixture_user", name: "Admin", role: "admin", mustChangePassword: false, status: "active"
  };

  it("returns an accessible site cursor page with gateway readiness", async () => {
    const heartbeat = new Date();
    const prisma: any = {
      site: { findUnique: jest.fn().mockResolvedValue({ gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 1200 }) },
      floor: {
        findFirst: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1" }),
        findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1", status: "active" })
      },
      fixture: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "fixture-1",
            name: "L1",
            x: 10,
            y: 20,
            size: 20,
            ratedWatt: "40.00",
            brightness: 70,
            status: "online",
            reportedStatus: "online",
            reportedStatusReason: "reported",
            statusReason: "reported",
            rssi: -60,
            hopCount: 1,
            commandSuccessRate: 0.99,
            lastSeenAt: new Date("2026-07-12T00:00:00.000Z"),
            bioControlMode: "sensor",
            bioConfiguredBrightness: null,
            bioRawHighBrightness: 127,
            healthFaultCodes: [4, 1],
            healthLastSeenAt: new Date("2026-07-12T00:00:01.000Z"),
            meshNode: {
            serialNumber: "DFK-H2-0001",
            deviceUuid: "device-1",
            meshAddress: "256",
              firmwareVersion: "1.2.3",
              gateway: { id: "gateway-1", name: "Gateway B2", lastHeartbeatAt: heartbeat }
            }
          },
          { id: "fixture-2" }
        ])
      }
    };
    const siteAccess = { assert: jest.fn().mockResolvedValue({ id: "site-1" }) };
    const service = new (FixturesService as any)(prisma, siteAccess);

    const result = await service.getFloorFixtures(user, "site-1", "floor-1", { limit: 1 });

    expect(siteAccess.assert).toHaveBeenCalledWith(user, "site-1", "read");
    expect(prisma.fixture.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { siteId: "site-1", floorId: "floor-1" }, orderBy: { id: "asc" }, take: 2 })
    );
    expect(result).toMatchObject({
      items: [
        {
          id: "fixture-1",
          gateway: { id: "gateway-1", name: "Gateway B2", connectionStatus: "online" },
          status: "fault",
          health: { faultCodes: [1, 4], observedAt: "2026-07-12T00:00:01.000Z" },
          bioControlMode: "sensor",
          bioConfiguredBrightness: null,
          bioRawHighBrightness: 127,
          controllable: false,
          controlBlockReason: "fixture_fault"
        }
      ],
      nextCursor: "fixture-1"
    });
    expect(result.items[0]).not.toHaveProperty("serialNumber");
    expect(result.items[0]).not.toHaveProperty("deviceUuid");
    expect(result.items[0]).not.toHaveProperty("meshAddress");
    expect(result.items[0]).not.toHaveProperty("firmwareVersion");
  });

  it("returns fixture identity metadata only through the admin settings listing", async () => {
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1", status: "active" }) },
      fixture: {
        findMany: jest.fn().mockResolvedValue([{
          id: "fixture-1",
          name: "L1",
          ratedWatt: "40.00",
          updatedAt: new Date("2026-09-12T00:00:00.000Z"),
          meshNode: {
            serialNumber: "DFK-H2-0001",
            deviceUuid: "device-1",
            meshAddress: "256",
            firmwareVersion: "1.2.3"
          }
        }, { id: "fixture-2" }])
      }
    };
    const siteAccess = { assert: jest.fn().mockResolvedValue({ id: "site-1" }) };
    const service = new (FixturesService as any)(prisma, siteAccess);

    await expect(service.getFloorFixtureSettings(user, "site-1", "floor-1", { limit: 1 }))
      .resolves.toEqual({
        items: [{
          id: "fixture-1",
          name: "L1",
          ratedWatt: 40,
          updatedAt: "2026-09-12T00:00:00.000Z",
          serialNumber: "DFK-H2-0001",
          deviceUuid: "device-1",
          meshAddress: "256",
          firmwareVersion: "1.2.3"
        }],
        nextCursor: "fixture-1"
      });
    expect(prisma.fixture.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: { id: "asc" },
      take: 2
    }));
    expect(siteAccess.assert).toHaveBeenCalledWith(user, "site-1", "manage");
  });

  it("does not query settings fixture identities without manage access", async () => {
    const prisma: any = {
      floor: { findUnique: jest.fn() },
      fixture: { findMany: jest.fn() }
    };
    const siteAccess = { assert: jest.fn().mockRejectedValue(new ForbiddenException("site capability denied")) };
    const service = new (FixturesService as any)(prisma, siteAccess);

    await expect(service.getFloorFixtureSettings(
      { ...user, role: "viewer" }, "site-1", "floor-1", {}
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.floor.findUnique).not.toHaveBeenCalled();
    expect(prisma.fixture.findMany).not.toHaveBeenCalled();
  });

  it.each([[120_000, "online"], [120_001, "offline"]] as const)(
    "returns server metadata and Site-specific gateway connection for age %s", async (age, connectionStatus) => {
      const now = new Date("2026-09-12T00:10:00.000Z");
      jest.useFakeTimers().setSystemTime(now);
      try {
        const prisma = {
          floor: {
            findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1", status: "active" })
          },
          site: { findUnique: jest.fn().mockResolvedValue({ gatewayOfflineAfterSeconds: 120, fixtureStaleAfterSeconds: 240 }) },
          fixture: { findMany: jest.fn().mockResolvedValue([{
            id: "fixture-1", status: "online", healthFaultCodes: [], healthLastSeenAt: now,
            reportedStatus: "online", reportedStatusReason: "reported", lastSeenAt: now,
            meshNode: { gateway: { id: "g", lastHeartbeatAt: new Date(now.getTime() - age) } }
          }]) }
        };
        const result = await new FixturesService(prisma as never, { assert: jest.fn() } as never)
          .getFloorFixtures(user, "site-1", "floor-1", {});
        expect(result).toMatchObject({ generatedAt: "2026-09-12T00:10:00.000Z",
          items: [{ gateway: { connectionStatus }, controllable: false, controlBlockReason: "gateway_offline" }] });
      } finally { jest.useRealTimers(); }
    }
  );

  it("does not reveal a floor in another tenant", async () => {
    const prisma: any = {
      floor: {
        findFirst: jest.fn().mockResolvedValue({ id: "other-floor", siteId: "other-site" }),
        findUnique: jest.fn().mockResolvedValue({ id: "other-floor", siteId: "other-site", status: "active" })
      },
      fixture: { findMany: jest.fn() }
    };
    const siteAccess = { assert: jest.fn().mockRejectedValue(new NotFoundException("site not found")) };

    await expect(new (FixturesService as any)(prisma, siteAccess).getFloorFixtures(user, "other-site", "other-floor", {})).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(prisma.fixture.findMany).not.toHaveBeenCalled();
  });

  it("returns the same public 404 response for absent and inaccessible floors", async () => {
    const absentService = new (FixturesService as any)(
      { floor: { findUnique: jest.fn().mockResolvedValue(null) } },
      { assert: jest.fn() }
    );
    const inaccessibleService = new (FixturesService as any)(
      {
        floor: { findUnique: jest.fn().mockResolvedValue({ id: "other-floor", siteId: "other-site", status: "active" }) },
        fixture: { findMany: jest.fn() }
      },
      { assert: jest.fn().mockRejectedValue(new NotFoundException("site not found")) }
    );

    const absent = await absentService.getFloorFixtures(user, "site-1", "missing-floor", {}).catch((error: unknown) => error);
    const inaccessible = await inaccessibleService.getFloorFixtures(user, "other-site", "other-floor", {}).catch((error: unknown) => error);

    expect(absent).toBeInstanceOf(NotFoundException);
    expect(inaccessible).toBeInstanceOf(NotFoundException);
    expect(inaccessible.getResponse()).toEqual(absent.getResponse());
  });

  it.each([0, 201])("rejects invalid page limit %s", async (limit) => {
    const service = new FixturesService({} as never, {} as never, {} as never, {} as never);
    await expect((service as any).getFloorFixtures(user, "site-1", "floor-1", { limit })).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([0, 201])("rejects invalid settings page limit %s", async (limit) => {
    const service = new FixturesService({} as never, {} as never, {} as never, {} as never);
    await expect((service as any).getFloorFixtureSettings(user, "site-1", "floor-1", { limit }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it("returns the opaque floor response when the requested site does not own the floor", async () => {
    const prisma: any = {
      floor: { findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1", status: "active" }) },
      fixture: { findMany: jest.fn() }
    };
    const siteAccess = { assert: jest.fn() };
    const service = new (FixturesService as any)(prisma, siteAccess);

    const error = await service.getFloorFixtures(user, "site-2", "floor-1", {}).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(NotFoundException);
    expect(error.getResponse()).toEqual({ statusCode: 404, message: "floor not found", error: "Not Found" });
    expect(siteAccess.assert).not.toHaveBeenCalled();
    expect(prisma.fixture.findMany).not.toHaveBeenCalled();
  });

  it("rejects an archived floor fixture listing with the opaque floor response", async () => {
    const prisma: any = {
      floor: {
        findUnique: jest.fn().mockResolvedValue({ id: "floor-1", siteId: "site-1", status: "archived" })
      },
      fixture: { findMany: jest.fn() }
    };
    const siteAccess = { assert: jest.fn() };
    const service = new (FixturesService as any)(prisma, siteAccess);

    await expect(service.getFloorFixtures(user, "site-1", "floor-1", {})).rejects.toEqual(
      new NotFoundException("floor not found")
    );
    expect(siteAccess.assert).not.toHaveBeenCalled();
    expect(prisma.fixture.findMany).not.toHaveBeenCalled();
  });

  it("updates only fixture metadata after transaction-local manage reauthorization and a tenant-scoped lock", async () => {
    const trackingStartedAt = new Date("2026-01-01T00:00:00.000Z");
    const fixture = {
      id: "fixture-1",
      siteId: "site-1",
      floorId: "floor-1",
      floorName: "B1",
      name: "Old",
      ratedWatt: "40.00",
      updatedAt: new Date("2026-09-12T00:00:00.000Z"),
      energyTrackingStartedAt: trackingStartedAt
    };
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([fixture]),
      $transaction: jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma)),
      fixture: {
        update: jest.fn().mockResolvedValue({ ...fixture, name: "New", ratedWatt: "55.50" })
      }
    };
    const siteAccess = {
      assert: jest.fn().mockResolvedValue({ id: "site-1" }),
      assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site-1" })
    };
    const energyCheckpoint = { closeRatedWattInterval: jest.fn().mockResolvedValue(true) };
    const energyDimensions = { recordFixtureDimensions: jest.fn().mockResolvedValue("energy-fixture-1") };
    const service = new (FixturesService as any)(prisma, siteAccess, energyCheckpoint, energyDimensions);

    await expect(service.updateMetadata(user, "site-1", "floor-1", "fixture-1", {
      expectedUpdatedAt: "2026-09-12T00:00:00.000Z",
      name: "New",
      ratedWatt: 55.5
    })).resolves.toMatchObject({ id: "fixture-1", name: "New", ratedWatt: 55.5 });

    expect(siteAccess.assert).toHaveBeenCalledWith(user, "site-1", "manage");
    expect(siteAccess.assertManageInTransaction).toHaveBeenCalledWith(prisma, user, "site-1");
    expect(siteAccess.assertManageInTransaction.mock.invocationCallOrder[0])
      .toBeLessThan(prisma.$queryRaw.mock.invocationCallOrder[0]);
    expect(renderSql(prisma.$queryRaw.mock.calls[0][0])).toContain(
      'WHERE "id" = ? AND "floorId" = ? AND "siteId" = ?'
    );
    expect(energyCheckpoint.closeRatedWattInterval).toHaveBeenCalledWith(
      prisma,
      "fixture-1",
      expect.objectContaining({}),
      expect.any(Date)
    );
    const changedAt = energyCheckpoint.closeRatedWattInterval.mock.calls[0][3];
    expect(energyDimensions.recordFixtureDimensions).toHaveBeenCalledWith(prisma, {
      fixtureId: "fixture-1",
      siteId: "site-1",
      name: "New",
      floorId: "floor-1",
      floorName: "B1",
      ratedWatt: expect.objectContaining({}),
      trackingStartedAt,
      effectiveAt: changedAt
    });
    expect(energyCheckpoint.closeRatedWattInterval.mock.invocationCallOrder[0])
      .toBeLessThan(energyDimensions.recordFixtureDimensions.mock.invocationCallOrder[0]);
    expect(energyDimensions.recordFixtureDimensions.mock.invocationCallOrder[0])
      .toBeLessThan(prisma.fixture.update.mock.invocationCallOrder[0]);
    expect(prisma.fixture.update).toHaveBeenCalledWith({
      where: { id: "fixture-1" },
      data: { name: "New", ratedWatt: expect.objectContaining({}) },
      select: { id: true, floorId: true, name: true, ratedWatt: true, updatedAt: true }
    });
  });

  it("records a name-only dimension change without closing a rated watt interval", async () => {
    const trackingStartedAt = new Date("2026-01-01T00:00:00.000Z");
    const fixture = {
      id: "fixture-1",
      siteId: "site-1",
      floorId: "floor-1",
      floorName: "B1",
      name: "Old",
      ratedWatt: "40.00",
      updatedAt: new Date("2026-09-12T00:00:00.000Z"),
      energyTrackingStartedAt: trackingStartedAt
    };
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([fixture]),
      $transaction: jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma)),
      fixture: { update: jest.fn().mockResolvedValue({ ...fixture, name: "New" }) }
    };
    const siteAccess = {
      assert: jest.fn().mockResolvedValue({ id: "site-1" }),
      assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site-1" })
    };
    const energyCheckpoint = { closeRatedWattInterval: jest.fn() };
    const energyDimensions = { recordFixtureDimensions: jest.fn().mockResolvedValue("energy-fixture-1") };
    const service = new (FixturesService as any)(prisma, siteAccess, energyCheckpoint, energyDimensions);

    await service.updateMetadata(user, "site-1", "floor-1", "fixture-1", {
      expectedUpdatedAt: "2026-09-12T00:00:00.000Z",
      name: "New"
    });

    expect(energyCheckpoint.closeRatedWattInterval).not.toHaveBeenCalled();
    expect(energyDimensions.recordFixtureDimensions).toHaveBeenCalledWith(prisma, expect.objectContaining({
      name: "New",
      ratedWatt: expect.objectContaining({}),
      effectiveAt: expect.any(Date)
    }));
    expect(energyDimensions.recordFixtureDimensions.mock.invocationCallOrder[0])
      .toBeLessThan(prisma.fixture.update.mock.invocationCallOrder[0]);
  });

  it.each([
    [{ expectedUpdatedAt: "2026-09-12T00:00:00.000Z", name: "New", meshNodeId: "attacker" }, "identity field"],
    [{ expectedUpdatedAt: "2026-09-12T00:00:00.000Z", ratedWatt: 0 }, "zero watt"],
    [{ expectedUpdatedAt: "2026-09-12T00:00:00.000Z", ratedWatt: 12.345 }, "excess precision"],
    [{}, "empty patch"]
  ])("rejects strict fixture metadata input: %s (%s)", async (body, _label) => {
    const prisma: any = { $transaction: jest.fn() };
    const siteAccess = { assert: jest.fn().mockResolvedValue({ id: "site-1" }) };
    const service = new (FixturesService as any)(prisma, siteAccess);

    await expect(service.updateMetadata(user, "site-1", "floor-1", "fixture-1", body)).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("checks manage capability before parsing malformed fixture metadata", async () => {
    const prisma: any = { $transaction: jest.fn() };
    const siteAccess = { assert: jest.fn().mockRejectedValue(new ForbiddenException("site capability denied")) };
    const service = new (FixturesService as any)(prisma, siteAccess);

    await expect(service.updateMetadata(user, "site-1", "floor-1", "fixture-1", {
      serialNumber: "attacker"
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("does not reveal a fixture outside the requested site and floor", async () => {
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma)),
      fixture: { update: jest.fn() }
    };
    const siteAccess = {
      assert: jest.fn().mockResolvedValue({ id: "site-1" }),
      assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site-1" })
    };
    const service = new (FixturesService as any)(prisma, siteAccess);

    await expect(service.updateMetadata(user, "site-1", "floor-1", "fixture-1", {
      expectedUpdatedAt: "2026-09-12T00:00:00.000Z",
      name: "Hidden"
    }))
      .rejects.toEqual(new NotFoundException("fixture not found"));
    expect(prisma.fixture.update).not.toHaveBeenCalled();
  });

  it("rejects a stale fixture metadata update after locking the fixture", async () => {
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([{
        id: "fixture-1", siteId: "site-1", floorId: "floor-1", floorName: "B1",
        name: "Current", ratedWatt: "40.00", updatedAt: new Date("2026-09-12T00:01:00.000Z"),
        energyTrackingStartedAt: new Date("2026-01-01T00:00:00.000Z")
      }]),
      $transaction: jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma)),
      fixture: { update: jest.fn() }
    };
    const siteAccess = {
      assert: jest.fn().mockResolvedValue({ id: "site-1" }),
      assertManageInTransaction: jest.fn().mockResolvedValue({ id: "site-1" })
    };
    const service = new (FixturesService as any)(prisma, siteAccess, {}, {});

    await expect(service.updateMetadata(user, "site-1", "floor-1", "fixture-1", {
      expectedUpdatedAt: "2026-09-12T00:00:00.000Z",
      name: "Stale"
    })).rejects.toEqual(new ConflictException({ code: "settings_version_conflict" }));
    expect(prisma.fixture.update).not.toHaveBeenCalled();
  });
});

function renderSql(query: TemplateStringsArray | { strings?: string[] }) {
  if (Array.isArray(query)) return query.join("?");
  return (query as { strings?: string[] }).strings?.join("?") ?? "";
}
