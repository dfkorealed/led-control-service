import {
  AcceptanceAckV2,
  DeviceStatusAckV2,
  GatewayDimmingCommandV2,
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
  onAccepted?: (acceptance: AcceptanceAckV2) => Promise<void>
): Promise<GatewayCommandResult> {
  const existing = await journal.get(command.idempotencyKey);
  if (existing?.state === "completed") return existing.result as GatewayCommandResult;
  if (existing?.state === "accepted") {
    throw new Error("duplicate command has an indeterminate accepted result");
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
    const reports = await adapter.setBrightness(command.targetFixtureIds, command.brightness);
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
    deviceStatus = deviceStatusAckV2Schema.parse({
      ...identity,
      eventId: randomUUID(),
      status: "failed",
      occurredAt: new Date().toISOString(),
      results: command.targetFixtureIds.map((fixtureId) => ({
        fixtureId,
        status: "failed",
        errorMessage: error instanceof Error ? error.message : "unknown BLE Mesh command error"
      }))
    });
  }

  const result = { acceptance, deviceStatus };
  await journal.complete(command.idempotencyKey, result);
  return result;
}
