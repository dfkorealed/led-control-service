import { describe, expect, it } from "vitest";
import { resolveDesiredState } from "./automation-arbiter";

describe("resolveDesiredState", () => {
  it("uses manual, maximum vehicle event, schedule, and current in strict priority order", () => {
    const activeManual = { sourceId: "manual-1", brightness: 60 };
    const event80 = { sourceId: "event-80", brightness: 80 };
    const event50 = { sourceId: "event-50", brightness: 50 };
    const schedule = { sourceId: "schedule-1", occurrenceKey: "schedule-1:2026-08-30", brightness: 40 };

    expect(resolveDesiredState({ manual: activeManual, events: [event80], schedule, current: 20 }).brightness).toBe(60);
    expect(resolveDesiredState({ manual: null, events: [event50, event80], schedule, current: 20 }).brightness).toBe(80);
    expect(resolveDesiredState({ manual: null, events: [], schedule, current: 20 }).brightness).toBe(40);
    expect(resolveDesiredState({ manual: null, events: [], schedule: null, current: 20 }).brightness).toBe(20);
  });

  it("falls back to the explicit default only when no current state exists", () => {
    expect(resolveDesiredState({ manual: null, events: [], schedule: null, current: null, defaultBrightness: 15 }))
      .toEqual({ sourceType: "default", sourceId: null, occurrenceKey: null, brightness: 15 });
  });

  it("selects equal-brightness vehicle events deterministically", () => {
    expect(resolveDesiredState({
      manual: null,
      events: [
        { sourceId: "vehicle-b", brightness: 80 },
        { sourceId: "vehicle-a", brightness: 80 }
      ],
      schedule: null,
      current: 20
    })).toMatchObject({ sourceType: "vehicle_event_rule", sourceId: "vehicle-a", brightness: 80 });
  });
});
