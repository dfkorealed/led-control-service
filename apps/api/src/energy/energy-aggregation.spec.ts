import { Prisma } from "@prisma/client";
import {
  aggregateFixtureStateTransition,
  projectOpenFixtureEnergy,
  type FixtureEnergySnapshot
} from "./energy-aggregation";

const decimal = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value);

function snapshot(overrides: Partial<FixtureEnergySnapshot> = {}): FixtureEnergySnapshot {
  return {
    energyTrackingStartedAt: new Date("2026-01-01T00:00:00.000Z"),
    firstStateOccurredAt: new Date("2026-01-01T00:00:00.000Z"),
    lastStateEventId: "event-1",
    lastStateSequence: 1n,
    lastStateOccurredAt: new Date("2026-01-01T00:00:00.000Z"),
    brightness: 50,
    powerOn: true,
    ratedWatt: decimal("40.00"),
    ...overrides
  };
}

describe("aggregateFixtureStateTransition", () => {
  it.each([
    ["duplicate", { eventId: "event-1", sequence: 1n, occurredAt: "2026-01-01T00:01:00.000Z" }],
    ["stale_sequence", { eventId: "event-old", sequence: 1n, occurredAt: "2026-01-01T00:01:00.000Z" }],
    ["reverse_time", { eventId: "event-2", sequence: 2n, occurredAt: "2025-12-31T23:59:59.000Z" }]
  ] as const)("returns %s without changing aggregates for a rejected state", (status, event) => {
    const result = aggregateFixtureStateTransition({
      snapshot: snapshot(),
      event: {
        ...event,
        occurredAt: new Date(event.occurredAt),
        brightness: 80,
        powerOn: true
      },
      timeZone: "UTC",
      tariffKwhRate: decimal("160.00")
    });

    expect(result.status).toBe(status);
    expect(result.dailyDeltas).toEqual([]);
    expect(result.nextSnapshot).toEqual(snapshot());
  });

  it("records only unknown time before the first accepted state", () => {
    const result = aggregateFixtureStateTransition({
      snapshot: snapshot({
        energyTrackingStartedAt: new Date("2026-01-01T00:00:00.000Z"),
        firstStateOccurredAt: null,
        lastStateEventId: null,
        lastStateSequence: null,
        lastStateOccurredAt: null,
        brightness: 0,
        powerOn: null
      }),
      event: {
        eventId: "event-first",
        sequence: 1n,
        occurredAt: new Date("2026-01-01T00:05:00.000Z"),
        brightness: 70,
        powerOn: true
      },
      timeZone: "UTC",
      tariffKwhRate: decimal("160.00")
    });

    expect(result.status).toBe("accepted");
    expect(result.dailyDeltas).toHaveLength(1);
    expect(result.dailyDeltas[0]).toMatchObject({ knownSeconds: 0, unknownSeconds: 300 });
    expect(result.dailyDeltas[0].estimatedKwh.toString()).toBe("0");
    expect(result.dailyDeltas[0].estimatedCost.toString()).toBe("0");
    expect(result.nextSnapshot.firstStateOccurredAt).toEqual(new Date("2026-01-01T00:05:00.000Z"));
    expect(result.nextSnapshot.brightness).toBe(70);
  });

  it("accepts a higher sequence at the same instant without adding duration", () => {
    const result = aggregateFixtureStateTransition({
      snapshot: snapshot(),
      event: {
        eventId: "event-2",
        sequence: 2n,
        occurredAt: new Date("2026-01-01T00:00:00.000Z"),
        brightness: 25,
        powerOn: false
      },
      timeZone: "UTC",
      tariffKwhRate: decimal("160.00")
    });

    expect(result.status).toBe("accepted");
    expect(result.dailyDeltas).toEqual([]);
    expect(result.nextSnapshot).toMatchObject({
      lastStateEventId: "event-2",
      lastStateSequence: 2n,
      brightness: 25,
      powerOn: false
    });
  });

  it("counts an observed OFF interval as known time with zero energy", () => {
    const result = aggregateFixtureStateTransition({
      snapshot: snapshot({ brightness: 100, powerOn: false }),
      event: {
        eventId: "event-2",
        sequence: 2n,
        occurredAt: new Date("2026-01-01T00:01:00.000Z"),
        brightness: 100,
        powerOn: true
      },
      timeZone: "UTC",
      tariffKwhRate: decimal("160.00")
    });

    expect(result.dailyDeltas[0]).toMatchObject({ knownSeconds: 60, unknownSeconds: 0 });
    expect(result.dailyDeltas[0].estimatedKwh.toString()).toBe("0");
    expect(result.dailyDeltas[0].estimatedCost.toString()).toBe("0");
  });

  it("limits the previous known state to 180 seconds and marks the remainder unknown", () => {
    const result = aggregateFixtureStateTransition({
      snapshot: snapshot({ brightness: 50, powerOn: true }),
      event: {
        eventId: "event-2",
        sequence: 2n,
        occurredAt: new Date("2026-01-01T00:05:00.000Z"),
        brightness: 80,
        powerOn: true
      },
      timeZone: "UTC",
      tariffKwhRate: decimal("160.00")
    });

    expect(result.dailyDeltas[0]).toMatchObject({ knownSeconds: 180, unknownSeconds: 120 });
    expect(result.dailyDeltas[0].estimatedKwh.toFixed(12)).toBe("0.001000000000");
    expect(result.dailyDeltas[0].estimatedCost.toFixed(8)).toBe("0.16000000");
  });

  it("keeps exactly 180 seconds fully known", () => {
    const result = aggregateFixtureStateTransition({
      snapshot: snapshot(),
      event: {
        eventId: "event-2",
        sequence: 2n,
        occurredAt: new Date("2026-01-01T00:03:00.000Z"),
        brightness: 50,
        powerOn: true
      },
      timeZone: "UTC",
      tariffKwhRate: decimal("160.00")
    });

    expect(result.dailyDeltas[0]).toMatchObject({ knownSeconds: 180, unknownSeconds: 0 });
  });

  it("splits an interval at the site's local midnight", () => {
    const result = aggregateFixtureStateTransition({
      snapshot: snapshot({ lastStateOccurredAt: new Date("2026-01-01T14:59:00.000Z") }),
      event: {
        eventId: "event-2",
        sequence: 2n,
        occurredAt: new Date("2026-01-01T15:01:00.000Z"),
        brightness: 50,
        powerOn: true
      },
      timeZone: "Asia/Seoul",
      tariffKwhRate: decimal("160.00")
    });

    expect(result.dailyDeltas.map((delta) => [delta.localDate.toISOString(), delta.knownSeconds])).toEqual([
      ["2026-01-01T00:00:00.000Z", 60],
      ["2026-01-02T00:00:00.000Z", 60]
    ]);
  });

  it("preserves Decimal precision instead of converting energy through number", () => {
    const result = aggregateFixtureStateTransition({
      snapshot: snapshot({ brightness: 33, ratedWatt: decimal("40.01") }),
      event: {
        eventId: "event-2",
        sequence: 2n,
        occurredAt: new Date("2026-01-01T00:02:59.000Z"),
        brightness: 33,
        powerOn: true
      },
      timeZone: "UTC",
      tariffKwhRate: decimal("163.27")
    });

    expect(result.dailyDeltas[0].estimatedKwh.toFixed(18)).toBe("0.000656497416666667");
    expect(result.dailyDeltas[0].estimatedCost.toFixed(18)).toBe("0.107186333219166667");
    expect(result.dailyDeltas[0].estimatedKwh).toBeInstanceOf(Prisma.Decimal);
  });
});

