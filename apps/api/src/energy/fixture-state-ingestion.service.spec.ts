import { Prisma } from "@prisma/client";
import { fixtureStateV2Schema } from "@led-control/shared";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";
import {
  closeFixtureEnergyForRatedWattChange,
  closeSiteEnergyForSettingsChange,
  FixtureStateIngestionService
} from "./fixture-state-ingestion.service";

const scope = {
  siteId: "22222222-2222-4222-8222-222222222222",
  gatewayId: "55555555-5555-4555-8555-555555555555",
  fixtureId: "66666666-6666-4666-8666-666666666666",
  energyFixtureId: "77777777-7777-4777-8777-777777777777"
};

describe("FixtureStateIngestionService", () => {
  it("resolves correlated state online and clears unreachable without bypassing energy ingestion", async () => {
    const prisma = fixturePrisma();
    const refreshId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", batchId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const query = prisma.$queryRaw.getMockImplementation();
    prisma.$queryRaw.mockImplementation(async (q: any) => {
      if (q.sql.includes('FROM "Gateway"')) return [{ id: scope.gatewayId }];
      if (q.sql.includes('FROM "MonitoringRefresh"')) return [{ id: refreshId, siteId: scope.siteId, floorId: prisma.__row.floorId, status: "pending", deadlineAt: new Date("2026-08-26T00:00:30Z") }];
      if (q.sql.includes('FROM "MonitoringRefreshBatch"')) return [{ id: batchId, refreshId, siteId: scope.siteId, gatewayId: scope.gatewayId, status: "published", targetFixtureIds: [scope.fixtureId] }];
      if (q.sql.includes('FROM "MonitoringRefreshFixture"')) return [{ refreshId, batchId, siteId: scope.siteId, fixtureId: scope.fixtureId, status: "pending" }];
      return query(q);
    });
    prisma.monitoringRefreshFixture = { update: jest.fn() };
    const receivedAt = new Date("2026-08-26T00:00:12Z");
    await new FixtureStateIngestionService(prisma).ingest(scope.gatewayId, { ...fixtureEvent(9), refreshId, batchId }, receivedAt);
    expect(prisma.fixture.update.mock.calls[0][0].data).toMatchObject({ lastUnreachableAt: null, brightness: 70, powerOn: true });
    expect(prisma.monitoringRefreshFixture.update).toHaveBeenCalledWith({ where: { refreshId_fixtureId: { refreshId, fixtureId: scope.fixtureId } }, data: { status: "online", errorCode: null, observedAt: receivedAt } });
    expect(prisma.fixtureEnergyStateCursor.upsert).toHaveBeenCalledTimes(1);
  });
  it("recognizes the latest exact replay after raw ledger deletion without reapplying energy", async () => {
    const prisma = fixturePrisma({ watermark: fixtureWatermark(), lastStateSequence: 9n });
    const service = new FixtureStateIngestionService(prisma as never);
    await expect(service.ingest(scope.gatewayId, fixtureEvent(9))).resolves.toMatchObject({ status: "duplicate" });
    expect(prisma.fixture.update).not.toHaveBeenCalled();
    expect(prisma.fixtureEnergyDailyAggregate.upsert).not.toHaveBeenCalled();
  });

  it("rejects a corrupt latest replay after raw ledger deletion", async () => {
    const prisma = fixturePrisma({ watermark: fixtureWatermark(), lastStateSequence: 9n });
    const service = new FixtureStateIngestionService(prisma as never);
    await expect(service.ingest(scope.gatewayId, { ...fixtureEvent(9), brightness: 20 })).rejects.toThrow("conflict");
    expect(prisma.fixture.update).not.toHaveBeenCalled();
  });

  it("shares the site lock before exclusively locking the fixture and reading energy settings", async () => {
    const prisma = fixturePrisma();
    const service = new FixtureStateIngestionService(prisma as never);

    await service.ingest(scope.gatewayId, fixtureEvent(9));

    const lockSql = prisma.$queryRaw.mock.calls.map(([query]: [{ sql: string }]) => query.sql);
    expect(lockSql[0]).toMatch(/FROM "Site"[\s\S]*FOR KEY SHARE/);
    expect(lockSql[1]).toMatch(/FROM "Fixture" f[\s\S]*FOR UPDATE OF f/);
  });

  it("atomically persists the ledger, aggregate, checkpoint, and latest fixture snapshot", async () => {
    const prisma = fixturePrisma();
    const service = new FixtureStateIngestionService(prisma as never);

    await expect(service.ingest(scope.gatewayId, fixtureEvent(9))).resolves.toMatchObject({
      status: "ingested",
      eventId: fixtureEvent(9).eventId,
      sequence: 9,
      fixtureId: scope.fixtureId
    });

    expect(prisma.fixtureEnergyDailyAggregate.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { energyFixtureId_localDate: { energyFixtureId: scope.energyFixtureId, localDate: new Date("2026-08-26T00:00:00.000Z") } },
      update: expect.objectContaining({ unknownSeconds: { increment: 9 } })
    }));
    expect(prisma.fixtureEnergyHourlyAggregate.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { energyFixtureId_bucketStartUtc: {
        energyFixtureId: scope.energyFixtureId,
        bucketStartUtc: new Date("2026-08-26T00:00:00.000Z")
      } },
      update: expect.objectContaining({ unknownSeconds: { increment: 9 } })
    }));
    expect(prisma.fixtureEnergyStateCursor.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { fixtureId: scope.fixtureId },
      update: expect.objectContaining({ aggregatedThrough: new Date("2026-08-26T00:00:09.000Z") })
    }));
    expect(prisma.fixture.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: scope.fixtureId },
      data: expect.objectContaining({ brightness: 70, powerOn: true, firstStateOccurredAt: new Date("2026-08-26T00:00:09.000Z"),
        reportedStatus: "online", reportedStatusReason: "reported" })
    }));
    expect(prisma.processedGatewayEvent.create).toHaveBeenCalledTimes(1);
  });

  it("records a future event as a terminal rejection before cursor or aggregate work", async () => {
    const prisma = fixturePrisma();
    const service = new FixtureStateIngestionService(prisma as never);
    const receivedAt = new Date("2026-08-26T00:00:00.000Z");
    const futureEvent = { ...fixtureEvent(9), eventId: "88888888-8888-4888-8888-888888888888", occurredAt: "9999-01-01T00:00:00.000Z" };

    await expect(service.ingest(scope.gatewayId, futureEvent, receivedAt)).resolves.toMatchObject({
      status: "rejected_future_timestamp"
    });
    // The settings contract adds a Site key-share lock before the existing
    // Fixture row lock; future rejection must stop after those two scope locks.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.fixtureEnergyStateCursor.findUnique).not.toHaveBeenCalled();
    expect(prisma.fixtureEnergyDailyAggregate.upsert).not.toHaveBeenCalled();
    expect(prisma.fixtureEnergyHourlyAggregate.upsert).not.toHaveBeenCalled();
    expect(prisma.fixture.update).not.toHaveBeenCalled();
    expect(prisma.processedGatewayEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventId: futureEvent.eventId,
        gatewayId: scope.gatewayId,
        fixtureId: scope.fixtureId,
        sequence: 9n,
        eventType: "fixture_state",
        occurredAt: new Date(futureEvent.occurredAt),
        receivedAt,
        ingestionStatus: "rejected_future_timestamp",
        payloadHash: fixturePayloadHash(futureEvent)
      })
    });
  });

  it("uses the frozen receipt timestamp for freshness and device timestamp for state ordering", async () => {
    const prisma = fixturePrisma();
    const service = new FixtureStateIngestionService(prisma as never);
    const receivedAt = new Date("2026-08-26T00:00:12.000Z");

    await service.ingest(scope.gatewayId, fixtureEvent(9), receivedAt);

    expect(prisma.fixture.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        lastSeenAt: receivedAt,
        lastStateOccurredAt: new Date("2026-08-26T00:00:09.000Z")
      })
    }));
    expect(prisma.processedGatewayEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payloadHash: fixturePayloadHash(fixtureEvent(9)),
        receivedAt,
        ingestionStatus: "accepted"
      })
    });
  });

  it("returns a committed duplicate without applying energy twice", async () => {
    const prisma = fixturePrisma({
      processedEvent: {
        eventId: fixtureEvent(9).eventId,
        gatewayId: scope.gatewayId,
        sequence: 9n,
        eventType: "fixture_state",
        occurredAt: new Date("2026-08-26T00:00:09.000Z"),
        fixtureId: scope.fixtureId,
        payloadHash: fixturePayloadHash(fixtureEvent(9)),
        ingestionStatus: "accepted"
      }
    });
    const service = new FixtureStateIngestionService(prisma as never);

    await expect(service.ingest(scope.gatewayId, fixtureEvent(9))).resolves.toMatchObject({ status: "duplicate" });
    expect(prisma.fixtureEnergyDailyAggregate.upsert).not.toHaveBeenCalled();
    expect(prisma.fixture.update).not.toHaveBeenCalled();
  });

  it("returns duplicate when an exact accepted replay commits while this transaction waits for the fixture lock", async () => {
    const event = fixtureEvent(9);
    const committedEvent = {
      eventId: event.eventId,
      gatewayId: scope.gatewayId,
      sequence: 9n,
      eventType: "fixture_state",
      occurredAt: new Date(event.occurredAt),
      fixtureId: scope.fixtureId,
      payloadHash: fixturePayloadHash(event),
      ingestionStatus: "accepted"
    };
    const prisma = fixturePrisma();
    prisma.processedGatewayEvent.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(committedEvent);
    const service = new FixtureStateIngestionService(prisma as never);

    await expect(service.ingest(scope.gatewayId, event)).resolves.toMatchObject({ status: "duplicate" });
    expect(prisma.processedGatewayEvent.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.processedGatewayEvent.findFirst).not.toHaveBeenCalled();
    expect(prisma.fixtureEnergyStateCursor.findUnique).not.toHaveBeenCalled();
    expect(prisma.fixture.update).not.toHaveBeenCalled();
  });

  it("binds an exact legacy replay under the fixture lock without applying state or energy again", async () => {
    const legacy = legacyFixtureEvent();
    const prisma = fixturePrisma({ processedEvent: legacy });
    const locked = deferred();
    prisma.$queryRaw.mockImplementationOnce(async () => { await locked.promise; return [prisma.__row]; });
    const replay = new FixtureStateIngestionService(prisma as never).ingest(scope.gatewayId, fixtureEvent(9));
    // Attach before releasing the lock so the RED rejection is observed without an unhandled promise.
    const result = expect(replay).resolves.toMatchObject({ status: "duplicate" });
    await Promise.resolve();
    expect(legacy.payloadHash).toBeNull();
    expect(prisma.processedGatewayEvent.updateMany).not.toHaveBeenCalled();
    locked.resolve();
    await result;
    expect(legacy.payloadHash).toBe(fixturePayloadHash(fixtureEvent(9)));
    expect(prisma.processedGatewayEvent.updateMany).toHaveBeenCalledWith({
      where: { eventId: legacy.eventId, payloadHash: null }, data: { payloadHash: legacy.payloadHash }
    });
    expect(prisma.fixtureEnergyStateCursor.findUnique).not.toHaveBeenCalled();
    expect(prisma.fixtureEnergyDailyAggregate.upsert).not.toHaveBeenCalled();
    expect(prisma.fixtureEnergyHourlyAggregate.upsert).not.toHaveBeenCalled();
    expect(prisma.fixture.update).not.toHaveBeenCalled();
    await expect(new FixtureStateIngestionService(prisma as never).ingest(scope.gatewayId,
      { ...fixtureEvent(9), brightness: 20 })).rejects.toThrow("conflict");
  });

  it.each([false, true])("reloads a competing legacy CAS winner and fails closed for a different payload (different=%s)", async (different) => {
    const legacy = legacyFixtureEvent();
    const prisma = fixturePrisma({ processedEvent: legacy });
    const winnerHash = fixturePayloadHash({ ...fixtureEvent(9), brightness: different ? 20 : 70 });
    prisma.processedGatewayEvent.updateMany.mockImplementationOnce(async () => {
      legacy.payloadHash = winnerHash;
      return { count: 0 };
    });
    const replay = new FixtureStateIngestionService(prisma as never).ingest(scope.gatewayId, fixtureEvent(9));
    if (different) await expect(replay).rejects.toThrow("conflict");
    else await expect(replay).resolves.toMatchObject({ status: "duplicate" });
    expect(prisma.processedGatewayEvent.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.processedGatewayEvent.findUnique).toHaveBeenCalledTimes(3);
    expect(legacy.payloadHash).toBe(winnerHash);
    expect(prisma.fixture.update).not.toHaveBeenCalled();
    expect(prisma.fixtureEnergyStateCursor.findUnique).not.toHaveBeenCalled();
  });

  it("rejects legacy reconciliation before changing the hash when fixture ownership no longer matches", async () => {
    const legacy = legacyFixtureEvent();
    const prisma = fixturePrisma({ processedEvent: legacy, lockedRows: [] });
    await expect(new FixtureStateIngestionService(prisma as never).ingest(scope.gatewayId, fixtureEvent(9)))
      .rejects.toThrow("fixture state scope rejected");
    expect(legacy.payloadHash).toBeNull();
    expect(prisma.processedGatewayEvent.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    { gatewayId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    { fixtureId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    { sequence: 8n }, { eventType: "gateway_heartbeat" },
    { occurredAt: new Date("2026-08-26T00:00:08.000Z") }
  ])("never treats a null hash as evidence of a matching legacy identity: %o", async (mismatch) => {
    const legacy = { ...legacyFixtureEvent(), ...mismatch };
    const prisma = fixturePrisma({ processedEvent: legacy });
    await expect(new FixtureStateIngestionService(prisma as never).ingest(scope.gatewayId, fixtureEvent(9)))
      .rejects.toThrow("conflict");
    expect(legacy.payloadHash).toBeNull();
    expect(prisma.processedGatewayEvent.updateMany).not.toHaveBeenCalled();
  });

  it("returns a previous future rejection only for the exact canonical payload", async () => {
    const event = fixtureEvent(9);
    const prisma = fixturePrisma({
      processedEvent: {
        eventId: event.eventId,
        gatewayId: scope.gatewayId,
        sequence: 9n,
        eventType: "fixture_state",
        occurredAt: new Date(event.occurredAt),
        fixtureId: scope.fixtureId,
        payloadHash: fixturePayloadHash(event),
        ingestionStatus: "rejected_future_timestamp"
      }
    });
    const service = new FixtureStateIngestionService(prisma as never);

    await expect(service.ingest(scope.gatewayId, event)).resolves.toMatchObject({ status: "rejected_future_timestamp" });
    expect(prisma.fixtureEnergyStateCursor.findUnique).not.toHaveBeenCalled();
    expect(prisma.fixture.update).not.toHaveBeenCalled();
  });

  it("fails closed when an event identity is replayed with a different payload", async () => {
    const event = fixtureEvent(9);
    const prisma = fixturePrisma({
      processedEvent: {
        eventId: event.eventId,
        gatewayId: scope.gatewayId,
        sequence: 9n,
        eventType: "fixture_state",
        occurredAt: new Date(event.occurredAt),
        fixtureId: scope.fixtureId,
        payloadHash: fixturePayloadHash(event),
        ingestionStatus: "accepted"
      }
    });
    const service = new FixtureStateIngestionService(prisma as never);

    await expect(service.ingest(scope.gatewayId, { ...event, brightness: 20 })).rejects.toThrow("fixture state event identity conflict");
    expect(prisma.fixture.update).not.toHaveBeenCalled();
  });

  it("records and acknowledges stale sequence without changing fixture or aggregate", async () => {
    const prisma = fixturePrisma({ lastStateSequence: 10n, lastStateOccurredAt: new Date("2026-08-26T00:00:10.000Z") });
    const service = new FixtureStateIngestionService(prisma as never);

    await expect(service.ingest(scope.gatewayId, fixtureEvent(9))).resolves.toMatchObject({ status: "stale_sequence" });
    expect(prisma.processedGatewayEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.fixtureEnergyDailyAggregate.upsert).not.toHaveBeenCalled();
    expect(prisma.fixture.update).not.toHaveBeenCalled();
  });

  it("explicitly acknowledges a state behind the persisted energy checkpoint", async () => {
    const prisma = fixturePrisma({
      cursor: {
        fixtureId: scope.fixtureId,
        aggregatedThrough: new Date("2026-08-26T00:00:10.000Z"),
        observedStateOccurredAt: null,
        brightness: 0,
        powerOn: null,
        ratedWatt: new Prisma.Decimal("40.00"),
        durationRemainders: []
      }
    });
    const service = new FixtureStateIngestionService(prisma as never);

    await expect(service.ingest(scope.gatewayId, fixtureEvent(9))).resolves.toMatchObject({ status: "stale_checkpoint" });
    expect(prisma.fixture.update).not.toHaveBeenCalled();
  });

  it("fails closed when the topic gateway does not own the fixture", async () => {
    const prisma = fixturePrisma({ lockedRows: [] });
    const service = new FixtureStateIngestionService(prisma as never);
    const futureEvent = { ...fixtureEvent(9), occurredAt: "9999-01-01T00:00:00.000Z" };
    await expect(service.ingest(scope.gatewayId, futureEvent, new Date("2026-08-26T00:00:00.000Z")))
      .rejects.toThrow("fixture state scope rejected");
    expect(prisma.processedGatewayEvent.create).not.toHaveBeenCalled();
  });

  it("fails the transaction before the fixture snapshot when hourly persistence fails", async () => {
    const prisma = fixturePrisma();
    prisma.fixtureEnergyHourlyAggregate.upsert.mockRejectedValue(new Error("hourly write failed"));
    const service = new FixtureStateIngestionService(prisma as never);

    await expect(service.ingest(scope.gatewayId, fixtureEvent(9))).rejects.toThrow("hourly write failed");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.fixtureEnergyStateCursor.upsert).not.toHaveBeenCalled();
    expect(prisma.fixture.update).not.toHaveBeenCalled();
  });

  it("closes the old rated-watt interval before advancing the persisted checkpoint", async () => {
    const prisma = fixturePrisma({
      lastStateSequence: 1n,
      lastStateOccurredAt: new Date("2026-08-26T00:00:00.000Z"),
      cursor: {
        fixtureId: scope.fixtureId,
        aggregatedThrough: new Date("2026-08-26T00:00:00.000Z"),
        observedStateOccurredAt: new Date("2026-08-26T00:00:00.000Z"),
        brightness: 50,
        powerOn: true,
        ratedWatt: new Prisma.Decimal("40.00"),
        durationRemainders: []
      }
    });
    prisma.$queryRaw.mockResolvedValueOnce([{
      ...prisma.__row,
      id: scope.fixtureId,
      brightness: 50,
      powerOn: true,
      ratedWatt: new Prisma.Decimal("40.00"),
      lastStateEventId: "11111111-1111-4111-8111-111111111111"
    }]);

    await closeFixtureEnergyForRatedWattChange(
      prisma,
      scope.fixtureId,
      new Prisma.Decimal("80.00"),
      new Date("2026-08-26T00:01:00.000Z")
    );

    expect(prisma.fixtureEnergyDailyAggregate.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ knownSeconds: { increment: 60 } })
    }));
    expect(prisma.fixtureEnergyStateCursor.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ ratedWatt: new Prisma.Decimal("80.00") })
    }));
  });

  it("locks all site fixtures once and batch-closes them with the previous timezone and tariff", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-08-26T15:01:00.000Z"));
    const rows = ["fixture-b", "fixture-a"].map((fixtureId, index) => ({
      ...fixturePrisma().__row,
      id: fixtureId,
      energyFixtureId: `energy-${index}`,
      brightness: 50,
      powerOn: true,
      lastStateOccurredAt: new Date("2026-08-26T14:59:00.000Z"),
      cursorAggregatedThrough: new Date("2026-08-26T14:59:00.000Z"),
      cursorObservedStateOccurredAt: new Date("2026-08-26T14:59:00.000Z"),
      cursorBrightness: 50,
      cursorPowerOn: true,
      cursorRatedWatt: new Prisma.Decimal("40.00"),
      cursorDurationRemainders: []
    }));
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue(rows),
      $executeRaw: jest.fn().mockResolvedValue(2)
    };

    try {
      await expect(closeSiteEnergyForSettingsChange(tx, {
        siteId: scope.siteId,
        timeZone: "Asia/Seoul",
        tariffKwhRate: new Prisma.Decimal("120.00")
      })).resolves.toEqual(new Date("2026-08-26T15:01:00.000Z"));
    } finally {
      jest.useRealTimers();
    }

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.calls[0][0].sql).toMatch(
      /WHERE f\."siteId" = \?\s+ORDER BY f\."id"\s+FOR UPDATE OF f/
    );
    expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
    for (const [query] of tx.$executeRaw.mock.calls as Array<[{ sql: string }]>) {
      expect(query.sql).toContain("CURRENT_TIMESTAMP AT TIME ZONE 'UTC'");
    }
    const dailyWrite = tx.$executeRaw.mock.calls
      .map(([query]: [{ sql: string; values: unknown[] }]) => query)
      .find((query: { sql: string }) => query.sql.includes('"FixtureEnergyDailyAggregate"'));
    expect(dailyWrite).toBeDefined();
    expect(dailyWrite!.sql).toContain("CAST(? AS DATE)");
    expect(dailyWrite!.values.filter((value: unknown) => /^2026-08-2[67]$/.test(String(value))))
      .toEqual(["2026-08-26", "2026-08-27", "2026-08-26", "2026-08-27"]);
    expect(dailyWrite!.values.filter((value: unknown) => value instanceof Prisma.Decimal).map(String))
      .toEqual(["0.00033333333333333333333", "0.04", "0.00033333333333333333333", "0.04",
        "0.00033333333333333333333", "0.04", "0.00033333333333333333333", "0.04"]);
    const hourlyWrite = tx.$executeRaw.mock.calls
      .map(([query]: [{ sql: string; values: unknown[] }]) => query)
      .find((query: { sql: string }) => query.sql.includes('"FixtureEnergyHourlyAggregate"'))!;
    expect(hourlyWrite.sql).toContain("CAST(? AS TIMESTAMPTZ) AT TIME ZONE 'UTC'");
    expect(hourlyWrite.values).toContain("2026-08-26T15:00:00.000Z");
    const cursorWrite = tx.$executeRaw.mock.calls
      .map(([query]: [{ sql: string; values: unknown[] }]) => query)
      .find((query: { sql: string }) => query.sql.includes('"FixtureEnergyStateCursor"'))!;
    expect(cursorWrite.sql).toContain("CAST(? AS TIMESTAMPTZ) AT TIME ZONE 'UTC'");
    expect(cursorWrite.values).toContain("2026-08-26T15:01:00.000Z");
    expect(cursorWrite.values).not.toContainEqual(new Date("2026-08-26T15:01:00.000Z"));
  });
});

