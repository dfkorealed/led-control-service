import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  mqttTopics,
  vehicleSensorCapabilityIngestedAckV1Schema,
  vehicleSensorCapabilityReportV1Schema,
  type VehicleSensorCapabilityIngestedAckV1,
  type VehicleSensorCapabilityReportV1
} from "@led-control/shared";
import { AtomicJsonCommitUncertainError, readJsonFile, writeJsonAtomic } from "./mesh-store-file";

export const MAX_VEHICLE_SENSOR_CAPABILITY_NODES = 10_000;
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024;

export type VehicleSensorCapabilityDelivery =
  | { state: "pending" }
  | { state: "terminal"; status: "applied" | "stale" | "duplicate"; ingestedAt: string }
  | { state: "rejected"; errorCode: string; ingestedAt: string };

export interface StoredVehicleSensorCapabilityRecord {
  report: VehicleSensorCapabilityReportV1;
  reportPayloadHash: `sha256:${string}`;
  delivery: VehicleSensorCapabilityDelivery;
}

export interface VehicleSensorCapabilityBinding {
  meshNodeId: string;
  sensorServerBound: boolean;
  vendorVehicleEventModelBound: boolean;
}

interface JournalState {
  version: 2;
  scope: { siteId: string; gatewayId: string };
  records: StoredVehicleSensorCapabilityRecord[];
  refreshPendingNodeIds: string[];
}

type Writer = (path: string, value: unknown) => Promise<void>;

export class VehicleSensorCapabilityJournal {
  private state: JournalState;
  private initialized = false;
  private fenced = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly manifestPath: string;
  private readonly createEventId: () => string;
  private readonly now: () => Date;
  private readonly write: Writer;

  constructor(
    private readonly path: string,
    private readonly scope: { siteId: string; gatewayId: string },
    options: { createEventId?: () => string; now?: () => Date; write?: Writer } = {}
  ) {
    this.state = { version: 2, scope: { ...scope }, records: [], refreshPendingNodeIds: [] };
    this.manifestPath = `${path}.manifest`;
    this.createEventId = options.createEventId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.write = options.write ?? writeJsonAtomic;
  }

  async initialize() {
    if (this.initialized) return;
    const [manifest, journal] = await Promise.all([
      readJsonFile(this.manifestPath, { maxBytes: MAX_MANIFEST_BYTES }),
      readJsonFile(this.path, { maxBytes: MAX_JOURNAL_BYTES })
    ]);
    if (manifest === null && journal === null) {
      await this.write(this.manifestPath, { version: 1, scope: { ...this.scope } });
      await this.write(this.path, this.state);
      this.initialized = true;
      return;
    }
    parseManifest(manifest, this.scope);
    if (journal === null) throw new Error("vehicle_sensor_capability_journal_missing");
    this.state = parseJournal(journal, this.scope);
    this.initialized = true;
  }

  recordBinding(input: VehicleSensorCapabilityBinding): Promise<{
    changed: boolean;
    record: StoredVehicleSensorCapabilityRecord;
  }> {
    return this.exclusive(async () => {
      await this.initialize();
      this.requireAvailable();
      const result = this.prepareBindings([input], []);
      if (!isDeepStrictEqual(result.next, this.state)) await this.commit(result.next);
      return {
        changed: result.changedNodeIds.includes(input.meshNodeId),
        record: structuredClone(result.recordsByNodeId.get(input.meshNodeId)!)
      };
    });
  }

  recordBindingsAndCompleteBatch(inputs: VehicleSensorCapabilityBinding[]): Promise<{
    changedNodeIds: string[];
  }> {
    return this.exclusive(async () => {
      await this.initialize();
      this.requireAvailable();
      const nodeIds = inputs.map(({ meshNodeId }) => meshNodeId);
      const result = this.prepareBindings(inputs, nodeIds);
      if (!isDeepStrictEqual(result.next, this.state)) await this.commit(result.next);
      return { changedNodeIds: result.changedNodeIds };
    });
  }

  current(meshNodeId: string) {
    return this.exclusive(async () => {
      await this.initialize(); this.requireAvailable();
      const record = this.state.records.find(({ report }) => report.meshNodeId === meshNodeId);
      return record ? structuredClone(record) : null;
    });
  }

  pending() {
    return this.exclusive(async () => {
      await this.initialize(); this.requireAvailable();
      return this.state.records.filter(({ delivery }) => delivery.state === "pending")
        .map((record) => structuredClone(record));
    });
  }

  requestRefresh(meshNodeId: string) {
    return this.requestRefreshBatch([meshNodeId]);
  }

