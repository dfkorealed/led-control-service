import { Prisma } from "@prisma/client";
import { fixturePresenceV2Schema } from "@led-control/shared";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";
import { FixturePresenceIngestionService } from "./fixture-presence-ingestion.service";

const scope = {
  siteId: "22222222-2222-4222-8222-222222222222",
  gatewayId: "55555555-5555-4555-8555-555555555555",
  fixtureId: "66666666-6666-4666-8666-666666666666"
};

describe("FixturePresenceIngestionService", () => {
  it("resolves correlated presence online and clears an older unreachable in the same transaction", async () => {
    const prisma = presencePrisma();
    const refreshId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", batchId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const query = prisma.$queryRaw.getMockImplementation();
    prisma.$queryRaw.mockImplementation(async (q: any) => {
      if (q.sql.includes('FROM "MonitoringRefresh"')) return [{ id: refreshId, siteId: scope.siteId, floorId: "floor", status: "pending", deadlineAt: new Date("2026-09-14T00:00:30Z") }];
      if (q.sql.includes('FROM "MonitoringRefreshBatch"')) return [{ id: batchId, refreshId, siteId: scope.siteId, gatewayId: scope.gatewayId, status: "published", targetFixtureIds: [scope.fixtureId] }];
      if (q.sql.includes('FROM "MonitoringRefreshFixture"')) return [{ refreshId, batchId, siteId: scope.siteId, fixtureId: scope.fixtureId, status: "pending" }];
      return query(q);
    });
    prisma.monitoringRefreshFixture = { update: jest.fn() };
    const receivedAt = new Date("2026-09-14T00:00:12Z");
    await new FixturePresenceIngestionService(prisma).ingest(scope.gatewayId, { ...presence(), refreshId, batchId }, receivedAt);
    expect(prisma.fixture.update.mock.calls[0][0].data).toMatchObject({ lastUnreachableAt: null, lastSeenAt: receivedAt });
    expect(prisma.monitoringRefreshFixture.update).toHaveBeenCalledWith({ where: { refreshId_fixtureId: { refreshId, fixtureId: scope.fixtureId } }, data: { status: "online", errorCode: null, observedAt: receivedAt } });
  });
  it("locks Site, Gateway, then Fixture and stores only presence/freshness state", async () => {
    const prisma = presencePrisma();
    const receivedAt = new Date("2026-09-14T00:00:12.000Z");

    await expect(new FixturePresenceIngestionService(prisma as never).ingest(scope.gatewayId, presence(), receivedAt))
      .resolves.toMatchObject({ eventId: presence().eventId, sequence: 9, fixtureId: scope.fixtureId, status: "ingested" });

    const lockSql = prisma.$queryRaw.mock.calls.map(([query]: [{ sql: string }]) => query.sql);
    expect(lockSql[0]).toMatch(/FROM "Site"[\s\S]*FOR KEY SHARE/);
    expect(lockSql[1]).toMatch(/FROM "Gateway"[\s\S]*FOR KEY SHARE/);
    expect(lockSql[2]).toMatch(/FROM "Fixture" f[\s\S]*FOR UPDATE OF f/);
    expect(prisma.fixture.update).toHaveBeenCalledWith({
      where: { id: scope.fixtureId },
      data: {
        lastSeenAt: receivedAt,
        lastUnreachableAt: null,
        rssi: -41,
        hopCount: null,
        bioControlMode: "sensor",
        bioConfiguredBrightness: null,
        bioRawHighBrightness: 127,
        lastPresenceEventId: presence().eventId,
        lastPresenceSequence: 9n,
        lastPresenceOccurredAt: new Date(presence().occurredAt),
        status: "online",
        statusReason: "reported"
      }
    });
    expect(prisma.fixtureEnergyDailyAggregate.upsert).not.toHaveBeenCalled();
    expect(prisma.fixtureEnergyHourlyAggregate.upsert).not.toHaveBeenCalled();
    expect(prisma.fixtureEnergyStateCursor.upsert).not.toHaveBeenCalled();
  });

  it("acknowledges only an exact replay and rejects an altered event identity", async () => {
    const event = presence();
    const processedEvent = ledger(event);
    const prisma = presencePrisma({ processedEvent });
    const service = new FixturePresenceIngestionService(prisma as never);

    await expect(service.ingest(scope.gatewayId, event)).resolves.toMatchObject({ status: "duplicate" });
    await expect(service.ingest(scope.gatewayId, { ...event, rawHighBrightness: 126 }))
      .rejects.toThrow("fixture presence event identity conflict");
    expect(prisma.fixture.update).not.toHaveBeenCalled();
  });

  it.each<[string, { routeGatewayId?: string; event?: Partial<ReturnType<typeof presence>>; lockedFixture?: boolean }]>([
    ["route gateway", { routeGatewayId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
    ["wire gateway", { event: { gatewayId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } }],
    ["wire site", { event: { siteId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } }],
    ["fixture ownership", { lockedFixture: false }]
  ])("rejects %s scope before writing an ordering ledger", async (_label, variant) => {
    const prisma = presencePrisma({ lockedFixture: variant.lockedFixture });
    const event = { ...presence(), ...variant.event };

    await expect(new FixturePresenceIngestionService(prisma as never).ingest(variant.routeGatewayId ?? scope.gatewayId, event))
      .rejects.toThrow("fixture presence scope rejected");
    expect(prisma.processedGatewayEvent.create).not.toHaveBeenCalled();
    expect(prisma.fixture.update).not.toHaveBeenCalled();
  });

  it("records stale sequence and reverse-time observations without refreshing the fixture", async () => {
    const stale = presencePrisma({ watermark: watermark(10n) });
    await expect(new FixturePresenceIngestionService(stale as never).ingest(scope.gatewayId, presence()))
      .resolves.toMatchObject({ status: "stale_sequence" });
    expect(stale.processedGatewayEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ ingestionStatus: "accepted" }) });
    expect(stale.fixture.update).not.toHaveBeenCalled();

    const reverse = presencePrisma({ lastPresenceOccurredAt: new Date("2026-09-14T00:00:10.000Z") });
    await expect(new FixturePresenceIngestionService(reverse as never).ingest(scope.gatewayId, presence()))
      .resolves.toMatchObject({ status: "stale_sequence" });
    expect(reverse.fixture.update).not.toHaveBeenCalled();
  });

  it("rejects a watermark-only altered replay before reverse-time stale acknowledgement", async () => {
    const original = presence({ occurredAt: "2026-09-14T00:00:10.000Z" });
    const altered = presence({ rawHighBrightness: 126 });
    const prisma = presencePrisma({
      watermark: watermarkFor(original),
      lastPresenceOccurredAt: new Date("2026-09-14T00:00:11.000Z")
    });

    await expect(new FixturePresenceIngestionService(prisma as never).ingest(scope.gatewayId, altered))
      .rejects.toThrow("fixture presence event identity conflict");
    expect(prisma.processedGatewayEvent.create).not.toHaveBeenCalled();
    expect(prisma.fixture.update).not.toHaveBeenCalled();
  });

  it("records future timestamp rejection before watermark or fixture writes", async () => {
    const prisma = presencePrisma();
    const event = presence({ occurredAt: "9999-01-01T00:00:00.000Z" });
    const receivedAt = new Date("2026-09-14T00:00:00.000Z");

    await expect(new FixturePresenceIngestionService(prisma as never).ingest(scope.gatewayId, event, receivedAt))
      .resolves.toMatchObject({ status: "rejected_future_timestamp" });
    expect(prisma.gatewayEventWatermark.upsert).not.toHaveBeenCalled();
    expect(prisma.fixture.update).not.toHaveBeenCalled();
    expect(prisma.processedGatewayEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      eventType: "fixture_presence", ingestionStatus: "rejected_future_timestamp", receivedAt
    }) });
  });

  it.each(["fixture_stale", "gateway_offline"])("restores only persisted freshness status %s", async (statusReason) => {
    const prisma = presencePrisma({ statusReason });
    await new FixturePresenceIngestionService(prisma as never).ingest(scope.gatewayId, presence());
    expect(prisma.fixture.update.mock.calls[0][0].data).toMatchObject({ status: "online", statusReason: "reported" });
  });

  it.each(["fixture_stale", "gateway_offline"])(
    "restores the persisted command failure after freshness marks the fixture %s",
    async (statusReason) => {
      const prisma = presencePrisma({
        statusReason,
        reportedStatus: "offline",
        reportedStatusReason: "command_failed"
      });

      await new FixturePresenceIngestionService(prisma as never).ingest(scope.gatewayId, presence());

      // A presence GET proves only BIO reachability. It must not turn a prior
      // command failure into an operationally controllable online fixture.
      expect(prisma.fixture.update.mock.calls[0][0].data).toMatchObject({
        status: "offline",
        statusReason: "command_failed"
      });
    }
  );

  it.each(["command_failed", "fixture_fault", "provisioning_waiting_state"])("preserves non-freshness status %s", async (statusReason) => {
    const prisma = presencePrisma({ statusReason });
    await new FixturePresenceIngestionService(prisma as never).ingest(scope.gatewayId, presence());
    const data = prisma.fixture.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("status");
    expect(data).not.toHaveProperty("statusReason");
  });
});