describe("projectOpenFixtureEnergy", () => {
  it.each([
    ["spring-forward", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z", 82_800],
    ["fall-back", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z", 90_000]
  ])("uses the actual UTC duration of a %s local day", (_name, startedAt, generatedAt, expectedSeconds) => {
    const result = projectOpenFixtureEnergy({
      snapshot: snapshot({
        energyTrackingStartedAt: new Date(startedAt),
        firstStateOccurredAt: null,
        lastStateEventId: null,
        lastStateSequence: null,
        lastStateOccurredAt: null,
        powerOn: null
      }),
      generatedAt: new Date(generatedAt),
      timeZone: "America/New_York",
      tariffKwhRate: decimal("160.00")
    });

    expect(result).toHaveLength(1);
    expect(result[0].unknownSeconds).toBe(expectedSeconds);
  });

  it("projects only 180 known seconds from the latest state and marks the rest unknown", () => {
    const result = projectOpenFixtureEnergy({
      snapshot: snapshot({ brightness: 25, powerOn: true, ratedWatt: decimal("40") }),
      generatedAt: new Date("2026-01-01T00:05:00.000Z"),
      timeZone: "UTC",
      tariffKwhRate: decimal("160")
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ knownSeconds: 180, unknownSeconds: 120 });
    expect(result[0].estimatedKwh.toFixed(12)).toBe("0.000500000000");
  });

  it("does not project before tracking starts or before the last state", () => {
    expect(
      projectOpenFixtureEnergy({
        snapshot: snapshot({
          energyTrackingStartedAt: new Date("2026-01-01T00:10:00.000Z"),
          firstStateOccurredAt: null,
          lastStateEventId: null,
          lastStateSequence: null,
          lastStateOccurredAt: null
        }),
        generatedAt: new Date("2026-01-01T00:05:00.000Z"),
        timeZone: "UTC",
        tariffKwhRate: decimal("160")
      })
    ).toEqual([]);

    expect(
      projectOpenFixtureEnergy({
        snapshot: snapshot(),
        generatedAt: new Date("2025-12-31T23:59:59.000Z"),
        timeZone: "UTC",
        tariffKwhRate: decimal("160")
      })
    ).toEqual([]);
  });

  it("rejects an invalid IANA timezone", () => {
    expect(() =>
      projectOpenFixtureEnergy({
        snapshot: snapshot(),
        generatedAt: new Date("2026-01-01T00:01:00.000Z"),
        timeZone: "Not/A_Zone",
        tariffKwhRate: decimal("160")
      })
    ).toThrow("invalid IANA time zone");
  });
});
