import { BadRequestException } from "@nestjs/common";
import { encodeScheduleListCursor } from "./dto/schedule.dto";
import { SchedulesService } from "./schedules.service";
import { TargetSnapshotService } from "./target-snapshot.service";
import { canonicalPayloadHash } from "./automation-payload-hash";

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

function exclusionHarness(options: { version?: number; bio?: boolean; timeZone?: string; coverage?: boolean; readback?: boolean; lease?: boolean } = {}) {
  const semantic = { country: "KR", source: "kasi", year: 2026, coverageFrom: "2026-01-01", coverageUntil: "2026-12-31", dates: [] as any[] };
  const dataset = { ...semantic, revision: "first", payloadHash: canonicalPayloadHash(semantic), fetchedAt: new Date("2026-10-01Z"),
    coverageFrom: new Date("2026-01-01Z"), coverageUntil: new Date("2026-12-31Z"), complete: true,
    completenessProof: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, totalCount: 0, pageCount: 1, numOfRows: 100, pages: [{ page: 1, itemCount: 0 }] })) };
  let saved: any = { id: SCHEDULE_ID, siteId: SITE_ID, gatewayId: GATEWAY_ID, name: "Saved", status: "enabled",
    activeFrom: new Date("2026-10-03Z"), activeUntil: new Date("2026-10-07Z"), localStartTime: "09:00", localEndTime: "10:00",
    recurrenceKind: "daily", weeklyDays: [], monthlyDay: null, yearlyMonth: null, yearlyDay: null,
    dimmingEnabled: true, brightnessPercent: 60, excludeWeekends: true, excludeHolidays: true,
    fixtures: [{ fixtureId: FIXTURE_1 }, { fixtureId: FIXTURE_2 }], desiredRevision: 4, appliedRevision: 3,
    createdById: admin.id, updatedById: admin.id, createdAt: new Date("2026-10-01Z"), updatedAt: new Date("2026-10-01Z"),
    gateway: { automationConfiguration: { desiredRevision: 4, appliedRevision: 3, syncStatus: "PENDING" } }, executions: [] };
  let peers: any[] = [];
  const tx = { $queryRaw: async () => [{ assignmentVersion: 1 }],
    gatewayAutomationProtocolSupport: { findFirst: async () => ({ maxSnapshotVersion: options.version ?? 3, temporaryControlVersion: 1, bioConfigurationReadback: options.readback ?? true, durableFixtureLease: options.lease ?? true }) },
    fixture: { findMany: async () => [FIXTURE_1, FIXTURE_2].map(id => ({ id, meshNode: { vehicleSensorProtocol: options.bio === false ? "bluez_stateful" : "bio_usb_pulse", gatewayId: GATEWAY_ID } })) },
    site: { findUnique: async () => ({ timeZone: options.timeZone ?? "Asia/Seoul" }) },
    vehicleEventSource: { findFirst: async () => null },
    holidayYearCoverage: { findMany: jest.fn(async ({ where }: any) => options.coverage === false
      || where.year.gte > 2026 || where.year.lte < 2026 ? [] : [{ year: 2026, complete: true, dataset }]) },
    lightingSchedule: { findMany: async (args: any) => args.where.fixtures ? peers : [saved], count: async () => 1,
      findFirst: async () => saved, create: async ({ data }: any) => { saved = { ...saved, ...data }; },
      update: async ({ data }: any) => { saved = { ...saved, ...data }; } },
    lightingScheduleFixture: { createMany: async () => ({}), deleteMany: async () => ({}) } };
  const service = new SchedulesService({ $transaction: (fn: any) => fn(tx) } as never,
    { assert: async () => {}, assertManageInTransaction: async () => {}, assertReadInTransaction: async () => ({ timeZone: options.timeZone ?? "Asia/Seoul" }) } as never,
    { resolve: async () => [FIXTURE_1, FIXTURE_2], assertSingleGateway: async () => GATEWAY_ID } as never,
    { now: () => new Date("2026-10-02T23:00:00Z") } as never,
    { lockMutation: async () => {}, incrementDesiredRevision: async () => { saved.desiredRevision++; } } as never);
  return { service, tx, saved: () => saved,
    setPeers: (rows: any[]) => { peers = rows; },
    promote: () => { semantic.dates = [{ date: "2026-10-05", names: ["Temporary holiday"] }]; Object.assign(dataset, { dates: semantic.dates, revision: "late", payloadHash: canonicalPayloadHash(semantic) });
      dataset.completenessProof[9].totalCount = 1; dataset.completenessProof[9].pages[0].itemCount = 1; } };
}

