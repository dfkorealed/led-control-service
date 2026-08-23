import {
  AcceptanceAckV2,
  DeviceStatusAckV2,
  GatewayDimmingCommandV2,
  acceptanceAckV2Schema,
  deviceStatusAckV2Schema,
  isGatewayCommandExpired
} from "@led-control/shared";
import { randomUUID } from "node:crypto";
import { BleMeshAdapter } from "../gateway";
import type { GroupStateIdentity, GroupStateStore } from "../mesh/group-state-store";
import type { KeyedSerialTaskQueue } from "../runtime/keyed-serial-task-queue";

interface JournalLike {
  get(key: string): Promise<{ state: "accepted" | "completed"; command: unknown; result?: unknown } | null>;
  accept(key: string, command: unknown): Promise<boolean>;
  complete(key: string, result: unknown): Promise<void>;
}

export interface GatewayCommandResult {
  acceptance: AcceptanceAckV2;
  deviceStatus: DeviceStatusAckV2;
  fixtureStateObserved: boolean;
  observedFixtureIds?: string[];
}

interface GatewayCommandOptions {
  timeoutMs?: number;
  groupStateStore?: Pick<GroupStateStore, "assertReady">;
  groupQueue?: Pick<KeyedSerialTaskQueue, "run">;
}

export function handleGatewayDimmingCommand(
  adapter: BleMeshAdapter,
  journal: JournalLike,
  command: GatewayDimmingCommandV2,
  onAccepted?: (acceptance: AcceptanceAckV2) => Promise<void>,
  options: GatewayCommandOptions = {}
): Promise<GatewayCommandResult> {
  if (command.deliveryMode !== "mesh_group") {
    return executeGatewayDimmingCommand(adapter, journal, command, onAccepted, options);
  }
  const groupId = command.meshControlGroupId;
  if (!groupId || !options.groupQueue) {
    return executeGatewayDimmingCommand(adapter, journal, command, onAccepted, options);
  }
  return options.groupQueue.run(groupId, () => executeGatewayDimmingCommand(adapter, journal, command, onAccepted, options));
}

async function executeGatewayDimmingCommand(
  adapter: BleMeshAdapter,
  journal: JournalLike,
  command: GatewayDimmingCommandV2,
  onAccepted: ((acceptance: AcceptanceAckV2) => Promise<void>) | undefined,
  options: GatewayCommandOptions
): Promise<GatewayCommandResult> {
  const existing = await journal.get(command.idempotencyKey);
  if (existing?.state === "completed") return existing.result as GatewayCommandResult;
  if (existing?.state === "accepted") {
    const stored = existing.command as { acceptance?: AcceptanceAckV2 };
    const result = createIndeterminateResult(command, stored.acceptance);
    await journal.complete(command.idempotencyKey, result);
    return result;
  }

  // Broker expiry is primary; this verifies the API's publish-relative deadline before BLE execution.
  if (isGatewayCommandExpired(command.expiresAt)) {
    return rejectExpiredCommand(journal, command);
  }

  if (command.deliveryMode === "mesh_group") {
    const identity = meshGroupIdentity(command);
    if (!options.groupStateStore || !options.groupQueue || !adapter.applyMeshGroup) {
      return rejectBeforeExecution(journal, command, "MESH_GROUP_UNAVAILABLE", "mesh group control is unavailable");
    }
    try {
      await options.groupStateStore.assertReady(identity);
    } catch (error) {
      const code = errorCode(error, "MESH_GROUP_NOT_READY");
      return rejectBeforeExecution(journal, command, code, error instanceof Error ? error.message : "mesh group is not ready");
    }
  }

  const identity = {
    commandId: command.commandId,
    dispatchId: command.dispatchId,
    idempotencyKey: command.idempotencyKey,
    sequence: command.sequence,
    siteId: command.siteId,
    gatewayId: command.gatewayId
  };
  const acceptance = acceptanceAckV2Schema.parse({
    ...identity,
    eventId: randomUUID(),
    status: "accepted",
    acceptedAt: new Date().toISOString()
  });
  const reserved = await journal.accept(command.idempotencyKey, { command, acceptance });
  if (!reserved) {
    const raced = await journal.get(command.idempotencyKey);
    if (raced?.state === "completed") return raced.result as GatewayCommandResult;
    throw new Error("duplicate command has an indeterminate accepted result");
  }
  await onAccepted?.(acceptance);

  // Journal fsync and the acceptance PUBACK can consume the remaining delivery window.
  if (isGatewayCommandExpired(command.expiresAt)) {
    return rejectExpiredCommand(journal, command, true);
  }

  let deviceStatus: DeviceStatusAckV2;
  let fixtureStateObserved = false;
  let observedFixtureIds: string[] = [];
  try {
    const timeoutMs = validateTimeout(options.timeoutMs ?? 8000);
    const controller = new AbortController();
    const reports = validateReports(
      command.targetFixtureIds,
      await withTimeout(applyCommand(adapter, command, controller.signal), timeoutMs, () => controller.abort())
    );
    observedFixtureIds = reports
      .filter((report) => report.acknowledged || report.faultCode === "state_mismatch")
      .map((report) => report.fixtureId);
    fixtureStateObserved = observedFixtureIds.length > 0;
    const results = reports.map((report) => ({
      fixtureId: report.fixtureId,
      status: report.acknowledged
        ? ("succeeded" as const)
        : report.outcome === "timed_out"
          ? ("timed_out" as const)
          : ("failed" as const),
      ...(report.acknowledged || report.faultCode === "state_mismatch" ? { brightness: report.brightness } : {}),
      ...(report.faultCode ? { faultCode: report.faultCode } : {}),
      rssi: report.rssi,
      hopCount: report.hopCount
    }));
    const succeeded = results.filter((result) => result.status === "succeeded").length;
    const timedOut = results.some((result) => result.status === "timed_out");
    deviceStatus = deviceStatusAckV2Schema.parse({
      ...identity,
      eventId: randomUUID(),
      status: succeeded === results.length
        ? "succeeded"
        : succeeded > 0
          ? "partially_succeeded"
          : timedOut
            ? "timed_out"
            : "failed",
      occurredAt: new Date().toISOString(),
      results
    });
  } catch (error) {
    const timedOut = error instanceof MeshStatusTimeoutError;
    deviceStatus = deviceStatusAckV2Schema.parse({
      ...identity,
      eventId: randomUUID(),
      status: timedOut ? "timed_out" : "failed",
      occurredAt: new Date().toISOString(),
      results: command.targetFixtureIds.map((fixtureId) => ({
        fixtureId,
        status: timedOut ? "timed_out" : "failed",
        errorMessage: error instanceof Error ? error.message : "unknown BLE Mesh command error"
      }))
    });
  }

  const result = { acceptance, deviceStatus, fixtureStateObserved, observedFixtureIds };
  await journal.complete(command.idempotencyKey, result);
  return result;
}

