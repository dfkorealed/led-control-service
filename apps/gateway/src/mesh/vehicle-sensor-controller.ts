import type { EventEmitter } from "node:events";
import {
  vehicleSensorCapabilityIngestedAckV1Schema,
  type VehicleSensorCapabilityIngestedAckV1,
  type VehicleSensorCapabilityReportV1
} from "@led-control/shared";
import type { VehicleSensorInput } from "../automation/vehicle-event-runtime";
import { KeyedSerialTaskQueue } from "../runtime/keyed-serial-task-queue";
import { BLUEZ_APPLICATION_PATHS } from "./bluez-dbus-application";
import {
  BLUETOOTH_MESH_SENSOR,
  encodePresenceDetectedSensorGet,
  startsWithMeshOpcode,
  type VehicleSensorVendorModel
} from "./bluez-mesh-model-config";
import {
  assertVendorEvent,
  decodeSensorStatus,
  decodeVendorVehicleEvent,
  encodeVendorVehicleEventAcknowledgement,
  type VendorVehicleEvent
} from "./vehicle-sensor-codec";
import {
  VehicleSensorCapabilityJournal,
  VehicleSensorCapabilityPublisher
} from "./vehicle-sensor-capability";

export interface VehicleSensorSource {
  fixtureId: string;
  meshNodeId: string;
  primaryUnicast: number;
}

export interface ConfirmedVehicleSensorSource extends VehicleSensorSource {
  elementCount: number;
}

export interface VehicleSensorMeshPort {
  listConfirmedSources(): Promise<ConfirmedVehicleSensorSource[]>;
  resolveByFixtureId(fixtureId: string): Promise<VehicleSensorSource | null>;
  resolveBySourceUnicast(sourceUnicast: number): Promise<VehicleSensorSource | null>;
  configureSource(source: ConfirmedVehicleSensorSource): Promise<{
    sensorServerBound: boolean;
    vendorVehicleEventModelBound: boolean;
  }>;
  send(destination: number, payload: Uint8Array): Promise<void>;
  onMessage(listener: (sourceUnicast: number, data: Uint8Array) => void): () => void;
}

interface BluezVehicleSensorMapping {
  fixtureId: string;
  nodeId: string;
  primaryUnicast: number;
  elementCount: number;
  status: "reserved" | "confirmed";
}

export class BluezVehicleSensorMeshPort implements VehicleSensorMeshPort {
  constructor(private readonly options: {
    transport: { call(service: string, path: string, interfaceName: string, method: string, args: unknown[]): Promise<unknown> };
    application: EventEmitter;
    provisioner: { nodePath: string | null };
    addressStore: {
      findByFixtureId(fixtureId: string): Promise<BluezVehicleSensorMapping | null>;
      findByPrimaryUnicast(primaryUnicast: number): Promise<BluezVehicleSensorMapping | null>;
      listConfirmed(): Promise<Array<BluezVehicleSensorMapping & { status: "confirmed" }>>;
    };
    createConfigClient(nodePath: string): {
      configureVehicleSensorModels(input: { unicast: number; elementCount: number }): Promise<{
        sensorServerBound: boolean;
        vendorVehicleEventModelBound: boolean;
      }>;
    };
  }) {}

  async listConfirmedSources() {
    return (await this.options.addressStore.listConfirmed()).map((mapping) => ({
      ...confirmedSource(mapping)!, elementCount: mapping.elementCount
    }));
  }
  async resolveByFixtureId(fixtureId: string) {
    return confirmedSource(await this.options.addressStore.findByFixtureId(fixtureId));
  }
  async resolveBySourceUnicast(sourceUnicast: number) {
    return confirmedSource(await this.options.addressStore.findByPrimaryUnicast(sourceUnicast));
  }
  configureSource(source: ConfirmedVehicleSensorSource) {
    return this.options.createConfigClient(this.requireNodePath()).configureVehicleSensorModels({
      unicast: source.primaryUnicast, elementCount: source.elementCount
    });
  }
  async send(destination: number, payload: Uint8Array) {
    await this.options.transport.call("org.bluez.mesh", this.requireNodePath(), "org.bluez.mesh.Node1", "Send", [
      BLUEZ_APPLICATION_PATHS.element, destination, 0, [], Array.from(payload)
    ]);
  }
  onMessage(listener: (sourceUnicast: number, data: Uint8Array) => void) {
    const receive = (event: { source: number; data: Uint8Array }) => listener(event.source, event.data);
    this.options.application.on("messageReceived", receive);
    return () => this.options.application.off("messageReceived", receive);
  }
  private requireNodePath() {
    if (!this.options.provisioner.nodePath) throw new Error("BlueZ Mesh provisioner is not attached");
    return this.options.provisioner.nodePath;
  }
}

