import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { EnergyReportDocumentBuilder } from "./energy-report-document.builder";
import { EnergyReportSnapshotService } from "./energy-report-snapshot.service";
import type { PrismaService } from "../../prisma/prisma.service";

const reportId = "10000000-0000-4000-8000-000000000001";
const siteId = "20000000-0000-4000-8000-000000000001";
const fixtureId = "30000000-0000-4000-8000-000000000001";
const request = { from: "2026-09-07", to: "2026-09-08", scope: "site", identityId: siteId, format: "xlsx" };
const decimal = (value: string) => new Prisma.Decimal(value);
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

function setup(timeZone = "Asia/Seoul") {
  const row = {
    id: fixtureId, trackingStartedAt: new Date("2026-09-01T15:00:00Z"), retiredAt: null,
    dimensionVersions: [{ name: "등 A", floorId: "40000000-0000-4000-8000-000000000001", floorName: "1층", ratedWatt: decimal("40"), effectiveFrom: new Date("2026-09-01T15:00:00Z"), effectiveTo: null }],
    groupMemberships: [],
    dailyAggregates: [{ localDate: day("2026-09-07"), estimatedKwh: decimal("0.200000000001"), estimatedCost: decimal("187.5"), knownSeconds: 60 }],
    hourlyAggregates: [{ bucketStartUtc: new Date("2026-09-07T01:00:00Z"), localDate: day("2026-09-07"), localHour: 10, estimatedKwh: decimal("0.200000000001"), knownSeconds: 60, brightnessWeightedSeconds: decimal("1200") }]
  };
  const tx = {
    site: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: siteId, name: "서울 현장", timeZone, tariffKwhRate: null }) },
    energyFixtureIdentity: { findMany: jest.fn().mockResolvedValue([row]) },
    energyGroupIdentity: { findFirst: jest.fn().mockResolvedValue(null) },
    floor: { findFirst: jest.fn().mockResolvedValue(null) }
  };
  const prisma = { $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) };
  return { tx, prisma, row, service: new EnergyReportSnapshotService(prisma as unknown as PrismaService, new EnergyReportDocumentBuilder()) };
}

