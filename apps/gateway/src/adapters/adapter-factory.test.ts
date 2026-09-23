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
  it("fails closed when the production adapter is missing or unknown", async () => {
    for (const value of [undefined, "", "stub", "command", "hybrid"]) {
      await expect(createProductionAdapters({ GATEWAY_ADAPTER: value })).rejects.toThrow("PRODUCTION_ADAPTER_REQUIRED");
    }
  });

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

  it("allows the internal-use Company Identifier only for an explicitly acknowledged Lab HIL deployment", async () => {
    const adapter = {
      setBrightness: vi.fn(),
      onFixtureStatus: vi.fn(() => () => undefined),
      onLightingObservation: vi.fn(() => () => undefined),
      resyncFixtureStates: vi.fn(),
      resyncLightingFixtures: vi.fn(),
      syncGroupSubscriptions: vi.fn(),
      acceptsDeviceUuid: vi.fn(() => true),
      scan: vi.fn(),
      identify: vi.fn(),
      provision: vi.fn(),
      vehicleSensors: {
        listConfirmedSources: vi.fn(async () => []),
        resolveByFixtureId: vi.fn(async () => null),
        resolveBySourceUnicast: vi.fn(async () => null),
        configureSource: vi.fn(),
        send: vi.fn(async () => undefined),
        onMessage: vi.fn(() => () => undefined)
      },
      healthProbes: {
        adapterKind: "bluez" as const,
        dbusOwner: vi.fn(async () => true),
        bluezAttached: vi.fn(async () => true),
        mappingValid: vi.fn(async () => true)
      }
    };
    const createBluezAdapter = vi.fn(async () => adapter);

    await expect(createProductionAdapters({
      GATEWAY_ADAPTER: "bluez",
      GATEWAY_DEPLOYMENT_MODE: "lab-hil",
      GATEWAY_LAB_HIL_ACK: "NOT_FOR_PRODUCTION",
      GATEWAY_BLUETOOTH_COMPANY_ID: String(TEST_BLUETOOTH_COMPANY_ID)
    }, { createBluezAdapter })).resolves.toMatchObject({ dimming: adapter });
    expect(createBluezAdapter).toHaveBeenCalledWith(TEST_BLUETOOTH_COMPANY_ID);

    for (const env of [
      { GATEWAY_DEPLOYMENT_MODE: "lab-hil", GATEWAY_BLUETOOTH_COMPANY_ID: String(TEST_BLUETOOTH_COMPANY_ID) },
      { GATEWAY_DEPLOYMENT_MODE: "lab-hil", GATEWAY_LAB_HIL_ACK: "NOT_FOR_PRODUCTION", GATEWAY_BLUETOOTH_COMPANY_ID: "65535" },
      { GATEWAY_DEPLOYMENT_MODE: "lab-hil", GATEWAY_LAB_HIL_ACK: "NOT_FOR_PRODUCTION", GATEWAY_BLUETOOTH_COMPANY_ID: "0x1234" },
      { GATEWAY_DEPLOYMENT_MODE: "production", GATEWAY_LAB_HIL_ACK: "NOT_FOR_PRODUCTION", GATEWAY_BLUETOOTH_COMPANY_ID: String(TEST_BLUETOOTH_COMPANY_ID) },
      { GATEWAY_DEPLOYMENT_MODE: "unknown", GATEWAY_LAB_HIL_ACK: "NOT_FOR_PRODUCTION", GATEWAY_BLUETOOTH_COMPANY_ID: String(TEST_BLUETOOTH_COMPANY_ID) }
    ]) {
      await expect(createProductionAdapters(
        { GATEWAY_ADAPTER: "bluez", ...env },
        { createBluezAdapter }
      )).rejects.toThrow();
    }
  });

  it("constructs one real BlueZ adapter for all production capabilities", async () => {
    const adapter = {
      setBrightness: vi.fn(),
      onFixtureStatus: vi.fn(() => () => undefined),
      onLightingObservation: vi.fn(() => () => undefined),
      resyncFixtureStates: vi.fn(),
      resyncLightingFixtures: vi.fn(),
      syncGroupSubscriptions: vi.fn(),
      acceptsDeviceUuid: vi.fn(() => true),
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
    const healthProbes = {
      adapterKind: "bluez" as const,
      dbusOwner: vi.fn(async () => true),
      bluezAttached: vi.fn(async () => true),
      mappingValid: vi.fn(async () => true)
    };
    const stop = vi.fn(async () => undefined);
    const createBluezAdapter = vi.fn(async () => Object.assign(adapter, { vehicleSensors, healthProbes, stop }));
    const result = await createProductionAdapters(
      { GATEWAY_ADAPTER: "bluez", GATEWAY_BLUETOOTH_COMPANY_ID: "0x1234" },
      { createBluezAdapter }
    );
    expect(result).toMatchObject({
      adapterKind: "bluez",
      dimming: adapter,
      scanner: adapter,
      provisioning: adapter,
      vehicleSensors,
      vehicleSensorCloudSupported: true,
      healthProbes
    });
    expect(createBluezAdapter).toHaveBeenCalledWith(0x1234);
    await result.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("constructs BIO direct USB without reading a Company Identifier or BlueZ dependency", async () => {
    const connection = { kind: "direct-usb" };
    const createBioConnection = vi.fn(() => connection);
    const client = {
      probe: vi.fn(async () => ({ kind: "probe" })),
      close: vi.fn(async () => undefined),
      onEvent: vi.fn(() => () => undefined),
      transportSnapshot: vi.fn(() => ({ transportConnected: true, protocolReady: true }))
    };
    const createBioClient = vi.fn((options: { connectionFactory: () => unknown }) => {
      expect(options.connectionFactory()).toBe(connection);
      return client;
    });
    const mappings = { validate: vi.fn(async () => undefined) };
    const createBioMappingStore = vi.fn(() => mappings);
    const adapter = {
      setBrightness: vi.fn(),
      onFixtureStatus: vi.fn(() => () => undefined),
      onLightingObservation: vi.fn(() => () => undefined),
      resyncFixtureStates: vi.fn(),
      resyncLightingFixtures: vi.fn(),
      syncGroupSubscriptions: vi.fn(),
      acceptsDeviceUuid: vi.fn(() => true),
      scan: vi.fn(),
      identify: vi.fn(),
      provision: vi.fn()
    };
    const createBioAdapter = vi.fn(() => adapter);
    const vehicleSensors = {
      listConfirmedSources: vi.fn(async () => []),
      resolveByFixtureId: vi.fn(async () => null),
      resolveBySourceUnicast: vi.fn(async () => null),
      configureSource: vi.fn(),
      send: vi.fn(),
      onMessage: vi.fn(() => () => undefined)
    };
    const createBioVehicleSensors = vi.fn(() => vehicleSensors);
    const createBioSensorShadowCapture = vi.fn();

    const result = await createProductionAdapters({
      GATEWAY_ADAPTER: "bio-usb",
      GATEWAY_BIO_MAPPING_PATH: "/data/bio-mappings.json",
      GATEWAY_BIO_RESPONSE_TIMEOUT_MS: "450",
      GATEWAY_BIO_SCAN_DURATION_MS: "6500"
    }, {
      createBioConnection: createBioConnection as never,
      createBioClient: createBioClient as never,
      createBioMappingStore: createBioMappingStore as never,
      createBioAdapter: createBioAdapter as never,
      createBioVehicleSensors: createBioVehicleSensors as never,
      createBioSensorShadowCapture: createBioSensorShadowCapture as never
    });

    expect(createBioClient).toHaveBeenCalledWith({
      connectionFactory: expect.any(Function),
      timeoutMs: 450,
      scanDurationMs: 6500
    });
    expect(createBioMappingStore).toHaveBeenCalledWith("/data/bio-mappings.json");
    expect(createBioAdapter).toHaveBeenCalledWith(client, mappings);
    expect(client.probe).toHaveBeenCalledTimes(1);
    expect(mappings.validate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      adapterKind: "bio-usb",
      dimming: adapter,
      scanner: adapter,
      provisioning: adapter,
      vehicleSensors,
      vehicleSensorCloudSupported: false,
      healthProbes: { adapterKind: "bio-usb" }
    });
    expect(result.healthProbes).not.toHaveProperty("dbusOwner");
    expect(result.healthProbes).not.toHaveProperty("bluezAttached");
    await result.stop();
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(client.onEvent).not.toHaveBeenCalled();
    expect(createBioSensorShadowCapture).not.toHaveBeenCalled();
  });

  it("starts an opted-in capture only after probe and mapping validation, forwards events, and closes before USB", async () => {
    const order: string[] = [];
    const event = { kind: "invalid-notification" };
    let listener: ((value: typeof event) => void) | undefined;
    const client = {
      probe: vi.fn(async () => { order.push("probe"); }),
      close: vi.fn(async () => { order.push("usb-close"); }),
      setBrightness: vi.fn(),
      onEvent: vi.fn((callback: typeof listener) => { listener = callback; order.push("subscribe"); return () => { order.push("unsubscribe"); }; }),
      transportSnapshot: vi.fn(() => ({ transportConnected: true, protocolReady: true }))
    };
    const mapping = { nativeUuid: "001122334455", logicalAddress: 0x1234, firmware: "1.2.3", protocol: "crc16", status: "confirmed" };
    const mappings = { validate: vi.fn(async () => { order.push("validate"); }), listConfirmed: vi.fn(async () => [mapping]) };
    const capture = { record: vi.fn(), close: vi.fn(async () => { order.push("capture-close"); }) };
    const logs: unknown[][] = [];
    const log = vi.spyOn(console, "info").mockImplementation((...args) => { logs.push(args); });
    const errorLog = vi.spyOn(console, "error").mockImplementation((...args) => { logs.push(args); });
    const createBioSensorShadowCapture = vi.fn(async (options: { onPhase: (phase: { kind: string; cycle: number }) => void; onComplete: () => void; onFailure: (error: unknown) => void }) => {
      order.push("capture-create");
      options.onPhase({ kind: "baseline", cycle: 0 });
      options.onPhase({ kind: "stimulus", cycle: 1 });
      options.onPhase({ kind: "recovery", cycle: 1 });
      options.onComplete();
      options.onFailure(new Error("SECRET_PAYLOAD"));
      return capture;
    });
    try {
      const result = await createProductionAdapters({ GATEWAY_ADAPTER: "bio-usb", GATEWAY_BIO_SENSOR_SHADOW_CAPTURE_NAME: "bio-sensor-shadow-20260923T010203Z.jsonl" }, {
        createBioClient: vi.fn(() => client) as never,
        createBioMappingStore: vi.fn(() => mappings) as never,
        createBioAdapter: vi.fn(() => ({})) as never,
        createBioVehicleSensors: vi.fn(() => ({})) as never,
        createBioSensorShadowCapture: createBioSensorShadowCapture as never
      });
      expect(order.slice(0, 4)).toEqual(["probe", "validate", "capture-create", "subscribe"]);
      expect(createBioSensorShadowCapture).toHaveBeenCalledWith(expect.objectContaining({
        evidenceRoot: "/var/lib/led-control/evidence", captureName: "bio-sensor-shadow-20260923T010203Z.jsonl",
        source: { nativeUuid: "001122334455", logicalAddress: 0x1234, firmware: "1.2.3", protocol: "crc16" }
      }));
      listener?.(event);
      expect(capture.record).toHaveBeenCalledWith(event);
      expect(result.vehicleSensorCloudSupported).toBe(false);
      expect(client.setBrightness).not.toHaveBeenCalled();
      expect(logs).toEqual([
        ["BIO_SENSOR_SHADOW_PHASE phase=baseline cycle=0"],
        ["BIO_SENSOR_SHADOW_PHASE phase=stimulus cycle=1"],
        ["BIO_SENSOR_SHADOW_PHASE phase=recovery cycle=1"],
        ["BIO_SENSOR_SHADOW_COMPLETE"],
        ["BIO_SENSOR_SHADOW_CAPTURE_FAILED"]
      ]);
      await result.stop();
      expect(order.slice(-3)).toEqual(["unsubscribe", "capture-close", "usb-close"]);
    } finally { log.mockRestore(); errorLog.mockRestore(); }
  });

  it.each([{ rows: [] }, { rows: [{ nativeUuid: "001122334455", logicalAddress: 1, firmware: "1", protocol: "crc16" }, { nativeUuid: "112233445566", logicalAddress: 2, firmware: "1", protocol: "crc16" }] }])("rejects capture unless exactly one mapping is confirmed: $rows", async ({ rows }) => {
    const client = { probe: vi.fn(async () => undefined), close: vi.fn(async () => undefined), onEvent: vi.fn() };
    const createBioSensorShadowCapture = vi.fn();
    await expect(createProductionAdapters({ GATEWAY_ADAPTER: "bio-usb", GATEWAY_BIO_SENSOR_SHADOW_CAPTURE_NAME: "bio-sensor-shadow-20260923T010203Z.jsonl" }, {
      createBioClient: vi.fn(() => client) as never,
      createBioMappingStore: vi.fn(() => ({ validate: vi.fn(async () => undefined), listConfirmed: vi.fn(async () => rows) })) as never,
      createBioSensorShadowCapture: createBioSensorShadowCapture as never
    })).rejects.toThrow();
    expect(createBioSensorShadowCapture).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.onEvent).not.toHaveBeenCalled();
  });

  it("closes USB when capture startup fails and closes USB after a capture close failure", async () => {
    const client = { probe: vi.fn(async () => undefined), close: vi.fn(async () => undefined), onEvent: vi.fn(() => vi.fn()), transportSnapshot: vi.fn(() => ({ transportConnected: true, protocolReady: true })) };
    const mapping = { nativeUuid: "001122334455", logicalAddress: 1, firmware: "1", protocol: "crc16" };
    const common = { createBioClient: vi.fn(() => client) as never, createBioMappingStore: vi.fn(() => ({ validate: vi.fn(async () => undefined), listConfirmed: vi.fn(async () => [mapping]) })) as never, createBioAdapter: vi.fn(() => ({})) as never, createBioVehicleSensors: vi.fn(() => ({})) as never };
    const env = { GATEWAY_ADAPTER: "bio-usb", GATEWAY_BIO_SENSOR_SHADOW_CAPTURE_NAME: "bio-sensor-shadow-20260923T010203Z.jsonl" };
    await expect(createProductionAdapters(env, { ...common, createBioSensorShadowCapture: vi.fn(async () => { throw new Error("startup"); }) as never })).rejects.toThrow("startup");
    expect(client.close).toHaveBeenCalledOnce();
    client.close.mockClear();
    const unsubscribe = vi.fn();
    client.onEvent.mockReturnValue(unsubscribe);
    const capture = { record: vi.fn(), close: vi.fn(async () => { throw new Error("runtime"); }) };
    const result = await createProductionAdapters(env, { ...common, createBioSensorShadowCapture: vi.fn(async () => capture) as never });
    await expect(result.stop()).rejects.toThrow("runtime");
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
    expect(result.vehicleSensorCloudSupported).toBe(false);
  });

  it.each(["0", "-1", "NaN", "1.5"])("rejects invalid BIO timeout or scan duration %s", async (value) => {
    await expect(createProductionAdapters({
      GATEWAY_ADAPTER: "bio-usb",
      GATEWAY_BIO_RESPONSE_TIMEOUT_MS: value
    })).rejects.toThrow("BIO timeout and scan settings");
    await expect(createProductionAdapters({
      GATEWAY_ADAPTER: "bio-usb",
      GATEWAY_BIO_SCAN_DURATION_MS: value
    })).rejects.toThrow("BIO timeout and scan settings");
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
    expect(probes.adapterKind).toBe("bluez");
    if (probes.adapterKind !== "bluez") throw new Error("expected BlueZ health probes");

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
