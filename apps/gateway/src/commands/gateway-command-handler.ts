import {
  AcceptanceAckV2,
  DeviceStatusAckV2,
  GatewayDimmingCommandV2,
  GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS,
  acceptanceAckV2Schema,
  deviceStatusAckV2Schema
} from "@led-control/shared";
import { randomUUID } from "node:crypto";
import { BleMeshAdapter } from "../gateway";

interface JournalLike {
  get(key: string): Promise<{ state: "accepted" | "completed"; command: unknown; result?: unknown } | null>;
  accept(key: string, command: unknown): Promise<boolean>;
  complete(key: string, result: unknown): Promise<void>;
}

interface GatewayCommandResult {
  acceptance: AcceptanceAckV2;
  deviceStatus: DeviceStatusAckV2;
}

export async function handleGatewayDimmingCommand(
  adapter: BleMeshAdapter,
  journal: JournalLike,
  command: GatewayDimmingCommandV2,
  onAccepted?: (acceptance: AcceptanceAckV2) => Promise<void>,
  options: { timeoutMs?: number } = {}
): Promise<GatewayCommandResult> {
  const existing = await journal.get(command.idempotencyKey);
  if (existing?.state === "completed") return existing.result as GatewayCommandResult;
  if (existing?.state === "accepted") {
    const stored = existing.command as { acceptance?: AcceptanceAckV2 };
    const result = createIndeterminateResult(command, stored.acceptance);
    await journal.complete(command.idempotencyKey, result);
    return result;
  }

  // Broker expiry is primary; this blocks delayed delivery paths before they reach BLE.
  if (Date.now() - Date.parse(command.requestedAt) >= GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS) {
    return rejectExpiredCommand(journal, command);
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

  let deviceStatus: DeviceStatusAckV2;
  try {
    const timeoutMs = validateTimeout(options.timeoutMs ?? 8000);
    const reports = await withTimeout(adapter.setBrightness(command.targetFixtureIds, command.brightness), timeoutMs);
    const results = reports.map((report) => ({
      fixtureId: report.fixtureId,
      status: report.acknowledged ? ("succeeded" as const) : ("failed" as const),
      ...(report.acknowledged ? { brightness: report.brightness } : {}),
      ...(report.faultCode ? { faultCode: report.faultCode } : {}),
      rssi: report.rssi,
      hopCount: report.hopCount
    }));
    const succeeded = results.filter((result) => result.status === "succeeded").length;
    deviceStatus = deviceStatusAckV2Schema.parse({
      ...identity,
      eventId: randomUUID(),
      status: succeeded === results.length ? "succeeded" : succeeded === 0 ? "failed" : "partially_succeeded",
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

  const result = { acceptance, deviceStatus };
  await journal.complete(command.idempotencyKey, result);
  return result;
}

class MeshStatusTimeoutError extends Error {}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new MeshStatusTimeoutError(`BLE Mesh status timeout after ${timeoutMs}ms`)), timeoutMs);
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
  return { acceptance: accepted, deviceStatus };
}

async function rejectExpiredCommand(journal: JournalLike, command: GatewayDimmingCommandV2): Promise<GatewayCommandResult> {
  const identity = {
    commandId: command.commandId,
    dispatchId: command.dispatchId,
    idempotencyKey: command.idempotencyKey,
    sequence: command.sequence,
    siteId: command.siteId,
    gatewayId: command.gatewayId
  };
  const result = {
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
    })
  };
  const reserved = await journal.accept(command.idempotencyKey, { command, acceptance: result.acceptance });
  if (!reserved) {
    const raced = await journal.get(command.idempotencyKey);
    if (raced?.state === "completed") return raced.result as GatewayCommandResult;
    throw new Error("duplicate command has an indeterminate accepted result");
  }
  await journal.complete(command.idempotencyKey, result);
  return result;
}
