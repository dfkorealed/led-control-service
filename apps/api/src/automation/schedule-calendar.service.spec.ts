import { NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { canonicalPayloadHash } from "./automation-payload-hash";
import { AutomationController } from "./automation.controller";
import { ScheduleCalendarService } from "./schedule-calendar.service";
import { SchedulesService } from "./schedules.service";
import { Test } from "@nestjs/testing";
import { AuthService } from "../auth/auth.service";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { scheduleCalendarResponseSchema } from "@led-control/shared";

const SITE = "00000000-0000-4000-8000-000000000001";
const GATEWAY = "00000000-0000-4000-8000-000000000002";
const FIXTURE = "00000000-0000-4000-8000-000000000003";
const actor = { id: FIXTURE } as never;

function row(index = 10, patch: Record<string, unknown> = {}) {
  return { id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, siteId: SITE, gatewayId: GATEWAY,
    name: "Daily", status: "enabled", activeFrom: new Date("2026-10-01T00:00:00Z"), activeUntil: new Date("2026-12-31T00:00:00Z"),
    localStartTime: "23:00", localEndTime: "01:00", recurrenceKind: "daily", weeklyDays: [], monthlyDay: null,
    yearlyMonth: null, yearlyDay: null, dimmingEnabled: true, brightnessPercent: 60, excludeWeekends: false,
    excludeHolidays: false, fixtures: [{ fixtureId: FIXTURE }], desiredRevision: 4, appliedRevision: 3, ...patch };
}

function coverage(holiday = false, revision = "initial") {
  const semantic = { country: "KR", source: "kasi", year: 2026, coverageFrom: "2026-01-01", coverageUntil: "2026-12-31",
    dates: holiday ? [{ date: "2026-10-05", names: ["Temporary holiday"] }] : [] };
  return { year: 2026, complete: true, dataset: { ...semantic, revision, payloadHash: canonicalPayloadHash(semantic),
    fetchedAt: new Date("2026-10-01T00:00:00Z"), coverageFrom: new Date("2026-01-01T00:00:00Z"),
    coverageUntil: new Date("2026-12-31T00:00:00Z"), complete: true,
    completenessProof: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, totalCount: holiday && i === 9 ? 1 : 0,
      pageCount: 1, numOfRows: 100, pages: [{ page: 1, itemCount: holiday && i === 9 ? 1 : 0 }] })) } };
}

function harness(rows = [row()], datasets = [coverage()]) {
  let configuration = { gatewayId: GATEWAY, desiredRevision: 4, appliedRevision: 3, payloadHash: `sha256:${"a".repeat(64)}` };
  const tx = { lightingSchedule: { findMany: jest.fn(async (args: any) => {
    // A paged calendar silently loses rule101; the fake mirrors that SQL boundary.
    return args.take ? rows.slice(0, args.take) : rows;
  }) }, gatewayAutomationConfiguration: { findMany: jest.fn(async () => [{ ...configuration }]) },
    holidayYearCoverage: { findMany: jest.fn(async () => datasets) } };
  const prisma = { $transaction: jest.fn(async (fn: any, options: any) => {
    expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return fn(tx);
  }) };
  const access = { assertReadInTransaction: jest.fn(async (client: any) => {
    expect(client).toBe(tx); return { timeZone: "Asia/Seoul" };
  }) };
  const service = new ScheduleCalendarService(prisma as never, access as never);
  return { get: (range: any) => service.get(SITE, actor, range), service, tx, access,
    changeGatewayRevision: () => { configuration = { ...configuration, appliedRevision: 4 }; },
    promote: () => { datasets.splice(0, datasets.length, coverage(true, "late")); configuration = { ...configuration, desiredRevision: 5 }; } };
}

