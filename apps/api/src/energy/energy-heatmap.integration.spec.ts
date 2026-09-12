import { Prisma } from "@prisma/client";
import { energyHeatmapResponseSchema } from "@led-control/shared";
import { PrismaService } from "../prisma/prisma.service";
import { EnergyHeatmapService } from "./energy-heatmap.service";
import { randomUUID } from "node:crypto";
import { EnergyReportSnapshotService } from "./reports/energy-report-snapshot.service";
import { EnergyReportDocumentBuilder } from "./reports/energy-report-document.builder";

const databaseUrl = process.env.ENERGY_QUERY_TEST_DATABASE_URL ?? process.env.FIXTURE_STATE_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("energy heatmap PostgreSQL query", () => {
  const ids = {
    organizationId: "32000000-0000-4000-8000-000000000001",
    siteId: "32000000-0000-4000-8000-000000000002",
    floorId: "32000000-0000-4000-8000-000000000003",
    fixtureId: "32000000-0000-4000-8000-000000000004",
    energyFixtureId: "32000000-0000-4000-8000-000000000005"
  };
  const user = { id: "user", organizationId: ids.organizationId, organizationType: "customer", role: "admin" } as never;
  let prisma: PrismaService;
  let service: EnergyHeatmapService;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    service = new EnergyHeatmapService(prisma, { assert: jest.fn().mockResolvedValue({ id: ids.siteId }) } as never);
    await prisma.organization.upsert({ where: { id: ids.organizationId }, create: { id: ids.organizationId, name: "Heatmap", type: "customer" }, update: {} });
    await prisma.site.upsert({
      where: { id: ids.siteId },
      create: { id: ids.siteId, organizationId: ids.organizationId, name: "Heatmap", address: "Test", tariffKwhRate: "100", timeZone: "America/New_York" },
      update: { timeZone: "America/New_York" }
    });
    await prisma.floor.upsert({ where: { id: ids.floorId }, create: { id: ids.floorId, siteId: ids.siteId, name: "B1", level: -1 }, update: { siteId: ids.siteId } });
    await prisma.fixture.upsert({
      where: { id: ids.fixtureId },
      create: { id: ids.fixtureId, floorId: ids.floorId, name: "B1-L01", ratedWatt: "40", x: 0, y: 0, energyTrackingStartedAt: new Date("2026-01-01T00:00:00.000Z") },
      update: { floorId: ids.floorId }
    });
    await prisma.energyFixtureIdentity.upsert({
      where: { fixtureId: ids.fixtureId },
      create: { id: ids.energyFixtureId, siteId: ids.siteId, fixtureId: ids.fixtureId, trackingStartedAt: new Date("2026-01-01T00:00:00.000Z") },
      update: { retiredAt: null }
    });
  });

  beforeEach(async () => {
    await prisma.fixtureEnergyHourlyAggregate.deleteMany({ where: { energyFixtureId: ids.energyFixtureId } });
    await prisma.energyFixtureDimensionVersion.deleteMany({ where: { energyFixtureId: ids.energyFixtureId } });
    await prisma.energyFixtureDimensionVersion.create({ data: {
      energyFixtureId: ids.energyFixtureId, name: "B1-L01", floorId: ids.floorId, floorName: "B1", ratedWatt: "40", effectiveFrom: new Date("2026-01-01T00:00:00.000Z")
    } });
  });

  afterAll(async () => {
    await prisma.site.delete({ where: { id: ids.siteId } });
    await prisma.organization.delete({ where: { id: ids.organizationId } });
    await prisma.$disconnect();
  });

  it("assigns 09:00 before and 15:00 after a noon floor/group transfer using exact bucket instants, including report snapshots", async () => {
    const otherFloorId = randomUUID(); const oldGroupId = randomUUID(); const newGroupId = randomUUID();
    const noon = new Date("2026-09-02T03:00:00Z");
    await prisma.site.update({ where: { id: ids.siteId }, data: { timeZone: "Asia/Seoul" } });
    await prisma.floor.create({ data: { id: otherFloorId, siteId: ids.siteId, name: "2층", level: 2 } });
    await prisma.energyFixtureDimensionVersion.updateMany({ where: { energyFixtureId: ids.energyFixtureId }, data: { effectiveTo: noon } });
    await prisma.energyFixtureDimensionVersion.create({ data: { energyFixtureId: ids.energyFixtureId,
      name: "이동 조명", floorId: otherFloorId, floorName: "2층", ratedWatt: 40, effectiveFrom: noon } });
    for (const [id, name, from, to] of [
      [oldGroupId, "기존 그룹", new Date("2026-01-01T00:00:00Z"), noon],
      [newGroupId, "이동 그룹", noon, null]
    ] as const) {
      await prisma.energyGroupIdentity.create({ data: { id, siteId: ids.siteId, trackingStartedAt: from,
        dimensionVersions: { create: { name, effectiveFrom: from } },
        memberships: { create: { energyFixtureId: ids.energyFixtureId, effectiveFrom: from, effectiveTo: to } }
      } });
    }
    await prisma.fixtureEnergyHourlyAggregate.createMany({ data: [
      row("2026-09-02T00:00:00Z", "2026-09-02", 9, 540, "1", 20),
      row("2026-09-02T06:00:00Z", "2026-09-02", 15, 540, "2", 80)
    ] });
    await prisma.fixtureEnergyDailyAggregate.createMany({ data: [
      { energyFixtureId: ids.energyFixtureId, localDate: new Date("2026-09-02"), estimatedKwh: 3, estimatedCost: 450, knownSeconds: 7200 },
      { energyFixtureId: ids.energyFixtureId, localDate: new Date("2026-09-03"), estimatedKwh: 0.5, estimatedCost: 75, knownSeconds: 3600 }
    ] });
    const snapshots = new EnergyReportSnapshotService(prisma, new EnergyReportDocumentBuilder());
    for (const [scope, identityId, morning, afternoon] of [
      ["floor", ids.floorId, 1, null], ["floor", otherFloorId, null, 2],
      ["group", oldGroupId, 1, null], ["group", newGroupId, null, 2]
    ] as const) {
      const range = { from: "2026-09-02", to: "2026-09-02", scope, identityId };
      const result = await service.getHeatmap(user, ids.siteId, { ...range, metric: "energy" });
      expect([result.cells[81].value, result.cells[87].value]).toEqual([morning, afternoon]);
      const { documentSnapshot } = await snapshots.capture(randomUUID(), ids.siteId, { ...range, format: "xlsx" }, new Date("2026-09-04"));
      const heatmap = documentSnapshot.sections.find(section => section.kind === "heatmap" && section.metric === "energy");
      if (heatmap?.kind !== "heatmap") throw new Error("missing report heatmap");
      expect([heatmap.cells[81].value, heatmap.cells[87].value]).toEqual([morning, afternoon]);
      const daily = documentSnapshot.sections.find(section => section.kind === "table" && section.id === "daily");
      expect(daily).toMatchObject({ rows: [[{ value: "2026-09-02" }, { value: null }, { value: null }]] });
    }
    const { documentSnapshot: report } = await snapshots.capture(randomUUID(), ids.siteId,
      { from: "2026-09-02", to: "2026-09-03", scope: "site", identityId: ids.siteId, format: "pdf" }, new Date("2026-09-04"));
    expect(report.sections[0]).toMatchObject({ rows: [{ value: 3.5 }, { value: 525 }] });
    const ranking = report.sections.find(section => section.kind === "table" && section.id === "floor-ranking");
    expect(ranking).toMatchObject({ rows: [[{ value: 1 }, { value: otherFloorId }, { value: "2층" }, { value: 0.5 }, { value: 75 }]] });
  }, 15_000);

  it("merges repeated DST local hours and retains an observed zero", async () => {
    await prisma.fixtureEnergyHourlyAggregate.createMany({ data: [
      row("2026-11-01T05:00:00.000Z", "2026-11-01", 1, -240, "0.75", 20),
      row("2026-11-01T06:00:00.000Z", "2026-11-01", 1, -300, "1.25", 80),
      row("2026-11-03T09:00:00.000Z", "2026-11-03", 4, -300, "0", 0)
    ] });

    const energy = await service.getHeatmap(user, ids.siteId, {
      scope: "fixture", identityId: ids.energyFixtureId, metric: "energy", from: "2026-11-01", to: "2026-11-07"
    });
    const brightness = await service.getHeatmap(user, ids.siteId, {
      scope: "fixture", identityId: ids.energyFixtureId, metric: "brightness", from: "2026-11-01", to: "2026-11-07"
    });

    expect(energy.cells[1].value).toBe(2);
    expect(brightness.cells[1].value).toBe(50);
    expect(energy.cells[52].value).toBe(0);
    expect(energy.cells[0].value).toBeNull();
    expect(energyHeatmapResponseSchema.safeParse(energy).success).toBe(true);
  }, 15_000);

  function row(bucketStartUtc: string, localDate: string, localHour: number, utcOffsetMinutes: number, estimatedKwh: string, brightness: number) {
    return {
      energyFixtureId: ids.energyFixtureId, bucketStartUtc: new Date(bucketStartUtc), localDate: new Date(`${localDate}T00:00:00.000Z`),
      localHour, utcOffsetMinutes, estimatedKwh: new Prisma.Decimal(estimatedKwh), knownSeconds: 3_600, unknownSeconds: 0,
      brightnessWeightedSeconds: new Prisma.Decimal(brightness * 3_600)
    };
  }
});
