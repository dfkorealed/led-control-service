import { Prisma } from "@prisma/client";
import {
  aggregateFixtureStateTransition as aggregateWithCheckpoint,
  closeFixtureEnergyCheckpoint,
  createInitialFixtureEnergyCheckpoint,
  projectOpenFixtureEnergy as projectWithCheckpoint,
  type FixtureEnergyCheckpoint,
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

type TransitionInput = Omit<Parameters<typeof aggregateWithCheckpoint>[0], "checkpoint"> & {
  checkpoint?: FixtureEnergyCheckpoint;
};

function aggregateFixtureStateTransition(input: TransitionInput) {
  return aggregateWithCheckpoint({
    ...input,
    checkpoint: input.checkpoint ?? createInitialFixtureEnergyCheckpoint(input.snapshot)
  });
}

type ProjectionInput = Omit<Parameters<typeof projectWithCheckpoint>[0], "checkpoint" | "queryStartedAt"> & {
  checkpoint?: FixtureEnergyCheckpoint;
  queryStartedAt?: Date;
};

function projectOpenFixtureEnergy(input: ProjectionInput) {
  return projectWithCheckpoint({
    ...input,
    checkpoint: input.checkpoint ?? createInitialFixtureEnergyCheckpoint(input.snapshot),
    queryStartedAt: input.queryStartedAt ?? input.snapshot.energyTrackingStartedAt
  }).dailyDeltas;
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

  it("never revives a state that expired before energy tracking started", () => {
    const first = aggregateFixtureStateTransition({
      snapshot: snapshot({
        energyTrackingStartedAt: new Date("2026-01-01T00:10:00.000Z"),
        firstStateOccurredAt: null,
        lastStateEventId: null,
        lastStateSequence: null,
        lastStateOccurredAt: null,
        brightness: 0,
        powerOn: null
      }),
      event: {
        eventId: "event-before-tracking",
        sequence: 1n,
        occurredAt: new Date("2026-01-01T00:05:00.000Z"),
        brightness: 100,
        powerOn: true
      },
      timeZone: "UTC",
      tariffKwhRate: decimal("160")
    });

    const second = aggregateFixtureStateTransition({
      snapshot: first.nextSnapshot,
      checkpoint: first.nextCheckpoint,
      event: {
        eventId: "event-after-tracking",
        sequence: 2n,
        occurredAt: new Date("2026-01-01T00:11:00.000Z"),
        brightness: 100,
        powerOn: true
      },
      timeZone: "UTC",
      tariffKwhRate: decimal("160")
    });

    expect(second.dailyDeltas).toHaveLength(1);
    expect(second.dailyDeltas[0]).toMatchObject({ knownSeconds: 0, unknownSeconds: 60 });
    expect(second.dailyDeltas[0].estimatedKwh.toString()).toBe("0");
  });

  it("carries milliseconds across repeated events instead of truncating each event", () => {
    let current = snapshot();
    let checkpoint = createInitialFixtureEnergyCheckpoint(current);
    let knownSeconds = 0;

    for (let sequence = 2; sequence <= 61; sequence += 1) {
      const result = aggregateFixtureStateTransition({
        snapshot: current,
        checkpoint,
        event: {
          eventId: `event-${sequence}`,
          sequence: BigInt(sequence),
          occurredAt: new Date(current.lastStateOccurredAt!.getTime() + 60_900),
          brightness: 50,
          powerOn: true
        },
        timeZone: "UTC",
        tariffKwhRate: decimal("160")
      });
      knownSeconds += result.dailyDeltas.reduce((sum, delta) => sum + delta.knownSeconds, 0);
      current = result.nextSnapshot;
      checkpoint = result.nextCheckpoint;
    }

    expect(knownSeconds).toBe(3_654);
  });

  it("exposes exact Decimal durations when a one-second interval straddles local midnight", () => {
    const result = aggregateFixtureStateTransition({
      snapshot: snapshot({ lastStateOccurredAt: new Date("2026-01-01T14:59:59.500Z") }),
      event: {
        eventId: "event-2",
        sequence: 2n,
        occurredAt: new Date("2026-01-01T15:00:00.500Z"),
        brightness: 50,
        powerOn: true
      },
      timeZone: "Asia/Seoul",
      tariffKwhRate: decimal("160")
    });

    expect(result.dailyDeltas.map((delta) => delta.knownDurationSeconds.toString())).toEqual(["0.5", "0.5"]);
    expect(result.dailyDeltas.map((delta) => delta.knownSeconds)).toEqual([1, 0]);
    expect(result.nextCheckpoint.durationRemainders).toEqual([
      { localDate: "2026-01-02", knownMilliseconds: 500, unknownMilliseconds: 0 }
    ]);
  });

  it("finalizes both known and unknown remainders when their local day closes", () => {
    const original = snapshot({ lastStateOccurredAt: new Date("2026-01-01T23:50:00.000Z") });
    const beforeMidnight = aggregateFixtureStateTransition({
      snapshot: original,
      event: {
        eventId: "event-before-midnight",
        sequence: 2n,
        occurredAt: new Date("2026-01-01T23:59:59.500Z"),
        brightness: 50,
        powerOn: true
      },
      timeZone: "UTC",
      tariffKwhRate: decimal("160")
    });
    const afterMidnight = aggregateFixtureStateTransition({
      snapshot: beforeMidnight.nextSnapshot,
      checkpoint: beforeMidnight.nextCheckpoint,
      event: {
        eventId: "event-after-midnight",
        sequence: 3n,
        occurredAt: new Date("2026-01-02T00:01:00.000Z"),
        brightness: 50,
        powerOn: true
      },
      timeZone: "UTC",
      tariffKwhRate: decimal("160")
    });

    expect(afterMidnight.dailyDeltas[0]).toMatchObject({ knownSeconds: 1, unknownSeconds: 1 });
    expect(afterMidnight.nextCheckpoint.durationRemainders).not.toContainEqual(
      expect.objectContaining({ localDate: "2026-01-01" })
    );
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

  it("clips a pre-tracking observation without extending its original 180-second expiry", () => {
    const result = projectOpenFixtureEnergy({
      snapshot: snapshot({
        energyTrackingStartedAt: new Date("2026-01-01T00:10:00.000Z"),
        lastStateOccurredAt: new Date("2026-01-01T00:05:00.000Z"),
        brightness: 100,
        powerOn: true
      }),
      generatedAt: new Date("2026-01-01T00:11:00.000Z"),
      timeZone: "UTC",
      tariffKwhRate: decimal("160")
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ knownSeconds: 0, unknownSeconds: 60 });
    expect(result[0].estimatedKwh.toString()).toBe("0");
  });

  it("clips work to the requested query start and exposes its immutable source boundary", () => {
    const source = snapshot({
      energyTrackingStartedAt: new Date("2025-01-01T00:00:00.000Z"),
      firstStateOccurredAt: null,
      lastStateEventId: null,
      lastStateSequence: null,
      lastStateOccurredAt: null,
      powerOn: null,
      ratedWatt: decimal("37.25")
    });
    const checkpoint = createInitialFixtureEnergyCheckpoint(source);
    const result = projectWithCheckpoint({
      snapshot: source,
      checkpoint,
      queryStartedAt: new Date("2026-01-02T00:00:00.000Z"),
      generatedAt: new Date("2026-01-03T00:00:00.000Z"),
      timeZone: "UTC",
      tariffKwhRate: decimal("160")
    });

    expect(result.dailyDeltas).toHaveLength(1);
    expect(result.dailyDeltas[0]).toMatchObject({ unknownSeconds: 86_400 });
    expect(result.boundary).toMatchObject({
      projectedFrom: new Date("2026-01-02T00:00:00.000Z"),
      projectedThrough: new Date("2026-01-03T00:00:00.000Z"),
      checkpointAggregatedThrough: new Date("2025-01-01T00:00:00.000Z")
    });
    expect(result.boundary.ratedWattSnapshot.toString()).toBe("37.25");
    expect(result.sourceCheckpoint).toEqual(checkpoint);
    expect(result.sourceCheckpoint).not.toBe(checkpoint);
  });
});

describe("closeFixtureEnergyCheckpoint", () => {
  it("closes the old watt interval once and preserves the original observation expiry", () => {
    const original = snapshot({ brightness: 50, ratedWatt: decimal("40") });
    const checkpoint = createInitialFixtureEnergyCheckpoint(original);
    const closed = closeFixtureEnergyCheckpoint({
      snapshot: original,
      checkpoint,
      closedAt: new Date("2026-01-01T00:01:00.000Z"),
      nextRatedWatt: decimal("80"),
      timeZone: "UTC",
      tariffKwhRate: decimal("160")
    });

    expect(closed.dailyDeltas[0].estimatedKwh.toFixed(12)).toBe("0.000333333333");
    expect(closed.nextCheckpoint).toMatchObject({
      aggregatedThrough: new Date("2026-01-01T00:01:00.000Z"),
      observedStateOccurredAt: new Date("2026-01-01T00:00:00.000Z")
    });
    expect(closed.nextCheckpoint.ratedWatt.toString()).toBe("80");

    const updated = snapshot({ brightness: 50, ratedWatt: decimal("80") });
    const next = aggregateFixtureStateTransition({
      snapshot: updated,
      checkpoint: closed.nextCheckpoint,
      event: {
        eventId: "event-2",
        sequence: 2n,
        occurredAt: new Date("2026-01-01T00:02:00.000Z"),
        brightness: 50,
        powerOn: true
      },
      timeZone: "UTC",
      tariffKwhRate: decimal("160")
    });

    expect(next.dailyDeltas[0]).toMatchObject({ knownSeconds: 60, unknownSeconds: 0 });
    expect(next.dailyDeltas[0].estimatedKwh.toFixed(12)).toBe("0.000666666667");
    expect(next.nextCheckpoint.observedStateOccurredAt).toEqual(new Date("2026-01-01T00:02:00.000Z"));
  });

  it("rejects a rated watt change that skipped the explicit checkpoint close", () => {
    const original = snapshot({ ratedWatt: decimal("40") });
    const checkpoint = createInitialFixtureEnergyCheckpoint(original);

    expect(() =>
      aggregateFixtureStateTransition({
        snapshot: snapshot({ ratedWatt: decimal("80") }),
        checkpoint,
        event: {
          eventId: "event-2",
          sequence: 2n,
          occurredAt: new Date("2026-01-01T00:01:00.000Z"),
          brightness: 50,
          powerOn: true
        },
        timeZone: "UTC",
        tariffKwhRate: decimal("160")
      })
    ).toThrow("ratedWatt differs from the persisted energy checkpoint");
  });

  it("rejects a delayed higher-sequence state behind an advanced rated-watt checkpoint", () => {
    const original = snapshot({ brightness: 50, ratedWatt: decimal("40") });
    const closed = closeFixtureEnergyCheckpoint({
      snapshot: original,
      checkpoint: createInitialFixtureEnergyCheckpoint(original),
      closedAt: new Date("2026-01-01T00:10:00.000Z"),
      nextRatedWatt: decimal("80"),
      timeZone: "UTC",
      tariffKwhRate: decimal("160")
    });
    const updated = snapshot({ brightness: 50, ratedWatt: decimal("80") });

    const result = aggregateFixtureStateTransition({
      snapshot: updated,
      checkpoint: closed.nextCheckpoint,
      event: {
        eventId: "delayed-event",
        sequence: 2n,
        occurredAt: new Date("2026-01-01T00:09:00.000Z"),
        brightness: 100,
        powerOn: true
      },
      timeZone: "UTC",
      tariffKwhRate: decimal("160")
    });

    expect(result.status).toBe("stale_checkpoint");
    expect(result.dailyDeltas).toEqual([]);
    expect(result.nextSnapshot).toEqual(updated);
    expect(result.nextCheckpoint).toEqual(closed.nextCheckpoint);
  });

  it("accepts a higher-sequence state exactly at the persisted checkpoint boundary", () => {
    const original = snapshot({ brightness: 50, ratedWatt: decimal("40") });
    const closed = closeFixtureEnergyCheckpoint({
      snapshot: original,
      checkpoint: createInitialFixtureEnergyCheckpoint(original),
      closedAt: new Date("2026-01-01T00:10:00.000Z"),
      nextRatedWatt: decimal("80"),
      timeZone: "UTC",
      tariffKwhRate: decimal("160")
    });
    const updated = snapshot({ brightness: 50, ratedWatt: decimal("80") });

    const result = aggregateFixtureStateTransition({
      snapshot: updated,
      checkpoint: closed.nextCheckpoint,
      event: {
        eventId: "boundary-event",
        sequence: 2n,
        occurredAt: new Date("2026-01-01T00:10:00.000Z"),
        brightness: 100,
        powerOn: true
      },
      timeZone: "UTC",
      tariffKwhRate: decimal("160")
    });

    expect(result.status).toBe("accepted");
    expect(result.dailyDeltas).toEqual([]);
    expect(result.nextSnapshot.lastStateEventId).toBe("boundary-event");
  });
});
