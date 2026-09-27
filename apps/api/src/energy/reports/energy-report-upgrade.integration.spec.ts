import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { EnergyReportDocumentBuilder } from "./energy-report-document.builder";
import { EnergyReportSnapshotService } from "./energy-report-snapshot.service";
import { PdfEnergyReportRenderer } from "./pdf-energy-report.renderer";
import type { EnergyReportDocument } from "@led-control/shared";

const databaseUrl = process.env.ENERGY_REPORT_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("report upgrade from pre-analytics persisted daily facts", () => {
  const schema = `report_upgrade_${randomUUID().replaceAll("-", "")}`;
  const siteId = randomUUID(); const fixtureId = randomUUID(); const floorId = randomUUID(); const organizationId = randomUUID();
  let prisma: PrismaClient;
  beforeAll(async () => {
    sql(`CREATE SCHEMA "${schema}";`);
    const url = new URL(databaseUrl!); url.searchParams.set("schema", schema);
    prisma = new PrismaClient({ datasourceUrl: url.toString() });
    const directory = join(__dirname, "../../../prisma/migrations");
    for (const migration of readdirSync(directory).filter(name => /^\d/.test(name)).sort((a, b) => a.localeCompare(b))) {
      if (migration === "20260911120000_energy_analytics_history_hourly") {
        // Current Prisma also INSERTs current defaults (e.g. Site.currency).
        // Seed this historical boundary with its actual column shape instead.
        await prisma.$executeRaw`INSERT INTO "Organization" ("id", "name", "type", "updatedAt") VALUES (${organizationId}, 'Upgrade', 'customer', now())`;
        await prisma.$executeRaw`INSERT INTO "Site" ("id", "organizationId", "name", "timeZone", "tariffKwhRate", "updatedAt")
          VALUES (${siteId}, ${organizationId}, '조명 💡 현장', 'Asia/Seoul', 9999, now())`;
        await prisma.$executeRaw`INSERT INTO "Floor" ("id", "siteId", "name", "level", "updatedAt") VALUES (${floorId}, ${siteId}, '이력 이전 층', 1, now())`;
        await prisma.$executeRaw`INSERT INTO "Fixture" ("id", "floorId", "siteId", "name", "ratedWatt", "x", "y", "updatedAt")
          VALUES (${fixtureId}, ${floorId}, ${siteId}, '기존 조명', 40, 0, 0, now())`;
        // This is the actual old table shape, before energyFixtureId exists. The
        // migration assigns an analytics identity without inventing earlier history.
        await prisma.$executeRaw`INSERT INTO "FixtureEnergyDailyAggregate"
          ("id", "fixtureId", "localDate", "estimatedKwh", "estimatedCost", "knownSeconds", "updatedAt") VALUES
          (${randomUUID()}, ${fixtureId}, '2026-09-01', 0.5, 50, 900, now()),
          (${randomUUID()}, ${fixtureId}, '2026-09-02', 1.25, 187.5, 1800, now())`;
      }
      sql(`SET search_path TO "${schema}", public;\n${readFileSync(join(directory, migration, "migration.sql"), "utf8")}`);
    }
  }, 60_000);
  afterAll(async () => {
    await prisma?.$disconnect();
    sql(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
  });

  it("keeps upgraded authoritative totals/costs but no fabricated historical rankings in PDF", async () => {
    const identity = await prisma.energyFixtureIdentity.findUniqueOrThrow({ where: { fixtureId } });
    expect(identity.trackingStartedAt.getTime()).toBeGreaterThan(Date.parse("2026-09-02T15:00:00Z"));
    const snapshots = new EnergyReportSnapshotService(prisma as never, new EnergyReportDocumentBuilder());
    const { dataSnapshot, documentSnapshot: document } = await snapshots.capture(randomUUID(), siteId,
      { from: "2026-09-02", to: "2026-09-02", scope: "site", identityId: siteId, format: "pdf" }, new Date("2026-09-12T00:00:00Z"));
    expect(dataSnapshot.fixtures[0].daily).toEqual([
      { localDate: "2026-09-01", energyKwh: "0.5", cost: "50", durationSeconds: 900 },
      { localDate: "2026-09-02", energyKwh: "1.25", cost: "187.5", durationSeconds: 1800 }
    ]);
    expect(table(document, "comparison")).toEqual([
      ["현재 기간", "2026-09-02 ~ 2026-09-02", 1.25, 187.5],
      ["직전 동일 일수", "2026-09-01 ~ 2026-09-01", 0.5, 50],
      ["차이", null, 0.75, 137.5], ["변화율", null, 150, 275]
    ]);
    for (const kind of ["fixture", "floor", "group"]) expect(table(document, `${kind}-ranking`)).toEqual([]);
    const pdf = await new PdfEnergyReportRenderer().render(document);
    expect(pdf.bytes.length).toBeGreaterThan(0);
    expect(document).toMatchObject({ schemaVersion: 2, calculationBasis: { tariffKwhRate: "9999", baselineReason: "dimension_history_missing", expectedSeconds: null, knownSeconds: null } });
    expect(JSON.stringify(document)).not.toMatch(/forecast|carbon|emission|탄소|최적화/i);
    const retiredId = randomUUID();
    await prisma.energyFixtureIdentity.create({ data: { id: retiredId, siteId,
      trackingStartedAt: new Date("2026-09-01T00:00:00Z"), retiredAt: new Date("2026-09-02T03:00:00Z"),
      dimensionVersions: { create: { name: "종료 조명", floorId, floorName: "이력 이전 층", ratedWatt: 40,
        effectiveFrom: new Date("2026-09-01T00:00:00Z"), effectiveTo: new Date("2026-09-02T03:00:00Z") } },
      dailyAggregates: { create: { localDate: new Date("2026-09-02"), estimatedKwh: 0.25, estimatedCost: 25, knownSeconds: 1800 } }
    } });
    const retired = await snapshots.capture(randomUUID(), siteId,
      { from: "2026-09-02", to: "2026-09-02", scope: "site", identityId: siteId, format: "pdf" }, new Date("2026-09-12T00:00:00Z"));
    expect(retired.documentSnapshot.sections[0]).toMatchObject({ rows: [
      { label: "사용 전력량", value: 1.5, source: "persisted_actual" }, { label: "저장 비용", value: 212.5, source: "persisted_actual" },
      { label: "24시간 기준 전력량", value: null, source: "captured_current_configuration" },
      { label: "절감 전력량", value: null, source: "captured_current_configuration" },
      { label: "절감률", value: null, source: "captured_current_configuration" },
      { label: "현재 단가 기준 비용", value: null, source: "captured_current_configuration" },
      { label: "예상 절감 비용", value: null, source: "captured_current_configuration" },
      { label: "데이터 수집률", value: null, source: "captured_current_configuration" }
    ] });
    expect(table(retired.documentSnapshot, "fixture-ranking")).toEqual([]);
  }, 30_000);

  function sql(input: string) {
    const result = spawnSync("psql", ["-q", "-v", "ON_ERROR_STOP=1", databaseUrl!], { input, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
});

function table(document: EnergyReportDocument, id: string) {
  const section = document.sections.find(section => section.kind === "table" && section.id === id);
  if (section?.kind !== "table") throw new Error("missing table");
  return section.rows.map(row => row.map(cell => cell.value));
}
