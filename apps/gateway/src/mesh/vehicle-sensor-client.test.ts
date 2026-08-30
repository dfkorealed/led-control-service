import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BluezVehicleSensorMeshPort,
  VehicleSensorGatewayController,
  VehicleSensorCapabilityJournal,
  VehicleSensorCapabilityPublisher,
  VehicleSensorClient,
  decodeSensorStatus,
  decodeVendorVehicleEvent
} from "./vehicle-sensor-client";
import { createVehicleSensorVendorModel } from "./bluez-mesh-model-config";
import { TEST_BLUETOOTH_COMPANY_ID } from "../test-fixtures/vehicle-sensor-protocol";
import { AtomicJsonCommitUncertainError, writeJsonAtomic } from "./mesh-store-file";

const SOURCE_FIXTURE_ID = "00000000-0000-4000-8000-000000000102";
const SOURCE_NODE_ID = "00000000-0000-4000-8000-000000000202";
const SOURCE_UNICAST = 0x1201;
const VENDOR_MODEL = createVehicleSensorVendorModel(TEST_BLUETOOTH_COMPANY_ID);

describe("vehicle sensor wire decoders", () => {
  it("decodes Presence Detected and Motion Sensed Sensor Status properties", () => {
    expect(decodeSensorStatus(Uint8Array.from([
      0x52,
      0xa0, 0x09, 0x01,
      0x40, 0x08, 0x00
    ]))).toEqual([
      { property: "presence_detected", active: true },
      { property: "motion_sensed", active: false }
    ]);
    expect(decodeSensorStatus(Uint8Array.from([0x52, 0x40, 0x08, 0x64])))
      .toEqual([{ property: "motion_sensed", active: true }]);
    expect(() => decodeSensorStatus(Uint8Array.from([0x52, 0x40, 0x08, 0x65])))
      .toThrow("malformed_vehicle_sensor_status");
    expect(() => decodeSensorStatus(Uint8Array.from([0x52, 0xa0, 0x09, 0x02])))
      .toThrow("malformed_vehicle_sensor_status");
    expect(() => decodeSensorStatus(new Uint8Array(129))).toThrow("malformed_vehicle_sensor_status");
  });

  it("strictly decodes the versioned vendor event payload", () => {
    expect(decodeVendorVehicleEvent(Uint8Array.from([
      ...VENDOR_MODEL.eventOpcode,
      0x01,
      0x07, 0x00, 0x00, 0x00,
      0x09, 0x00, 0x00, 0x00,
      0x01,
      0x01
    ]), VENDOR_MODEL)).toEqual({ bootId: 7, sequence: 9, eventKind: "detected", level: true });

    expect(() => decodeVendorVehicleEvent(Uint8Array.from([
      ...VENDOR_MODEL.eventOpcode, 0x01, 0x07, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x01
    ]), VENDOR_MODEL)).toThrow("malformed_vehicle_sensor_vendor_event");
    expect(() => decodeVendorVehicleEvent(Uint8Array.from([
      ...VENDOR_MODEL.eventOpcode, 0x01, 0x07, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x01, 0x00
    ]), VENDOR_MODEL)).toThrow("malformed_vehicle_sensor_vendor_event");
  });
});

