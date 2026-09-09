import type {
  AutomationSnapshotV1,
  AutomationConfigAppliedV1,
  IdentifyDevicePayload,
  MeshGroupSubscriptionResultPayload,
  MeshGroupSubscriptionSyncPayload,
  ProvisionDevicePayload,
  ProvisioningCompletedPayload,
  ProvisioningFailedPayload,
  ProvisioningScanStartPayload,
  ProvisioningScanFoundDevice
} from "@led-control/shared";
import {
  automationConfigAppliedV1Schema,
  mqttTopicsV2,
  parseDfkDeviceUuid,
  provisioningScanCompletedSchema,
  provisioningScanFailedSchema,
  provisioningScanFoundSchema
} from "@led-control/shared";
import { ProvisioningScanJournal, type ProvisioningScanTerminalEvent } from "./state/provisioning-scan-journal";
import { AutomationRuntimeError, type AutomationRuntime } from "./automation/automation-runtime";

export interface BleMeshAdapter {
  setAttention?(fixtureId: string, expiresAt: number, action: "start" | "stop", signal?: AbortSignal): Promise<number>;
  setBrightness(fixtureIds: string[], brightness: number): Promise<BleMeshCommandReport[]>;
  applyUnicast?(fixtureId: string, brightness: number, signal?: AbortSignal, deadlineAt?: number): Promise<BleMeshCommandReport>;
  applyParallelUnicast?(
    fixtureIds: string[],
    brightness: number,
    concurrency?: number,
    signal?: AbortSignal,
    deadlineAt?: number
  ): Promise<BleMeshCommandReport[]>;
  applyMeshGroup?(
    groupAddress: number,
    fixtureIds: string[],
    brightness: number,
    signal?: AbortSignal,
    deadlineAt?: number
  ): Promise<BleMeshCommandReport[]>;
  onFixtureStatus(listener: (status: BleMeshFixtureStatus) => void): () => void;
  onLightingObservation(listener: (observation: BleMeshLightingObservation) => void): () => void;
  onResyncReport?(listener: (report: BleMeshResyncReport) => void): () => void;
  resyncFixtureStates(signal?: AbortSignal): Promise<BleMeshResyncReport>;
  resyncLightingFixtures(fixtureIds: string[], signal?: AbortSignal): Promise<BleMeshResyncReport>;
  syncGroupSubscriptions(command: MeshGroupSubscriptionSyncPayload, appliedMembers?: MeshGroupSubscriptionSyncPayload["desiredMembers"]): Promise<MeshGroupSubscriptionResultPayload>;
}

export function configuredVehicleSensorSourceFixtureIds(snapshot: AutomationSnapshotV1 | null) {
  if (!snapshot) return [];
  return [...new Set(snapshot.vehicleEventRules
    .filter(({ status }) => status === "enabled")
    .flatMap(({ sourceFixtureIds }) => sourceFixtureIds))].sort();
}

export interface BleMeshLightingObservation {
  fixtureId: string;
  brightness: number;
  powerOn: boolean;
  observedAt: string;
}

export interface BleMeshFixtureStatus {
  fixtureId: string;
  brightness: number;
  powerOn: boolean;
  status: "online" | "fault";
  faultCode?: string;
  health: { faultCodes: number[]; observedAt: string };
  rssi: number | null;
  hopCount: number | null;
}

export interface BleMeshResyncReport {
  total: number;
  configured: number;
  observed: number;
  healthPending: number;
  timedOut: number;
  failed: number;
}

export interface ProvisioningScannerAdapter {
  scan(command: ProvisioningScanStartPayload): Promise<ProvisioningScanFoundDevice[]>;
}

export interface ProvisioningAdapter {
  identify(command: IdentifyDevicePayload): Promise<void>;
  provision(command: ProvisionDevicePayload): Promise<ProvisioningCompletedPayload>;
}