function fixturePrisma(options: {
  lastStateSequence?: bigint | null;
  lastStateOccurredAt?: Date | null;
  processedEvent?: unknown;
  cursor?: unknown;
  lockedRows?: unknown[];
  watermark?: unknown;
} = {}) {
  const row = {
    id: scope.fixtureId,
    energyFixtureId: scope.energyFixtureId,
    name: "B1-L01",
    floorId: "33333333-3333-4333-8333-333333333333",
    floorName: "B1",
    siteId: scope.siteId,
    gatewayId: scope.gatewayId,
    ratedWatt: new Prisma.Decimal("40.00"),
    brightness: 0,
    powerOn: null,
    energyTrackingStartedAt: new Date("2026-08-26T00:00:00.000Z"),
    firstStateOccurredAt: null,
    lastStateEventId: null,
    lastStateSequence: options.lastStateSequence ?? null,
    lastStateOccurredAt: options.lastStateOccurredAt ?? null,
    timeZone: "Asia/Seoul",
    tariffKwhRate: new Prisma.Decimal("120.00")
  };
  const prisma: any = {
    __row: row,
    $executeRaw: jest.fn().mockResolvedValue(1),
    gatewayEventWatermark: {
      findUnique: jest.fn().mockResolvedValue(options.watermark ?? null),
      findFirst: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue(undefined)
    },
    $queryRaw: jest.fn(async (query: { sql: string }) => query.sql.includes('FROM "Site"')
      ? [{ id: scope.siteId }]
      : (options.lockedRows ?? [row])),
    processedGatewayEvent: {
      findUnique: jest.fn().mockResolvedValue(options.processedEvent ?? null),
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn(async ({ where, data }) => {
        const event = options.processedEvent as ReturnType<typeof legacyFixtureEvent> | undefined;
        if (!event || event.eventId !== where.eventId || event.payloadHash !== where.payloadHash) return { count: 0 };
        Object.assign(event, data);
        return { count: 1 };
      }),
      create: jest.fn().mockResolvedValue(undefined)
    },
    fixtureEnergyStateCursor: {
      findUnique: jest.fn().mockResolvedValue(options.cursor ?? null),
      upsert: jest.fn().mockResolvedValue(undefined)
    },
    fixtureEnergyDailyAggregate: { upsert: jest.fn().mockResolvedValue(undefined) },
    fixtureEnergyHourlyAggregate: { upsert: jest.fn().mockResolvedValue(undefined) },
    fixture: { update: jest.fn().mockResolvedValue(undefined) }
  };
  prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
  return prisma;
}

