import { BadRequestException } from "@nestjs/common";
import { encodeScheduleListCursor } from "./dto/schedule.dto";
import { SchedulesService } from "./schedules.service";
import { TargetSnapshotService } from "./target-snapshot.service";

const SITE_ID = "00000000-0000-4000-8000-000000000001";
const GATEWAY_ID = "00000000-0000-4000-8000-000000000002";
const FIXTURE_1 = "00000000-0000-4000-8000-000000000003";
const FIXTURE_2 = "00000000-0000-4000-8000-000000000004";
const SCHEDULE_ID = "00000000-0000-4000-8000-000000000005";

const admin = {
  id: "00000000-0000-4000-8000-000000000006",
  organizationId: "00000000-0000-4000-8000-000000000007",
  organizationType: "customer" as const,
  loginId: "schedule_admin",
  name: "Schedule admin",
  role: "admin" as const,
  mustChangePassword: false,
  status: "active" as const
};

function scheduleInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "Weekday opening",
    status: "enabled",
    activeFrom: "2026-09-01T00:00:00.000Z",
    activeUntil: "2026-09-30T00:00:00.000Z",
    localStartTime: "09:00",
    localEndTime: "10:00",
    recurrence: {
      kind: "daily",
      weeklyDays: [],
      monthlyDay: null,
      yearlyMonth: null,
      yearlyDay: null
    },
    action: { dimmingEnabled: true, brightnessPercent: 60 },
    target: { type: "fixtures", fixtureIds: [FIXTURE_1, FIXTURE_2] },
    ...overrides
  };
}

