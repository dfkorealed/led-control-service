import { describe, expect, it } from "vitest";
import { matchesMonitoringFixture } from "./monitoring-fixture-filter";
describe("KPI filters use authoritative DTO categories", () => {
  it("includes command failures in fault and not offline", () => {
    expect(matchesMonitoringFixture({ status: "fault" }, "fault", { kind: "placed", point: { x: 1, y: 1 } })).toBe(true);
    expect(matchesMonitoringFixture({ status: "fault" }, "offline", { kind: "placed", point: { x: 1, y: 1 } })).toBe(false);
  });
  it("does not treat unknown coordinates as unplaced", () => {
    expect(matchesMonitoringFixture({ status: "online" }, "unplaced", { kind: "unknown" })).toBe(false);
  });
});