  requestRefreshBatch(meshNodeIds: string[]) {
    return this.updateRefresh((pending) => [...new Set([...pending, ...meshNodeIds])].sort());
  }

  completeRefresh(meshNodeId: string) {
    return this.completeRefreshBatch([meshNodeId]);
  }

  completeRefreshBatch(meshNodeIds: string[]) {
    const completed = new Set(meshNodeIds);
    return this.updateRefresh((pending) => pending.filter((candidate) => !completed.has(candidate)));
  }

  pendingRefreshNodeIds() {
    return this.exclusive(async () => {
      await this.initialize(); this.requireAvailable();
      return [...this.state.refreshPendingNodeIds];
    });
  }

  acknowledge(value: unknown): Promise<"ignored" | "terminal" | "rejected"> {
    return this.exclusive(async () => {
      await this.initialize(); this.requireAvailable();
      const ack = vehicleSensorCapabilityIngestedAckV1Schema.parse(value) as VehicleSensorCapabilityIngestedAckV1;
      const index = this.state.records.findIndex(({ report, reportPayloadHash }) =>
        report.gatewayId === ack.gatewayId && report.meshNodeId === ack.meshNodeId && report.eventId === ack.eventId &&
        report.capabilityRevision === ack.capabilityRevision && reportPayloadHash === ack.reportPayloadHash
      );
      if (index < 0 || ack.gatewayId !== this.scope.gatewayId) return "ignored";
      const current = this.state.records[index]!;
      const delivery: VehicleSensorCapabilityDelivery = ack.status === "rejected"
        ? { state: "rejected", errorCode: requireErrorCode(ack.errorCode), ingestedAt: ack.ingestedAt }
        : { state: "terminal", status: ack.status, ingestedAt: ack.ingestedAt };
      if (!isDeepStrictEqual(current.delivery, delivery)) {
        const next = structuredClone(this.state);
        next.records[index] = { ...current, delivery };
        await this.write(this.path, next);
        this.state = next;
      }
      return ack.status === "rejected" ? "rejected" : "terminal";
    });
  }

  private prepareBindings(inputs: VehicleSensorCapabilityBinding[], completedNodeIds: string[]) {
    if (inputs.length > MAX_VEHICLE_SENSOR_CAPABILITY_NODES ||
      new Set(inputs.map(({ meshNodeId }) => meshNodeId)).size !== inputs.length) {
      throw new Error("invalid_vehicle_sensor_capability_binding_batch");
    }
    const recordsByNodeId = new Map(this.state.records.map((record) => [record.report.meshNodeId, record]));
    const changedNodeIds: string[] = [];
    for (const input of [...inputs].sort((left, right) => left.meshNodeId.localeCompare(right.meshNodeId))) {
      const current = recordsByNodeId.get(input.meshNodeId);
      if (current && current.report.sensorServerBound === input.sensorServerBound &&
        current.report.vendorVehicleEventModelBound === input.vendorVehicleEventModelBound) continue;
      if (!current && recordsByNodeId.size >= MAX_VEHICLE_SENSOR_CAPABILITY_NODES) {
        throw new Error("vehicle_sensor_capability_capacity");
      }
      const capabilityRevision = (current?.report.capabilityRevision ?? 0) + 1;
      if (!Number.isSafeInteger(capabilityRevision)) throw new Error("vehicle_sensor_capability_revision_exhausted");
      const report = vehicleSensorCapabilityReportV1Schema.parse({
        schemaVersion: 1,
        eventId: this.createEventId(),
        siteId: this.scope.siteId,
        gatewayId: this.scope.gatewayId,
        meshNodeId: input.meshNodeId,
        capabilityRevision,
        status: input.sensorServerBound && input.vendorVehicleEventModelBound ? "supported" : "unsupported",
        verifiedAt: this.now().toISOString(),
        sensorServerBound: input.sensorServerBound,
        vendorVehicleEventModelBound: input.vendorVehicleEventModelBound
      }) as VehicleSensorCapabilityReportV1;
      recordsByNodeId.set(input.meshNodeId, {
        report,
        reportPayloadHash: canonicalHash(report),
        delivery: { state: "pending" }
      });
      changedNodeIds.push(input.meshNodeId);
    }
    const completed = new Set(completedNodeIds);
    return {
      changedNodeIds,
      recordsByNodeId,
      next: {
        ...this.state,
        records: [...recordsByNodeId.values()]
          .sort((left, right) => left.report.meshNodeId.localeCompare(right.report.meshNodeId)),
        refreshPendingNodeIds: this.state.refreshPendingNodeIds
          .filter((meshNodeId) => !completed.has(meshNodeId))
      }
    };
  }