describe("schedule exclusions consumers", () => {
  it("persists flags and issues a revision while omitted PATCH flags survive", async () => {
    const h = exclusionHarness();
    const created = await h.service.create(SITE_ID, admin, scheduleInput({ activeFrom: "2026-10-03T00:00:00Z", activeUntil: "2026-10-07T00:00:00Z", excludeWeekends: true, excludeHolidays: true }));
    expect(created).toMatchObject({ excludeWeekends: true, excludeHolidays: true, desiredRevision: 1, nextOccurrence: { localDate: "2026-10-05" } });
    const updated = await h.service.update(SITE_ID, created.id, admin, { name: "Rename" });
    expect(updated).toMatchObject({ name: "Rename", excludeWeekends: true, excludeHolidays: true, desiredRevision: 2 });
    const cleared = await h.service.update(SITE_ID, created.id, admin, { excludeWeekends: false, excludeHolidays: false });
    expect(cleared).toMatchObject({ excludeWeekends: false, excludeHolidays: false, desiredRevision: 3, nextOccurrence: { localDate: "2026-10-03" } });
  });

  it("moves next occurrence after a late verified holiday revision", async () => {
    const h = exclusionHarness();
    const before = await h.service.list(SITE_ID, admin, {});
    expect(before.items[0].nextOccurrence?.localDate).toBe("2026-10-05");
    h.promote();
    const after = await h.service.list(SITE_ID, admin, {});
    expect(after.items[0].nextOccurrence?.localDate).toBe("2026-10-06");
  });

  it.each([{ version: 2 }, { version: 4 }, { readback: false }, { lease: false }])("rejects true exclusions without current known V3 %j", async options => {
    const h = exclusionHarness(options);
    await expect(h.service.create(SITE_ID, admin, scheduleInput({ excludeWeekends: true }))).rejects.toMatchObject({ status: 409, response: { code: "schedule_exclusions_unsupported" } });
  });

  it("requires BIO targets only when exclusions are true", async () => {
    const h = exclusionHarness({ bio: false });
    await expect(h.service.create(SITE_ID, admin, scheduleInput({ excludeWeekends: true }))).rejects.toMatchObject({ status: 409, response: { code: "schedule_exclusions_bio_required" } });
    const created = await h.service.create(SITE_ID, admin, scheduleInput());
    expect(created).toMatchObject({ excludeWeekends: false, excludeHolidays: false });
  });

  it.each([{ timeZone: "America/New_York" }, { coverage: false }])("rejects holiday exclusions without Seoul/full active coverage %j", async options => {
    const h = exclusionHarness(options);
    await expect(h.service.create(SITE_ID, admin, scheduleInput({ excludeHolidays: true }))).rejects.toMatchObject({ status: 409 });
  });

  it("revalidates full active-period coverage on save and enable, including Seoul year boundaries", async () => {
    const h = exclusionHarness();
    await expect(h.service.create(SITE_ID, admin, scheduleInput({ excludeHolidays: true,
      activeFrom: "2026-10-01T00:00:00Z", activeUntil: "2026-12-31T15:00:00Z" })))
      .rejects.toMatchObject({ status: 409, response: { code: "holiday_coverage_unavailable" } });
    const missing = exclusionHarness({ coverage: false }); missing.saved().status = "disabled";
    await expect(missing.service.update(SITE_ID, SCHEDULE_ID, admin, { status: "enabled" }))
      .rejects.toMatchObject({ status: 409, response: { code: "holiday_coverage_unavailable" } });
    const covered = exclusionHarness();
    const saved = await covered.service.create(SITE_ID, admin, scheduleInput({ excludeHolidays: true,
      activeFrom: "2025-12-31T15:00:00Z", activeUntil: "2026-01-01T14:59:59Z" }));
    expect(saved).toMatchObject({ excludeHolidays: true, activeFrom: "2025-12-31T15:00:00.000Z" });
    expect(covered.tx.holidayYearCoverage.findMany.mock.calls[0]).toBeDefined();
  });

  it("allows independent weekend/holiday flags and preserves native false default without holiday cache", async () => {
    const weekend = exclusionHarness({ coverage: false });
    const a = await weekend.service.create(SITE_ID, admin, scheduleInput({ excludeWeekends: true }));
    expect(a).toMatchObject({ excludeWeekends: true, excludeHolidays: false });
    expect(weekend.tx.holidayYearCoverage.findMany).not.toHaveBeenCalled();
    const holiday = exclusionHarness();
    const b = await holiday.service.create(SITE_ID, admin, scheduleInput({ excludeHolidays: true }));
    expect(b).toMatchObject({ excludeWeekends: false, excludeHolidays: true });
    const native = exclusionHarness({ bio: false, version: 1, coverage: false });
    expect(await native.service.create(SITE_ID, admin, scheduleInput())).toMatchObject({ excludeWeekends: false, excludeHolidays: false });
    expect(native.tx.holidayYearCoverage.findMany).not.toHaveBeenCalled();
  });

  it("uses exclusions and verified datasets in the existing overlap evaluator", async () => {
    const h = exclusionHarness();
    h.setPeers([{ ...h.saved(), excludeWeekends: false, excludeHolidays: false, recurrenceKind: "once", activeUntil: new Date("2026-10-03Z") }]);
    const created = await h.service.create(SITE_ID, admin, scheduleInput({ activeFrom: "2026-10-03T00:00:00Z", activeUntil: "2026-10-07T00:00:00Z", excludeWeekends: true }));
    expect(created.nextOccurrence?.localDate).toBe("2026-10-05");
    h.setPeers([{ ...h.saved(), id: SCHEDULE_ID, excludeWeekends: false, excludeHolidays: false, recurrenceKind: "once", activeFrom: new Date("2026-10-05Z"), activeUntil: new Date("2026-10-05Z") }]);
    await expect(h.service.update(SITE_ID, created.id, admin, { name: "Overlap" })).rejects.toMatchObject({ status: 409, response: { code: "schedule_overlap" } });
  });

  it("ignores a holiday overlap but still rejects a covered non-holiday overlap", async () => {
    const h = exclusionHarness(); h.promote();
    const peer = { ...h.saved(), excludeWeekends: false, excludeHolidays: false, recurrenceKind: "once",
      activeFrom: new Date("2026-10-05Z"), activeUntil: new Date("2026-10-05Z") };
    h.setPeers([peer]);
    const created = await h.service.create(SITE_ID, admin, scheduleInput({ activeFrom: "2026-10-03T00:00:00Z",
      activeUntil: "2026-10-07T00:00:00Z", excludeHolidays: true }));
    expect(created.nextOccurrence?.localDate).toBe("2026-10-03");
    h.setPeers([{ ...peer, activeFrom: new Date("2026-10-06Z"), activeUntil: new Date("2026-10-06Z") }]);
    await expect(h.service.update(SITE_ID, created.id, admin, { name: "Covered overlap" })).rejects.toMatchObject({ status: 409, response: { code: "schedule_overlap" } });
  });
});

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

