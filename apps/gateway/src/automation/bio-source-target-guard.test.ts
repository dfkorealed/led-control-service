import { describe, expect, it } from "vitest";
import type { AutomationSnapshot } from "@led-control/shared";
import { isActiveBioSourceTarget } from "./bio-source-target-guard";

describe("active BIO source target protection", () => {
  it.each([
    [3, "enabled", "bio-usb-pulse", true],
    [3, "disabled", "bio-usb-pulse", false],
    [4, "enabled", "bio-usb-pulse", false],
    [2, "enabled", "bio-usb-pulse", true],
    [2, "disabled", "bio-usb-pulse", false],
    [2, "enabled", "bluez-stateful", false],
    [1, "enabled", undefined, false]
  ] as const)("derives protection from snapshot v%s %s %s", (schemaVersion, status, sensorProtocol, blocked) => {
    const snapshot = { schemaVersion, vehicleEventRules: [{ status, sensorProtocol, sourceFixtureIds: ["source-a"] }] } as AutomationSnapshot;
    expect(isActiveBioSourceTarget(snapshot, ["target-b", "SOURCE-A"])).toBe(blocked);
    expect(isActiveBioSourceTarget(snapshot, ["target-b"])).toBe(false);
    expect(isActiveBioSourceTarget(null, ["source-a"])).toBe(false);
  });
});
