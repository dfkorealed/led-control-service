import { describe, expect, it } from "vitest";
import {
  FIXTURE_OPERATIONAL_FRESHNESS_MS,
  FIXTURE_PRESENCE_POLL_INTERVAL_MS,
  GATEWAY_HEARTBEAT_FRESHNESS_MS,
  fixtureOperationalFreshSince,
  gatewayHeartbeatFreshSince,
  isGatewayHeartbeatFresh
} from "./freshness";

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

describe("fixture operational freshness", () => {
  it("uses the exact 20-minute operational boundary and 10-minute poll interval", () => {
    const now = new Date("2026-09-14T00:20:00.000Z");

    expect(fixtureOperationalFreshSince(now)).toEqual(new Date("2026-09-14T00:00:00.000Z"));
    expect(FIXTURE_PRESENCE_POLL_INTERVAL_MS).toBe(600_000);
    expect(FIXTURE_OPERATIONAL_FRESHNESS_MS).toBe(1_200_000);
  });
});