it.each(["fixture", "fixtures", "floor", "group"] as const)("rejects a schedule whose expanded %s target contains an active BIO source", async type => {
  const fixture = { id: FIXTURE_1, siteId: SITE_ID, meshNodeId: "node", gatewayId: GATEWAY_ID };
  const tx = { site: { findUnique: jest.fn().mockResolvedValue({ timeZone: "Asia/Seoul" }) },
    fixture: { findMany: jest.fn().mockResolvedValue([fixture]) },
    gateway: { findUnique: jest.fn().mockResolvedValue({ siteId: SITE_ID }) },
    floor: { findFirst: jest.fn().mockResolvedValue({ fixtures: [fixture] }) },
    fixtureGroup: { findFirst: jest.fn().mockResolvedValue({ groupFixtures: [{ fixture }] }) },
    vehicleEventSource: { findFirst: jest.fn().mockResolvedValue({ fixtureId: FIXTURE_1 }) },
    lightingSchedule: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn() } };
  const service = new SchedulesService({ $transaction: (fn: any) => fn(tx) } as never,
    { assert: async () => {}, assertManageInTransaction: async () => {} } as never, new TargetSnapshotService(),
    { now: () => new Date("2026-08-31T00:00:00Z") } as never, { lockMutation: async () => {} } as never);
  const target = type === "fixture" ? { type, fixtureId: FIXTURE_1 } : type === "fixtures" ? { type, fixtureIds: [FIXTURE_1] }
    : type === "floor" ? { type, floorId: SCHEDULE_ID } : { type, groupId: SCHEDULE_ID };
  await expect(service.create(SITE_ID, admin, scheduleInput({ target }))).rejects.toMatchObject({ response: { code: "bio_source_target_forbidden" } });
  expect(tx.lightingSchedule.create).not.toHaveBeenCalled();
});