export interface BleMeshCommandReport {
  fixtureId: string;
  acknowledged: boolean;
  outcome?: "applied" | "failed" | "timed_out";
  brightness: number;
  faultCode?: string;
  rssi: number | null;
  hopCount: number | null;
}

export async function applyProvisioningScan(adapter: ProvisioningScannerAdapter, command: ProvisioningScanStartPayload) {
  return adapter.scan(command);
}

export async function handleAutomationConfigPayload(
  payload: Buffer,
  runtime: Pick<AutomationRuntime, "gatewayId" | "hotReload">,
  recordAcknowledgement: (acknowledgement: AutomationConfigAppliedV1) => Promise<unknown>,
  now: () => Date = () => new Date()
) {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString());
  } catch (error) {
    throw new AutomationRuntimeError("snapshot_invalid", "snapshot_invalid", undefined, undefined, { cause: error });
  }

  let acknowledgement: AutomationConfigAppliedV1;
  try {
    acknowledgement = await runtime.hotReload(value);
  } catch (error) {
    if (!(error instanceof AutomationRuntimeError) || !error.acknowledgeable ||
      error.revision === undefined || error.payloadHash === undefined) {
      throw error;
    }
    acknowledgement = automationConfigAppliedV1Schema.parse({
      schemaVersion: 1,
      gatewayId: runtime.gatewayId,
      revision: error.revision,
      payloadHash: error.payloadHash,
      status: "rejected",
      errorCode: error.code,
      appliedAt: now().toISOString()
    }) as AutomationConfigAppliedV1;
  }
  await recordAcknowledgement(acknowledgement);
  return acknowledgement;
}

export type ProvisioningScanEnvelope = { eventId: string; sequence: number; occurredAt: string };

const PROVISIONING_SCAN_OUTBOX_LEASE_MS = 30_000;
const DEFAULT_RECOVERY_PUBLISH_TIMEOUT_MS = 10_000;
const DEFAULT_RECOVERY_RETRY_INITIAL_DELAY_MS = 1_000;
const DEFAULT_RECOVERY_RETRY_MAX_DELAY_MS = 30_000;

type RecoveryPublish = (topic: string, payload: unknown) => Promise<void>;
type RecoveryErrorHandler = (error: unknown) => unknown;

export class ProvisioningScanRecoveryPublisher {
  private preparation: Promise<void> | undefined;
  private activeDrain: { promise: Promise<void>; controller: AbortController } | undefined;
  private readonly publishTimeoutMs: number;
  private readonly retryInitialDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private retryDelayMs: number;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private connectedDrain: { generation: number; promise: Promise<void> } | undefined;
  private connectedPublish: RecoveryPublish | undefined;
  private connectedErrorHandler: RecoveryErrorHandler | undefined;
  private retryRequested = false;
  // A generation fence prevents a late publish completion from a closed connection scheduling work on its replacement.
  private connectionGeneration = 0;
  private connected = false;

  constructor(
    private readonly journal: ProvisioningScanJournal,
    options: {
      publishTimeoutMs?: number;
      retryInitialDelayMs?: number;
      retryMaxDelayMs?: number;
    } = {}
  ) {
    this.publishTimeoutMs = boundedRecoveryPublishTimeout(options.publishTimeoutMs ?? DEFAULT_RECOVERY_PUBLISH_TIMEOUT_MS);
    const retryBounds = boundedRecoveryRetryDelays(
      options.retryInitialDelayMs ?? DEFAULT_RECOVERY_RETRY_INITIAL_DELAY_MS,
      options.retryMaxDelayMs ?? DEFAULT_RECOVERY_RETRY_MAX_DELAY_MS
    );
    this.retryInitialDelayMs = retryBounds.initial;
    this.retryMaxDelayMs = retryBounds.max;
    this.retryDelayMs = this.retryInitialDelayMs;
  }