  private async commit(next: JournalState) {
    try {
      await this.write(this.path, next);
    } catch (error) {
      if (!(error instanceof AtomicJsonCommitUncertainError)) throw error;
      let visible: JournalState;
      try {
        visible = parseJournal(await readJsonFile(this.path, { maxBytes: MAX_JOURNAL_BYTES }), this.scope);
      } catch (readbackError) {
        this.fenced = true;
        throw new Error("vehicle_sensor_capability_commit_ambiguous", {
          cause: new AggregateError([error, readbackError])
        });
      }
      if (isDeepStrictEqual(visible, next)) { this.state = next; return; }
      if (isDeepStrictEqual(visible, this.state)) {
        throw new Error("vehicle_sensor_capability_commit_uncertain", { cause: error });
      }
      this.fenced = true;
      throw new Error("vehicle_sensor_capability_commit_ambiguous", { cause: error });
    }
    this.state = next;
  }

  private updateRefresh(change: (pending: string[]) => string[]): Promise<void> {
    return this.exclusive(async () => {
      await this.initialize(); this.requireAvailable();
      const pending = change(this.state.refreshPendingNodeIds);
      if (pending.length > MAX_VEHICLE_SENSOR_CAPABILITY_NODES) {
        throw new Error("vehicle_sensor_capability_refresh_capacity");
      }
      parsePending(pending);
      if (isDeepStrictEqual(pending, this.state.refreshPendingNodeIds)) return;
      const next = { ...this.state, refreshPendingNodeIds: pending };
      await this.commit(next);
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private requireAvailable() {
    if (this.fenced) throw new Error("vehicle_sensor_capability_journal_unavailable");
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
  private readonly retryInitialMs: number;
  private readonly retryMaxMs: number;
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
    this.retryInitialMs = options.retryInitialDelayMs ?? 1_000;
    this.retryMaxMs = options.retryMaxDelayMs ?? 30_000;
    this.publishTimeoutMs = options.publishTimeoutMs ?? 10_000;
    if (!Number.isInteger(this.retryInitialMs) || this.retryInitialMs < 1 ||
      !Number.isInteger(this.retryMaxMs) || this.retryMaxMs < this.retryInitialMs ||
      !Number.isInteger(this.publishTimeoutMs) || this.publishTimeoutMs < 1) {
      throw new Error("invalid_vehicle_sensor_capability_retry_options");
    }
    this.retryDelayMs = this.retryInitialMs;
  }

  connect(publish: (topic: string, payload: VehicleSensorCapabilityReportV1) => Promise<void>) {
    if (this.connected) return this.activeDrains.get(this.generation) ?? Promise.resolve();
    this.connected = true; this.stopped = false; this.publish = publish; this.retryDelayMs = this.retryInitialMs;
    const generation = ++this.generation;
    this.clearRetry();
    return this.runDrain(generation);
  }

  disconnect() {
    this.connected = false; this.publish = undefined; this.generation += 1; this.retryDelayMs = this.retryInitialMs;
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
      if ((await this.journal.pending()).length === 0) this.clearRetry();
      else void this.wake();
    }
    return result;
  }

  async stopAndDrain() {
    this.stopped = true; this.connected = false; this.generation += 1; this.clearRetry();
    await Promise.all(this.activeDrains.values());
    this.publish = undefined;
  }

  private runDrain(generation: number): Promise<void> {
    const active = this.activeDrains.get(generation);
    if (active) return active;
    const publish = this.publish;
    if (!publish || !this.isCurrent(generation)) return Promise.resolve();
    const completion = (async () => {
      let hasPending = false;
      for (const record of await this.journal.pending()) {
        hasPending = true;
        try {
          await withTimeout(
            publish(mqttTopics.vehicleSensorCapabilityReport(this.scope.siteId, this.scope.gatewayId), record.report),
            this.publishTimeoutMs
          );
        } catch (error) { this.reportError(error); }
      }
      if (!this.isCurrent(generation)) return;
      if (hasPending && (await this.journal.pending()).length > 0) this.scheduleRetry(generation);
      else this.retryDelayMs = this.retryInitialMs;
    })().finally(() => {
      if (this.activeDrains.get(generation) === completion) this.activeDrains.delete(generation);
    });
    this.activeDrains.set(generation, completion);
    return completion;
  }

  private scheduleRetry(generation: number) {
    if (this.retryTimer || !this.isCurrent(generation)) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.retryMaxMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.isCurrent(generation)) void this.runDrain(generation).catch((error) => this.reportError(error));
    }, delay);
  }

  private clearRetry() { if (this.retryTimer) clearTimeout(this.retryTimer); this.retryTimer = undefined; }
  private isCurrent(generation: number) { return this.connected && !this.stopped && this.generation === generation; }
  private reportError(error: unknown) { try { this.options.onError?.(error); } catch { /* retry owns progress */ } }
}

