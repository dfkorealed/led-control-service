import { describe, expect, it } from "vitest";
import { demoIds } from "@led-control/shared";
import { applyDimmingCommand, createMockDiscoveredNodes } from "./simulator";

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
      requestedBy: demoIds.userId,
      requestedAt: "2026-07-01T00:00:00.000Z"
    });

    expect(next[0].brightness).toBe(0);
    expect(next[0].powerOn).toBe(false);
  });

  it("updates fixtures that belong to a group target", () => {
    const states = [
      {
        fixtureId: "00000000-0000-4000-8000-000000002001",
        brightness: 10,
        powerOn: true,
        status: "online" as const,
        rssi: -60,
        hopCount: 1,
        commandSuccessRate: 1,
        lastSeenAt: "2026-07-01T00:00:00.000Z"
      },
      {
        fixtureId: "00000000-0000-4000-8000-000000002009",
        brightness: 10,
        powerOn: true,
        status: "online" as const,
        rssi: -62,
        hopCount: 2,
        commandSuccessRate: 1,
        lastSeenAt: "2026-07-01T00:00:00.000Z"
      }
    ];

    const next = applyDimmingCommand(
      states,
      {
        commandId: "11111111-1111-4111-8111-111111111111",
        siteId: "22222222-2222-4222-8222-222222222222",
        targetType: "group",
        targetId: "00000000-0000-4000-8000-000000000006",
        brightness: 35,
        requestedBy: demoIds.userId,
        requestedAt: "2026-07-01T00:00:00.000Z"
      },
      { "00000000-0000-4000-8000-000000000006": ["00000000-0000-4000-8000-000000002001"] }
    );

    expect(next[0].brightness).toBe(35);
    expect(next[1].brightness).toBe(10);
  });

  it("uses targetFixtureIds from the command payload before environment group maps", () => {
    const states = [
      {
        fixtureId: "00000000-0000-4000-8000-000000002001",
        brightness: 10,
        powerOn: true,
        status: "online" as const,
        rssi: -60,
        hopCount: 1,
        commandSuccessRate: 1,
        lastSeenAt: "2026-07-01T00:00:00.000Z"
      },
      {
        fixtureId: "00000000-0000-4000-8000-000000002002",
        brightness: 10,
        powerOn: true,
        status: "online" as const,
        rssi: -62,
        hopCount: 1,
        commandSuccessRate: 1,
        lastSeenAt: "2026-07-01T00:00:00.000Z"
      }
    ];

    const next = applyDimmingCommand(
      states,
      {
        commandId: "11111111-1111-4111-8111-111111111111",
        siteId: "22222222-2222-4222-8222-222222222222",
        targetType: "group",
        targetId: "00000000-0000-4000-8000-000000000006",
        targetFixtureIds: ["00000000-0000-4000-8000-000000002002"],
        brightness: 25,
        requestedBy: demoIds.userId,
        requestedAt: "2026-07-01T00:00:00.000Z"
      },
      { "00000000-0000-4000-8000-000000000006": ["00000000-0000-4000-8000-000000002001"] }
    );

    expect(next[0].brightness).toBe(10);
    expect(next[1].brightness).toBe(25);
  });
});

describe("createMockDiscoveredNodes", () => {
  it("returns deterministic unprovisioned nodes for a registration session", () => {
    const nodes = createMockDiscoveredNodes({
      sessionId: "11111111-1111-4111-8111-111111111111",
      floorName: "B2",
      count: 3
    });

    expect(nodes).toHaveLength(3);
    expect(nodes[0]).toMatchObject({
      sessionId: "11111111-1111-4111-8111-111111111111",
      deviceUuid: "esp32h2-b2-001",
      serialNumber: "LC-B2-001",
      rssi: -54,
      oobCapability: "static-oob",
      firmwareVersion: "mock-node-0.1.0"
    });
    expect(nodes[2].deviceUuid).toBe("esp32h2-b2-003");
  });
});