  prepare(createTerminal: (command: ProvisioningScanStartPayload) => Promise<ProvisioningScanTerminalEvent>) {
    this.preparation ??= this.journal.recoverRunning(createTerminal);
    return this.preparation;
  }

  connect(publish: RecoveryPublish, onError?: RecoveryErrorHandler) {
    if (this.connected) return this.connectedDrain?.promise ?? Promise.resolve();
    this.connected = true;
    const generation = ++this.connectionGeneration;
    this.connectedPublish = publish;
    this.connectedErrorHandler = onError;
    this.retryDelayMs = this.retryInitialDelayMs;
    this.retryRequested = false;
    this.clearRetryTimer();
    return this.runConnectedDrain(generation);
  }

  scheduleRetry() {
    if (!this.connected) return;
    this.retryRequested = true;
    if (this.connectedDrain) return;
    this.armRetryTimer(this.connectionGeneration);
  }

  async acknowledgeTerminal(acknowledgement: unknown) {
    const acknowledged = await this.journal.acknowledgeTerminal(acknowledgement);
    if (!acknowledged || !this.connected) return acknowledged;
    if ((await this.journal.pendingTerminals()).length === 0) {
      this.retryRequested = false;
      this.retryDelayMs = this.retryInitialDelayMs;
      this.clearRetryTimer();
    }
    return acknowledged;
  }

  drain(publish: RecoveryPublish) {
    if (this.activeDrain) return this.activeDrain.promise;
    const controller = new AbortController();
    const promise = (async () => {
      for (const terminal of await this.journal.pendingTerminals()) {
        await publishRecoveryTerminal(publish, terminal, this.publishTimeoutMs, controller.signal);
      }
    })();
    const active = { promise, controller };
    this.activeDrain = active;
    void promise.then(
      () => { if (this.activeDrain === active) this.activeDrain = undefined; },
      () => { if (this.activeDrain === active) this.activeDrain = undefined; }
    );
    return promise;
  }

  disconnect() {
    this.connected = false;
    this.connectionGeneration += 1;
    this.connectedPublish = undefined;
    this.connectedErrorHandler = undefined;
    this.retryRequested = false;
    this.retryDelayMs = this.retryInitialDelayMs;
    this.clearRetryTimer();
    this.connectedDrain = undefined;
    const active = this.activeDrain;
    if (!active) return;
    this.activeDrain = undefined;
    active.controller.abort(new Error("provisioning scan terminal recovery disconnected"));
  }

  private runConnectedDrain(generation: number): Promise<void> {
    const current = this.connectedDrain;
    if (current?.generation === generation) return current.promise;
    const publish = this.connectedPublish;
    if (!publish || !this.isCurrentConnection(generation)) return Promise.resolve();
    this.retryRequested = false;
    const active = { generation, promise: Promise.resolve() };
    active.promise = (async () => {
      let retry = false;
      try {
        await this.drain(publish);
        retry = (await this.journal.pendingTerminals()).length > 0;
      } catch (error) {
        retry = true;
        if (this.isCurrentConnection(generation)) this.reportConnectedError(error);
      }
      if (this.connectedDrain !== active) return;
      this.connectedDrain = undefined;
      if (!this.isCurrentConnection(generation)) return;
      if (retry || this.retryRequested) this.armRetryTimer(generation);
      else this.retryDelayMs = this.retryInitialDelayMs;
    })();
    this.connectedDrain = active;
    return active.promise;
  }

  private armRetryTimer(generation: number) {
    if (this.retryTimer || this.connectedDrain || !this.isCurrentConnection(generation)) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.retryMaxDelayMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.isCurrentConnection(generation)) void this.runConnectedDrain(generation);
    }, delay);
  }

  private clearRetryTimer() {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private isCurrentConnection(generation: number) {
    return this.connected && this.connectionGeneration === generation;
  }

  private reportConnectedError(error: unknown) {
    try {
      this.connectedErrorHandler?.(error);
    } catch {
      // Retry ownership must remain with this scheduler even if observability reporting fails.
    }
  }
}