describe("TargetSnapshotService", () => {
  const service = new TargetSnapshotService();

  it("resolves an exact, sorted distinct fixture snapshot", async () => {
    const tx = {
      fixture: {
        findMany: jest.fn().mockResolvedValue([
          { id: FIXTURE_2, siteId: SITE_ID, meshNodeId: "node-2", gatewayId: GATEWAY_ID },
          { id: FIXTURE_1, siteId: SITE_ID, meshNodeId: "node-1", gatewayId: GATEWAY_ID }
        ])
      },
      gateway: { findUnique: jest.fn().mockResolvedValue({ id: GATEWAY_ID, siteId: SITE_ID }) }
    };

    await expect(service.resolve(tx as never, SITE_ID, {
      type: "fixtures",
      fixtureIds: [FIXTURE_2, FIXTURE_1]
    })).resolves.toEqual([FIXTURE_1, FIXTURE_2]);
    await expect(service.assertSingleGateway(tx as never, [FIXTURE_1, FIXTURE_2]))
      .resolves.toBe(GATEWAY_ID);
  });

  it("rejects a selected fixture that is not registered to a gateway", async () => {
    const tx = {
      fixture: {
        findMany: jest.fn().mockResolvedValue([
          { id: FIXTURE_1, siteId: SITE_ID, meshNodeId: null, gatewayId: null }
        ])
      }
    };

    await expect(service.resolve(tx as never, SITE_ID, {
      type: "fixture",
      fixtureId: FIXTURE_1
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    [
      "floor",
      { type: "floor" as const, floorId: "00000000-0000-4000-8000-000000000008" },
      {
        floor: {
          findFirst: jest.fn().mockResolvedValue({
            fixtures: [
              { id: FIXTURE_2, siteId: SITE_ID, meshNodeId: "node-2", gatewayId: GATEWAY_ID },
              { id: FIXTURE_1, siteId: SITE_ID, meshNodeId: "node-1", gatewayId: GATEWAY_ID }
            ]
          })
        }
      }
    ],
    [
      "group",
      { type: "group" as const, groupId: "00000000-0000-4000-8000-000000000009" },
      {
        fixtureGroup: {
          findFirst: jest.fn().mockResolvedValue({
            groupFixtures: [
              { fixture: { id: FIXTURE_2, siteId: SITE_ID, meshNodeId: "node-2", gatewayId: GATEWAY_ID } },
              { fixture: { id: FIXTURE_1, siteId: SITE_ID, meshNodeId: "node-1", gatewayId: GATEWAY_ID } }
            ]
          })
        }
      }
    ]
  ])("snapshots the exact current %s fixture membership", async (_label, target, tx) => {
    await expect(service.resolve(tx as never, SITE_ID, target)).resolves.toEqual([FIXTURE_1, FIXTURE_2]);
  });

  it("rejects a target snapshot spanning more than one gateway", async () => {
    const tx = {
      fixture: {
        findMany: jest.fn().mockResolvedValue([
          { id: FIXTURE_1, siteId: SITE_ID, meshNodeId: "node-1", gatewayId: GATEWAY_ID },
          {
            id: FIXTURE_2,
            siteId: SITE_ID,
            meshNodeId: "node-2",
            gatewayId: "00000000-0000-4000-8000-000000000010"
          }
        ])
      }
    };

    await expect(service.assertSingleGateway(tx as never, [FIXTURE_1, FIXTURE_2])).rejects.toMatchObject({
      status: 409,
      response: { code: "single_gateway_required" }
    });
  });

  it("rejects a group containing a fixture from another site", async () => {
    const tx = {
      fixtureGroup: {
        findFirst: jest.fn().mockResolvedValue({
          groupFixtures: [{
            fixture: {
              id: FIXTURE_1,
              siteId: "00000000-0000-4000-8000-000000000011",
              meshNodeId: "node-1",
              gatewayId: GATEWAY_ID
            }
          }]
        })
      }
    };

    await expect(service.resolve(tx as never, SITE_ID, {
      type: "group",
      groupId: "00000000-0000-4000-8000-000000000009"
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a gateway whose owner Site differs from the fixture snapshot Site", async () => {
    const tx = {
      fixture: {
        findMany: jest.fn().mockResolvedValue([
          { id: FIXTURE_1, siteId: SITE_ID, meshNodeId: "node-1", gatewayId: GATEWAY_ID }
        ])
      },
      gateway: {
        findUnique: jest.fn().mockResolvedValue({
          id: GATEWAY_ID,
          siteId: "00000000-0000-4000-8000-000000000011"
        })
      }
    };

    await expect(service.assertSingleGateway(tx as never, [FIXTURE_1])).rejects
      .toBeInstanceOf(BadRequestException);
  });
});

describe("SchedulesService", () => {
  it("lists one deterministic bounded page and returns total plus next cursor", async () => {
    const createdAt = new Date("2026-08-30T01:02:03.456Z");
    const tx = {
      lightingSchedule: {
        count: jest.fn().mockResolvedValue(37),
        findMany: jest.fn().mockResolvedValue([])
      }
    };
    const prisma = {
      $transaction: jest.fn((callback, _options) => callback(tx))
    };
    const siteAccess = {
      assertReadInTransaction: jest.fn().mockResolvedValue({ id: SITE_ID, timeZone: "Asia/Seoul" })
    };
    const service = new SchedulesService(
      prisma as never,
      siteAccess as never,
      {} as never,
      { now: jest.fn().mockReturnValue(new Date("2026-08-31T23:00:00.000Z")) } as never,
      {} as never
    );
    const cursor = encodeScheduleListCursor({ siteId: SITE_ID, createdAt, id: SCHEDULE_ID });

    await expect(service.list(SITE_ID, admin, {
      cursor,
      limit: "25"
    })).resolves.toEqual({ items: [], total: 37, nextCursor: null });
    expect(siteAccess.assertReadInTransaction).toHaveBeenCalledWith(tx, admin, SITE_ID);
    expect(tx.lightingSchedule.count).toHaveBeenCalledWith({ where: { siteId: SITE_ID } });
    expect(tx.lightingSchedule.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        siteId: SITE_ID,
        OR: [
          { createdAt: { lt: createdAt } },
          { createdAt, id: { gt: SCHEDULE_ID } }
        ]
      },
      take: 26,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }]
    }));
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "RepeatableRead" });
  });

  it("rejects an enabled exact overlap with the stable schedule_overlap code", async () => {
    const transactionCalls: string[] = [];
    const tx = {
      $queryRaw: jest.fn().mockImplementation(() => {
        transactionCalls.push("automation-lock");
        return Promise.resolve([{ lock_automation_membership_mutation: null }]);
      }),
      site: { findUnique: jest.fn().mockResolvedValue({ id: SITE_ID, timeZone: "Asia/Seoul" }) },
      lightingSchedule: {
        findMany: jest.fn().mockResolvedValue([{
          id: SCHEDULE_ID,
          name: "Existing",
          status: "enabled",
          activeFrom: new Date("2026-09-01T00:00:00.000Z"),
          activeUntil: new Date("2026-09-30T00:00:00.000Z"),
          localStartTime: "09:30",
          localEndTime: "10:30",
          recurrenceKind: "daily",
          weeklyDays: [],
          monthlyDay: null,
          yearlyMonth: null,
          yearlyDay: null,
          dimmingEnabled: true,
          brightnessPercent: 80,
          fixtures: [{ fixtureId: FIXTURE_1 }]
        }]),
        create: jest.fn()
      }
    };
    const prisma = { $transaction: jest.fn((callback) => callback(tx)) };
    const siteAccess = {
      assert: jest.fn().mockResolvedValue({ id: SITE_ID }),
      assertManageInTransaction: jest.fn().mockImplementation(() => {
        transactionCalls.push("site-lock");
        return Promise.resolve({ id: SITE_ID });
      })
    };
    const targetSnapshot = {
      resolve: jest.fn().mockResolvedValue([FIXTURE_1, FIXTURE_2]),
      assertSingleGateway: jest.fn().mockResolvedValue(GATEWAY_ID)
    };
    const service = new SchedulesService(
      prisma as never,
      siteAccess as never,
      targetSnapshot as never,
      { now: jest.fn().mockReturnValue(new Date("2026-08-31T23:00:00.000Z")) } as never,
      {
        lockMutation: jest.fn().mockImplementation(() => {
          transactionCalls.push("automation-lock");
          return Promise.resolve();
        })
      } as never
    );

    await expect(service.create(SITE_ID, admin, scheduleInput())).rejects.toMatchObject({
      status: 409,
      response: { code: "schedule_overlap" }
    });
    expect(tx.lightingSchedule.create).not.toHaveBeenCalled();
    expect(transactionCalls.slice(0, 2)).toEqual(["automation-lock", "site-lock"]);
  });

  it("rejects a PATCH whose merged local times are equal", async () => {
    const transactionCalls: string[] = [];
    const existing = {
      id: SCHEDULE_ID,
      siteId: SITE_ID,
      gatewayId: GATEWAY_ID,
      name: "Existing",
      status: "enabled",
      activeFrom: new Date("2026-09-01T00:00:00.000Z"),
      activeUntil: new Date("2026-09-30T00:00:00.000Z"),
      localStartTime: "09:00",
      localEndTime: "10:00",
      recurrenceKind: "daily",
      weeklyDays: [],
      monthlyDay: null,
      yearlyMonth: null,
      yearlyDay: null,
      dimmingEnabled: true,
      brightnessPercent: 80,
      fixtures: [{ fixtureId: FIXTURE_1 }]
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ lock_automation_membership_mutation: null }]),
      site: { findUnique: jest.fn().mockResolvedValue({ id: SITE_ID, timeZone: "Asia/Seoul" }) },
      lightingSchedule: {
        findFirst: jest.fn().mockResolvedValue(existing),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn()
      }
    };
    const service = new SchedulesService(
      { $transaction: jest.fn((callback) => callback(tx)) } as never,
      {
        assert: jest.fn().mockResolvedValue({ id: SITE_ID }),
        assertManageInTransaction: jest.fn().mockImplementation(() => {
          transactionCalls.push("site-lock");
          return Promise.resolve({ id: SITE_ID });
        })
      } as never,
      {
        resolve: jest.fn(),
        assertSingleGateway: jest.fn()
      } as never,
      { now: jest.fn().mockReturnValue(new Date("2026-08-31T23:00:00.000Z")) } as never,
      { lockMutation: jest.fn().mockImplementation(() => {
        transactionCalls.push("automation-lock");
        return Promise.resolve();
      }) } as never
    );

    await expect(service.update(SITE_ID, SCHEDULE_ID, admin, { localEndTime: "09:00" }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(tx.lightingSchedule.update).not.toHaveBeenCalled();
    expect(transactionCalls.slice(0, 2)).toEqual(["automation-lock", "site-lock"]);
  });

  it("locks automation before Site reauthorization on delete", async () => {
    const transactionCalls: string[] = [];
    const tx = {
      lightingSchedule: { findFirst: jest.fn().mockResolvedValue(null) }
    };
    const service = new SchedulesService(
      { $transaction: jest.fn((callback) => callback(tx)) } as never,
      {
        assert: jest.fn().mockResolvedValue({ id: SITE_ID }),
        assertManageInTransaction: jest.fn().mockImplementation(() => {
          transactionCalls.push("site-lock");
          return Promise.resolve({ id: SITE_ID });
        })
      } as never,
      {} as never,
      { now: jest.fn() } as never,
      { lockMutation: jest.fn().mockImplementation(() => {
        transactionCalls.push("automation-lock");
        return Promise.resolve();
      }) } as never
    );

    await expect(service.remove(SITE_ID, SCHEDULE_ID, admin)).rejects.toMatchObject({ status: 404 });
    expect(transactionCalls).toEqual(["automation-lock", "site-lock"]);
  });
});
