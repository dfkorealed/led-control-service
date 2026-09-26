import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { SitesService } from "./sites.service";

const enabled = process.env.DASHBOARD_INTEGRATION_TEST === "1";

(enabled ? describe : describe.skip)("dashboard summaries on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;

  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    const migrated = cluster.deploy(url);
    expect(migrated.stderr + migrated.stdout).not.toMatch(/Error:|P30\d\d/);
    expect(migrated.status).toBe(0);
    db = new PrismaClient({ datasourceUrl: url });
  }, 60_000);

  afterAll(async () => { await db?.$disconnect(); cluster?.stop(); });

  it("returns 1,000 registered fixture counts without serializing any fixture detail", async () => {
    const organizationId = randomUUID(), siteId = randomUUID(), first = randomUUID(), second = randomUUID();
    await db.organization.create({ data: { id: organizationId, name: "Dashboard fixture" } });
    await db.site.create({ data: { id: siteId, organizationId, name: "Factory" } });
    await db.floor.createMany({ data: [
      { id: first, siteId, name: "B1", level: -1, mapRevision: 5 },
      { id: second, siteId, name: "1F", level: 1, mapRevision: 6 }
    ] });
    await db.fixture.createMany({ data: Array.from({ length: 1000 }, (_, index) => ({
      siteId, floorId: index < 600 ? first : second, name: `Fixture ${index}`,
      ratedWatt: "40", x: 0, y: 0, brightness: 20,
      reportedStatus: index < 500 ? "online" as const : index < 750 ? "fault" as const : "offline" as const
    })) });
    const service = new SitesService(db as never, {} as never);

    const dashboard = await service.getDashboardById(siteId, false);
    expect(dashboard.summary).toMatchObject({ totalFixtures: 1000, onlineFixtures: 500, faultFixtures: 250, offlineFixtures: 250 });
    expect(dashboard.floors.map((floor) => floor.summary)).toEqual([
      { totalFixtures: 600, onlineFixtures: 500, faultFixtures: 100, offlineFixtures: 0 },
      { totalFixtures: 400, onlineFixtures: 0, faultFixtures: 150, offlineFixtures: 250 }
    ]);
    expect(dashboard.floors.every((floor) => floor.fixtures.length === 0 && floor.mapConfigured === false)).toBe(true);
    expect(JSON.stringify(dashboard).length).toBeLessThan(10_000);
  });
});
