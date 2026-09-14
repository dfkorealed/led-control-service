import { PrismaService } from "../prisma/prisma.service";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { FixturePresenceIngestionService } from "./fixture-presence-ingestion.service";

let databaseUrl = process.env.FIXTURE_PRESENCE_TEST_DATABASE_URL;
const selfOwnedDatabase = process.env.FIXTURE_PRESENCE_DISPOSABLE_POSTGRES === "1";
const describeWithDatabase = databaseUrl || selfOwnedDatabase ? describe : describe.skip;

describeWithDatabase("fixture-presence PostgreSQL ingestion", () => {
  const ids = {
    organizationId: "31000000-0000-4000-8000-000000000001",
    siteId: "31000000-0000-4000-8000-000000000002",
    floorId: "31000000-0000-4000-8000-000000000003",
    gatewayId: "31000000-0000-4000-8000-000000000004",
    meshNodeId: "31000000-0000-4000-8000-000000000005",
    fixtureId: "31000000-0000-4000-8000-000000000006",
    energyFixtureId: "31000000-0000-4000-8000-000000000008"
  };
  let prisma: PrismaService;
  let service: FixturePresenceIngestionService;
  let cluster: Awaited<ReturnType<typeof disposablePostgres>> | undefined;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    if (selfOwnedDatabase) {
      cluster = await disposablePostgres();
      databaseUrl = cluster.database();
      const deployed = cluster.deploy(databaseUrl);
      expect(deployed.status).toBe(0);
      expect(deployed.stderr).not.toContain("Error");
    }
    process.env.DATABASE_URL = databaseUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    service = new FixturePresenceIngestionService(prisma);
    await prisma.organization.upsert({ where: { id: ids.organizationId }, create: { id: ids.organizationId, name: "Presence integration", type: "customer" }, update: {} });
    await prisma.site.upsert({ where: { id: ids.siteId }, create: { id: ids.siteId, organizationId: ids.organizationId, name: "Presence site" }, update: {} });
    await prisma.floor.upsert({ where: { id: ids.floorId }, create: { id: ids.floorId, siteId: ids.siteId, name: "B1", level: -1 }, update: { siteId: ids.siteId } });
    await prisma.gateway.upsert({ where: { id: ids.gatewayId }, create: { id: ids.gatewayId, siteId: ids.siteId, name: "Presence gateway", serialNumber: "PRESENCE-GW-001", firmwareVersion: "integration" }, update: { siteId: ids.siteId } });
    await prisma.meshNode.upsert({ where: { id: ids.meshNodeId }, create: { id: ids.meshNodeId, gatewayId: ids.gatewayId, deviceUuid: "presence-node", meshAddress: "0x1301", firmwareVersion: "integration" }, update: { gatewayId: ids.gatewayId } });
  });

  beforeEach(async () => {
    await prisma.processedGatewayEvent.deleteMany({ where: { gatewayId: ids.gatewayId } });
    await prisma.gatewayEventWatermark.deleteMany({ where: { gatewayId: ids.gatewayId } });
    await prisma.fixtureEnergyDailyAggregate.deleteMany({ where: { fixtureId: ids.fixtureId } });
    await prisma.fixtureEnergyHourlyAggregate.deleteMany({ where: { energyFixtureId: ids.energyFixtureId } });
    await prisma.fixtureEnergyStateCursor.deleteMany({ where: { fixtureId: ids.fixtureId } });
    const fixtureBaseline = {
      meshNodeId: ids.meshNodeId,
      brightness: 38,
      powerOn: null,
      lastStateEventId: "31111111-1111-4111-8111-111111111111",
      lastStateSequence: 4n,
      lastStateOccurredAt: new Date("2026-09-14T00:00:04.000Z"),
      lastPresenceEventId: null,
      lastPresenceSequence: null,
      lastPresenceOccurredAt: null,
      status: "offline" as const,
      statusReason: "fixture_stale"
    };
    await prisma.fixture.upsert({
      where: { id: ids.fixtureId },
      create: { id: ids.fixtureId, floorId: ids.floorId, name: "B1-L01", ratedWatt: "40.00", x: 10, y: 10, ...fixtureBaseline },
      update: fixtureBaseline
    });
    await prisma.energyFixtureIdentity.upsert({ where: { fixtureId: ids.fixtureId }, create: { id: ids.energyFixtureId, siteId: ids.siteId, fixtureId: ids.fixtureId, trackingStartedAt: new Date("2026-09-14T00:00:00.000Z") }, update: { retiredAt: null } });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    cluster?.stop();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("updates liveness and BIO metadata without changing output state or energy", async () => {
    const receivedAt = new Date("2026-09-14T00:00:12.000Z");
    const event = presence();
    await expect(service.ingest(ids.gatewayId, event, receivedAt)).resolves.toMatchObject({ status: "ingested" });

    const saved = await prisma.fixture.findUniqueOrThrow({ where: { id: ids.fixtureId } });
    expect(saved).toMatchObject({ lastSeenAt: receivedAt, rssi: -41, hopCount: null, bioControlMode: "sensor", bioConfiguredBrightness: null, bioRawHighBrightness: 127, brightness: 38, powerOn: null, lastStateEventId: "31111111-1111-4111-8111-111111111111", lastPresenceEventId: event.eventId, lastPresenceSequence: 9n, lastPresenceOccurredAt: new Date(event.occurredAt), status: "online", statusReason: "reported" });
    expect(await prisma.fixtureEnergyDailyAggregate.count({ where: { fixtureId: ids.fixtureId } })).toBe(0);
    expect(await prisma.fixtureEnergyHourlyAggregate.count({ where: { energyFixtureId: ids.energyFixtureId } })).toBe(0);
    expect(await prisma.fixtureEnergyStateCursor.count({ where: { fixtureId: ids.fixtureId } })).toBe(0);
  });

  it.each(["command_failed", "fixture_fault", "provisioning_waiting_state"])("does not clear non-freshness blocker %s", async (statusReason) => {
    await prisma.fixture.update({ where: { id: ids.fixtureId }, data: { status: statusReason === "fixture_fault" ? "fault" : "offline", statusReason } });
    await service.ingest(ids.gatewayId, presence());
    expect(await prisma.fixture.findUniqueOrThrow({ where: { id: ids.fixtureId } })).toMatchObject({ statusReason });
  });

  function presence(overrides: Record<string, unknown> = {}) {
    return {
      siteId: ids.siteId, gatewayId: ids.gatewayId, fixtureId: ids.fixtureId,
      eventId: "31000000-0000-4000-8000-000000000007", sequence: 9, occurredAt: "2026-09-14T00:00:09.000Z",
      controlMode: "sensor" as const, rawHighBrightness: 127, configuredBrightness: null, rssi: -41, hopCount: null, ...overrides
    };
  }
});
