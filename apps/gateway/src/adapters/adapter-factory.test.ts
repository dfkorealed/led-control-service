import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProductionAdapters } from "./adapter-factory";

describe("createProductionAdapters", () => {
  it("rejects stub and command adapters in every environment", async () => {
    await expect(createProductionAdapters({ GATEWAY_ADAPTER: "stub" })).rejects.toThrow("PRODUCTION_ADAPTER_REQUIRED");
    await expect(createProductionAdapters({ GATEWAY_ADAPTER: "command" })).rejects.toThrow("PRODUCTION_ADAPTER_REQUIRED");
  });

  it("constructs one real BlueZ adapter for all production capabilities", async () => {
    const adapter = { setBrightness: vi.fn(), scan: vi.fn(), identify: vi.fn(), provision: vi.fn() };
    const result = await createProductionAdapters(
      { GATEWAY_ADAPTER: "bluez" },
      { createBluezAdapter: async () => adapter }
    );
    expect(result).toEqual({ dimming: adapter, scanner: adapter, provisioning: adapter });
  });

  it("keeps stub adapter construction out of the gateway entrypoint", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../index.ts"), "utf8");
    expect(source).not.toContain("new StubBleMeshAdapter");
    expect(source).not.toContain("new StubProvisioningAdapter");
    expect(source).not.toContain("new StubProvisioningScannerAdapter");
    expect(source).toContain('GATEWAY_PHASE0_PROBE === "1"');
    expect(source).not.toContain("mqttTopics.dimmingCommand");
    expect(source).not.toContain("mqttTopics.commandAck");
    expect(source).not.toContain("mqttTopics.fixtureState");
    expect(source).not.toContain("mqttTopics.gatewayHeartbeat");
  });
});
