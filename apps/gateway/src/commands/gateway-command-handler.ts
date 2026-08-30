import {
  AcceptanceAckV2,
  AutomationExecutionFixtureResultV1,
  DeviceStatusAckV2,
  GatewayDimmingCommandV2,
  acceptanceAckV2Schema,
  deriveDeviceStatusAckStatus,
  deviceStatusAckV2Schema,
  gatewayDimmingCommandV2Schema,
  isGatewayCommandExpired
} from "@led-control/shared";
import { randomUUID } from "node:crypto";
import { BleMeshAdapter } from "../gateway";
import type { GroupStateIdentity, GroupStateStore } from "../mesh/group-state-store";
import type { KeyedSerialTaskQueue } from "../runtime/keyed-serial-task-queue";

interface JournalLike {
  get(key: string): Promise<{
    state: "accepted" | "completed";
    command: unknown;
    result?: unknown;
    automationHandoff?: "pending" | "completed";
  } | null>;
  accept(key: string, command: unknown): Promise<boolean>;
  complete(
    key: string,
    result: unknown,
    options?: { automationHandoffPending?: boolean }
  ): Promise<void>;
  markAutomationHandoffComplete?(key: string): Promise<void>;
}

export interface GatewayCommandResult {
  acceptance: AcceptanceAckV2;
  deviceStatus: DeviceStatusAckV2;
  fixtureStateObserved: boolean;
  observedFixtureIds?: string[];
}

export interface ManualOverrideCoordinator {
  prepare(command: GatewayDimmingCommandV2): Promise<void>;
  handoff(command: GatewayDimmingCommandV2, terminal: DeviceStatusAckV2): Promise<void>;
}

interface ManualAutomationRecoveryJournal {
  pendingAutomationRecoveries(): Promise<Array<{
    idempotencyKey: string;
    state: "accepted" | "completed";
    command: unknown;
    result?: unknown;
  }>>;
  complete(
    key: string,
    result: unknown,
    options?: { automationHandoffPending?: boolean }
  ): Promise<void>;
  markAutomationHandoffComplete(key: string): Promise<void>;
}

export interface GatewayCommandOptions {
  timeoutMs?: number;
  groupStateStore?: Pick<GroupStateStore, "assertReady">;
  groupQueue?: Pick<KeyedSerialTaskQueue, "run">;
  beforeExecution?: () => Promise<void>;
  isCommandExpired?: (expiresAt: string) => Promise<boolean> | boolean;
  automation?: ManualOverrideCoordinator;
  onAutomationError?: (error: unknown) => void;
}

interface AutomationDimmingAction {
  fixtureId: string;
  brightnessPercent: number;
}

interface AutomationDimmingOptions {
  timeoutMs?: number;
  now?: () => Date;
}

const COMMAND_COMPLETION_GRACE_MS = 250;
const MAX_BLE_STATUS_TIMEOUT_MS = 29_000;

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

export async function recoverPendingManualAutomationHandoffs(
  journal: ManualAutomationRecoveryJournal,
  automation: ManualOverrideCoordinator
) {
  for (const recovery of await journal.pendingAutomationRecoveries()) {
    const wrapper = recovery.command as { command?: unknown };
    const command = gatewayDimmingCommandV2Schema.parse(wrapper.command);
    if (!command.overrideUntil) continue;
    const result = recovery.state === "completed"
      ? recovery.result as GatewayCommandResult
      : createIndeterminateResult(command);
    if (recovery.state === "accepted") {
      await journal.complete(recovery.idempotencyKey, result, { automationHandoffPending: true });
    }
    await automation.handoff(command, result.deviceStatus);
    await journal.markAutomationHandoffComplete(recovery.idempotencyKey);
  }
}

