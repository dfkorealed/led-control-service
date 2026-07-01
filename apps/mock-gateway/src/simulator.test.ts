import { describe, expect, it } from "vitest";
import { applyDimmingCommand } from "./simulator";

describe("applyDimmingCommand", () => {
  it("updates matching fixture brightness and power state", () => {
    const states = [
      {
        fixtureId: "33333333-3333-4333-8333-333333333333",
        brightness: 10,
        powerOn: true,
        status: "online" as const,
        rssi: -60,
        hopCount: 1,
        commandSuccessRate: 1,
        lastSeenAt: "2026-07-01T00:00:00.000Z"
      }
    ];

    const next = applyDimmingCommand(states, {
      commandId: "11111111-1111-4111-8111-111111111111",
      siteId: "22222222-2222-4222-8222-222222222222",
      targetType: "fixture",
      targetId: "33333333-3333-4333-8333-333333333333",
      brightness: 0,
      requestedBy: "operator@example.com",
      requestedAt: "2026-07-01T00:00:00.000Z"
    });

    expect(next[0].brightness).toBe(0);
    expect(next[0].powerOn).toBe(false);
  });
});