describe("VehicleSensorClient", () => {
  let runtimeEvents: unknown[];
  let sent: Array<{ destination: number; payload: number[] }>;
  let warnings: unknown[];
  let configured: Set<string>;
  let vendorReceipts: Set<string>;

  beforeEach(async () => {
    runtimeEvents = [];
    sent = [];
    warnings = [];
    configured = new Set([SOURCE_FIXTURE_ID]);
    vendorReceipts = new Set();
  });

  it("applies one vendor event and retransmits the ACK for its duplicate", async () => {
    const client = createClient();
    await client.initialize();

    await client.onVendorEvent(SOURCE_UNICAST, {
      bootId: 7,
      sequence: 9,
      eventKind: "detected",
      level: true
    });
    await client.onVendorEvent(SOURCE_UNICAST, {
      bootId: 7,
      sequence: 9,
      eventKind: "detected",
      level: true
    });

    expect(runtimeEvents).toEqual([{ type: "detected", sourceFixtureId: SOURCE_FIXTURE_ID }]);
    expect(sent.slice(-2)).toEqual([
      { destination: SOURCE_UNICAST, payload: [0xc2, 0xff, 0xff, 0x01, 0x07, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00] },
      { destination: SOURCE_UNICAST, payload: [0xc2, 0xff, 0xff, 0x01, 0x07, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00] }
    ]);
  });

  it("treats a changed bootId as a new session even when sequence decreases", async () => {
    const client = createClient();
    await client.initialize();

    await client.onVendorEvent(SOURCE_UNICAST, {
      bootId: 7,
      sequence: 9,
      eventKind: "detected",
      level: true
    });
    await client.onVendorEvent(SOURCE_UNICAST, {
      bootId: 8,
      sequence: 1,
      eventKind: "cleared",
      level: false
    });

    expect(runtimeEvents).toEqual([
      { type: "detected", sourceFixtureId: SOURCE_FIXTURE_ID },
      { type: "cleared", sourceFixtureId: SOURCE_FIXTURE_ID }
    ]);
  });

  it("keeps dedupe state across restart and still retransmits the ACK", async () => {
    const first = createClient();
    await first.initialize();
    await first.onVendorEvent(SOURCE_UNICAST, {
      bootId: 7,
      sequence: 9,
      eventKind: "detected",
      level: true
    });

    runtimeEvents = [];
    sent = [];
    const restarted = createClient();
    await restarted.initialize();
    await restarted.onVendorEvent(SOURCE_UNICAST, {
      bootId: 7,
      sequence: 9,
      eventKind: "detected",
      level: true
    });

    expect(runtimeEvents).toEqual([]);
    expect(sent.at(-1)?.destination).toBe(SOURCE_UNICAST);
  });

  it("does not ACK before the atomic runtime input and inbox receipt are durable", async () => {
    const recordVendorInput = vi.fn()
      .mockRejectedValueOnce(new Error("runtime state fsync failed"))
      .mockImplementationOnce(async (event) => { runtimeEvents.push(event); return true; });
    const client = new VehicleSensorClient({
      vendorModel: VENDOR_MODEL,
      listConfiguredSourceFixtureIds: () => [SOURCE_FIXTURE_ID],
      resolveByFixtureId: async () => ({ fixtureId: SOURCE_FIXTURE_ID, meshNodeId: SOURCE_NODE_ID, primaryUnicast: SOURCE_UNICAST }),
      resolveBySourceUnicast: async () => ({ fixtureId: SOURCE_FIXTURE_ID, meshNodeId: SOURCE_NODE_ID, primaryUnicast: SOURCE_UNICAST }),
      recordInput: async () => undefined,
      recordVendorInput,
      send: async (destination, payload) => { sent.push({ destination, payload: [...payload] }); }
    });
    await client.initialize();
    const event = { bootId: 7, sequence: 9, eventKind: "detected" as const, level: true };

    await expect(client.onVendorEvent(SOURCE_UNICAST, event)).rejects.toThrow("runtime state fsync failed");
    await client.onVendorEvent(SOURCE_UNICAST, event);

    expect(recordVendorInput).toHaveBeenCalledTimes(2);
    expect(runtimeEvents).toEqual([{ type: "detected", sourceFixtureId: SOURCE_FIXTURE_ID }]);
    expect(sent.filter(({ payload }) => payload[0] === 0xc2)).toHaveLength(1);
  });

  it("queries every configured source on startup and reconnect and applies current state", async () => {
    const client = createClient();

    await client.initialize();
    await client.reconnect();
    await client.onMeshMessage(SOURCE_UNICAST, Uint8Array.from([0x52, 0xa0, 0x09, 0x01]));

    expect(sent.filter(({ payload }) => payload[0] === 0x82)).toEqual([
      { destination: SOURCE_UNICAST, payload: [0x82, 0x31, 0x4d, 0x00] },
      { destination: SOURCE_UNICAST, payload: [0x82, 0x31, 0x4d, 0x00] }
    ]);
    expect(runtimeEvents).toEqual([
      { type: "current-state", sourceFixtureId: SOURCE_FIXTURE_ID, active: true }
    ]);
  });

  it("leaves state unchanged and logs sanitized metadata for unknown, unconfigured, and malformed input", async () => {
    const client = createClient();
    await client.initialize();

    await client.onMeshMessage(0x1301, Uint8Array.from([
      ...VENDOR_MODEL.eventOpcode, 0x01, 0x07, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x01, 0x01
    ]));
    configured.clear();
    await client.onMeshMessage(SOURCE_UNICAST, Uint8Array.from([
      ...VENDOR_MODEL.eventOpcode, 0x01, 0x07, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x01, 0x01
    ]));
    configured.add(SOURCE_FIXTURE_ID);
    await client.onMeshMessage(SOURCE_UNICAST, Uint8Array.from([0x52, 0xa0]));
    await client.onMeshMessage(SOURCE_UNICAST, Uint8Array.from([0x52, 0xc0, 0x09, 0x01]));

    expect(runtimeEvents).toEqual([]);
    expect(sent.filter(({ payload }) => payload[0] === 0xc2)).toEqual([]);
    expect(warnings).toEqual([
      { event: "vehicle_sensor_input_rejected", reason: "unknown_source", sourceUnicast: 0x1301 },
      { event: "vehicle_sensor_input_rejected", reason: "unconfigured_source", sourceUnicast: SOURCE_UNICAST },
      { event: "vehicle_sensor_input_rejected", reason: "malformed_sensor_status", sourceUnicast: SOURCE_UNICAST },
      { event: "vehicle_sensor_input_rejected", reason: "unsupported_sensor_property", sourceUnicast: SOURCE_UNICAST }
    ]);
    expect(JSON.stringify(warnings)).not.toContain("bootId");
  });

  it("continues startup queries when one configured source cannot be reached", async () => {
    configured.add("00000000-0000-4000-8000-000000000103");
    const client = new VehicleSensorClient({
      vendorModel: VENDOR_MODEL,
      listConfiguredSourceFixtureIds: () => [...configured],
      resolveByFixtureId: async (fixtureId) => ({
        fixtureId,
        meshNodeId: SOURCE_NODE_ID,
        primaryUnicast: fixtureId === SOURCE_FIXTURE_ID ? SOURCE_UNICAST : SOURCE_UNICAST + 1
      }),
      resolveBySourceUnicast: async () => null,
      recordInput: async () => undefined,
      recordVendorInput: async () => true,
      send: async (destination, payload) => {
        if (destination === SOURCE_UNICAST) throw new Error("private transport failure");
        sent.push({ destination, payload: [...payload] });
      },
      warn: (warning) => { warnings.push(warning); }
    });

    await expect(client.initialize()).resolves.toBeUndefined();
    expect(sent).toEqual([{
      destination: SOURCE_UNICAST + 1,
      payload: [0x82, 0x31, 0x4d, 0x00]
    }]);
    expect(warnings).toContainEqual({
      event: "vehicle_sensor_input_rejected",
      reason: "sensor_get_failed",
      sourceUnicast: SOURCE_UNICAST
    });
    expect(JSON.stringify(warnings)).not.toContain("private transport failure");
  });

  function createClient() {
    return new VehicleSensorClient({
      vendorModel: VENDOR_MODEL,
      listConfiguredSourceFixtureIds: () => [...configured],
      resolveByFixtureId: async (fixtureId) => fixtureId === SOURCE_FIXTURE_ID
        ? { fixtureId: SOURCE_FIXTURE_ID, meshNodeId: SOURCE_NODE_ID, primaryUnicast: SOURCE_UNICAST }
        : null,
      resolveBySourceUnicast: async (sourceUnicast) => sourceUnicast === SOURCE_UNICAST
        ? { fixtureId: SOURCE_FIXTURE_ID, meshNodeId: SOURCE_NODE_ID, primaryUnicast: SOURCE_UNICAST }
        : null,
      recordInput: async (event) => { runtimeEvents.push(event); },
      recordVendorInput: async (event, identity) => {
        const key = `${identity.sourceUnicast}:${identity.bootId}:${identity.sequence}`;
        if (vendorReceipts.has(key)) return false;
        vendorReceipts.add(key);
        runtimeEvents.push(event);
        return true;
      },
      send: async (destination, payload) => { sent.push({ destination, payload: [...payload] }); },
      warn: (warning) => { warnings.push(warning); }
    });
  }
});