async function executeGatewayDimmingCommand(
  adapter: BleMeshAdapter,
  journal: JournalLike,
  command: GatewayDimmingCommandV2,
  onAccepted: ((acceptance: AcceptanceAckV2) => Promise<void>) | undefined,
  options: GatewayCommandOptions
): Promise<GatewayCommandResult> {
  const existing = await journal.get(command.idempotencyKey);
  if (existing?.state === "completed") {
    const result = existing.result as GatewayCommandResult;
    if (existing.automationHandoff === "pending") {
      await replayAutomationHandoff(journal, command, result, options);
    }
    return result;
  }
  if (existing?.state === "accepted") {
    const stored = existing.command as { acceptance?: AcceptanceAckV2 };
    const result = createIndeterminateResult(command, stored.acceptance);
    await completeWithAutomationHandoff(journal, command, result, options);
    return result;
  }

  // Broker expiry is primary; this verifies the API's publish-relative deadline before BLE execution.
  if (await commandExpired(command.expiresAt, options)) {
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

  try {
    await options.beforeExecution?.();
  } catch {
    return rejectBeforeExecution(
      journal,
      command,
      "STATE_OUTBOX_CAPACITY",
      "durable fixture state capacity is unavailable"
    );
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
  if (await commandExpired(command.expiresAt, options)) {
    return rejectExpiredCommand(journal, command, true);
  }

  let deviceStatus: DeviceStatusAckV2;
  let fixtureStateObserved = false;
  let observedFixtureIds: string[] = [];
  try {
    if (command.overrideUntil) await options.automation?.prepare(command);
    const timeoutMs = validateTimeout(options.timeoutMs ?? 8000);
    const deadlineAt = Date.now() + timeoutMs;
    const controller = new AbortController();
    const reports = validateReports(
      command.targetFixtureIds,
      await withTimeout(
        applyCommand(adapter, command, controller.signal, deadlineAt),
        deadlineAt + COMMAND_COMPLETION_GRACE_MS,
        timeoutMs,
        () => controller.abort()
      )
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
    deviceStatus = deviceStatusAckV2Schema.parse({
      ...identity,
      eventId: randomUUID(),
      status: deriveDeviceStatusAckStatus(results),
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
  await completeWithAutomationHandoff(journal, command, result, options);
  return result;
}

async function commandExpired(expiresAt: string, options: GatewayCommandOptions) {
  return options.isCommandExpired
    ? options.isCommandExpired(expiresAt)
    : isGatewayCommandExpired(expiresAt);
}

async function completeWithAutomationHandoff(
  journal: JournalLike,
  command: GatewayDimmingCommandV2,
  result: GatewayCommandResult,
  options: GatewayCommandOptions
) {
  const pending = Boolean(command.overrideUntil && options.automation);
  await journal.complete(command.idempotencyKey, result, { automationHandoffPending: pending });
  if (pending) await replayAutomationHandoff(journal, command, result, options);
}

async function replayAutomationHandoff(
  journal: JournalLike,
  command: GatewayDimmingCommandV2,
  result: GatewayCommandResult,
  options: GatewayCommandOptions
) {
  if (!command.overrideUntil || !options.automation) return;
  try {
    await options.automation.handoff(command, result.deviceStatus);
    await journal.markAutomationHandoffComplete?.(command.idempotencyKey);
  } catch (error) {
    options.onAutomationError?.(error);
  }
}

export async function executeAutomationDimmingActions(
  adapter: BleMeshAdapter,
  actions: AutomationDimmingAction[],
  options: AutomationDimmingOptions = {}
): Promise<AutomationExecutionFixtureResultV1[]> {
  validateAutomationActions(actions);
  const timeoutMs = validateTimeout(options.timeoutMs ?? 8000);
  const now = options.now ?? (() => new Date());
  const grouped = new Map<number, string[]>();
  for (const action of actions) {
    const fixtures = grouped.get(action.brightnessPercent) ?? [];
    fixtures.push(action.fixtureId);
    grouped.set(action.brightnessPercent, fixtures);
  }

  const results = new Map<string, AutomationExecutionFixtureResultV1>();
  for (const [brightness, fixtureIds] of grouped) {
    const deadlineAt = Date.now() + timeoutMs;
    const controller = new AbortController();
    try {
      const reports = validateReports(
        fixtureIds,
        await withTimeout(
          applyAutomationBatch(adapter, fixtureIds, brightness, controller.signal, deadlineAt),
          deadlineAt + COMMAND_COMPLETION_GRACE_MS,
          timeoutMs,
          () => controller.abort()
        )
      );
      const occurredAt = now().toISOString();
      for (const report of reports) {
        const status = report.acknowledged
          ? "succeeded" as const
          : report.outcome === "timed_out"
            ? "timed_out" as const
            : "failed" as const;
        const observed = report.acknowledged || report.faultCode === "state_mismatch";
        results.set(report.fixtureId, {
          fixtureId: report.fixtureId,
          status,
          brightnessPercent: observed ? report.brightness : null,
          faultCode: report.faultCode ?? null,
          errorCode: status === "succeeded" ? null : report.faultCode ?? "mesh_command_failed",
          occurredAt
        });
      }
    } catch (error) {
      const timedOut = error instanceof MeshStatusTimeoutError;
      const occurredAt = now().toISOString();
      for (const fixtureId of fixtureIds) {
        results.set(fixtureId, {
          fixtureId,
          status: timedOut ? "timed_out" : "failed",
          brightnessPercent: null,
          faultCode: null,
          errorCode: timedOut ? "status_timeout" : "mesh_command_failed",
          occurredAt
        });
      }
    }
  }
  return actions.map((action) => results.get(action.fixtureId)!);
}

function applyCommand(
  adapter: BleMeshAdapter,
  command: GatewayDimmingCommandV2,
  signal: AbortSignal,
  deadlineAt: number
) {
  switch (command.deliveryMode) {
    case "unicast":
      return adapter.applyUnicast
        ? adapter.applyUnicast(command.targetFixtureIds[0], command.brightness, signal, deadlineAt).then((report) => [report])
        : adapter.setBrightness(command.targetFixtureIds, command.brightness);
    case "parallel_unicast":
      if (!adapter.applyParallelUnicast) throw new Error("parallel unicast control is unavailable");
      return adapter.applyParallelUnicast(command.targetFixtureIds, command.brightness, 8, signal, deadlineAt);
    case "mesh_group":
      if (!adapter.applyMeshGroup || !command.destinationAddress) throw new Error("mesh group control is unavailable");
      return adapter.applyMeshGroup(
        parseGroupAddress(command.destinationAddress),
        command.targetFixtureIds,
        command.brightness,
        signal,
        deadlineAt
      );
  }
}

function applyAutomationBatch(
  adapter: BleMeshAdapter,
  fixtureIds: string[],
  brightness: number,
  signal: AbortSignal,
  deadlineAt: number
) {
  if (fixtureIds.length === 1 && adapter.applyUnicast) {
    return adapter.applyUnicast(fixtureIds[0], brightness, signal, deadlineAt).then((report) => [report]);
  }
  if (fixtureIds.length > 1 && adapter.applyParallelUnicast) {
    return adapter.applyParallelUnicast(fixtureIds, brightness, 8, signal, deadlineAt);
  }
  return adapter.setBrightness(fixtureIds, brightness);
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

function validateAutomationActions(actions: AutomationDimmingAction[]) {
  if (actions.length === 0 || new Set(actions.map((action) => action.fixtureId)).size !== actions.length) {
    throw new Error("automation actions must contain unique fixtures");
  }
  for (const action of actions) validateBrightness(action.brightnessPercent);
}

function validateBrightness(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error("invalid automation brightness");
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

function withTimeout<T>(
  operation: Promise<T>,
  watchdogAt: number,
  statusTimeoutMs: number,
  onTimeout: () => void = () => undefined
) {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      onTimeout();
      reject(new MeshStatusTimeoutError(`BLE Mesh status timeout after ${statusTimeoutMs}ms`));
    }, Math.max(0, watchdogAt - Date.now()));
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
  // Keep the emergency watchdog below the API's 30-second accepted-command deadline.
  if (!Number.isInteger(value) || value < 1000 || value > MAX_BLE_STATUS_TIMEOUT_MS) {
    throw new Error(`BLE Mesh timeout must be 1000-${MAX_BLE_STATUS_TIMEOUT_MS}ms`);
  }
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
