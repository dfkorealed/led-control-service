import { describe, expect, it } from "vitest";
import { GATEWAY_HEARTBEAT_FRESHNESS_MS, gatewayHeartbeatFreshSince, isGatewayHeartbeatFresh } from "./freshness";

describe("gateway heartbeat freshness", () => {
  const now = new Date("2026-07-11T00:05:00.000Z");

  it("uses one inclusive 90-second boundary for queries and status decisions", () => {
    expect(GATEWAY_HEARTBEAT_FRESHNESS_MS).toBe(90_000);
    expect(gatewayHeartbeatFreshSince(now)).toEqual(new Date("2026-07-11T00:03:30.000Z"));
    expect(isGatewayHeartbeatFresh(new Date("2026-07-11T00:03:30.001Z"), now)).toBe(true);
    expect(isGatewayHeartbeatFresh(new Date("2026-07-11T00:03:30.000Z"), now)).toBe(true);
    expect(isGatewayHeartbeatFresh(new Date("2026-07-11T00:03:29.999Z"), now)).toBe(false);
    expect(isGatewayHeartbeatFresh(null, now)).toBe(false);
  });
});