function presence(overrides: Partial<{
  siteId: string;
  gatewayId: string;
  fixtureId: string;
  eventId: string;
  sequence: number;
  occurredAt: string;
  controlMode: "sensor" | "force-off" | "force-on";
  rawHighBrightness: number;
  configuredBrightness: number | null;
  rssi: number | null;
  hopCount: number | null;
}> = {}) {
  return fixturePresenceV2Schema.parse({
    ...scope,
    eventId: "99999999-9999-4999-8999-999999999999",
    sequence: 9,
    occurredAt: "2026-09-14T00:00:09.000Z",
    controlMode: "sensor",
    rawHighBrightness: 127,
    configuredBrightness: null,
    rssi: -41,
    hopCount: null,
    ...overrides
  });
}

function ledger(event: ReturnType<typeof presence>) {
  return {
    eventId: event.eventId, gatewayId: scope.gatewayId, fixtureId: scope.fixtureId, sequence: 9n,
    eventType: "fixture_presence", occurredAt: new Date(event.occurredAt), payloadHash: canonicalPayloadHash(event),
    ingestionStatus: "accepted" as const
  };
}

function watermark(lastSequence: bigint) {
  const event = presence();
  return {
    gatewayId: scope.gatewayId, eventType: "fixture_presence", scopeKey: scope.fixtureId, lastSequence,
    lastEventId: "11111111-1111-4111-8111-111111111111", lastPayloadHash: canonicalPayloadHash(event),
    lastOccurredAt: new Date(event.occurredAt)
  };
}