function confirmedSource(mapping: BluezVehicleSensorMapping | null): VehicleSensorSource | null {
  return mapping?.status === "confirmed" ? {
    fixtureId: mapping.fixtureId,
    meshNodeId: mapping.nodeId,
    primaryUnicast: mapping.primaryUnicast
  } : null;
}

export interface VehicleSensorWarning {
  event: "vehicle_sensor_input_rejected";
  reason: "unknown_source" | "unconfigured_source" | "malformed_sensor_status" |
    "malformed_vendor_event" | "unsupported_sensor_property" | "sensor_get_failed";
  sourceUnicast: number;
}

export class VehicleSensorClient {
  private initialized = false;
  private readonly sources = new KeyedSerialTaskQueue();
  constructor(private readonly options: {
    vendorModel: VehicleSensorVendorModel;
    listConfiguredSourceFixtureIds: () => string[];
    resolveByFixtureId: (fixtureId: string) => Promise<VehicleSensorSource | null>;
    resolveBySourceUnicast: (sourceUnicast: number) => Promise<VehicleSensorSource | null>;
    recordInput: (input: VehicleSensorInput) => Promise<void>;
    recordVendorInput: (
      input: Exclude<VehicleSensorInput, { type: "current-state" }>,
      identity: { sourceUnicast: number; bootId: number; sequence: number }
    ) => Promise<boolean>;
    send: (destination: number, payload: Uint8Array) => Promise<void>;
    warn?: (warning: VehicleSensorWarning) => void;
  }) {}

  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    await this.queryConfiguredSources();
  }
  async reconnect() {
    if (!this.initialized) return this.initialize();
    await this.queryConfiguredSources();
  }
  async onMeshMessage(sourceUnicast: number, data: Uint8Array) {
    if (startsWithMeshOpcode(data, this.options.vendorModel.eventOpcode)) {
      try {
        return await this.onVendorEvent(sourceUnicast, decodeVendorVehicleEvent(data, this.options.vendorModel));
      } catch (error) {
        if (error instanceof Error && error.message !== "malformed_vehicle_sensor_vendor_event") throw error;
        this.reject("malformed_vendor_event", sourceUnicast);
        return false;
      }
    }
    if (!startsWithMeshOpcode(data, BLUETOOTH_MESH_SENSOR.opcodes.status)) return false;
    const source = await this.configuredSource(sourceUnicast);
    if (!source) return false;
    let properties: ReturnType<typeof decodeSensorStatus>;
    try {
      properties = decodeSensorStatus(data);
      if (new Set(properties.map(({ active }) => active)).size > 1) throw new Error("conflict");
    } catch {
      this.reject("malformed_sensor_status", sourceUnicast);
      return false;
    }
    if (properties.length === 0) {
      this.reject("unsupported_sensor_property", sourceUnicast);
      return false;
    }
    await this.options.recordInput({ type: "current-state", sourceFixtureId: source.fixtureId, active: properties[0]!.active });
    return true;
  }
  onVendorEvent(sourceUnicast: number, event: VendorVehicleEvent) {
    return this.sources.run(String(sourceUnicast), async () => {
      assertVendorEvent(event);
      const source = await this.configuredSource(sourceUnicast);
      if (!source) return false;
      const applied = await this.options.recordVendorInput(
        { type: event.eventKind, sourceFixtureId: source.fixtureId },
        { sourceUnicast, bootId: event.bootId, sequence: event.sequence }
      );
      await this.options.send(sourceUnicast, encodeVendorVehicleEventAcknowledgement(event, this.options.vendorModel));
      return applied;
    });
  }
  async queryConfiguredSources() {
    for (const fixtureId of [...new Set(this.options.listConfiguredSourceFixtureIds())].sort()) {
      const source = await this.options.resolveByFixtureId(fixtureId);
      if (!source) continue;
      try {
        await this.options.send(source.primaryUnicast, encodePresenceDetectedSensorGet());
      } catch {
        this.reject("sensor_get_failed", source.primaryUnicast);
      }
    }
  }
  private async configuredSource(sourceUnicast: number) {
    const source = await this.options.resolveBySourceUnicast(sourceUnicast);
    if (!source) { this.reject("unknown_source", sourceUnicast); return null; }
    if (!this.options.listConfiguredSourceFixtureIds().includes(source.fixtureId)) {
      this.reject("unconfigured_source", sourceUnicast); return null;
    }
    return source;
  }
  private reject(reason: VehicleSensorWarning["reason"], sourceUnicast: number) {
    this.options.warn?.({ event: "vehicle_sensor_input_rejected", reason, sourceUnicast });
  }
}