function applyCommand(adapter: BleMeshAdapter, command: GatewayDimmingCommandV2, signal: AbortSignal) {
  switch (command.deliveryMode) {
    case "unicast":
      return adapter.applyUnicast
        ? adapter.applyUnicast(command.targetFixtureIds[0], command.brightness, signal).then((report) => [report])
        : adapter.setBrightness(command.targetFixtureIds, command.brightness);
    case "parallel_unicast":
      if (!adapter.applyParallelUnicast) throw new Error("parallel unicast control is unavailable");
      return adapter.applyParallelUnicast(command.targetFixtureIds, command.brightness, 8, signal);
    case "mesh_group":
      if (!adapter.applyMeshGroup || !command.destinationAddress) throw new Error("mesh group control is unavailable");
      return adapter.applyMeshGroup(
        parseGroupAddress(command.destinationAddress),
        command.targetFixtureIds,
        command.brightness,
        signal
      );
  }
}

function validateReports(expectedFixtureIds: string[], reports: Awaited<ReturnType<BleMeshAdapter["setBrightness"]>>) {
  const expected = new Set(expectedFixtureIds);
  if (
    reports.length !== expected.size ||
    reports.some((report) => !expected.has(report.fixtureId)) ||
    new Set(reports.map((report) => report.fixtureId)).size !== reports.length
  ) {
    throw new Error("BLE Mesh adapter returned an invalid fixture result set");
  }
  const byFixture = new Map(reports.map((report) => [report.fixtureId, report]));
  return expectedFixtureIds.map((fixtureId) => byFixture.get(fixtureId)!);
}

function meshGroupIdentity(command: GatewayDimmingCommandV2): GroupStateIdentity {
  if (!command.meshControlGroupId || !command.meshControlGroupVersion || !command.destinationAddress) {
    throw new Error("mesh group command metadata is incomplete");
  }
  return {
    groupId: command.meshControlGroupId,
    groupAddress: command.destinationAddress,
    version: command.meshControlGroupVersion
  };
}

function parseGroupAddress(value: string) {
  const address = Number.parseInt(value.slice(2), 16);
  if (!/^0x[0-9a-f]{4}$/i.test(value) || address < 0xc000 || address > 0xfeff) {
    throw new Error("invalid mesh group address");
  }
  return address;
}

function errorCode(error: unknown, fallback: string) {
  if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "string" || error.code.length === 0) {
    return fallback;
  }
  return error.code;
}