function parseManifest(value: unknown, scope: { siteId: string; gatewayId: string }) {
  if (!isRecord(value) || value.version !== 1 || !sameScope(value.scope, scope) ||
    Object.keys(value).sort().join(",") !== "scope,version") {
    throw new Error("invalid_vehicle_sensor_capability_manifest");
  }
}

function parseJournal(value: unknown, scope: { siteId: string; gatewayId: string }): JournalState {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || !sameScope(value.scope, scope) ||
    !Array.isArray(value.records) || value.records.length > MAX_VEHICLE_SENSOR_CAPABILITY_NODES) {
    throw new Error("invalid_vehicle_sensor_capability_journal");
  }
  const legacy = value.version === 1;
  const keys = legacy ? "records,scope,version" : "records,refreshPendingNodeIds,scope,version";
  if (Object.keys(value).sort().join(",") !== keys) throw new Error("invalid_vehicle_sensor_capability_journal");
  const records = value.records.map((candidate) => parseRecord(candidate, scope));
  if (new Set(records.map(({ report }) => report.meshNodeId)).size !== records.length) {
    throw new Error("invalid_vehicle_sensor_capability_journal");
  }
  return {
    version: 2,
    scope: { ...scope },
    records,
    refreshPendingNodeIds: legacy ? [] : parsePending(value.refreshPendingNodeIds)
  };
}

function parseRecord(value: unknown, scope: { siteId: string; gatewayId: string }): StoredVehicleSensorCapabilityRecord {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "delivery,report,reportPayloadHash") {
    throw new Error("invalid_vehicle_sensor_capability_journal");
  }
  const report = vehicleSensorCapabilityReportV1Schema.parse(value.report) as VehicleSensorCapabilityReportV1;
  if (report.siteId !== scope.siteId || report.gatewayId !== scope.gatewayId || value.reportPayloadHash !== canonicalHash(report)) {
    throw new Error("invalid_vehicle_sensor_capability_journal");
  }
  return {
    report,
    reportPayloadHash: value.reportPayloadHash as `sha256:${string}`,
    delivery: parseDelivery(value.delivery)
  };
}

function parseDelivery(value: unknown): VehicleSensorCapabilityDelivery {
  if (!isRecord(value)) throw new Error("invalid_vehicle_sensor_capability_journal");
  if (value.state === "pending" && Object.keys(value).join(",") === "state") return { state: "pending" };
  if (value.state === "terminal" && (value.status === "applied" || value.status === "stale" || value.status === "duplicate") &&
    isTimestamp(value.ingestedAt) && Object.keys(value).sort().join(",") === "ingestedAt,state,status") {
    return { state: "terminal", status: value.status, ingestedAt: value.ingestedAt };
  }
  if (value.state === "rejected" && typeof value.errorCode === "string" && value.errorCode &&
    isTimestamp(value.ingestedAt) && Object.keys(value).sort().join(",") === "errorCode,ingestedAt,state") {
    return { state: "rejected", errorCode: value.errorCode, ingestedAt: value.ingestedAt };
  }
  throw new Error("invalid_vehicle_sensor_capability_journal");
}

function parsePending(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_VEHICLE_SENSOR_CAPABILITY_NODES ||
    value.some((nodeId) => typeof nodeId !== "string" || nodeId.length < 1 || nodeId.length > 128) ||
    new Set(value).size !== value.length) throw new Error("invalid_vehicle_sensor_capability_journal");
  return [...value].sort() as string[];
}

function canonicalHash(value: unknown) {
  return `sha256:${createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex")}` as const;
}
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => [key, sortJson(child)]));
}
function sameScope(value: unknown, scope: { siteId: string; gatewayId: string }) {
  return isRecord(value) && value.siteId === scope.siteId && value.gatewayId === scope.gatewayId &&
    Object.keys(value).sort().join(",") === "gatewayId,siteId";
}
function requireErrorCode(value: string | null) {
  if (!value) throw new Error("vehicle_sensor_capability_rejected_without_error");
  return value;
}
function isTimestamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("vehicle_sensor_capability_publish_timeout")), timeoutMs);
    void promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}