describe("EnergyReportSnapshotService", () => {
  it("freezes current tariff and historical watts alongside the original stored costs", async () => {
    const { service, tx, row } = setup();
    tx.site.findUniqueOrThrow.mockResolvedValue({ id: siteId, name: "서울 현장", timeZone: "Asia/Seoul", tariffKwhRate: decimal("160") });
    Object.assign(row.dimensionVersions[0], { ratedWatt: decimal("40") });
    const captured = await service.capture(reportId, siteId, request, new Date("2026-09-09T00:00:00Z"));
    expect(captured.dataSnapshot).toMatchObject({ schemaVersion: 2, site: { tariffKwhRate: "160" }, fixtures: [{ dimensions: [{ ratedWatt: "40" }] }] });
    expect(captured.documentSnapshot).toMatchObject({ schemaVersion: 2, calculationBasis: { expectedSeconds: 172800 } });
    expect(captured.dataSnapshot.fixtures[0].daily[0].cost).toBe("187.5");
  });
  it("preserves cost and exact UTC bucket/history instants in the immutable data", async () => {
    const { service } = setup();
    const { dataSnapshot } = await service.capture(reportId, siteId, request, new Date("2026-09-09T00:00:00Z"));
    expect(dataSnapshot.fixtures[0]).toMatchObject({
      from: "2026-09-01T15:00:00.000Z",
      daily: [{ cost: "187.5" }], hourly: [{ bucketStartUtc: "2026-09-07T01:00:00.000Z" }]
    });
  });
  it("captures one RepeatableRead view with explicit persisted-only selects and decimal-preserving snapshots", async () => {
    const { tx, prisma, row, service } = setup();
    const result = await service.capture(reportId, siteId, request, new Date("2026-09-08T15:00:00Z"));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    const query = tx.energyFixtureIdentity.findMany.mock.calls[0][0] as unknown as { select: Record<string, any>; where: unknown };
    expect(query.where).toEqual({ siteId });
    expect(query.select.dailyAggregates.where.localDate).toEqual({ gte: day("2026-09-05"), lte: day("2026-09-08") });
    expect(query.select.hourlyAggregates.where.localDate).toEqual({ gte: day("2026-09-07"), lte: day("2026-09-08") });
    expect(query.select.dailyAggregates.select).toEqual({ localDate: true, estimatedKwh: true, estimatedCost: true, knownSeconds: true });
    expect(query.select.hourlyAggregates.select).toEqual({ bucketStartUtc: true, localDate: true, localHour: true, estimatedKwh: true, knownSeconds: true, brightnessWeightedSeconds: true });
    expect(query.select.dimensionVersions.select.ratedWatt).toBe(true);
    expect(JSON.stringify(query)).not.toMatch(/cursor|unknownSeconds|powerOn|forecast/i);
    expect(result.dataSnapshot.fixtures[0]).toMatchObject({ from: "2026-09-01T15:00:00.000Z", daily: [{ energyKwh: "0.200000000001", durationSeconds: 60 }] });
    expect(result.requestSnapshot).toEqual(request);
    expect(JSON.stringify(result.dataSnapshot)).not.toMatch(/known|unknown|estimated|forecast|baseline|coverage/i);
    row.dailyAggregates[0].estimatedKwh = decimal("999");
    expect(result.dataSnapshot.fixtures[0].daily[0].energyKwh).toBe("0.200000000001");
    expect(result.documentSnapshot.sections[0]).toMatchObject({ rows: expect.arrayContaining([expect.objectContaining({ label: "사용 전력량", value: 0.2 }), expect.objectContaining({ label: "저장 비용", value: 187.5 })]) });
  });

  it.each(["2026-09-08T14:59:59Z", "2026-09-07T15:00:00Z"])("rejects an unfinished site-local date at %s before aggregate reads", async (now) => {
    const { service, tx } = setup();
    await expect(service.capture(reportId, siteId, request, new Date(now))).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.energyFixtureIdentity.findMany).not.toHaveBeenCalled();
  });

  it("uses the site's date rather than UTC and handles the DST completion boundary", async () => {
    const { service, tx } = setup("America/New_York");
    const dstRequest = { ...request, from: "2026-11-01", to: "2026-11-01" };
    await expect(service.capture(reportId, siteId, dstRequest, new Date("2026-11-02T04:59:59Z"))).rejects.toBeInstanceOf(BadRequestException);
    tx.energyFixtureIdentity.findMany.mockResolvedValue([]);
    const result = await service.capture(reportId, siteId, dstRequest, new Date("2026-11-02T05:00:00Z"));
    expect(result.dataSnapshot.comparisonRange).toEqual({ from: "2026-10-31", to: "2026-10-31" });
    expect(result.dataSnapshot).toMatchObject({ completedDays: [{ localDate: "2026-11-01", from: "2026-11-01T04:00:00.000Z", to: "2026-11-02T05:00:00.000Z", seconds: 90000 }] });
  });

  it.each([
    { ...request, to: "2026-09-06" },
    { ...request, from: "invalid" },
    { ...request, forecast: true }
  ])("rejects invalid requests without reading the database", async (input) => {
    const { service, prisma } = setup();
    await expect(service.capture(reportId, siteId, input)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(["site", "fixture", "floor", "group"])("rejects another site's %s identity", async (scope) => {
    const { service } = setup();
    await expect(service.capture(reportId, siteId, { ...request, scope, identityId: "90000000-0000-4000-8000-000000000001" }, new Date("2026-09-09T00:00:00Z")))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it("intersects membership, group lifecycle and historical group-name validity", async () => {
    const { service, row } = setup();
    Object.assign(row, { groupMemberships: [{
      energyGroupId: "50000000-0000-4000-8000-000000000001", effectiveFrom: day("2026-09-01"), effectiveTo: null,
      energyGroup: { trackingStartedAt: day("2026-09-03"), retiredAt: day("2026-09-08"), dimensionVersions: [
        { name: "통로", effectiveFrom: day("2026-09-02"), effectiveTo: day("2026-09-07") },
        { name: "변경 통로", effectiveFrom: day("2026-09-07"), effectiveTo: null }
      ] }
    }] });
    const result = await service.capture(reportId, siteId, request, new Date("2026-09-09T00:00:00Z"));
    expect(result.dataSnapshot.fixtures[0].groups).toEqual([
      { id: "50000000-0000-4000-8000-000000000001", name: "통로", from: "2026-09-03T00:00:00.000Z", to: "2026-09-07T00:00:00.000Z" },
      { id: "50000000-0000-4000-8000-000000000001", name: "변경 통로", from: "2026-09-07T00:00:00.000Z", to: "2026-09-08T00:00:00.000Z" }
    ]);
    expect(result.dataSnapshot.fixtures[0]).toMatchObject({ memberships: [
      { id: "50000000-0000-4000-8000-000000000001", from: "2026-09-03T00:00:00.000Z", to: "2026-09-08T00:00:00.000Z" }
    ] });
  });
});
