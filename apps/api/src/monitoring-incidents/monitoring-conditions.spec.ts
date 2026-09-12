import { isMonitoringConditionActive } from "./monitoring-conditions";

describe("current monitoring conditions", () => {
  const now = new Date("2026-09-12T00:10:00.000Z");
  const policy = { gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 180 };
  const fixture = { lastSeenAt: now, statusReason: null, healthFaultCodes: [], healthLastSeenAt: now };

  it("keeps the exact threshold fresh and expires one millisecond later", () => {
    for (const [age, expected] of [[90_000, false], [90_001, true]] as const) {
      expect(isMonitoringConditionActive("gateway_offline", { gateway: { lastHeartbeatAt: new Date(now.getTime() - age) } }, policy, now)).toBe(expected);
    }
    for (const [age, expected] of [[180_000, false], [180_001, true]] as const) {
      expect(isMonitoringConditionActive("fixture_stale", { gateway: { lastHeartbeatAt: now }, fixture: { ...fixture, lastSeenAt: new Date(now.getTime() - age) } }, policy, now)).toBe(expected);
    }
  });
  it("uses per-Site thresholds for the same device snapshot", () => {
    const target = { gateway: { lastHeartbeatAt: new Date("2026-09-12T00:09:00.000Z") } };
    expect(isMonitoringConditionActive("gateway_offline", target, policy, now)).toBe(false);
    expect(isMonitoringConditionActive("gateway_offline", target, { ...policy, gatewayOfflineAfterSeconds: 30 }, now)).toBe(true);
  });
  it("suppresses first-state waiting and gateway-caused stale duplicates", () => {
    expect(isMonitoringConditionActive("fixture_stale", { fixture: { ...fixture, lastSeenAt: null, statusReason: "provisioning_waiting_state" } }, policy, now)).toBe(false);
    expect(isMonitoringConditionActive("fixture_stale", { fixture: { ...fixture, lastSeenAt: null }, gateway: { lastHeartbeatAt: null } }, policy, now)).toBe(false);
  });
  it("keeps Health fault and command failure independent from freshness", () => {
    expect(isMonitoringConditionActive("fixture_fault", { fixture: { ...fixture, healthFaultCodes: [1] }, gateway: { lastHeartbeatAt: null } }, policy, now)).toBe(true);
    expect(isMonitoringConditionActive("fixture_fault", { fixture: { ...fixture, healthFaultCodes: [0] } }, policy, now)).toBe(false);
    expect(isMonitoringConditionActive("command_failed", { fixture: { ...fixture, statusReason: "command_failed" } }, policy, now)).toBe(true);
    expect(isMonitoringConditionActive("command_failed", { fixture }, policy, now)).toBe(false);
  });
  it("requires a currently online mapped gateway for fixture-stale incidents", () => {
    expect(isMonitoringConditionActive("fixture_stale", { fixture: { ...fixture, lastSeenAt: null }, gateway: null }, policy, now)).toBe(false);
  });
});
