import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createBluezHealthProbes,
  createProductionAdapters,
  isHciRfkillUnblocked
} from "./adapter-factory";
import { TEST_BLUETOOTH_COMPANY_ID } from "../test-fixtures/vehicle-sensor-protocol";

describe("createProductionAdapters", () => {
  it("rejects stub and command adapters in every environment", async () => {
    await expect(createProductionAdapters({ GATEWAY_ADAPTER: "stub" })).rejects.toThrow("PRODUCTION_ADAPTER_REQUIRED");
    await expect(createProductionAdapters({ GATEWAY_ADAPTER: "command" })).rejects.toThrow("PRODUCTION_ADAPTER_REQUIRED");
  });

  it("fails closed without a deployment-owned Company Identifier", async () => {
    const createBluezAdapter = vi.fn();
    for (const value of [undefined, "0", "0x02e5", String(TEST_BLUETOOTH_COMPANY_ID)]) {
      await expect(createProductionAdapters(
        { GATEWAY_ADAPTER: "bluez", GATEWAY_BLUETOOTH_COMPANY_ID: value },
        { createBluezAdapter }
      )).rejects.toThrow("owned_bluetooth_company_id_required");
    }
    expect(createBluezAdapter).not.toHaveBeenCalled();
  });

  it("constructs one real BlueZ adapter for all production capabilities", async () => {
    const adapter = {
      setBrightness: vi.fn(),
      onFixtureStatus: vi.fn(() => () => undefined),
      onLightingObservation: vi.fn(() => () => undefined),
      resyncFixtureStates: vi.fn(),
      resyncLightingFixtures: vi.fn(),
      syncGroupSubscriptions: vi.fn(),
      scan: vi.fn(),
      identify: vi.fn(),
      provision: vi.fn()
    };
    const vehicleSensors = {
      listConfirmedSources: vi.fn(async () => []),
      resolveByFixtureId: vi.fn(async () => null),
      resolveBySourceUnicast: vi.fn(async () => null),
      configureSource: vi.fn(),
      send: vi.fn(async () => undefined),
      onMessage: vi.fn(() => () => undefined)
    };
    const createBluezAdapter = vi.fn(async () => Object.assign(adapter, { vehicleSensors }));
    const result = await createProductionAdapters(
      { GATEWAY_ADAPTER: "bluez", GATEWAY_BLUETOOTH_COMPANY_ID: "0x1234" },
      { createBluezAdapter }
    );
    expect(result).toEqual({ dimming: adapter, scanner: adapter, provisioning: adapter, vehicleSensors });
    expect(createBluezAdapter).toHaveBeenCalledWith(0x1234);
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
    expect(source).toContain("mqttTopics.meshGroupSubscriptionSync");
  });

  it("does not let the non-root Gateway runtime invoke btmgmt", () => {
    const source = readFileSync(resolve(import.meta.dirname, "adapter-factory.ts"), "utf8");

    expect(source).not.toContain("btmgmt");
    expect(source).not.toContain("node:child_process");
  });

  it("verifies the attached node through D-Bus instead of trusting a cached node path", async () => {
    const transport = { call: vi.fn().mockResolvedValue('<node><interface name="org.bluez.mesh.Node1"/></node>') };
    const probes = createBluezHealthProbes(
      transport as never,
      { nodePath: "/org/bluez/mesh/node1" } as never,
      { validate: vi.fn() } as never
    );

    await expect(probes.bluezAttached()).resolves.toBe(true);
    transport.call.mockResolvedValueOnce('<node><interface name="org.bluez.mesh.Management1"/></node>');
    await expect(probes.bluezAttached()).resolves.toBe(false);
    expect(transport.call).toHaveBeenCalledWith(
      "org.bluez.mesh",
      "/org/bluez/mesh/node1",
      "org.freedesktop.DBus.Introspectable",
      "Introspect",
      []
    );
  });

  it("retains rfkill only as an optional diagnostic", async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-hci-"));
    await mkdir(join(root, "rfkill7"));
    await writeFile(join(root, "rfkill7", "type"), "bluetooth\n");
    await writeFile(join(root, "rfkill7", "state"), "1\n");

    await expect(isHciRfkillUnblocked(root)).resolves.toBe(true);
  });
});