export async function publishProvisioningScanLifecycle(input: {
  adapter: ProvisioningScannerAdapter;
  command: ProvisioningScanStartPayload;
  nextEnvelope: () => Promise<ProvisioningScanEnvelope>;
  publish: (topic: string, payload: unknown) => Promise<void>;
  persistTerminal?: (terminal: ProvisioningScanTerminalEvent) => Promise<ProvisioningScanTerminalEvent>;
  onTerminalPersisted?: () => void;
}) {
  let nodes: ProvisioningScanFoundDevice[];
  try {
    nodes = (await applyProvisioningScan(input.adapter, input.command))
      .filter((node) => parseDfkDeviceUuid(node.deviceUuid) !== null);
    for (const node of nodes) {
      await input.publish(
        mqttTopicsV2.provisioningScanFound(input.command.siteId, input.command.gatewayId),
        createProvisioningScanFoundPayload(input.command, node, await input.nextEnvelope())
      );
    }
  } catch (error) {
    await publishScanTerminal(input, {
      topic: mqttTopicsV2.provisioningScanFailed(input.command.siteId, input.command.gatewayId),
      payload: createProvisioningScanFailedPayload(input.command, error, await input.nextEnvelope())
    });
    return;
  }

  await publishScanTerminal(input, {
    topic: mqttTopicsV2.provisioningScanCompleted(input.command.siteId, input.command.gatewayId),
    payload: createProvisioningScanCompletedPayload(input.command, nodes.length, await input.nextEnvelope())
  });
}

export async function handleDurableProvisioningScan(input: {
  adapter: ProvisioningScannerAdapter;
  journal: ProvisioningScanJournal;
  command: ProvisioningScanStartPayload;
  nextEnvelope: () => Promise<ProvisioningScanEnvelope>;
  publish: (topic: string, payload: unknown) => Promise<void>;
  onTerminalPersisted?: () => void;
}) {
  const started = await input.journal.begin(input.command);
  if (started.kind === "terminal") {
    if (!started.delivered) {
      input.onTerminalPersisted?.();
      await publishScanTerminal({
        publish: input.publish
      }, started.terminal);
    }
    return;
  }
  if (started.kind === "running") return;
  if (started.kind === "recovered") {
    await publishScanTerminal({
      publish: input.publish,
      persistTerminal: (terminal) => input.journal.complete(input.command, terminal),
      onTerminalPersisted: input.onTerminalPersisted
    }, {
      topic: mqttTopicsV2.provisioningScanFailed(input.command.siteId, input.command.gatewayId),
      payload: createProvisioningScanFailedPayload(input.command, new Error("gateway scan interrupted"), await input.nextEnvelope())
    });
    return;
  }
  await publishProvisioningScanLifecycle({
    adapter: input.adapter,
    command: input.command,
    nextEnvelope: input.nextEnvelope,
    publish: input.publish,
    persistTerminal: (terminal) => input.journal.complete(input.command, terminal),
    onTerminalPersisted: input.onTerminalPersisted
  });
}

async function publishScanTerminal(
  input: {
    persistTerminal?: (terminal: ProvisioningScanTerminalEvent) => Promise<ProvisioningScanTerminalEvent>;
    publish: (topic: string, payload: unknown) => Promise<void>;
    onTerminalPersisted?: () => void;
  },
  terminal: ProvisioningScanTerminalEvent
) {
  const durable = input.persistTerminal ? await input.persistTerminal(terminal) : terminal;
  input.onTerminalPersisted?.();
  await input.publish(durable.topic, durable.payload);
}