describe("ScheduleCalendarService", () => {
  it("projects all101 authorized schedules in one complete transaction including overnight ends", async () => {
    const h = harness(Array.from({ length: 101 }, (_, i) => row(i + 10)));
    const view = await h.get({ from: "2026-10-05", to: "2026-10-05" });
    expect(view?.complete).toBe(true);
    expect(scheduleCalendarResponseSchema.safeParse(view).success).toBe(true);
    expect(new Set(view.occurrences.map((x: any) => x.scheduleId)).size).toBe(101);
    expect(view.occurrences[0]).toMatchObject({ localDate: "2026-10-05", startsAt: "2026-10-05T14:00:00.000Z", endsAt: "2026-10-05T16:00:00.000Z" });
    expect(h.tx.lightingSchedule.findMany.mock.calls[0][0]).toMatchObject({ where: { siteId: SITE } });
  });

  it("uses the promoted verified dataset and same-transaction revisions", async () => {
    const h = harness([row(10, { excludeHolidays: true })]);
    const before = await h.get({ from: "2026-10-05", to: "2026-10-06" });
    expect(before?.occurrences.map((x: any) => x.localDate)).toEqual(["2026-10-05", "2026-10-06"]);
    h.promote();
    const after = await h.get({ from: "2026-10-05", to: "2026-10-06" });
    expect(after.occurrences.map((x: any) => x.localDate)).toEqual(["2026-10-06"]);
    expect(after.revisionKey).not.toBe(before.revisionKey);
    expect(after.holidayCoverage[0].revision).toBe("late");
  });

  it("changes revisionKey for a Gateway applied revision even with unchanged schedules and dataset", async () => {
    const h = harness();
    const before = await h.get({ from: "2026-10-05", to: "2026-10-05" });
    h.changeGatewayRevision();
    const after = await h.get({ from: "2026-10-05", to: "2026-10-05" });
    expect(after.occurrences).toEqual(before.occurrences);
    expect(after.revisionKey).not.toBe(before.revisionKey);
    expect(h.tx.gatewayAutomationConfiguration.findMany.mock.calls[0]).toBeDefined();
  });

  it("refuses unproved coverage instead of returning a complete empty calendar", async () => {
    const h = harness([row(10, { excludeHolidays: true })], []);
    await expect(h.get({ from: "2026-10-05", to: "2026-10-05" })).rejects.toMatchObject({ status: 409, response: { code: "holiday_coverage_unavailable" } });
  });

  it("needs no dataset for false/native rules, disabled rules or dates beyond the active period", async () => {
    const native = harness([row()], []);
    expect((await native.get({ from: "2026-10-05", to: "2026-10-05" })).complete).toBe(true);
    expect(native.tx.holidayYearCoverage.findMany).not.toHaveBeenCalled();
    const disabled = harness([row(10, { excludeHolidays: true, status: "disabled" })], []);
    expect((await disabled.get({ from: "2026-10-05", to: "2026-10-05" })).occurrences).toEqual([]);
    const outside = harness([row(10, { excludeHolidays: true })], []);
    expect((await outside.get({ from: "2027-01-01", to: "2027-01-01" })).occurrences).toEqual([]);
  });

  it("does not require coverage for a once whose original start is outside the requested range", async () => {
    const h = harness([row(10, { excludeHolidays: true, recurrenceKind: "once" })], []);
    expect((await h.get({ from: "2026-10-05", to: "2026-10-05" })).occurrences).toEqual([]);
  });

  it("covers only the overnight start year when the end crosses into an unknown year", async () => {
    const h = harness([row(10, { excludeHolidays: true })]);
    const view = await h.get({ from: "2026-12-31", to: "2027-01-01" });
    expect(view.occurrences).toEqual([{ scheduleId: row().id, key: `${row().id}:2026-12-31`, localDate: "2026-12-31",
      startsAt: "2026-12-31T14:00:00.000Z", endsAt: "2026-12-31T16:00:00.000Z" }]);
    expect(view.holidayCoverage.map(dataset => dataset.year)).toEqual([2026]);
  });

  it("propagates corrupt proof/hash and sanitized storage failures from the verified reader", async () => {
    const corrupt = coverage(); corrupt.dataset.payloadHash = `sha256:${"f".repeat(64)}`;
    await expect(harness([row(10, { excludeHolidays: true })], [corrupt]).get({ from: "2026-10-05", to: "2026-10-05" }))
      .rejects.toMatchObject({ status: 409, response: { code: "holiday_coverage_unavailable" } });
    const h = harness([row(10, { excludeHolidays: true })]);
    h.tx.holidayYearCoverage.findMany.mockRejectedValueOnce(new Error("secret fixture failure"));
    await expect(h.get({ from: "2026-10-05", to: "2026-10-05" })).rejects.toMatchObject({ status: 503, response: { code: "holiday_storage_unavailable" } });
  });

  it("accepts42 inclusive days and rejects43 or invalid civil dates", async () => {
    const h = harness();
    expect((await h.get({ from: "2026-10-01", to: "2026-11-11" }))?.complete).toBe(true);
    for (const range of [{ from: "2026-10-01", to: "2026-11-12" }, { from: "2026-02-30", to: "2026-03-01" }, { from: "2026-10-02", to: "2026-10-01" }]) {
      await expect(h.get(range)).rejects.toMatchObject({ status: 400 });
    }
  });

  it.each(["limit", "cursor", "query", "status", "syncStatus", "page", "scheduleId"])("rejects mixed calendar argument %s", async key => {
    const h = harness();
    await expect(h.get({ from: "2026-10-05", to: "2026-10-05", [key]: "1" })).rejects.toMatchObject({ status: 400 });
  });

  it("rechecks site read permission before reading calendar data", async () => {
    const h = harness();
    h.access.assertReadInTransaction.mockRejectedValueOnce(new NotFoundException());
    await expect(h.get({ from: "2026-10-05", to: "2026-10-05" })).rejects.toMatchObject({ status: 404 });
    expect(h.tx.lightingSchedule.findMany).not.toHaveBeenCalled();
  });

  it("exposes the calendar read through the authenticated schedule controller", async () => {
    const h = harness(); const controller = new (AutomationController as any)({}, { get: (_site: string, _actor: unknown, range: unknown) => h.get(range) });
    const view = await controller.calendar(SITE, { from: "2026-10-05", to: "2026-10-05" }, actor);
    expect(view?.complete).toBe(true);
  });

  it("serves the complete calendar at the authenticated HTTP route with private no-store and rejects filters", async () => {
    const h = harness(Array.from({ length: 101 }, (_, i) => row(i + 10)));
    const module = await Test.createTestingModule({ controllers: [AutomationController], providers: [SessionAuthGuard,
      { provide: SchedulesService, useValue: {} }, { provide: ScheduleCalendarService, useValue: h.service },
      { provide: AuthService, useValue: { getUserBySessionToken: async () => actor } }] }).compile();
    const app = module.createNestApplication();
    try {
      await app.listen(0, "127.0.0.1");
      const url = `${await app.getUrl()}/sites/${SITE}/automation/schedules/calendar?from=2026-10-05&to=2026-10-05`;
      expect((await fetch(url)).status).toBe(401);
      const headers = { cookie: `${AuthService.sessionCookieName}=local-fixture` };
      const response = await fetch(url, { headers });
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
      const view = await response.json() as any;
      expect(view.complete).toBe(true); expect(view.schedules).toHaveLength(101); expect(view.occurrences).toHaveLength(101);
      expect((await fetch(`${url}&limit=100`, { headers })).status).toBe(400);
      h.access.assertReadInTransaction.mockRejectedValueOnce(new NotFoundException());
      expect((await fetch(url, { headers })).status).toBe(404);
    } finally { await app.close(); }
  });
});
