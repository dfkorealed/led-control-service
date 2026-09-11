import { Prisma } from "@prisma/client";
import { closeFixtureEnergyForRatedWattChange, FixtureStateIngestionService } from "./fixture-state-ingestion.service";

const scope = {
  siteId: "22222222-2222-4222-8222-222222222222",
  gatewayId: "55555555-5555-4555-8555-555555555555",
  fixtureId: "66666666-6666-4666-8666-666666666666",
  energyFixtureId: "77777777-7777-4777-8777-777777777777"
};

describe("FixtureStateIngestionService", () => {
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
      data: expect.objectContaining({ brightness: 70, powerOn: true, firstStateOccurredAt: new Date("2026-08-26T00:00:09.000Z") })
    }));
    expect(prisma.processedGatewayEvent.create).toHaveBeenCalledTimes(1);
  });

  it("returns a committed duplicate without applying energy twice", async () => {
    const prisma = fixturePrisma({
      processedEvent: {
        eventId: fixtureEvent(9).eventId,
        gatewayId: scope.gatewayId,
        sequence: 9n,
        eventType: "fixture_state",
        occurredAt: new Date("2026-08-26T00:00:09.000Z"),
        fixtureId: scope.fixtureId
      }
    });
    const service = new FixtureStateIngestionService(prisma as never);

    await expect(service.ingest(scope.gatewayId, fixtureEvent(9))).resolves.toMatchObject({ status: "duplicate" });
    expect(prisma.fixtureEnergyDailyAggregate.upsert).not.toHaveBeenCalled();
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
    await expect(service.ingest(scope.gatewayId, fixtureEvent(9))).rejects.toThrow("fixture state scope rejected");
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
});

function fixturePrisma(options: {
  lastStateSequence?: bigint | null;
  lastStateOccurredAt?: Date | null;
  processedEvent?: unknown;
  cursor?: unknown;
  lockedRows?: unknown[];
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
    $queryRaw: jest.fn().mockResolvedValue(options.lockedRows ?? [row]),
    processedGatewayEvent: {
      findUnique: jest.fn().mockResolvedValue(options.processedEvent ?? null),
      findFirst: jest.fn().mockResolvedValue(null),
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