function watermarkFor(event: ReturnType<typeof presence>) {
  return {
    gatewayId: scope.gatewayId, eventType: "fixture_presence", scopeKey: scope.fixtureId, lastSequence: BigInt(event.sequence),
    lastEventId: event.eventId, lastPayloadHash: canonicalPayloadHash(event), lastOccurredAt: new Date(event.occurredAt)
  };
}

function presencePrisma(options: {
  processedEvent?: ReturnType<typeof ledger>;
  watermark?: ReturnType<typeof watermark> | ReturnType<typeof watermarkFor>;
  lockedFixture?: boolean;
  lastPresenceOccurredAt?: Date | null;
  statusReason?: string | null;
  reportedStatus?: "online" | "offline" | "fault";
  reportedStatusReason?: string | null;
} = {}) {
  const row = {
    id: scope.fixtureId, siteId: scope.siteId, gatewayId: scope.gatewayId,
    floorId: "floor", lastUnreachableAt: new Date("2026-09-14T00:00:01Z"),
    lastPresenceOccurredAt: options.lastPresenceOccurredAt ?? null,
    statusReason: options.statusReason ?? "fixture_stale",
    reportedStatus: options.reportedStatus ?? "online",
    reportedStatusReason: options.reportedStatusReason ?? "reported"
  };
  const prisma: any = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn(async (query: { sql: string; values: unknown[] }) => {
      if (query.sql.includes('FROM "Site"')) return query.values.includes(scope.siteId) ? [{ id: scope.siteId }] : [];
      if (query.sql.includes('FROM "Gateway"')) return query.values.includes(scope.gatewayId) && query.values.includes(scope.siteId)
        ? [{ id: scope.gatewayId }] : [];
      return options.lockedFixture === false || !query.values.includes(scope.siteId) || !query.values.includes(scope.gatewayId) ? [] : [row];
    }),
    processedGatewayEvent: {
      findUnique: jest.fn().mockResolvedValue(options.processedEvent ?? null),
      create: jest.fn().mockResolvedValue(undefined)
    },
    gatewayEventWatermark: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(options.watermark ?? null),
      upsert: jest.fn().mockResolvedValue(undefined)
    },
    fixture: { update: jest.fn().mockResolvedValue(undefined) },
    fixtureEnergyDailyAggregate: { upsert: jest.fn() },
    fixtureEnergyHourlyAggregate: { upsert: jest.fn() },
    fixtureEnergyStateCursor: { upsert: jest.fn() }
  };
  prisma.$transaction = jest.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma));
  return prisma;
}
