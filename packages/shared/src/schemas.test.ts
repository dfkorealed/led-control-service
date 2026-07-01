import { describe, expect, it } from "vitest";
import { dimmingCommandSchema, fixtureStateSchema } from "./schemas";

describe("shared schemas", () => {
  it("accepts a valid dimming command", () => {
    const parsed = dimmingCommandSchema.parse({
      commandId: "11111111-1111-4111-8111-111111111111",
      siteId: "22222222-2222-4222-8222-222222222222",
      targetType: "fixture",
      targetId: "33333333-3333-4333-8333-333333333333",
      brightness: 70,
      requestedBy: "operator@example.com",
      requestedAt: "2026-07-01T00:00:00.000Z"
    });

    expect(parsed.brightness).toBe(70);
  });

  it("rejects brightness outside 0 to 100", () => {
    expect(() =>
      fixtureStateSchema.parse({
        fixtureId: "33333333-3333-4333-8333-333333333333",
        brightness: 101,
        powerOn: true,
        status: "online",
        rssi: -64,
        hopCount: 2,
        commandSuccessRate: 0.98,
        lastSeenAt: "2026-07-01T00:00:00.000Z"
      })
    ).toThrow();
  });
});
