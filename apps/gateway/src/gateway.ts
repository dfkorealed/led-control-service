import type {
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
  mqttTopicsV2,
  parseDfkDeviceUuid,
  provisioningScanCompletedSchema,
  provisioningScanFailedSchema,
  provisioningScanFoundSchema
} from "@led-control/shared";
import { ProvisioningScanJournal, type ProvisioningScanTerminalEvent } from "./state/provisioning-scan-journal";

export interface BleMeshAdapter {
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
  onResyncReport?(listener: (report: BleMeshResyncReport) => void): () => void;
  resyncFixtureStates(): Promise<BleMeshResyncReport>;
  syncGroupSubscriptions(command: MeshGroupSubscriptionSyncPayload, appliedMembers?: MeshGroupSubscriptionSyncPayload["desiredMembers"]): Promise<MeshGroupSubscriptionResultPayload>;
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

export type ProvisioningScanEnvelope = { eventId: string; sequence: number; occurredAt: string };

export class ProvisioningScanRecoveryPublisher {
  private preparation: Promise<void> | undefined;
  private draining: Promise<void> | undefined;

  constructor(private readonly journal: ProvisioningScanJournal) {}

  prepare(createTerminal: (command: ProvisioningScanStartPayload) => Promise<ProvisioningScanTerminalEvent>) {
    this.preparation ??= this.journal.recoverRunning(createTerminal);
    return this.preparation;
  }

  drain(publish: (topic: string, payload: unknown) => Promise<void>) {
    if (this.draining) return this.draining;
    const draining = (async () => {
      for (const terminal of await this.journal.pendingTerminals()) {
        await publish(terminal.topic, terminal.payload);
        if (!await this.journal.markDelivered(terminal)) {
          throw new Error("provisioning scan terminal delivery state changed");
        }
      }
    })();
    this.draining = draining;
    void draining.then(
      () => { if (this.draining === draining) this.draining = undefined; },
      () => { if (this.draining === draining) this.draining = undefined; }
    );
    return draining;
  }
}

export async function publishProvisioningScanLifecycle(input: {
  adapter: ProvisioningScannerAdapter;
  command: ProvisioningScanStartPayload;
  nextEnvelope: () => Promise<ProvisioningScanEnvelope>;
  publish: (topic: string, payload: unknown) => Promise<void>;
  persistTerminal?: (terminal: ProvisioningScanTerminalEvent) => Promise<ProvisioningScanTerminalEvent>;
  markDelivered?: (terminal: ProvisioningScanTerminalEvent) => Promise<boolean>;
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
}) {
  const started = await input.journal.begin(input.command);
  if (started.kind === "terminal") {
    if (!started.delivered) {
      await publishScanTerminal({
        publish: input.publish,
        markDelivered: (terminal) => input.journal.markDelivered(terminal)
      }, started.terminal);
    }
    return;
  }
  if (started.kind === "running") return;
  if (started.kind === "recovered") {
    await publishScanTerminal({
      publish: input.publish,
      persistTerminal: (terminal) => input.journal.complete(input.command, terminal),
      markDelivered: (terminal) => input.journal.markDelivered(terminal)
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
    markDelivered: (terminal) => input.journal.markDelivered(terminal)
  });
}

async function publishScanTerminal(
  input: {
    persistTerminal?: (terminal: ProvisioningScanTerminalEvent) => Promise<ProvisioningScanTerminalEvent>;
    markDelivered?: (terminal: ProvisioningScanTerminalEvent) => Promise<boolean>;
    publish: (topic: string, payload: unknown) => Promise<void>;
  },
  terminal: ProvisioningScanTerminalEvent
) {
  const durable = input.persistTerminal ? await input.persistTerminal(terminal) : terminal;
  await input.publish(durable.topic, durable.payload);
  if (input.markDelivered && !await input.markDelivered(durable)) {
    throw new Error("provisioning scan terminal delivery state changed");
  }
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