function fixtureWatermark() {
  return {
    gatewayId: scope.gatewayId, eventType: "fixture_state", scopeKey: scope.fixtureId,
    lastSequence: 9n, lastEventId: fixtureEvent(9).eventId,
    lastPayloadHash: canonicalPayloadHash(fixtureStateV2Schema.parse(fixtureEvent(9))),
    lastOccurredAt: new Date(fixtureEvent(9).occurredAt), updatedAt: new Date()
  };
}

function fixtureEvent(sequence: number) {
  return {
    ...scope,
    eventId: "99999999-9999-4999-8999-999999999999",
    sequence,
    occurredAt: "2026-08-26T00:00:09.000Z",
    brightness: 70,
    powerOn: true,
    status: "online" as const,
    statusReason: "reported" as const,
    health: { faultCodes: [4, 0, 1, 4], observedAt: "2026-08-26T00:00:08.000Z" },
    rssi: -60,
    hopCount: 1
  };
}

function fixturePayloadHash(event: ReturnType<typeof fixtureEvent>) {
  return canonicalPayloadHash(fixtureStateV2Schema.parse(event));
}

function legacyFixtureEvent() {
  const event = fixtureEvent(9);
  return { eventId: event.eventId, gatewayId: scope.gatewayId, fixtureId: scope.fixtureId,
    sequence: 9n, eventType: "fixture_state", occurredAt: new Date(event.occurredAt),
    payloadHash: null as string | null, ingestionStatus: "accepted" };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => { resolve = release; });
  return { promise, resolve };
}
