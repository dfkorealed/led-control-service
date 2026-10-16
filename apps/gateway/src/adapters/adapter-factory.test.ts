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
import { createGatewayShutdownHandler, startGatewayRuntime } from "../index";
import { BioDongleClient } from "../bio/bio-dongle-client";
import { BioDeviceMappingStore } from "../bio/bio-device-mapping-store";
import { BioUsbDongleAdapter } from "./bio-usb-dongle-adapter";
import { createBioCapabilityReporting } from "../index";
import { createHash } from "node:crypto";

function sourceClientMetadata() {
  return { sensorSourceSnapshot: vi.fn(() => ({ state: "ready" as const, generation: 1, ready: true,
    transportConnected: true, protocolReady: true })), onSensorSourceState: vi.fn(() => () => undefined),
    onSensorPulseCandidate: vi.fn(() => () => undefined) };
}
function sourceMappingMetadata() {
  return { onChange: vi.fn(() => () => undefined), findByNativeUuid: vi.fn(async () => null) };
}

describe("createProductionAdapters", () => {
  it("wires production OFF reporting through actual read-only mappings and canonical command identity", async () => {
    const fixtureId = "11111111-1111-4111-8111-111111111111", nodeId = "22222222-2222-4222-8222-222222222222";
    const client = new BioDongleClient({}); vi.spyOn(client, "probe").mockResolvedValue({} as never);
    vi.spyOn(client, "sensorSourceSnapshot").mockReturnValue({ state: "ready", generation: 1, ready: true, transportConnected: true, protocolReady: true });
    const directory = await mkdtemp(join(tmpdir(), "bio-off-factory-"));
    const mappings = new BioDeviceMappingStore(join(directory, "mappings.json"));
    await mappings.reserve({ fixtureId, nodeId: fixtureId, nativeUuid: "001122334455", deviceUuid: "bio:001122334455",
      logicalAddress: 256, observedLogicalAddressBeforeAssignment: 5, commandId: "registration", firmware: "not-authority", protocol: "crc16" });
    await mappings.confirm("bio:001122334455", 256);
    const adapters = await createProductionAdapters({ GATEWAY_ADAPTER: "bio-usb" }, {
      createBioClient: () => client, createBioMappingStore: () => mappings, createBioAdapter: () => ({} as never)
    });
    expect(adapters.bioCapabilityIdentity).toBeDefined();
    const scope = { siteId: fixtureId, gatewayId: nodeId, assignmentVersion: 3 };
    const controller = await createBioCapabilityReporting(adapters, join(directory, "capabilities.json"), () => scope,
      () => Promise.resolve(true), () => new Date("2026-10-02T00:00:01Z"));
    const deliveries: unknown[] = [];
    try {
      await controller!.connect(async (_topic, delivery) => { deliveries.push(delivery); }); expect(deliveries).toEqual([]);
      await controller!.recordIdentityProof({ version: 2, commandId: "33333333-3333-4333-8333-333333333333", ...scope,
        fixtureId, nodeId, meshAddress: "0x0100", deviceIdentityHash: createHash("sha256").update("bio:001122334455").digest("hex"),
        operation: "query", requestedAt: "2026-10-02T00:00:00Z", expiresAt: "2026-10-02T00:00:30Z" });
      await controller!.wake();
      expect(deliveries).toHaveLength(1); expect(deliveries[0]).toMatchObject({ report: { meshNodeId: nodeId, readiness: "off", verifiedFingerprintId: null, sensorModeVerifiedAt: null } });
      expect(adapters.bioPulseSource!.sourceAuthority(fixtureId)).toBeNull(); expect(adapters.vehicleSensorCloudSupported).toBe(false);
    } finally { await controller!.stopAndDrain(); await adapters.stop(); }
  });
  it("exposes the actual adapter configuration port with the same client and guarded operation control", async () => {
    const client = new BioDongleClient({}); vi.spyOn(client, "probe").mockResolvedValue({} as never);
    vi.spyOn(client, "scan").mockResolvedValue([{ nativeUuid: "001122334455", deviceUuid: "bio:001122334455",
      logicalAddress: 256, networkId: 2, firmwareVersion: "1.2.3", rssi: -40 }]);
    const configuration = { configuredHighBrightnessPercent: 30, bioMode: "sensor" as const };
    const read = vi.spyOn(client, "readConfiguration").mockResolvedValue(configuration);
    const restore = vi.spyOn(client, "restoreConfiguration").mockResolvedValue(configuration);
    const mappings = new BioDeviceMappingStore(join(await mkdtemp(join(tmpdir(), "bio-target-factory-")), "mapping.json"));
    await mappings.reserve({ fixtureId: "fixture-b", nodeId: "node-b", nativeUuid: "001122334455", deviceUuid: "bio:001122334455",
      logicalAddress: 256, observedLogicalAddressBeforeAssignment: 5, commandId: "test", firmware: "1.2.3", protocol: "crc16" });
    await mappings.confirm("bio:001122334455", 256);
    const adapters = await createProductionAdapters({ GATEWAY_ADAPTER: "bio-usb" }, {
      createBioClient: () => client, createBioMappingStore: () => mappings,
      createBioAdapter: (ownedClient, ownedMapping) => new BioUsbDongleAdapter(ownedClient, ownedMapping)
    });
    const beforeWrite = vi.fn(async () => {}); const control = { beforeWrite, mayStartWrite: () => true };
    const observed = await adapters.bioTargetConfiguration!.readBioState("fixture-b", control);
    await adapters.bioTargetConfiguration!.restoreBioState("fixture-b", observed.target, configuration, control);
    expect(read).toHaveBeenCalledWith({ kind: "unicast", nativeUuid: "001122334455", logicalAddress: 256, networkId: 2 },
      expect.objectContaining({ ...control, registrationCurrent: expect.any(Function) }));
    expect(read.mock.calls[0][1]?.registrationCurrent?.()).toBe(true);
    expect(restore.mock.calls[0][2]?.beforeWrite).toBe(beforeWrite);
    expect(restore.mock.calls[0][2]?.mayStartWrite?.()).toBe(true);
    expect(adapters.vehicleSensorCloudSupported).toBe(false); await adapters.stop();
  });
  it("owns one fail-closed pulse subscription until adapter shutdown without an env profile bypass", async () => {
    const client = new BioDongleClient({});
    vi.spyOn(client, "probe").mockResolvedValue({} as never);
    const subscribe = vi.spyOn(client, "onSensorPulseCandidate");
    const mappings = new BioDeviceMappingStore(join(await mkdtemp(join(tmpdir(), "bio-source-factory-")), "mapping.json"));
    const adapters = await createProductionAdapters({ GATEWAY_ADAPTER: "bio-usb", GATEWAY_BIO_PULSE_SUPPORTED: "true" }, {
      createBioClient: () => client, createBioMappingStore: () => mappings, createBioAdapter: () => ({} as never)
    });
    expect(adapters.bioPulseSource).toBeDefined();
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(adapters.bioPulseSource!.sourceAuthority("fixture-1")).toBeNull();
    expect(adapters.vehicleSensorCloudSupported).toBe(false);
    await adapters.stop();
    expect(adapters.bioPulseSource!.sourceAuthority("fixture-1")).toBeNull();
  });

  it("keeps different Fixture and node UUIDs unqualified in the actual production source factory", async () => {
    const fixtureId = "11111111-1111-4111-8111-111111111111";
    const nodeId = "22222222-2222-4222-8222-222222222222";
    const client = new BioDongleClient({}); vi.spyOn(client, "probe").mockResolvedValue({} as never);
    vi.spyOn(client, "sensorSourceSnapshot").mockReturnValue({ state: "ready", generation: 1, ready: true,
      transportConnected: true, protocolReady: true });
    const mappings = new BioDeviceMappingStore(join(await mkdtemp(join(tmpdir(), "bio-source-factory-ids-")), "mapping.json"));
    await mappings.reserve({ fixtureId, nodeId, nativeUuid: "001122334455", deviceUuid: "bio:001122334455",
      logicalAddress: 256, observedLogicalAddressBeforeAssignment: 5, commandId: "software-identity-regression",
      firmware: "not-authority", protocol: "crc16" });
    await mappings.confirm("bio:001122334455", 256);
    const adapters = await createProductionAdapters({ GATEWAY_ADAPTER: "bio-usb", GATEWAY_BIO_PULSE_SUPPORTED: "true" }, {
      createBioClient: () => client, createBioMappingStore: () => mappings, createBioAdapter: () => ({} as never)
    });
    try {
      for (const id of [fixtureId, nodeId]) {
        expect(await adapters.bioPulseSource!.preflight({ sourceFixtureId: id, snapshotRevision: 1 }, { requireHealthy: true })).toBeNull();
        expect(adapters.bioPulseSource!.sourceAuthority(id)).toBeNull();
      }
      expect(adapters.vehicleSensorCloudSupported).toBe(false);
    } finally { await adapters.stop(); }
  });

  it("releases the pulse observer and original client if later adapter construction fails", async () => {
    const client = new BioDongleClient({});
    vi.spyOn(client, "probe").mockResolvedValue({} as never);
    const close = vi.spyOn(client, "close"); const unsubscribe = vi.fn();
    vi.spyOn(client, "onSensorPulseCandidate").mockReturnValue(unsubscribe);
    const mappings = new BioDeviceMappingStore(join(await mkdtemp(join(tmpdir(), "bio-source-failure-")), "mapping.json"));
    await expect(createProductionAdapters({ GATEWAY_ADAPTER: "bio-usb" }, { createBioClient: () => client,
      createBioMappingStore: () => mappings, createBioAdapter: () => { throw new Error("construction failed"); } })).rejects.toThrow("construction failed");
    expect(unsubscribe).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });
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

  it.each([
    { response: undefined, observation: undefined, expectedResponse: 1000, expectedObservation: 2000 },
    { response: "450", observation: undefined, expectedResponse: 450, expectedObservation: 2000 },
    { response: "450", observation: "650", expectedResponse: 450, expectedObservation: 650 }
  ])("constructs BIO direct USB with independent response=$expectedResponse/report=$expectedObservation limits", async ({ response, observation, expectedResponse, expectedObservation }) => {
    const connection = { kind: "direct-usb" };
    const createBioConnection = vi.fn(() => connection);
    const client = {
      ...sourceClientMetadata(),
      probe: vi.fn(async () => ({ kind: "probe" })),
      close: vi.fn(async () => undefined),
      onEvent: vi.fn(() => () => undefined),
      transportSnapshot: vi.fn(() => ({ transportConnected: true, protocolReady: true }))
    };
    const createBioClient = vi.fn((options: { connectionFactory: () => unknown }) => {
      expect(options.connectionFactory()).toBe(connection);
      return client;
    });
    const mappings = { ...sourceMappingMetadata(), validate: vi.fn(async () => undefined) };
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
      GATEWAY_BIO_RESPONSE_TIMEOUT_MS: response,
      GATEWAY_BIO_OBSERVATION_TIMEOUT_MS: observation,
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
      timeoutMs: expectedResponse,
      observationTimeoutMs: expectedObservation,
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
    expect(client.onEvent).toHaveBeenCalledOnce();
    expect(createBioSensorShadowCapture).not.toHaveBeenCalled();
  });

  it("starts an opted-in capture only after probe and mapping validation, forwards events, and closes before USB", async () => {
    const order: string[] = [];
    const event = { kind: "invalid-notification" };
    let listener: ((value: typeof event) => void) | undefined;
    const client = {
      ...sourceClientMetadata(),
      probe: vi.fn(async () => { order.push("probe"); }),
      close: vi.fn(async () => { order.push("usb-close"); }),
      setBrightness: vi.fn(),
      onEvent: vi.fn((callback: typeof listener) => {
        if (listener) return () => undefined;
        listener = callback; order.push("subscribe"); return () => { order.push("unsubscribe"); };
      }),
      transportSnapshot: vi.fn(() => ({ transportConnected: true, protocolReady: true }))
    };
    const mapping = { nativeUuid: "001122334455", logicalAddress: 0x1234, firmware: "1.2.3", protocol: "crc16", status: "confirmed" };
    const mappings = { ...sourceMappingMetadata(), validate: vi.fn(async () => { order.push("validate"); }), listConfirmed: vi.fn(async () => [mapping]) };
    const capture = { record: vi.fn(), close: vi.fn(async () => { order.push("capture-close"); }) };
    const logs: unknown[][] = [];
    let failCapture: ((error: unknown) => void) | undefined;
    const log = vi.spyOn(console, "info").mockImplementation((...args) => { logs.push(args); });
    const errorLog = vi.spyOn(console, "error").mockImplementation((...args) => { logs.push(args); });
    const createBioSensorShadowCapture = vi.fn(async (options: { onPhase: (phase: { kind: string; cycle: number }) => void; onComplete: () => void; onFailure: (error: unknown) => void }) => {
      order.push("capture-create");
      options.onPhase({ kind: "baseline", cycle: 0 });
      options.onPhase({ kind: "stimulus", cycle: 1 });
      options.onPhase({ kind: "recovery", cycle: 1 });
      options.onComplete();
      failCapture = options.onFailure;
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
      failCapture?.(new Error("SECRET_PAYLOAD"));
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

  it("sanitizes a secret-bearing recorder startup error before it reaches Gateway startup logging", async () => {
    const secret = "SITE_SECRET";
    const path = "/var/lib/led-control/evidence/bio-sensor-shadow-20260923T010203Z.jsonl";
    const client = { probe: vi.fn(async () => undefined), close: vi.fn(async () => undefined), onEvent: vi.fn(() => vi.fn()), transportSnapshot: vi.fn(() => ({ transportConnected: true, protocolReady: true })) };
    const mapping = { nativeUuid: "001122334455", logicalAddress: 1, firmware: "1", protocol: "crc16" };
    const common = { createBioClient: vi.fn(() => client) as never, createBioMappingStore: vi.fn(() => ({ validate: vi.fn(async () => undefined), listConfirmed: vi.fn(async () => [mapping]) })) as never, createBioAdapter: vi.fn(() => ({})) as never, createBioVehicleSensors: vi.fn(() => ({})) as never };
    const env = { GATEWAY_ADAPTER: "bio-usb", GATEWAY_BIO_SENSOR_SHADOW_CAPTURE_NAME: "bio-sensor-shadow-20260923T010203Z.jsonl" };
    const failure = await startGatewayRuntime({
      env,
      resolveAssignment: vi.fn(async () => ({})) as never,
      ensureMqttIdentity: vi.fn(async () => undefined),
      createAdapters: ((runtimeEnv: NodeJS.ProcessEnv) => createProductionAdapters(runtimeEnv, {
        ...common,
        createBioSensorShadowCapture: vi.fn(async () => { throw new Error(`EEXIST ${path} ${secret}`); }) as never
      })) as never
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("BIO_SENSOR_SHADOW_CAPTURE_FAILED");
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(String((failure as Error).stack)).not.toContain(secret);
    expect(String((failure as Error).stack)).not.toContain(path);
    // index.ts의 startup 최종 처리기는 Error.message를 console.error로 전달한다.
    const startupLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      console.error(failure instanceof Error ? failure.message : failure);
      expect(startupLog).toHaveBeenCalledWith("BIO_SENSOR_SHADOW_CAPTURE_FAILED");
      expect(JSON.stringify(startupLog.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(startupLog.mock.calls)).not.toContain(path);
    } finally { startupLog.mockRestore(); }
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.onEvent).not.toHaveBeenCalled();
  });

  it("sanitizes a secret-bearing recorder close error before Gateway shutdown logging and still closes USB", async () => {
    const secret = "SITE_SECRET";
    const path = "/var/lib/led-control/evidence/bio-sensor-shadow-20260923T010203Z.jsonl";
    const order: string[] = [];
    const unsubscribe = vi.fn(() => { order.push("unsubscribe"); });
    const client = { ...sourceClientMetadata(), probe: vi.fn(async () => undefined), close: vi.fn(async () => { order.push("usb-close"); }), onEvent: vi.fn().mockReturnValueOnce(unsubscribe).mockReturnValue(() => undefined), transportSnapshot: vi.fn(() => ({ transportConnected: true, protocolReady: true })) };
    const mapping = { nativeUuid: "001122334455", logicalAddress: 1, firmware: "1", protocol: "crc16" };
    const capture = { record: vi.fn(), close: vi.fn(async () => { order.push("capture-close"); throw new Error(`EIO ${path} ${secret}`); }) };
    const result = await createProductionAdapters({ GATEWAY_ADAPTER: "bio-usb", GATEWAY_BIO_SENSOR_SHADOW_CAPTURE_NAME: "bio-sensor-shadow-20260923T010203Z.jsonl" }, {
      createBioClient: vi.fn(() => client) as never,
      createBioMappingStore: vi.fn(() => ({ ...sourceMappingMetadata(), validate: vi.fn(async () => undefined), listConfirmed: vi.fn(async () => [mapping]) })) as never,
      createBioAdapter: vi.fn(() => ({})) as never,
      createBioVehicleSensors: vi.fn(() => ({})) as never,
      createBioSensorShadowCapture: vi.fn(async () => capture) as never
    });
    const exit = vi.fn();
    const shutdownLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await createGatewayShutdownHandler(result, exit)();
      expect(exit).toHaveBeenCalledWith(1);
      expect(shutdownLog).toHaveBeenCalledOnce();
      const [prefix, loggedError] = shutdownLog.mock.calls[0]!;
      expect(prefix).toBe("Gateway shutdown failed");
      expect(loggedError).toBeInstanceOf(Error);
      expect((loggedError as Error).message).toBe("BIO_SENSOR_SHADOW_CAPTURE_FAILED");
      expect((loggedError as Error & { cause?: unknown }).cause).toBeUndefined();
      expect(String((loggedError as Error).stack)).not.toContain(secret);
      expect(String((loggedError as Error).stack)).not.toContain(path);
    } finally { shutdownLog.mockRestore(); }
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
    expect(order).toEqual(["unsubscribe", "capture-close", "usb-close"]);
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
    await expect(createProductionAdapters({
      GATEWAY_ADAPTER: "bio-usb",
      GATEWAY_BIO_OBSERVATION_TIMEOUT_MS: value
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