describe("BluezVehicleSensorMeshPort", () => {
  it("uses the attached Node1 and confirmed address mappings for sensor traffic and configuration", async () => {
    const application = new EventEmitter();
    const transport = { call: vi.fn().mockResolvedValue(undefined) };
    const configureVehicleSensorModels = vi.fn().mockResolvedValue({
      sensorServerBound: true,
      vendorVehicleEventModelBound: true
    });
    const port = new BluezVehicleSensorMeshPort({
      transport,
      application,
      provisioner: { nodePath: "/org/bluez/mesh/node0" },
      addressStore: {
        findByFixtureId: vi.fn(async () => ({
          fixtureId: SOURCE_FIXTURE_ID,
          nodeId: SOURCE_NODE_ID,
          primaryUnicast: SOURCE_UNICAST,
          elementCount: 1,
          status: "confirmed" as const
        })),
        findByPrimaryUnicast: vi.fn(async () => ({
          fixtureId: SOURCE_FIXTURE_ID,
          nodeId: SOURCE_NODE_ID,
          primaryUnicast: SOURCE_UNICAST,
          elementCount: 1,
          status: "confirmed" as const
        })),
        listConfirmed: vi.fn(async () => [{
          fixtureId: SOURCE_FIXTURE_ID,
          nodeId: SOURCE_NODE_ID,
          primaryUnicast: SOURCE_UNICAST,
          elementCount: 1,
          status: "confirmed" as const
        }])
      },
      createConfigClient: () => ({ configureVehicleSensorModels })
    });
    const messages: unknown[] = [];
    const unsubscribe = port.onMessage((source, data) => { messages.push({ source, data: [...data] }); });

    application.emit("messageReceived", { source: SOURCE_UNICAST, data: Uint8Array.from([0x52]) });
    await port.send(SOURCE_UNICAST, Uint8Array.from([0x82, 0x31, 0x4d, 0x00]));
    const source = (await port.listConfirmedSources())[0]!;
    await expect(port.configureSource(source)).resolves.toEqual({
      sensorServerBound: true,
      vendorVehicleEventModelBound: true
    });
    unsubscribe();

    expect(messages).toEqual([{ source: SOURCE_UNICAST, data: [0x52] }]);
    expect(transport.call).toHaveBeenCalledWith(
      "org.bluez.mesh",
      "/org/bluez/mesh/node0",
      "org.bluez.mesh.Node1",
      "Send",
      ["/com/dfkorea/ledcontrol/ele00", SOURCE_UNICAST, 0, [], [0x82, 0x31, 0x4d, 0x00]]
    );
    expect(configureVehicleSensorModels).toHaveBeenCalledWith({ unicast: SOURCE_UNICAST, elementCount: 1 });
  });
});