function publishRecoveryTerminal(
  publish: (topic: string, payload: unknown) => Promise<void>,
  terminal: ProvisioningScanTerminalEvent,
  timeoutMs: number,
  signal: AbortSignal
) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(signal.reason instanceof Error
      ? signal.reason
      : new Error("provisioning scan terminal recovery disconnected"));
    const timeout = setTimeout(
      () => finish(new Error(`provisioning scan terminal recovery timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void Promise.resolve()
      .then(() => publish(terminal.topic, terminal.payload))
      .then(() => finish(), finish);
  });
}

function boundedRecoveryPublishTimeout(value: number) {
  if (!Number.isInteger(value) || value < 1 || value >= PROVISIONING_SCAN_OUTBOX_LEASE_MS) {
    throw new Error("invalid provisioning scan recovery publish timeout");
  }
  return value;
}

function boundedRecoveryRetryDelays(initial: number, max: number) {
  if (!Number.isInteger(initial) || initial < 1 || !Number.isInteger(max) || max < initial) {
    throw new Error("invalid provisioning scan recovery retry delays");
  }
  return { initial, max };
}

export function createProvisioningScanFoundPayload(
  command: ProvisioningScanStartPayload,
  node: ProvisioningScanFoundDevice,
  envelope: ProvisioningScanEnvelope
) {
  return provisioningScanFoundSchema.parse({
    sessionId: command.sessionId,
    scanCorrelationId: command.scanCorrelationId,
    scanAttempt: command.scanAttempt,
    siteId: command.siteId,
    gatewayId: command.gatewayId,
    ...envelope,
    ...node
  });
}

export function createProvisioningScanCompletedPayload(
  command: ProvisioningScanStartPayload,
  acceptedNodeCount: number,
  envelope: ProvisioningScanEnvelope
) {
  return provisioningScanCompletedSchema.parse({
    sessionId: command.sessionId,
    scanCorrelationId: command.scanCorrelationId,
    scanAttempt: command.scanAttempt,
    siteId: command.siteId,
    gatewayId: command.gatewayId,
    ...envelope,
    acceptedNodeCount
  });
}

export function createProvisioningScanFailedPayload(
  command: ProvisioningScanStartPayload,
  error: unknown,
  envelope: ProvisioningScanEnvelope
) {
  return provisioningScanFailedSchema.parse({
    sessionId: command.sessionId,
    scanCorrelationId: command.scanCorrelationId,
    scanAttempt: command.scanAttempt,
    siteId: command.siteId,
    gatewayId: command.gatewayId,
    ...envelope,
    ...sanitizeProvisioningScanFailure(error)
  });
}

function sanitizeProvisioningScanFailure(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("bluetooth")) return { code: "bluetooth_unavailable" as const, message: "Bluetooth 기능을 사용할 수 없습니다." };
  if (message.includes("mesh")) return { code: "mesh_unavailable" as const, message: "Mesh 네트워크를 사용할 수 없습니다." };
  if (message.includes("timeout") || message.includes("timed out")) return { code: "scan_timeout" as const, message: "조명 검색 시간이 초과되었습니다." };
  if (message.includes("start")) return { code: "scan_start_failed" as const, message: "조명 검색을 시작하지 못했습니다." };
  return { code: "scan_runtime_failed" as const, message: "조명 검색 중 문제가 발생했습니다." };
}

export async function applyIdentifyDevice(adapter: ProvisioningAdapter, command: IdentifyDevicePayload) {
  await adapter.identify(command);
}

export async function applyProvisionDevice(
  adapter: ProvisioningAdapter,
  command: ProvisionDevicePayload
): Promise<{ completed?: ProvisioningCompletedPayload; failed?: ProvisioningFailedPayload }> {
  try {
    return { completed: await adapter.provision(command) };
  } catch (error) {
    return {
      failed: {
        sessionId: command.sessionId,
        nodeId: command.nodeId,
        deviceUuid: command.deviceUuid,
        errorMessage: error instanceof Error ? error.message : "Unknown provisioning adapter error",
        failedAt: new Date().toISOString()
      }
    };
  }
}