describe("SchedulesService", () => {
  it("rechecks saved fixture targets on PATCH without a new target selection", async () => {
    const existing = { id: SCHEDULE_ID, siteId: SITE_ID, gatewayId: GATEWAY_ID, name: "Saved", status: "enabled",
      activeFrom: new Date("2026-09-01T00:00:00Z"), activeUntil: new Date("2026-09-30T00:00:00Z"),
      localStartTime: "09:00", localEndTime: "10:00", recurrenceKind: "daily", weeklyDays: [],
      monthlyDay: null, yearlyMonth: null, yearlyDay: null, dimmingEnabled: true, brightnessPercent: 60,
      fixtures: [{ fixtureId: FIXTURE_1 }] };
    const tx = { site: { findUnique: async () => ({ timeZone: "Asia/Seoul" }) },
      vehicleEventSource: { findFirst: jest.fn().mockResolvedValue({ fixtureId: FIXTURE_1 }) },
      lightingSchedule: { findFirst: async () => existing, findMany: async () => [], update: jest.fn() } };
    const service = new SchedulesService({ $transaction: (fn: any) => fn(tx) } as never,
      { assert: async () => {}, assertManageInTransaction: async () => {} } as never, new TargetSnapshotService(),
      { now: () => new Date("2026-08-31T00:00:00Z") } as never, { lockMutation: async () => {} } as never);
    await expect(service.update(SITE_ID, SCHEDULE_ID, admin, { name: "Updated" })).rejects.toMatchObject({ response: { code: "bio_source_target_forbidden" } });
    expect(tx.lightingSchedule.update).not.toHaveBeenCalled();
  });
  it("lists one deterministic bounded page and returns total plus next cursor", async () => {
    const createdAt = new Date("2026-08-30T01:02:03.456Z");
    const tx = {
      lightingSchedule: {
        count: jest.fn().mockResolvedValueOnce(37).mockResolvedValueOnce(10).mockResolvedValueOnce(20).mockResolvedValueOnce(7),
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
    })).resolves.toEqual({ items: [], total: 37, filteredTotal: 37,
      siteSummary: { ruleCount: 37, syncRuleCounts: { APPLIED: 10, PENDING: 20, REJECTED: 7 } }, nextCursor: null });
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

  it("applies literal name, status, and Gateway sync filters to both page and filtered count", async () => {
    const tx = { lightingSchedule: { count: jest.fn()
      .mockResolvedValueOnce(5).mockResolvedValueOnce(1).mockResolvedValueOnce(2)
      .mockResolvedValueOnce(2).mockResolvedValueOnce(1), findMany: jest.fn().mockResolvedValue([]) } };
    const service = new SchedulesService(
      { $transaction: jest.fn(callback => callback(tx)) } as never,
      { assertReadInTransaction: jest.fn().mockResolvedValue({ id: SITE_ID, timeZone: "Asia/Seoul" }) } as never,
      {} as never, { now: jest.fn().mockReturnValue(new Date()) } as never, {} as never
    );
    await expect(service.list(SITE_ID, admin, { query: "  한글%_  ", status: "enabled", syncStatus: "PENDING" }))
      .resolves.toMatchObject({ total: 5, filteredTotal: 1,
        siteSummary: { ruleCount: 5, syncRuleCounts: { APPLIED: 2, PENDING: 2, REJECTED: 1 } } });
    expect(tx.lightingSchedule.count.mock.calls[1][0].where).toMatchObject({
      siteId: SITE_ID, name: { contains: "한글\\%\\_", mode: "insensitive" }, status: "enabled"
    });
    expect(tx.lightingSchedule.findMany.mock.calls[0][0].where).toMatchObject({
      siteId: SITE_ID, name: { contains: "한글\\%\\_", mode: "insensitive" }, status: "enabled"
    });
  });

  it("rejects an enabled exact overlap with the stable schedule_overlap code", async () => {
    const transactionCalls: string[] = [];
    const tx = {
      vehicleEventSource: { findFirst: jest.fn().mockResolvedValue(null) },
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
