import { describe, expect, it } from "vitest";
import { demoIds } from "./demo";
import {
  dimmingCommandSchema,
  fixtureStateSchema,
  provisioningScanStartSchema,
  unprovisionedDeviceFoundSchema
} from "./schemas";
import { mqttTopics } from "./mqtt";

describe("shared schemas", () => {
  it("accepts a valid dimming command", () => {
    const parsed = dimmingCommandSchema.parse({
      commandId: "11111111-1111-4111-8111-111111111111",
      siteId: "22222222-2222-4222-8222-222222222222",
      targetType: "fixture",
      targetId: "33333333-3333-4333-8333-333333333333",
      brightness: 70,
      requestedBy: demoIds.userId,
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

  it("defines provisioning MQTT topics and validates discovered node events", () => {
    expect(
      mqttTopics.provisioningScanStart(
        "00000000-0000-4000-8000-000000000003",
        "00000000-0000-4000-8000-000000000004"
      )
    ).toBe(
      "sites/00000000-0000-4000-8000-000000000003/gateways/00000000-0000-4000-8000-000000000004/commands/provisioning-scan-start"
    );

    const scanCommand = provisioningScanStartSchema.parse({
      sessionId: "11111111-1111-4111-8111-111111111111",
      siteId: "00000000-0000-4000-8000-000000000003",
      gatewayId: "00000000-0000-4000-8000-000000000004",
      floorId: "00000000-0000-4000-8000-000000000005",
      requestedBy: demoIds.userId,
      requestedAt: "2026-07-01T00:00:00.000Z"
    });

    expect(scanCommand.floorId).toBe("00000000-0000-4000-8000-000000000005");

    const discovered = unprovisionedDeviceFoundSchema.parse({
      sessionId: "11111111-1111-4111-8111-111111111111",
      deviceUuid: "esp32h2-demo-001",
      serialNumber: "LC-B2-001",
      rssi: -54,
      oobCapability: "static-oob",
      firmwareVersion: "mock-node-0.1.0",
      discoveredAt: "2026-07-01T00:00:01.000Z"
    });

    expect(discovered.rssi).toBe(-54);
  });
});
