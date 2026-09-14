import { describe, expect, it } from "vitest";
import { resolveDesiredState } from "./automation-arbiter";

describe("resolveDesiredState", () => {
  it("uses maximum vehicle event, schedule, and baseline in strict priority order", () => {
    const event80 = { sourceId: "event-80", startedAt: "2026-08-30T01:00:00.000Z", brightness: 80 };
    const event50 = { sourceId: "event-50", startedAt: "2026-08-30T01:00:00.000Z", brightness: 50 };
    const schedule = { sourceId: "schedule-1", occurrenceKey: "schedule-1:2026-08-30", brightness: 40 };

    expect(resolveDesiredState({ events: [event50, event80], schedules: [schedule], current: 20 }).brightness).toBe(80);
    expect(resolveDesiredState({ events: [], schedules: [schedule], current: 20 }).brightness).toBe(40);
    expect(resolveDesiredState({ events: [], schedules: [], current: 20 }).brightness).toBe(20);
  });

  it("suppresses exact active identities while allowing another occurrence or activation", () => {
    const suppression = {
      schedules: [{ scheduleId: "schedule-1", occurrenceKey: "today" }],
      vehicleEvents: [{ ruleId: "event-1", startedAt: "2026-08-30T01:00:00.000Z" }]
    };
    const event = { sourceId: "event-1", startedAt: "2026-08-30T01:00:00.000Z", brightness: 80 };
    const schedule = { sourceId: "schedule-1", occurrenceKey: "today", brightness: 40 };
    expect(resolveDesiredState({ events: [event], schedules: [schedule], suppression, current: 60 }).brightness).toBe(60);
    expect(resolveDesiredState({ events: [{ ...event, startedAt: "2026-08-30T02:00:00.000Z" }], schedules: [schedule], suppression, current: 60 }).brightness).toBe(80);
    expect(resolveDesiredState({ events: [event], schedules: [schedule, { ...schedule, occurrenceKey: "tomorrow" }], suppression, current: 60 }).brightness).toBe(40);
  });

  it("falls back to the explicit default only when no current state exists", () => {
    expect(resolveDesiredState({ events: [], schedules: [], current: null, defaultBrightness: 15 }))
      .toEqual({ sourceType: "default", sourceId: null, occurrenceKey: null, brightness: 15 });
  });

  it("selects equal-brightness vehicle events deterministically", () => {
    expect(resolveDesiredState({
      events: [
        { sourceId: "vehicle-b", startedAt: "2026-08-30T01:00:00.000Z", brightness: 80 },
        { sourceId: "vehicle-a", startedAt: "2026-08-30T01:00:00.000Z", brightness: 80 }
      ],
      schedules: [],
      current: 20
    })).toMatchObject({ sourceType: "vehicle_event_rule", sourceId: "vehicle-a", brightness: 80 });
  });
});