export type VehicleSensorDiagnostic =
  | { event: "vehicle_sensor_capability_configuration_failed"; meshNodeId: string }
  | { event: "vehicle_sensor_processing_failed"; sourceUnicast: number }
  | { event: "vehicle_sensor_capability_ack_rejected"; meshNodeId: string }
  | { event: "vehicle_sensor_capability_ack_ignored"; meshNodeId: string }
  | { event: "vehicle_sensor_capability_refresh_recovered"; meshNodeId: string }
  | { event: "vehicle_sensor_intake_drain_timeout"; pendingCount: number };

export class VehicleSensorGatewayController {
  private unsubscribe: (() => void) | undefined;
  private initialized = false;
  private stopping = false;
  private capabilityQueue: Promise<unknown> = Promise.resolve();
  private readonly acceptedSensorOperations = new Set<Promise<unknown>>();
  private readonly capabilityRefreshFailures = new Set<string>();
  private readonly sensorDrainTimeoutMs: number;
  private capabilityRetryTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly options: {
    port: VehicleSensorMeshPort;
    client: VehicleSensorClient;
    journal: VehicleSensorCapabilityJournal;
    publisher: VehicleSensorCapabilityPublisher;
    sensorDrainTimeoutMs?: number;
    diagnose?: (diagnostic: VehicleSensorDiagnostic) => void;
  }) {
    this.sensorDrainTimeoutMs = options.sensorDrainTimeoutMs ?? 5_000;
    if (!Number.isInteger(this.sensorDrainTimeoutMs) || this.sensorDrainTimeoutMs < 1) {
      throw new Error("invalid_vehicle_sensor_drain_timeout");
    }
  }
  async initialize() {
    if (this.initialized) return;
    this.stopping = false;
    await this.options.journal.initialize();
    const pendingRefreshNodeIds = await this.options.journal.pendingRefreshNodeIds();
    for (const meshNodeId of pendingRefreshNodeIds) this.capabilityRefreshFailures.add(meshNodeId);
    this.unsubscribe = this.options.port.onMessage((sourceUnicast, data) => {
      if (this.stopping) return;
      const operation = this.options.client.onMeshMessage(sourceUnicast, data).catch(() => {
        this.diagnose({ event: "vehicle_sensor_processing_failed", sourceUnicast });
      });
      this.acceptedSensorOperations.add(operation);
      void operation.finally(() => this.acceptedSensorOperations.delete(operation));
    });
    try {
      await this.options.client.initialize();
      this.initialized = true;
      if (pendingRefreshNodeIds.length > 0) this.scheduleCapabilityRetry(0);
    } catch (error) {
      this.unsubscribe?.(); this.unsubscribe = undefined; throw error;
    }
  }
  refreshCapabilities(meshNodeId?: string): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const operation = async () => {
      try {
        await this.performCapabilityRefresh(meshNodeId);
      } catch (error) {
        for (const pendingNodeId of await this.options.journal.pendingRefreshNodeIds()) {
          this.capabilityRefreshFailures.add(pendingNodeId);
        }
        throw error;
      } finally {
        if ((await this.options.journal.pendingRefreshNodeIds()).length > 0) this.scheduleCapabilityRetry();
      }
    };
    const result = this.capabilityQueue.then(operation, operation);
    this.capabilityQueue = result.then(() => undefined, () => undefined);
    return result;
  }
  async requestCapabilityRefresh(meshNodeId: string) {
    await this.options.journal.requestRefresh(meshNodeId);
    await this.refreshCapabilities(meshNodeId);
    if ((await this.options.journal.pendingRefreshNodeIds()).includes(meshNodeId)) {
      this.scheduleCapabilityRetry();
      throw new Error("vehicle_sensor_capability_refresh_pending");
    }
  }
  private async performCapabilityRefresh(meshNodeId?: string) {
    const sources = (await this.options.port.listConfirmedSources())
      .filter((source) => !meshNodeId || source.meshNodeId === meshNodeId);
    for (const source of sources) await this.options.journal.requestRefresh(source.meshNodeId);
    for (const source of sources) {
      if (this.stopping) return;
      let binding: Awaited<ReturnType<VehicleSensorMeshPort["configureSource"]>>;
      try { binding = await this.options.port.configureSource(source); } catch {
        this.capabilityRefreshFailures.add(source.meshNodeId);
        this.diagnose({ event: "vehicle_sensor_capability_configuration_failed", meshNodeId: source.meshNodeId });
        continue;
      }
      const result = await this.options.journal.recordBinding({ meshNodeId: source.meshNodeId, ...binding });
      if ((await this.options.journal.pendingRefreshNodeIds()).includes(source.meshNodeId)) {
        await this.options.journal.completeRefresh(source.meshNodeId);
        if (this.capabilityRefreshFailures.delete(source.meshNodeId)) {
          this.diagnose({ event: "vehicle_sensor_capability_refresh_recovered", meshNodeId: source.meshNodeId });
        }
      }
      if (result.changed) void this.options.publisher.wake();
    }
  }
  refreshConfiguration() { return this.options.client.queryConfiguredSources(); }
  reconnect(publish: (topic: string, payload: VehicleSensorCapabilityReportV1) => Promise<void>) {
    return Promise.all([this.options.client.reconnect(), this.options.publisher.connect(publish)]);
  }
  disconnect() { this.options.publisher.disconnect(); }
  async acknowledge(value: unknown) {
    const result = await this.options.publisher.acknowledge(value);
    const parsed = vehicleSensorCapabilityIngestedAckV1Schema.parse(value) as VehicleSensorCapabilityIngestedAckV1;
    if (result === "rejected") this.diagnose({ event: "vehicle_sensor_capability_ack_rejected", meshNodeId: parsed.meshNodeId });
    else if (result === "ignored") this.diagnose({ event: "vehicle_sensor_capability_ack_ignored", meshNodeId: parsed.meshNodeId });
    return result;
  }
  async stopAndDrain() {
    this.stopping = true;
    if (this.capabilityRetryTimer) clearTimeout(this.capabilityRetryTimer);
    this.capabilityRetryTimer = undefined;
    this.unsubscribe?.(); this.unsubscribe = undefined;
    await Promise.all([
      this.capabilityQueue,
      this.options.publisher.stopAndDrain(),
      withTimeout(Promise.all([...this.acceptedSensorOperations]), this.sensorDrainTimeoutMs).catch(() => {
        this.diagnose({ event: "vehicle_sensor_intake_drain_timeout", pendingCount: this.acceptedSensorOperations.size });
      })
    ]);
  }
  private diagnose(diagnostic: VehicleSensorDiagnostic) {
    try { this.options.diagnose?.(diagnostic); } catch { /* diagnostics never own progress */ }
  }
  private scheduleCapabilityRetry(delayMs = 1_000) {
    if (this.stopping || this.capabilityRetryTimer) return;
    this.capabilityRetryTimer = setTimeout(() => {
      this.capabilityRetryTimer = undefined;
      void this.retryPendingCapabilityRefreshes().catch(() => this.scheduleCapabilityRetry());
    }, delayMs);
  }
  private async retryPendingCapabilityRefreshes() {
    for (const meshNodeId of await this.options.journal.pendingRefreshNodeIds()) {
      await this.refreshCapabilities(meshNodeId);
    }
    if ((await this.options.journal.pendingRefreshNodeIds()).length > 0) this.scheduleCapabilityRetry();
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("vehicle_sensor_intake_drain_timeout")), timeoutMs);
    void promise.then(
      (value) => { clearTimeout(timeout); resolve(value); },
      (error) => { clearTimeout(timeout); reject(error); }
    );
  });
}