class MeshStatusTimeoutError extends Error {}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, onTimeout: () => void = () => undefined) {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      onTimeout();
      reject(new MeshStatusTimeoutError(`BLE Mesh status timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

function validateTimeout(value: number) {
  if (!Number.isInteger(value) || value < 1000 || value > 300_000) throw new Error("BLE Mesh timeout must be 1000-300000ms");
  return value;
}

export function parseCommandTimeout(value: string | undefined) {
  return validateTimeout(value === undefined ? 8000 : Number(value));
}

function createIndeterminateResult(command: GatewayDimmingCommandV2, acceptance?: AcceptanceAckV2): GatewayCommandResult {
  const identity = {
    commandId: command.commandId,
    dispatchId: command.dispatchId,
    idempotencyKey: command.idempotencyKey,
    sequence: command.sequence,
    siteId: command.siteId,
    gatewayId: command.gatewayId
  };
  const accepted =
    acceptance ??
    acceptanceAckV2Schema.parse({ ...identity, eventId: randomUUID(), status: "accepted", acceptedAt: new Date().toISOString() });
  const deviceStatus = deviceStatusAckV2Schema.parse({
    ...identity,
    eventId: randomUUID(),
    status: "timed_out",
    occurredAt: new Date().toISOString(),
    results: command.targetFixtureIds.map((fixtureId) => ({
      fixtureId,
      status: "timed_out",
      errorMessage: "indeterminate after gateway restart"
    }))
  });
  return { acceptance: accepted, deviceStatus, fixtureStateObserved: false };
}

async function rejectExpiredCommand(
  journal: JournalLike,
  command: GatewayDimmingCommandV2,
  alreadyAccepted = false
): Promise<GatewayCommandResult> {
  const identity = {
    commandId: command.commandId,
    dispatchId: command.dispatchId,
    idempotencyKey: command.idempotencyKey,
    sequence: command.sequence,
    siteId: command.siteId,
    gatewayId: command.gatewayId
  };
  const result: GatewayCommandResult = {
    acceptance: acceptanceAckV2Schema.parse({
      ...identity,
      eventId: randomUUID(),
      status: "rejected",
      acceptedAt: new Date().toISOString(),
      errorCode: "COMMAND_EXPIRED",
      errorMessage: "gateway command expired before execution"
    }),
    deviceStatus: deviceStatusAckV2Schema.parse({
      ...identity,
      eventId: randomUUID(),
      status: "failed",
      occurredAt: new Date().toISOString(),
      results: command.targetFixtureIds.map((fixtureId) => ({
        fixtureId,
        status: "failed" as const,
        errorMessage: "gateway command expired before execution"
      }))
    }),
    fixtureStateObserved: false
  };
  if (alreadyAccepted) {
    await journal.complete(command.idempotencyKey, result);
    return result;
  }
  const reserved = await journal.accept(command.idempotencyKey, { command, acceptance: result.acceptance });
  if (!reserved) {
    const raced = await journal.get(command.idempotencyKey);
    if (raced?.state === "completed") return raced.result as GatewayCommandResult;
    throw new Error("duplicate command has an indeterminate accepted result");
  }
  await journal.complete(command.idempotencyKey, result);
  return result;
}

async function rejectBeforeExecution(
  journal: JournalLike,
  command: GatewayDimmingCommandV2,
  code: string,
  message: string
): Promise<GatewayCommandResult> {
  const identity = {
    commandId: command.commandId,
    dispatchId: command.dispatchId,
    idempotencyKey: command.idempotencyKey,
    sequence: command.sequence,
    siteId: command.siteId,
    gatewayId: command.gatewayId
  };
  const result: GatewayCommandResult = {
    acceptance: acceptanceAckV2Schema.parse({
      ...identity,
      eventId: randomUUID(),
      status: "rejected",
      acceptedAt: new Date().toISOString(),
      errorCode: code,
      errorMessage: message
    }),
    deviceStatus: deviceStatusAckV2Schema.parse({
      ...identity,
      eventId: randomUUID(),
      status: "failed",
      occurredAt: new Date().toISOString(),
      results: command.targetFixtureIds.map((fixtureId) => ({ fixtureId, status: "failed", errorMessage: message }))
    }),
    fixtureStateObserved: false
  };
  const reserved = await journal.accept(command.idempotencyKey, { command, acceptance: result.acceptance });
  if (!reserved) {
    const raced = await journal.get(command.idempotencyKey);
    if (raced?.state === "completed") return raced.result as GatewayCommandResult;
    throw new Error("duplicate command has an indeterminate rejected result");
  }
  await journal.complete(command.idempotencyKey, result);
  return result;
}