describe("VehicleSensorGatewayController", () => {
  it("configures confirmed nodes, journals capability, and routes BlueZ input without exposing raw payloads", async () => {
    const path = await journalPath();
    let listener: ((source: number, data: Uint8Array) => void) | undefined;
    let completeConfiguration: (() => void) | undefined;
    const diagnostics: unknown[] = [];
    const source = { fixtureId: SOURCE_FIXTURE_ID, meshNodeId: SOURCE_NODE_ID, primaryUnicast: SOURCE_UNICAST, elementCount: 1 };
    const port = {
      listConfirmedSources: vi.fn(async () => [source]),
      resolveByFixtureId: vi.fn(async () => source),
      resolveBySourceUnicast: vi.fn(async () => source),
      configureSource: vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => {
          completeConfiguration = () => resolve({
            sensorServerBound: true,
            vendorVehicleEventModelBound: true
          });
        }))
        .mockRejectedValueOnce(new Error("private dbus path /secret")),
      send: vi.fn(async () => undefined),
      onMessage: vi.fn((next: (source: number, data: Uint8Array) => void) => {
        listener = next;
        return () => { listener = undefined; };
      })
    };
    const journal = new VehicleSensorCapabilityJournal(path, { siteId: "00000000-0000-4000-8000-000000000001", gatewayId: "00000000-0000-4000-8000-000000000002" });
    const publisher = new VehicleSensorCapabilityPublisher(journal, { siteId: "00000000-0000-4000-8000-000000000001", gatewayId: "00000000-0000-4000-8000-000000000002" });
    const recordInput = vi.fn(async () => undefined);
    const client = new VehicleSensorClient({
      vendorModel: VENDOR_MODEL,
      listConfiguredSourceFixtureIds: () => [SOURCE_FIXTURE_ID],
      resolveByFixtureId: port.resolveByFixtureId,
      resolveBySourceUnicast: port.resolveBySourceUnicast,
      recordInput,
      recordVendorInput: async () => true,
      send: port.send
    });
    const controller = new VehicleSensorGatewayController({
      port,
      client,
      journal,
      publisher,
      diagnose: (diagnostic) => { diagnostics.push(diagnostic); }
    });

    await controller.initialize();
    expect(port.configureSource).not.toHaveBeenCalled();
    listener?.(SOURCE_UNICAST, Uint8Array.from([0x52, 0xa0, 0x09, 0x01]));
    await vi.waitFor(() => expect(recordInput).toHaveBeenCalledWith({
      type: "current-state",
      sourceFixtureId: SOURCE_FIXTURE_ID,
      active: true
    }));
    const firstRefresh = controller.refreshCapabilities();
    const secondRefresh = controller.refreshCapabilities();
    await vi.waitFor(() => expect(port.configureSource).toHaveBeenCalledTimes(1));
    completeConfiguration?.();
    await Promise.all([firstRefresh, secondRefresh]);
    const beforeFailure = await journal.current(SOURCE_NODE_ID);

    expect(beforeFailure?.report).toMatchObject({
      capabilityRevision: 1,
      sensorServerBound: true,
      vendorVehicleEventModelBound: true
    });
    expect(await journal.current(SOURCE_NODE_ID)).toEqual(beforeFailure);
    expect(diagnostics).toEqual([{
      event: "vehicle_sensor_capability_configuration_failed",
      meshNodeId: SOURCE_NODE_ID
    }]);
    expect(await journal.pendingRefreshNodeIds()).toEqual([SOURCE_NODE_ID]);
    expect(JSON.stringify(diagnostics)).not.toContain("secret");
    await controller.stopAndDrain();
    expect(listener).toBeUndefined();
  });

  it("stops intake and drains every accepted sensor promise before shutdown", async () => {
    const path = await journalPath();
    let listener: ((source: number, data: Uint8Array) => void) | undefined;
    const pending = deferred<boolean>();
    const client = {
      initialize: vi.fn(async () => undefined),
      onMeshMessage: vi.fn(() => pending.promise),
      queryConfiguredSources: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined)
    };
    const journal = new VehicleSensorCapabilityJournal(path, { siteId: SOURCE_FIXTURE_ID, gatewayId: SOURCE_NODE_ID });
    const publisher = new VehicleSensorCapabilityPublisher(journal, { siteId: SOURCE_FIXTURE_ID, gatewayId: SOURCE_NODE_ID });
    const controller = new VehicleSensorGatewayController({
      port: {
        listConfirmedSources: vi.fn(async () => []),
        resolveByFixtureId: vi.fn(async () => null),
        resolveBySourceUnicast: vi.fn(async () => null),
        configureSource: vi.fn(),
        send: vi.fn(async () => undefined),
        onMessage: vi.fn((next) => { listener = next; return () => { listener = undefined; }; })
      },
      client: client as unknown as VehicleSensorClient,
      journal,
      publisher,
      sensorDrainTimeoutMs: 100
    });
    await controller.initialize();
    listener?.(SOURCE_UNICAST, Uint8Array.from([0x52]));
    const stopping = controller.stopAndDrain();
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await Promise.resolve();

    expect(listener).toBeUndefined();
    expect(stopped).toBe(false);
    pending.resolve(true);
    await stopping;
    expect(stopped).toBe(true);
  });

  it("bounds sensor drain timeout and emits only sanitized pending diagnostics", async () => {
    vi.useFakeTimers();
    try {
      const path = await journalPath();
      let listener: ((source: number, data: Uint8Array) => void) | undefined;
      const diagnostics: unknown[] = [];
      const journal = new VehicleSensorCapabilityJournal(path, { siteId: SOURCE_FIXTURE_ID, gatewayId: SOURCE_NODE_ID });
      const controller = new VehicleSensorGatewayController({
        port: {
          listConfirmedSources: vi.fn(async () => []), resolveByFixtureId: vi.fn(async () => null),
          resolveBySourceUnicast: vi.fn(async () => null), configureSource: vi.fn(), send: vi.fn(async () => undefined),
          onMessage: vi.fn((next) => { listener = next; return () => { listener = undefined; }; })
        },
        client: {
          initialize: vi.fn(async () => undefined),
          onMeshMessage: vi.fn(() => new Promise<boolean>(() => undefined))
        } as unknown as VehicleSensorClient,
        journal,
        publisher: new VehicleSensorCapabilityPublisher(journal, { siteId: SOURCE_FIXTURE_ID, gatewayId: SOURCE_NODE_ID }),
        sensorDrainTimeoutMs: 10,
        diagnose: (diagnostic) => { diagnostics.push(diagnostic); }
      });
      await controller.initialize();
      listener?.(SOURCE_UNICAST, Uint8Array.from([0x52, 0xaa, 0xbb]));
      const stopping = controller.stopAndDrain();
      await vi.advanceTimersByTimeAsync(10);
      await stopping;

      expect(diagnostics).toContainEqual({ event: "vehicle_sensor_intake_drain_timeout", pendingCount: 1 });
      expect(JSON.stringify(diagnostics)).not.toContain("170");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("vehicle sensor capability journal and publisher", () => {
  const SITE_ID = "00000000-0000-4000-8000-000000000001";
  const GATEWAY_ID = "00000000-0000-4000-8000-000000000002";
  const NODE_ID = "00000000-0000-4000-8000-000000000003";
  const EVENT_1 = "00000000-0000-4000-8000-000000000011";
  const EVENT_2 = "00000000-0000-4000-8000-000000000012";

  it("increments revision only when the actual model binding state changes", async () => {
    const path = await journalPath();
    const journal = new VehicleSensorCapabilityJournal(path, { siteId: SITE_ID, gatewayId: GATEWAY_ID }, {
      createEventId: vi.fn()
        .mockReturnValueOnce(EVENT_1)
        .mockReturnValueOnce(EVENT_2),
      now: () => new Date("2026-08-30T00:00:00.000Z")
    });
    await journal.initialize();

    const first = await journal.recordBinding({
      meshNodeId: NODE_ID,
      sensorServerBound: true,
      vendorVehicleEventModelBound: true
    });
    const unchanged = await journal.recordBinding({
      meshNodeId: NODE_ID,
      sensorServerBound: true,
      vendorVehicleEventModelBound: true
    });
    const changed = await journal.recordBinding({
      meshNodeId: NODE_ID,
      sensorServerBound: true,
      vendorVehicleEventModelBound: false
    });

    expect(first.changed).toBe(true);
    expect(first.record.report).toEqual({
      schemaVersion: 1,
      eventId: EVENT_1,
      siteId: SITE_ID,
      gatewayId: GATEWAY_ID,
      meshNodeId: NODE_ID,
      capabilityRevision: 1,
      status: "supported",
      verifiedAt: "2026-08-30T00:00:00.000Z",
      sensorServerBound: true,
      vendorVehicleEventModelBound: true
    });
    expect(first.record.reportPayloadHash).toBe(canonicalHash(first.record.report));
    expect(unchanged).toEqual({ changed: false, record: first.record });
    expect(changed.record.report).toEqual(expect.objectContaining({
      eventId: EVENT_2,
      capabilityRevision: 2,
      status: "unsupported",
      sensorServerBound: true,
      vendorVehicleEventModelBound: false
    }));

    const restarted = new VehicleSensorCapabilityJournal(path, { siteId: SITE_ID, gatewayId: GATEWAY_ID });
    await restarted.initialize();
    expect(await restarted.current(NODE_ID)).toEqual(changed.record);
  });

  it("durably retains capability refresh work until model configuration succeeds", async () => {
    const path = await journalPath();
    const journal = new VehicleSensorCapabilityJournal(path, { siteId: SITE_ID, gatewayId: GATEWAY_ID });
    await journal.initialize();

    await journal.requestRefresh(NODE_ID);
    expect(await journal.pendingRefreshNodeIds()).toEqual([NODE_ID]);

    const restarted = new VehicleSensorCapabilityJournal(path, { siteId: SITE_ID, gatewayId: GATEWAY_ID });
    await restarted.initialize();
    expect(await restarted.pendingRefreshNodeIds()).toEqual([NODE_ID]);
    await restarted.completeRefresh(NODE_ID);
    expect(await restarted.pendingRefreshNodeIds()).toEqual([]);
  });

  it("uses exact report identity for terminal ACK and preserves rejected or hash-mismatched reports", async () => {
    const path = await journalPath();
    const journal = new VehicleSensorCapabilityJournal(path, { siteId: SITE_ID, gatewayId: GATEWAY_ID }, {
      createEventId: () => EVENT_1,
      now: () => new Date("2026-08-30T00:00:00.000Z")
    });
    await journal.initialize();
    const { record } = await journal.recordBinding({
      meshNodeId: NODE_ID,
      sensorServerBound: true,
      vendorVehicleEventModelBound: true
    });
    const ack = {
      schemaVersion: 1 as const,
      eventId: EVENT_1,
      gatewayId: GATEWAY_ID,
      meshNodeId: NODE_ID,
      capabilityRevision: 1,
      reportPayloadHash: record.reportPayloadHash,
      status: "applied" as const,
      errorCode: null,
      ingestedAt: "2026-08-30T00:00:01.000Z"
    };

    await expect(journal.acknowledge({ ...ack, reportPayloadHash: `sha256:${"f".repeat(64)}` }))
      .resolves.toBe("ignored");
    expect((await journal.current(NODE_ID))?.delivery).toEqual({ state: "pending" });

    await expect(journal.acknowledge({ ...ack, status: "rejected", errorCode: "capability_revision_conflict" }))
      .resolves.toBe("rejected");
    expect((await journal.current(NODE_ID))?.delivery).toEqual({
      state: "rejected",
      errorCode: "capability_revision_conflict",
      ingestedAt: "2026-08-30T00:00:01.000Z"
    });
    expect(await journal.pending()).toEqual([]);

    const recovered = await journal.recordBinding({
      meshNodeId: NODE_ID,
      sensorServerBound: false,
      vendorVehicleEventModelBound: false
    });
    const recoveredAck = {
      ...ack,
      eventId: recovered.record.report.eventId,
      capabilityRevision: recovered.record.report.capabilityRevision,
      reportPayloadHash: recovered.record.reportPayloadHash,
      status: "duplicate" as const,
      ingestedAt: "2026-08-30T00:00:02.000Z"
    };
    await expect(journal.acknowledge(recoveredAck)).resolves.toBe("terminal");
    expect((await journal.current(NODE_ID))?.delivery).toEqual({
      state: "terminal",
      status: "duplicate",
      ingestedAt: "2026-08-30T00:00:02.000Z"
    });
  });

  it("keeps the journal after broker PUBACK and republishes the same report with bounded retry and reconnect", async () => {
    vi.useFakeTimers();
    const path = await journalPath();
    const journal = new VehicleSensorCapabilityJournal(path, { siteId: SITE_ID, gatewayId: GATEWAY_ID }, {
      createEventId: () => EVENT_1,
      now: () => new Date("2026-08-30T00:00:00.000Z")
    });
    await journal.initialize();
    const { record } = await journal.recordBinding({
      meshNodeId: NODE_ID,
      sensorServerBound: true,
      vendorVehicleEventModelBound: true
    });
    const published: Array<{ topic: string; payload: unknown }> = [];
    const publisher = new VehicleSensorCapabilityPublisher(journal, { siteId: SITE_ID, gatewayId: GATEWAY_ID }, {
      retryInitialDelayMs: 10,
      retryMaxDelayMs: 30,
      publishTimeoutMs: 100
    });
    const publish = vi.fn(async (topic: string, payload: unknown) => { published.push({ topic, payload }); });

    await publisher.connect(publish);
    expect((await journal.current(NODE_ID))?.delivery).toEqual({ state: "pending" });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(30);
    expect(published).toHaveLength(4);
    expect(new Set(published.map(({ payload }) => JSON.stringify(payload)))).toEqual(new Set([JSON.stringify(record.report)]));
    expect(published[0]?.topic).toBe(
      `sites/${SITE_ID}/gateways/${GATEWAY_ID}/events/automation/vehicle-sensor-capability`
    );

    publisher.disconnect();
    await publisher.connect(publish);
    expect(published).toHaveLength(5);
    expect(published.at(-1)?.payload).toEqual(record.report);
    publisher.disconnect();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("starts a new-generation capability drain when reconnect races an old publish callback", async () => {
    const path = await journalPath();
    const journal = new VehicleSensorCapabilityJournal(path, { siteId: SITE_ID, gatewayId: GATEWAY_ID }, {
      createEventId: () => EVENT_1,
      now: () => new Date("2026-08-30T00:00:00.000Z")
    });
    await journal.initialize();
    await journal.recordBinding({
      meshNodeId: NODE_ID,
      sensorServerBound: true,
      vendorVehicleEventModelBound: true
    });
    let finishOldPublish: (() => void) | undefined;
    const oldPublish = vi.fn(() => new Promise<void>((resolve) => { finishOldPublish = resolve; }));
    const newPublish = vi.fn(async () => undefined);
    const publisher = new VehicleSensorCapabilityPublisher(journal, { siteId: SITE_ID, gatewayId: GATEWAY_ID });

    const oldDrain = publisher.connect(oldPublish);
    await vi.waitFor(() => expect(oldPublish).toHaveBeenCalledTimes(1));
    publisher.disconnect();
    const newDrain = publisher.connect(newPublish);

    await vi.waitFor(() => expect(newPublish).toHaveBeenCalledTimes(1));
    finishOldPublish?.();
    await Promise.all([oldDrain, newDrain]);
    publisher.disconnect();
  });

  it("fails closed when an initialized journal disappears instead of resetting revisions", async () => {
    const path = await journalPath();
    const journal = new VehicleSensorCapabilityJournal(path, { siteId: SITE_ID, gatewayId: GATEWAY_ID });
    await journal.initialize();
    await rm(path);

    const restarted = new VehicleSensorCapabilityJournal(path, { siteId: SITE_ID, gatewayId: GATEWAY_ID });
    await expect(restarted.initialize()).rejects.toThrow("vehicle_sensor_capability_journal_missing");
  });

  it("does not advance memory or disk revision when an atomic binding commit fails", async () => {
    const path = await journalPath();
    const writes: unknown[] = [];
    let fail = false;
    const journal = new VehicleSensorCapabilityJournal(path, { siteId: SITE_ID, gatewayId: GATEWAY_ID }, {
      createEventId: vi.fn().mockReturnValueOnce(EVENT_1).mockReturnValueOnce(EVENT_2),
      now: () => new Date("2026-08-30T00:00:00.000Z"),
      write: async (target, value) => {
        if (fail && target === path) throw new Error("injected atomic write failure");
        writes.push(value);
        const { writeJsonAtomic } = await import("./mesh-store-file");
        await writeJsonAtomic(target, value);
      }
    });
    await journal.initialize();
    const first = await journal.recordBinding({
      meshNodeId: NODE_ID,
      sensorServerBound: true,
      vendorVehicleEventModelBound: true
    });
    fail = true;

    await expect(journal.recordBinding({
      meshNodeId: NODE_ID,
      sensorServerBound: false,
      vendorVehicleEventModelBound: false
    })).rejects.toThrow("injected atomic write failure");
    expect(await journal.current(NODE_ID)).toEqual(first.record);
    expect(JSON.parse(await readFile(path, "utf8")).records[0].report.capabilityRevision).toBe(1);
    expect(writes.length).toBeGreaterThan(0);
  });

  it("adopts the exact next capability identity after a rename-visible uncertain commit", async () => {
    const path = await journalPath();
    let uncertain = false;
    const journal = new VehicleSensorCapabilityJournal(path, { siteId: SITE_ID, gatewayId: GATEWAY_ID }, {
      createEventId: () => EVENT_1,
      now: () => new Date("2026-08-30T00:00:00.000Z"),
      write: async (target, value) => {
        await writeJsonAtomic(target, value);
        if (uncertain && target === path) throw new AtomicJsonCommitUncertainError(target);
      }
    });
    await journal.initialize();
    uncertain = true;

    const result = await journal.recordBinding({
      meshNodeId: NODE_ID,
      sensorServerBound: true,
      vendorVehicleEventModelBound: true
    });

    expect(result.changed).toBe(true);
    expect(await journal.current(NODE_ID)).toEqual(result.record);
    await expect(new VehicleSensorCapabilityJournal(path, { siteId: SITE_ID, gatewayId: GATEWAY_ID })
      .initialize()).resolves.toBeUndefined();
  });

  it("retains previous capability state when uncertainty reads back the previous target", async () => {
    const path = await journalPath();
    const journal = new VehicleSensorCapabilityJournal(path, { siteId: SITE_ID, gatewayId: GATEWAY_ID }, {
      createEventId: () => EVENT_1,
      write: async (target, value) => {
        if (target === path && (value as { records?: unknown[] }).records?.length) {
          throw new AtomicJsonCommitUncertainError(target);
        }
        await writeJsonAtomic(target, value);
      }
    });
    await journal.initialize();

    await expect(journal.recordBinding({
      meshNodeId: NODE_ID,
      sensorServerBound: true,
      vendorVehicleEventModelBound: true
    })).rejects.toThrow("vehicle_sensor_capability_commit_uncertain");
    expect(await journal.current(NODE_ID)).toBeNull();
  });

  it("fences an ambiguous capability journal target", async () => {
    const path = await journalPath();
    const journal = new VehicleSensorCapabilityJournal(path, { siteId: SITE_ID, gatewayId: GATEWAY_ID }, {
      createEventId: () => EVENT_1,
      write: async (target, value) => {
        if (target === path && (value as { records?: unknown[] }).records?.length) {
          await writeJsonAtomic(target, { version: 99 });
          throw new AtomicJsonCommitUncertainError(target);
        }
        await writeJsonAtomic(target, value);
      }
    });
    await journal.initialize();

    await expect(journal.recordBinding({
      meshNodeId: NODE_ID,
      sensorServerBound: true,
      vendorVehicleEventModelBound: true
    })).rejects.toThrow("vehicle_sensor_capability_commit_ambiguous");
    await expect(journal.current(NODE_ID)).rejects.toThrow("vehicle_sensor_capability_journal_unavailable");
  });
});

async function journalPath() {
  return join(await mkdtemp(join(tmpdir(), "vehicle-sensor-capability-")), "capability.json");
}

function canonicalHash(value: unknown) {
  const sort = (candidate: unknown): unknown => Array.isArray(candidate)
    ? candidate.map(sort)
    : candidate && typeof candidate === "object"
      ? Object.fromEntries(Object.entries(candidate).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, sort(child)]))
      : candidate;
  return `sha256:${createHash("sha256").update(JSON.stringify(sort(value))).digest("hex")}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
