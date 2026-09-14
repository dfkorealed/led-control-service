import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { GatewayRecommissionService } from "./gateway-recommission.service";

const enabled = process.env.GATEWAY_RECOMMISSION_DISPOSABLE_POSTGRES === "1";

(enabled ? describe : describe.skip)("gateway recommission migration on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;

  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    const deployed = cluster.deploy(url);
    expect(deployed.status).toBe(0);
    db = new PrismaClient({ datasourceUrl: url });
    await db.$connect();
  }, 30_000);

  afterAll(async () => { await db?.$disconnect(); cluster?.stop(); });

  beforeEach(async () => {
    await db.$executeRawUnsafe('TRUNCATE TABLE "Organization" CASCADE');
  });

  it("enforces the named status domain and one active reset fence per inventory", async () => {
    const constraints = await db.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = '"GatewayRecommissionJob"'::regclass AND conname = 'GatewayRecommissionJob_status_check'
    `;
    expect(constraints).toEqual([{ conname: "GatewayRecommissionJob_status_check" }]);
    const insert = (id: string, inventoryId: string, status: string) => db.$executeRawUnsafe(
      `INSERT INTO "GatewayRecommissionJob" ("id", "siteId", "inventoryId", "gatewayId", "serialNumber", "resetDigest", "targetSnapshot", "objectKeys", "status", "updatedAt")
       VALUES ('${id}', 'site-1', '${inventoryId}', 'gateway-1', 'GW-001', 'digest', '{}', '[]', '${status}', now())`
    );
    await expect(insert("job-1", "inventory-1", "prepared")).resolves.toBe(1);
    await expect(insert("job-2", "inventory-1", "mqtt_revoked")).rejects.toThrow();
    await expect(insert("job-3", "inventory-2", "not-a-status")).rejects.toThrow();
    await expect(insert("job-4", "inventory-1", "finalized")).resolves.toBe(1);
  });

  it("persists a real preview/prepare snapshot containing a nonempty watermark", async () => {
    const installation = await seedInstallation();
    await db.gatewayEventWatermark.create({ data: {
      gatewayId: installation.gatewayId, eventType: "fixture_state", scopeKey: "fixture:1",
      lastSequence: 3n, lastEventId: randomUUID(), lastOccurredAt: new Date("2026-09-14T00:00:03.000Z")
    } });
    const recommission = new GatewayRecommissionService(db as never);

    const preview = await recommission.preview(installation);
    const prepared = await recommission.prepare({ ...installation, resetDigest: preview.resetDigest });
    const saved = await db.gatewayRecommissionJob.findUniqueOrThrow({ where: { id: prepared.jobId } });

    expect(preview.counts.gatewayEventWatermark).toBe(1);
    expect(prepared.status).toBe("prepared");
    expect(saved.targetSnapshot)
      .toMatchObject({ deletionIds: { gatewayEventWatermark: [JSON.stringify(["fixture_state", "fixture:1"])] } });
  });

  it("includes open and resolved fixture incidents and changes the digest when an equal-count row is replaced", async () => {
    const installation = await seedInstallation();
    const firstIncident = await fixtureIncident(installation, "open");
    const resolvedIncident = await fixtureIncident(installation, "resolved");
    const recommission = new GatewayRecommissionService(db as never);

    const baseline = await recommission.preview(installation);
    await db.monitoringIncident.delete({ where: { id: firstIncident.id } });
    await fixtureIncident(installation, "open");
    const replaced = await recommission.preview(installation);

    expect(baseline.counts.monitoringIncident).toBe(2);
    expect(replaced.counts.monitoringIncident).toBe(2);
    expect(replaced.resetDigest).not.toBe(baseline.resetDigest);
    expect(resolvedIncident.status).toBe("resolved");
  });

  it("includes retired Site energy identities and daily/hourly aggregate history", async () => {
    const installation = await seedInstallation();
    const retiredFixture = await db.energyFixtureIdentity.create({ data: {
      siteId: installation.siteId, fixtureId: null, trackingStartedAt: new Date("2026-01-01T00:00:00.000Z"), retiredAt: new Date("2026-02-01T00:00:00.000Z")
    } });
    await db.energyGroupIdentity.create({ data: {
      siteId: installation.siteId, groupId: null, trackingStartedAt: new Date("2026-01-01T00:00:00.000Z"), retiredAt: new Date("2026-02-01T00:00:00.000Z")
    } });
    await db.fixtureEnergyDailyAggregate.create({ data: {
      energyFixtureId: retiredFixture.id, fixtureId: null, localDate: new Date("2026-01-02T00:00:00.000Z"), estimatedKwh: "1.0", estimatedCost: "100.0"
    } });
    await db.fixtureEnergyHourlyAggregate.create({ data: {
      energyFixtureId: retiredFixture.id, bucketStartUtc: new Date("2026-01-02T00:00:00.000Z"), localDate: new Date("2026-01-02T00:00:00.000Z"),
      localHour: 9, utcOffsetMinutes: 540, estimatedKwh: "1.0", brightnessWeightedSeconds: "100.0"
    } });

    const preview = await new GatewayRecommissionService(db as never).preview(installation);

    expect(preview.counts.energyFixtureIdentity).toBe(1);
    expect(preview.counts.energyGroupIdentity).toBe(1);
    expect(preview.counts.energyAggregate).toBe(2);
  });

  async function seedInstallation() {
    const organization = await db.organization.create({ data: { name: `recommission-${randomUUID()}` } });
    const site = await db.site.create({ data: { organizationId: organization.id, name: "Recommission site" } });
    const floor = await db.floor.create({ data: { siteId: site.id, name: "B1", level: -1 } });
    const gateway = await db.gateway.create({ data: { siteId: site.id, serialNumber: `GW-${randomUUID()}`, name: "Gateway", firmwareVersion: "test" } });
    await db.gatewayInventory.create({ data: { serialNumber: gateway.serialNumber, claimedGatewayId: gateway.id, claimedAt: new Date() } });
    const node = await db.meshNode.create({ data: { gatewayId: gateway.id, meshAddress: "0x1001", firmwareVersion: "test" } });
    const fixture = await db.fixture.create({ data: { floorId: floor.id, meshNodeId: node.id, name: "L01", ratedWatt: "40", x: 1, y: 1 } });
    return { siteId: site.id, serialNumber: gateway.serialNumber, gatewayId: gateway.id, fixtureId: fixture.id };
  }

  async function fixtureIncident(installation: Awaited<ReturnType<typeof seedInstallation>>, status: "open" | "resolved") {
    const now = new Date("2026-09-14T00:00:00.000Z");
    return db.monitoringIncident.create({ data: {
      siteId: installation.siteId, fixtureId: installation.fixtureId, type: "fixture_stale", targetKey: `fixture:${installation.fixtureId}`,
      status, activeKey: status === "open" ? `${installation.siteId}:fixture_stale:fixture:${installation.fixtureId}` : null,
      openedAt: now, lastObservedAt: now,
      ...(status === "resolved" ? { resolvedAt: now, resolutionKind: "automatic_recovery" } : {})
    } });
  }
});
