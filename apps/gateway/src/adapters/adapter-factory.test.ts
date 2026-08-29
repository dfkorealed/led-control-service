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
  isBluezAdapterPowered,
  isHciRfkillUnblocked
} from "./adapter-factory";

describe("createProductionAdapters", () => {
  it("rejects stub and command adapters in every environment", async () => {
    await expect(createProductionAdapters({ GATEWAY_ADAPTER: "stub" })).rejects.toThrow("PRODUCTION_ADAPTER_REQUIRED");
    await expect(createProductionAdapters({ GATEWAY_ADAPTER: "command" })).rejects.toThrow("PRODUCTION_ADAPTER_REQUIRED");
  });

  it("constructs one real BlueZ adapter for all production capabilities", async () => {
    const adapter = {
      setBrightness: vi.fn(),
      onFixtureStatus: vi.fn(() => () => undefined),
      resyncFixtureStates: vi.fn(),
      syncGroupSubscriptions: vi.fn(),
      scan: vi.fn(),
      identify: vi.fn(),
      provision: vi.fn()
    };
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
    expect(source).toContain("mqttTopics.meshGroupSubscriptionSync");
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

  it("does not treat an unblocked rfkill controller as a powered BlueZ adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-hci-"));
    await mkdir(join(root, "rfkill7"));
    await writeFile(join(root, "rfkill7", "type"), "bluetooth\n");
    await writeFile(join(root, "rfkill7", "state"), "1\n");
    const transport = { call: vi.fn().mockResolvedValue(false) };

    await expect(isHciRfkillUnblocked(root)).resolves.toBe(true);
    await expect(isBluezAdapterPowered(transport, "/org/bluez/hci7")).resolves.toBe(false);
    expect(transport.call).toHaveBeenCalledWith(
      "org.bluez",
      "/org/bluez/hci7",
      "org.freedesktop.DBus.Properties",
      "Get",
      ["org.bluez.Adapter1", "Powered"]
    );
  });

  it("fails closed when BlueZ cannot read the configured adapter power state", async () => {
    const transport = { call: vi.fn().mockRejectedValue(new Error("D-Bus unavailable")) };

    await expect(isBluezAdapterPowered(transport, "/org/bluez/hci7")).resolves.toBe(false);
  });

  it("accepts only a true Powered value from the configured BlueZ adapter", async () => {
    const transport = { call: vi.fn().mockResolvedValue(true) };

    await expect(isBluezAdapterPowered(transport, "/org/bluez/hci7")).resolves.toBe(true);
  });

  it("accepts the boolean variant shape returned by dbus-native", async () => {
    const transport = { call: vi.fn().mockResolvedValue([[{ type: "b", child: [] }], [true]]) };

    await expect(isBluezAdapterPowered(transport, "/org/bluez/hci7")).resolves.toBe(true);
  });
});
