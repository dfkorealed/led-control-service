import { createHash, randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import {
  mqttTopics,
  vehicleSensorCapabilityIngestedAckV1Schema,
  vehicleSensorCapabilityReportV1Schema,
  type VehicleSensorCapabilityIngestedAckV1,
  type VehicleSensorCapabilityReportV1
} from "@led-control/shared";
import { readJsonFile, writeJsonAtomic } from "./mesh-store-file";
import { BLUEZ_APPLICATION_PATHS } from "./bluez-dbus-application";
import {
  BLUETOOTH_MESH_SENSOR,
  VEHICLE_SENSOR_VENDOR_MODEL,
  encodePresenceDetectedSensorGet,
  startsWithMeshOpcode
} from "./bluez-mesh-model-config";
import type { VehicleSensorInput } from "../automation/vehicle-event-runtime";
import { KeyedSerialTaskQueue } from "../runtime/keyed-serial-task-queue";

const UINT32_MAX = 0xffff_ffff;
const MAX_DEDUPE_SOURCES = 10_000;
const MAX_CAPABILITY_NODES = 10_000;
const DEFAULT_CAPABILITY_RETRY_INITIAL_DELAY_MS = 1_000;
const DEFAULT_CAPABILITY_RETRY_MAX_DELAY_MS = 30_000;
const DEFAULT_CAPABILITY_PUBLISH_TIMEOUT_MS = 10_000;

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

const BLUEZ_MESH_SERVICE = "org.bluez.mesh";
const BLUEZ_NODE_INTERFACE = "org.bluez.mesh.Node1";

export class BluezVehicleSensorMeshPort implements VehicleSensorMeshPort {
  constructor(private readonly options: {
    transport: {
      call(service: string, path: string, interfaceName: string, method: string, args: unknown[]): Promise<unknown>;
    };
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
    return (await this.options.addressStore.listConfirmed()).map(toConfirmedVehicleSensorSource);
  }

  async resolveByFixtureId(fixtureId: string) {
    return confirmedSource(await this.options.addressStore.findByFixtureId(fixtureId));
  }

  async resolveBySourceUnicast(sourceUnicast: number) {
    return confirmedSource(await this.options.addressStore.findByPrimaryUnicast(sourceUnicast));
  }

  configureSource(source: ConfirmedVehicleSensorSource) {
    return this.options.createConfigClient(this.requireNodePath()).configureVehicleSensorModels({
      unicast: source.primaryUnicast,
      elementCount: source.elementCount
    });
  }

  async send(destination: number, payload: Uint8Array) {
    await this.options.transport.call(
      BLUEZ_MESH_SERVICE,
      this.requireNodePath(),
      BLUEZ_NODE_INTERFACE,
      "Send",
      [BLUEZ_APPLICATION_PATHS.element, destination, 0, [], Array.from(payload)]
    );
  }

  onMessage(listener: (sourceUnicast: number, data: Uint8Array) => void) {
    const receive = (event: { source: number; data: Uint8Array }) => listener(event.source, event.data);
    this.options.application.on("messageReceived", receive);
    return () => this.options.application.off("messageReceived", receive);
  }

  private requireNodePath() {
    const nodePath = this.options.provisioner.nodePath;
    if (!nodePath) throw new Error("BlueZ Mesh provisioner is not attached");
    return nodePath;
  }
}

function confirmedSource(mapping: BluezVehicleSensorMapping | null): VehicleSensorSource | null {
  return mapping?.status === "confirmed" ? {
    fixtureId: mapping.fixtureId,
    meshNodeId: mapping.nodeId,
    primaryUnicast: mapping.primaryUnicast
  } : null;
}

function toConfirmedVehicleSensorSource(
  mapping: BluezVehicleSensorMapping & { status: "confirmed" }
): ConfirmedVehicleSensorSource {
  return {
    ...confirmedSource(mapping)!,
    elementCount: mapping.elementCount
  };
}

export interface VendorVehicleEvent {
  bootId: number;
  sequence: number;
  eventKind: "detected" | "cleared";
  level: boolean;
}

export interface VehicleSensorWarning {
  event: "vehicle_sensor_input_rejected";
  reason:
    | "unknown_source"
    | "unconfigured_source"
    | "malformed_sensor_status"
    | "malformed_vendor_event"
    | "unsupported_sensor_property"
    | "sensor_get_failed";
  sourceUnicast: number;
}

interface DedupeSession {
  sourceUnicast: number;
  bootId: number;
  sequence: number;
}

interface StoredDedupeState {
  version: 1;
  sessions: DedupeSession[];
}

interface VehicleSensorDedupeManifest {
  version: 1;
}

export class FileVehicleSensorDedupeStore {
  private state: StoredDedupeState = { version: 1, sessions: [] };
  private initialized = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly manifestPath: string;

  constructor(private readonly path: string) {
    this.manifestPath = `${path}.manifest`;
  }

  async initialize() {
    if (this.initialized) return;
    const [manifestValue, stateValue] = await Promise.all([
      readJsonFile(this.manifestPath),
      readJsonFile(this.path)
    ]);
    if (manifestValue === null && stateValue === null) {
      const manifest: VehicleSensorDedupeManifest = { version: 1 };
      await writeJsonAtomic(this.manifestPath, manifest);
      await writeJsonAtomic(this.path, this.state);
      this.initialized = true;
      return;
    }
    if (!isRecord(manifestValue) || manifestValue.version !== 1 ||
      Object.keys(manifestValue).join(",") !== "version") {
      throw new Error("invalid_vehicle_sensor_dedupe_manifest");
    }
    if (stateValue === null) throw new Error("vehicle_sensor_dedupe_store_missing");
    this.state = parseDedupeState(stateValue);
    this.initialized = true;
  }

  isDuplicate(sourceUnicast: number, event: Pick<VendorVehicleEvent, "bootId" | "sequence">): Promise<boolean> {
    return this.exclusive(async () => {
      await this.initialize();
      const current = this.state.sessions.find((session) => session.sourceUnicast === sourceUnicast);
      return current?.bootId === event.bootId && event.sequence <= current.sequence;
    });
  }

  markProcessed(sourceUnicast: number, event: Pick<VendorVehicleEvent, "bootId" | "sequence">): Promise<void> {
    return this.exclusive(async () => {
      await this.initialize();
      const current = this.state.sessions.find((session) => session.sourceUnicast === sourceUnicast);
      if (current?.bootId === event.bootId && event.sequence <= current.sequence) return;
      if (!current && this.state.sessions.length >= MAX_DEDUPE_SOURCES) {
        throw new Error("vehicle_sensor_dedupe_capacity");
      }

      const next: StoredDedupeState = {
        version: 1,
        sessions: [
          ...this.state.sessions.filter((session) => session.sourceUnicast !== sourceUnicast),
          { sourceUnicast, bootId: event.bootId, sequence: event.sequence }
        ].sort((left, right) => left.sourceUnicast - right.sourceUnicast)
      };
      await writeJsonAtomic(this.path, next);
      this.state = next;
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class VehicleSensorClient {
  private initialized = false;
  private readonly sources = new KeyedSerialTaskQueue();

  constructor(private readonly options: {
    dedupeStore: FileVehicleSensorDedupeStore;
    listConfiguredSourceFixtureIds: () => string[];
    resolveByFixtureId: (fixtureId: string) => Promise<VehicleSensorSource | null>;
    resolveBySourceUnicast: (sourceUnicast: number) => Promise<VehicleSensorSource | null>;
    recordInput: (input: VehicleSensorInput) => Promise<void>;
    send: (destination: number, payload: Uint8Array) => Promise<void>;
    warn?: (warning: VehicleSensorWarning) => void;
  }) {}

  async initialize() {
    if (this.initialized) return;
    await this.options.dedupeStore.initialize();
    this.initialized = true;
    await this.queryConfiguredSources();
  }

  async reconnect() {
    if (!this.initialized) return this.initialize();
    await this.queryConfiguredSources();
  }

  async onMeshMessage(sourceUnicast: number, data: Uint8Array) {
    if (startsWithMeshOpcode(data, VEHICLE_SENSOR_VENDOR_MODEL.eventOpcode)) {
      let event: VendorVehicleEvent;
      try {
        event = decodeVendorVehicleEvent(data);
      } catch {
        this.reject("malformed_vendor_event", sourceUnicast);
        return false;
      }
      return this.onVendorEvent(sourceUnicast, event);
    }
    if (!startsWithMeshOpcode(data, BLUETOOTH_MESH_SENSOR.opcodes.status)) return false;

    const source = await this.configuredSource(sourceUnicast);
    if (!source) return false;
    let properties: ReturnType<typeof decodeSensorStatus>;
    try {
      properties = decodeSensorStatus(data);
      if (new Set(properties.map(({ active }) => active)).size > 1) throw new Error("conflicting sensor properties");
    } catch {
      this.reject("malformed_sensor_status", sourceUnicast);
      return false;
    }
    if (properties.length === 0) {
      this.reject("unsupported_sensor_property", sourceUnicast);
      return false;
    }
    await this.options.recordInput({
      type: "current-state",
      sourceFixtureId: source.fixtureId,
      active: properties[0]!.active
    });
    return true;
  }

  async onVendorEvent(sourceUnicast: number, event: VendorVehicleEvent) {
    return this.sources.run(String(sourceUnicast), async () => {
      assertVendorEvent(event);
      const source = await this.configuredSource(sourceUnicast);
      if (!source) return false;
      if (await this.options.dedupeStore.isDuplicate(sourceUnicast, event)) {
        await this.options.send(sourceUnicast, encodeVendorVehicleEventAcknowledgement(event));
        return false;
      }
      await this.options.recordInput({ type: event.eventKind, sourceFixtureId: source.fixtureId });
      await this.options.dedupeStore.markProcessed(sourceUnicast, event);
      await this.options.send(sourceUnicast, encodeVendorVehicleEventAcknowledgement(event));
      return true;
    });
  }

  async queryConfiguredSources() {
    const fixtureIds = [...new Set(this.options.listConfiguredSourceFixtureIds())].sort();
    for (const fixtureId of fixtureIds) {
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
    if (!source) {
      this.reject("unknown_source", sourceUnicast);
      return null;
    }
    if (!this.options.listConfiguredSourceFixtureIds().includes(source.fixtureId)) {
      this.reject("unconfigured_source", sourceUnicast);
      return null;
    }
    return source;
  }

  private reject(reason: VehicleSensorWarning["reason"], sourceUnicast: number) {
    this.options.warn?.({ event: "vehicle_sensor_input_rejected", reason, sourceUnicast });
  }
}

export type VehicleSensorCapabilityDelivery =
  | { state: "pending" }
  | { state: "terminal"; status: "applied" | "stale" | "duplicate"; ingestedAt: string }
  | { state: "rejected"; errorCode: string; ingestedAt: string };

export interface StoredVehicleSensorCapabilityRecord {
  report: VehicleSensorCapabilityReportV1;
  reportPayloadHash: `sha256:${string}`;
  delivery: VehicleSensorCapabilityDelivery;
}

interface StoredVehicleSensorCapabilityJournal {
  version: 1;
  scope: { siteId: string; gatewayId: string };
  records: StoredVehicleSensorCapabilityRecord[];
}

interface VehicleSensorCapabilityManifest {
  version: 1;
  scope: { siteId: string; gatewayId: string };
}

type AtomicJsonWriter = (path: string, value: unknown) => Promise<void>;

export class VehicleSensorCapabilityJournal {
  private state: StoredVehicleSensorCapabilityJournal;
  private initialized = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly manifestPath: string;
  private readonly createEventId: () => string;
  private readonly now: () => Date;
  private readonly write: AtomicJsonWriter;

  constructor(
    private readonly path: string,
    private readonly scope: { siteId: string; gatewayId: string },
    options: {
      createEventId?: () => string;
      now?: () => Date;
      write?: AtomicJsonWriter;
    } = {}
  ) {
    this.state = { version: 1, scope: { ...scope }, records: [] };
    this.manifestPath = `${path}.manifest`;
    this.createEventId = options.createEventId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.write = options.write ?? writeJsonAtomic;
  }

  async initialize() {
    if (this.initialized) return;
    const [manifestValue, journalValue] = await Promise.all([
      readJsonFile(this.manifestPath),
      readJsonFile(this.path)
    ]);
    if (manifestValue === null && journalValue === null) {
      const manifest: VehicleSensorCapabilityManifest = { version: 1, scope: { ...this.scope } };
      await this.write(this.manifestPath, manifest);
      await this.write(this.path, this.state);
      this.initialized = true;
      return;
    }
    if (manifestValue === null) throw new Error("vehicle_sensor_capability_manifest_missing");
    parseCapabilityManifest(manifestValue, this.scope);
    if (journalValue === null) throw new Error("vehicle_sensor_capability_journal_missing");
    this.state = parseCapabilityJournal(journalValue, this.scope);
    this.initialized = true;
  }

  recordBinding(input: {
    meshNodeId: string;
    sensorServerBound: boolean;
    vendorVehicleEventModelBound: boolean;
  }): Promise<{ changed: boolean; record: StoredVehicleSensorCapabilityRecord }> {
    return this.exclusive(async () => {
      await this.initialize();
      const current = this.state.records.find(({ report }) => report.meshNodeId === input.meshNodeId);
      if (current && current.report.sensorServerBound === input.sensorServerBound &&
        current.report.vendorVehicleEventModelBound === input.vendorVehicleEventModelBound) {
        return { changed: false, record: structuredClone(current) };
      }
      if (!current && this.state.records.length >= MAX_CAPABILITY_NODES) {
        throw new Error("vehicle_sensor_capability_capacity");
      }
      const capabilityRevision = (current?.report.capabilityRevision ?? 0) + 1;
      if (!Number.isSafeInteger(capabilityRevision)) throw new Error("vehicle_sensor_capability_revision_exhausted");
      const bothModelsBound = input.sensorServerBound && input.vendorVehicleEventModelBound;
      const report = vehicleSensorCapabilityReportV1Schema.parse({
        schemaVersion: 1,
        eventId: this.createEventId(),
        siteId: this.scope.siteId,
        gatewayId: this.scope.gatewayId,
        meshNodeId: input.meshNodeId,
        capabilityRevision,
        status: bothModelsBound ? "supported" : "unsupported",
        verifiedAt: this.now().toISOString(),
        sensorServerBound: input.sensorServerBound,
        vendorVehicleEventModelBound: input.vendorVehicleEventModelBound
      }) as VehicleSensorCapabilityReportV1;
      const record: StoredVehicleSensorCapabilityRecord = {
        report,
        reportPayloadHash: canonicalPayloadHash(report),
        delivery: { state: "pending" }
      };
      const next: StoredVehicleSensorCapabilityJournal = {
        ...this.state,
        records: [
          ...this.state.records.filter(({ report: stored }) => stored.meshNodeId !== input.meshNodeId),
          record
        ].sort((left, right) => left.report.meshNodeId.localeCompare(right.report.meshNodeId))
      };
      await this.write(this.path, next);
      this.state = next;
      return { changed: true, record: structuredClone(record) };
    });
  }

  current(meshNodeId: string): Promise<StoredVehicleSensorCapabilityRecord | null> {
    return this.exclusive(async () => {
      await this.initialize();
      const record = this.state.records.find(({ report }) => report.meshNodeId === meshNodeId);
      return record ? structuredClone(record) : null;
    });
  }

  pending(): Promise<StoredVehicleSensorCapabilityRecord[]> {
    return this.exclusive(async () => {
      await this.initialize();
      return this.state.records
        .filter(({ delivery }) => delivery.state === "pending")
        .map((record) => structuredClone(record));
    });
  }

  acknowledge(value: unknown): Promise<"ignored" | "terminal" | "rejected"> {
    return this.exclusive(async () => {
      await this.initialize();
      const acknowledgement = vehicleSensorCapabilityIngestedAckV1Schema.parse(value) as VehicleSensorCapabilityIngestedAckV1;
      const index = this.state.records.findIndex(({ report, reportPayloadHash }) =>
        report.gatewayId === acknowledgement.gatewayId &&
        report.meshNodeId === acknowledgement.meshNodeId &&
        report.eventId === acknowledgement.eventId &&
        report.capabilityRevision === acknowledgement.capabilityRevision &&
        reportPayloadHash === acknowledgement.reportPayloadHash
      );
      if (index < 0 || acknowledgement.gatewayId !== this.scope.gatewayId) return "ignored";
      const current = this.state.records[index]!;
      const delivery: VehicleSensorCapabilityDelivery = acknowledgement.status === "rejected"
        ? {
          state: "rejected",
          errorCode: requireRejectedErrorCode(acknowledgement.errorCode),
          ingestedAt: acknowledgement.ingestedAt
        }
        : {
          state: "terminal",
          status: acknowledgement.status,
          ingestedAt: acknowledgement.ingestedAt
        };
      if (sameDelivery(current.delivery, delivery)) {
        return acknowledgement.status === "rejected" ? "rejected" : "terminal";
      }
      const next = structuredClone(this.state);
      next.records[index] = { ...current, delivery };
      await this.write(this.path, next);
      this.state = next;
      return acknowledgement.status === "rejected" ? "rejected" : "terminal";
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class VehicleSensorCapabilityPublisher {
  private connected = false;
  private stopped = false;
  private generation = 0;
  private publish: ((topic: string, payload: VehicleSensorCapabilityReportV1) => Promise<void>) | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelayMs: number;
  private readonly activeDrains = new Map<number, Promise<void>>();
  private readonly retryInitialDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly publishTimeoutMs: number;

  constructor(
    private readonly journal: VehicleSensorCapabilityJournal,
    private readonly scope: { siteId: string; gatewayId: string },
    private readonly options: {
      retryInitialDelayMs?: number;
      retryMaxDelayMs?: number;
      publishTimeoutMs?: number;
      onError?: (error: unknown) => void;
    } = {}
  ) {
    this.retryInitialDelayMs = options.retryInitialDelayMs ?? DEFAULT_CAPABILITY_RETRY_INITIAL_DELAY_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_CAPABILITY_RETRY_MAX_DELAY_MS;
    this.publishTimeoutMs = options.publishTimeoutMs ?? DEFAULT_CAPABILITY_PUBLISH_TIMEOUT_MS;
    if (!Number.isInteger(this.retryInitialDelayMs) || this.retryInitialDelayMs < 1 ||
      !Number.isInteger(this.retryMaxDelayMs) || this.retryMaxDelayMs < this.retryInitialDelayMs ||
      !Number.isInteger(this.publishTimeoutMs) || this.publishTimeoutMs < 1) {
      throw new Error("invalid_vehicle_sensor_capability_retry_options");
    }
    this.retryDelayMs = this.retryInitialDelayMs;
  }

  connect(publish: (topic: string, payload: VehicleSensorCapabilityReportV1) => Promise<void>) {
    if (this.connected) return this.activeDrains.get(this.generation) ?? Promise.resolve();
    this.connected = true;
    this.stopped = false;
    this.publish = publish;
    this.retryDelayMs = this.retryInitialDelayMs;
    const generation = ++this.generation;
    this.clearRetry();
    return this.runDrain(generation);
  }

  disconnect() {
    this.connected = false;
    this.publish = undefined;
    this.generation += 1;
    this.retryDelayMs = this.retryInitialDelayMs;
    this.clearRetry();
  }

  wake() {
    if (!this.connected || this.stopped) return Promise.resolve();
    this.clearRetry();
    return this.runDrain(this.generation);
  }

  async acknowledge(value: unknown) {
    const result = await this.journal.acknowledge(value);
    if (result !== "ignored") {
      const pending = await this.journal.pending();
      if (pending.length === 0) this.clearRetry();
      else void this.wake();
    }
    return result;
  }

  async stopAndDrain() {
    this.stopped = true;
    this.connected = false;
    this.generation += 1;
    this.clearRetry();
    await Promise.all(this.activeDrains.values());
    this.publish = undefined;
  }

  private runDrain(generation: number): Promise<void> {
    const active = this.activeDrains.get(generation);
    if (active) return active;
    const publish = this.publish;
    if (!publish || !this.isCurrent(generation)) return Promise.resolve();
    const drain = (async () => {
      let hasPending = false;
      for (const record of await this.journal.pending()) {
        hasPending = true;
        try {
          await withTimeout(
            publish(mqttTopics.vehicleSensorCapabilityReport(this.scope.siteId, this.scope.gatewayId), record.report),
            this.publishTimeoutMs,
            "vehicle_sensor_capability_publish_timeout"
          );
        } catch (error) {
          this.reportError(error);
        }
      }
      return hasPending;
    })();
    const completion = drain.then(async (hasPending) => {
      if (this.activeDrains.get(generation) === completion) this.activeDrains.delete(generation);
      if (!this.isCurrent(generation)) return;
      if (hasPending && (await this.journal.pending()).length > 0) this.scheduleRetry(generation);
      else this.retryDelayMs = this.retryInitialDelayMs;
    }, (error) => {
      if (this.activeDrains.get(generation) === completion) this.activeDrains.delete(generation);
      if (!this.isCurrent(generation)) return;
      this.reportError(error);
      this.scheduleRetry(generation);
    });
    this.activeDrains.set(generation, completion);
    return completion;
  }

  private scheduleRetry(generation: number) {
    if (this.retryTimer || !this.isCurrent(generation)) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.retryMaxDelayMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.isCurrent(generation)) void this.runDrain(generation);
    }, delay);
  }

  private clearRetry() {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private isCurrent(generation: number) {
    return this.connected && !this.stopped && this.generation === generation;
  }

  private reportError(error: unknown) {
    try {
      this.options.onError?.(error);
    } catch {
      // Observability must not take retry ownership away from the publisher.
    }
  }
}

export type VehicleSensorDiagnostic =
  | { event: "vehicle_sensor_capability_configuration_failed"; meshNodeId: string }
  | { event: "vehicle_sensor_processing_failed"; sourceUnicast: number }
  | { event: "vehicle_sensor_capability_ack_rejected"; meshNodeId: string }
  | { event: "vehicle_sensor_capability_ack_ignored"; meshNodeId: string };

export class VehicleSensorGatewayController {
  private unsubscribe: (() => void) | undefined;
  private initialized = false;
  private stopping = false;
  private capabilityQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: {
    port: VehicleSensorMeshPort;
    client: VehicleSensorClient;
    journal: VehicleSensorCapabilityJournal;
    publisher: VehicleSensorCapabilityPublisher;
    diagnose?: (diagnostic: VehicleSensorDiagnostic) => void;
  }) {}

  async initialize() {
    if (this.initialized) return;
    this.stopping = false;
    await this.options.journal.initialize();
    this.unsubscribe = this.options.port.onMessage((sourceUnicast, data) => {
      void this.options.client.onMeshMessage(sourceUnicast, data).catch(() => {
        this.diagnose({ event: "vehicle_sensor_processing_failed", sourceUnicast });
      });
    });
    try {
      await this.options.client.initialize();
      this.initialized = true;
    } catch (error) {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      throw error;
    }
  }

  refreshCapabilities(meshNodeId?: string): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const operation = () => this.performCapabilityRefresh(meshNodeId);
    const result = this.capabilityQueue.then(operation, operation);
    this.capabilityQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async performCapabilityRefresh(meshNodeId?: string) {
    const sources = await this.options.port.listConfirmedSources();
    for (const source of sources) {
      if (this.stopping) return;
      if (meshNodeId && source.meshNodeId !== meshNodeId) continue;
      let binding: Awaited<ReturnType<VehicleSensorMeshPort["configureSource"]>>;
      try {
        binding = await this.options.port.configureSource(source);
      } catch {
        this.diagnose({
          event: "vehicle_sensor_capability_configuration_failed",
          meshNodeId: source.meshNodeId
        });
        continue;
      }
      const result = await this.options.journal.recordBinding({ meshNodeId: source.meshNodeId, ...binding });
      if (result.changed) void this.options.publisher.wake();
    }
  }

  refreshConfiguration() {
    return this.options.client.queryConfiguredSources();
  }

  reconnect(publish: (topic: string, payload: VehicleSensorCapabilityReportV1) => Promise<void>) {
    return Promise.all([
      this.options.client.reconnect(),
      this.options.publisher.connect(publish)
    ]);
  }

  disconnect() {
    this.options.publisher.disconnect();
  }

  async acknowledge(value: unknown) {
    const result = await this.options.publisher.acknowledge(value);
    const parsed = vehicleSensorCapabilityIngestedAckV1Schema.parse(value) as VehicleSensorCapabilityIngestedAckV1;
    if (result === "rejected") {
      this.diagnose({ event: "vehicle_sensor_capability_ack_rejected", meshNodeId: parsed.meshNodeId });
    } else if (result === "ignored") {
      this.diagnose({ event: "vehicle_sensor_capability_ack_ignored", meshNodeId: parsed.meshNodeId });
    }
    return result;
  }

  async stopAndDrain() {
    this.stopping = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await Promise.all([
      this.capabilityQueue,
      this.options.publisher.stopAndDrain()
    ]);
  }

  private diagnose(diagnostic: VehicleSensorDiagnostic) {
    try {
      this.options.diagnose?.(diagnostic);
    } catch {
      // Diagnostic hooks cannot own sensor input or durable delivery progress.
    }
  }
}

export function decodeSensorStatus(data: Uint8Array) {
  if (!startsWithMeshOpcode(data, BLUETOOTH_MESH_SENSOR.opcodes.status)) {
    throw new Error("malformed_vehicle_sensor_status");
  }
  const properties: Array<{ property: "presence_detected" | "motion_sensed"; active: boolean }> = [];
  let offset = BLUETOOTH_MESH_SENSOR.opcodes.status.length;
  while (offset < data.length) {
    const first = data[offset]!;
    const format = first & 0x01;
    const headerLength = format === 0 ? 2 : 3;
    if (offset + headerLength > data.length) throw new Error("malformed_vehicle_sensor_status");
    const encodedLength = format === 0 ? (first >> 1) & 0x0f : (first >> 1) & 0x7f;
    const valueLength = format === 1 && encodedLength === 0x7f ? 0 : encodedLength + 1;
    const propertyId = format === 0
      ? (data[offset + 1]! << 3) | (first >> 5)
      : data[offset + 1]! | (data[offset + 2]! << 8);
    const valueOffset = offset + headerLength;
    if (valueOffset + valueLength > data.length) throw new Error("malformed_vehicle_sensor_status");
    if (propertyId === BLUETOOTH_MESH_SENSOR.properties.presenceDetected ||
      propertyId === BLUETOOTH_MESH_SENSOR.properties.motionSensed) {
      const raw = data[valueOffset];
      if (valueLength !== 1 || (raw !== 0 && raw !== 1)) throw new Error("malformed_vehicle_sensor_status");
      properties.push({
        property: propertyId === BLUETOOTH_MESH_SENSOR.properties.presenceDetected
          ? "presence_detected"
          : "motion_sensed",
        active: raw === 1
      });
    }
    offset = valueOffset + valueLength;
  }
  return properties;
}

export function decodeVendorVehicleEvent(data: Uint8Array): VendorVehicleEvent {
  const opcodeLength = VEHICLE_SENSOR_VENDOR_MODEL.eventOpcode.length;
  if (!startsWithMeshOpcode(data, VEHICLE_SENSOR_VENDOR_MODEL.eventOpcode) ||
    data.length !== opcodeLength + VEHICLE_SENSOR_VENDOR_MODEL.eventPayloadLength) {
    throw new Error("malformed_vehicle_sensor_vendor_event");
  }
  const payload = Buffer.from(data.subarray(opcodeLength));
  const version = payload.readUInt8(0);
  const bootId = payload.readUInt32LE(1);
  const sequence = payload.readUInt32LE(5);
  const eventKindByte = payload.readUInt8(9);
  const levelByte = payload.readUInt8(10);
  const eventKind = eventKindByte === 1 ? "detected" : eventKindByte === 2 ? "cleared" : null;
  if (version !== VEHICLE_SENSOR_VENDOR_MODEL.protocolVersion || !eventKind ||
    (levelByte !== 0 && levelByte !== 1) || (eventKind === "detected") !== (levelByte === 1)) {
    throw new Error("malformed_vehicle_sensor_vendor_event");
  }
  return { bootId, sequence, eventKind, level: levelByte === 1 };
}

export function encodeVendorVehicleEventAcknowledgement(event: Pick<VendorVehicleEvent, "bootId" | "sequence">) {
  assertUint32(event.bootId);
  assertUint32(event.sequence);
  const payload = Buffer.alloc(VEHICLE_SENSOR_VENDOR_MODEL.acknowledgementPayloadLength);
  payload.writeUInt8(VEHICLE_SENSOR_VENDOR_MODEL.protocolVersion, 0);
  payload.writeUInt32LE(event.bootId, 1);
  payload.writeUInt32LE(event.sequence, 5);
  return Uint8Array.from([...VEHICLE_SENSOR_VENDOR_MODEL.acknowledgementOpcode, ...payload]);
}

function assertVendorEvent(event: VendorVehicleEvent) {
  assertUint32(event.bootId);
  assertUint32(event.sequence);
  if ((event.eventKind === "detected") !== event.level) throw new Error("malformed_vehicle_sensor_vendor_event");
}

function assertUint32(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new Error("malformed_vehicle_sensor_vendor_event");
  }
}

function parseDedupeState(value: unknown): StoredDedupeState {
  if (value === null) return { version: 1, sessions: [] };
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.sessions)) {
    throw new Error("invalid_vehicle_sensor_dedupe_store");
  }
  const sessions = value.sessions.map((session) => {
    if (!isRecord(session) || !isUnicast(session.sourceUnicast) ||
      !isUint32(session.bootId) || !isUint32(session.sequence)) {
      throw new Error("invalid_vehicle_sensor_dedupe_store");
    }
    return session as unknown as DedupeSession;
  });
  if (new Set(sessions.map(({ sourceUnicast }) => sourceUnicast)).size !== sessions.length) {
    throw new Error("invalid_vehicle_sensor_dedupe_store");
  }
  return { version: 1, sessions };
}

function parseCapabilityManifest(value: unknown, scope: { siteId: string; gatewayId: string }) {
  if (!isRecord(value) || value.version !== 1 || !sameScope(value.scope, scope) ||
    Object.keys(value).sort().join(",") !== "scope,version") {
    throw new Error("invalid_vehicle_sensor_capability_manifest");
  }
}

function parseCapabilityJournal(
  value: unknown,
  scope: { siteId: string; gatewayId: string }
): StoredVehicleSensorCapabilityJournal {
  if (!isRecord(value) || value.version !== 1 || !sameScope(value.scope, scope) || !Array.isArray(value.records) ||
    value.records.length > MAX_CAPABILITY_NODES || Object.keys(value).sort().join(",") !== "records,scope,version") {
    throw new Error("invalid_vehicle_sensor_capability_journal");
  }
  const records = value.records.map((candidate) => parseCapabilityRecord(candidate, scope));
  if (new Set(records.map(({ report }) => report.meshNodeId)).size !== records.length) {
    throw new Error("invalid_vehicle_sensor_capability_journal");
  }
  return { version: 1, scope: { ...scope }, records };
}

function parseCapabilityRecord(
  value: unknown,
  scope: { siteId: string; gatewayId: string }
): StoredVehicleSensorCapabilityRecord {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "delivery,report,reportPayloadHash") {
    throw new Error("invalid_vehicle_sensor_capability_journal");
  }
  const report = vehicleSensorCapabilityReportV1Schema.parse(value.report) as VehicleSensorCapabilityReportV1;
  if (report.siteId !== scope.siteId || report.gatewayId !== scope.gatewayId ||
    value.reportPayloadHash !== canonicalPayloadHash(report)) {
    throw new Error("invalid_vehicle_sensor_capability_journal");
  }
  return {
    report,
    reportPayloadHash: value.reportPayloadHash as `sha256:${string}`,
    delivery: parseCapabilityDelivery(value.delivery)
  };
}

function parseCapabilityDelivery(value: unknown): VehicleSensorCapabilityDelivery {
  if (!isRecord(value) || typeof value.state !== "string") throw new Error("invalid_vehicle_sensor_capability_journal");
  if (value.state === "pending" && Object.keys(value).join(",") === "state") return { state: "pending" };
  if (value.state === "terminal" && (value.status === "applied" || value.status === "stale" || value.status === "duplicate") &&
    isTimestamp(value.ingestedAt) && Object.keys(value).sort().join(",") === "ingestedAt,state,status") {
    return { state: "terminal", status: value.status, ingestedAt: value.ingestedAt };
  }
  if (value.state === "rejected" && typeof value.errorCode === "string" && value.errorCode.length > 0 &&
    isTimestamp(value.ingestedAt) && Object.keys(value).sort().join(",") === "errorCode,ingestedAt,state") {
    return { state: "rejected", errorCode: value.errorCode, ingestedAt: value.ingestedAt };
  }
  throw new Error("invalid_vehicle_sensor_capability_journal");
}

function canonicalPayloadHash(value: unknown) {
  return `sha256:${createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex")}` as const;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortJson(child)]));
}

function sameScope(value: unknown, scope: { siteId: string; gatewayId: string }) {
  return isRecord(value) && value.siteId === scope.siteId && value.gatewayId === scope.gatewayId &&
    Object.keys(value).sort().join(",") === "gatewayId,siteId";
}

function sameDelivery(left: VehicleSensorCapabilityDelivery, right: VehicleSensorCapabilityDelivery) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireRejectedErrorCode(value: string | null) {
  if (!value) throw new Error("vehicle_sensor_capability_rejected_without_error");
  return value;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string) {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => finish(() => reject(new Error(code))), timeoutMs);
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUint32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= UINT32_MAX;
}

function isUnicast(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 0x7fff;
}
