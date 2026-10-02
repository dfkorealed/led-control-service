import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { bioSensorModeCommandSchema, bioSensorModeResultSchema, type BioSensorModeCommand, type BioSensorModeResult } from "@led-control/shared";
import type { BleMeshAdapter } from "../gateway";
import { CommandJournal } from "./command-journal";
import { StateEventOutbox } from "../state/state-event-outbox";

type Options = { journal: CommandJournal; outbox: StateEventOutbox; nextSequence: () => Promise<number>;
  scope: { siteId: string; gatewayId: string; assignmentVersion: number }; clockTrusted?: () => Promise<boolean>;
  now?: () => Date; timeoutMs?: number; signal?: AbortSignal; onDurableReceipt?: () => void;
  onIdentityProof?: (command: BioSensorModeCommand) => Promise<void> };
const running = new WeakMap<CommandJournal, Map<string, { command: BioSensorModeCommand; receipt: Promise<void>; promise: Promise<void> }>>();

export async function handleBioSensorMode(adapter: Pick<BleMeshAdapter, "sensorModeOperation">, input: BioSensorModeCommand, options: Options) {
  const command = bioSensorModeCommandSchema.parse(input);
  if (command.siteId !== options.scope.siteId || command.gatewayId !== options.scope.gatewayId ||
      command.assignmentVersion !== options.scope.assignmentVersion) throw new Error("sensor mode command scope mismatch");
  return executeOwned(adapter, command, options);
}

// Live delivery and reconnect/application-ACK recovery must acquire the same
// ownership before reading the journal. Otherwise both can mint terminal IDs
// from one accepted record, leaving a conflicting result stuck in the outbox.
async function executeOwned(adapter: Pick<BleMeshAdapter, "sensorModeOperation">, command: BioSensorModeCommand, options: Options) {
  let active = running.get(options.journal);
  if (!active) { active = new Map(); running.set(options.journal, active); }
  const previous = active.get(command.commandId);
  if (previous) {
    if (!isDeepStrictEqual(previous.command, command)) throw new Error("sensor mode command identity conflict");
    // Receipt must not await a terminal/PUBACK that is queued behind this delivery.
    await previous.receipt;
    options.onDurableReceipt?.();
    return previous.promise;
  }
  let acknowledge!: () => void; let reject!: (error: unknown) => void;
  const receipt = new Promise<void>((resolve, fail) => { acknowledge = resolve; reject = fail; });
  void receipt.catch(() => undefined);
  const promise = execute(adapter, command, { ...options, onDurableReceipt: () => {
    acknowledge(); options.onDurableReceipt?.();
  } }).catch((error: unknown) => { reject(error); throw error; }).finally(() => active.delete(command.commandId));
  active.set(command.commandId, { command, receipt, promise });
  return promise;
}

async function execute(adapter: Pick<BleMeshAdapter, "sensorModeOperation">, command: BioSensorModeCommand, options: Options) {
  const { journal } = options;
  const wrapper = { kind: "bio_sensor_mode", command };
  let previous = await journal.get(command.commandId);
  if (previous && !isDeepStrictEqual(previous.command, wrapper)) throw new Error("sensor mode command identity conflict");
  if (!previous && !await journal.accept(command.commandId, wrapper)) previous = await journal.get(command.commandId);
  options.onDurableReceipt?.();
  if (previous?.state === "completed") return handoff(bioSensorModeResultSchema.parse(previous.result), options);
  const now = options.now ?? (() => new Date());
  const identity = resultIdentity(command);
  let detail: Record<string, unknown> = { status: "unknown", modeVerified: false, errorCode: "MODE_GET_UNCONFIRMED" };
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const remaining = Date.parse(command.expiresAt) - now().getTime();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (previous) detail.errorCode = "GATEWAY_RESTART";
    else if (remaining <= 0 || Date.parse(command.requestedAt) > now().getTime()) detail = { status: "timed_out", modeVerified: false, errorCode: "COMMAND_EXPIRED" };
    else if (options.clockTrusted && !await options.clockTrusted()) detail.errorCode = "GATEWAY_CLOCK_UNTRUSTED";
    else if (controller.signal.aborted) detail.errorCode = "GATEWAY_SHUTDOWN";
    else if (!adapter.sensorModeOperation) detail.errorCode = "UNSUPPORTED_ADAPTER";
    else {
      // Reporting is not RF authority. A slow/failing metadata observer must never
      // delay the owned mode transaction or turn its verified result into failure.
      try { void options.onIdentityProof?.(structuredClone(command)).catch(() => undefined); } catch { /* Observer only. */ }
      const wait = new Promise<never>((_, reject) => {
        const stop = () => reject(new Error("sensor mode deadline"));
        controller.signal.addEventListener("abort", stop, { once: true });
        timer = setTimeout(abort, Math.min(remaining, options.timeoutMs ?? 8_000));
      });
      const mode = await Promise.race([adapter.sensorModeOperation(command, { signal: controller.signal, deadlineAt: Date.parse(command.expiresAt) }), wait]);
      if (controller.signal.aborted || now().getTime() >= Date.parse(command.expiresAt)) throw new Error("expired GET");
      detail = { status: mode === "sensor" ? "verified" : "mismatch", modeVerified: mode === "sensor", observedMode: mode, evidence: "mode_get" };
    }
  } catch {
    detail = { status: controller.signal.aborted ? "timed_out" : "unknown", modeVerified: false,
      errorCode: options.signal?.aborted ? "GATEWAY_SHUTDOWN" : "MODE_GET_UNCONFIRMED" };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    controller.abort();
  }
  const result = bioSensorModeResultSchema.parse({ ...identity, ...detail, eventId: randomUUID(), sequence: await options.nextSequence(), occurredAt: now().toISOString() });
  await journal.complete(command.commandId, result);
  await handoff(result, options);
}

async function handoff(result: BioSensorModeResult, options: Options) {
  await options.outbox.enqueue(result);
  await options.journal.markSensorModeHandedOff(result.commandId);
}

export async function recoverBioSensorModes(options: Options) {
  for (const record of await options.journal.pendingSensorModeOperations()) {
    const command = bioSensorModeCommandSchema.parse((record.command as { command: unknown }).command);
    if (command.siteId !== options.scope.siteId || command.gatewayId !== options.scope.gatewayId) continue;
    // Restart recovery publishes unknown; only a new query command can make a fresh GET.
    // execute rereads durable terminal state inside the shared ownership boundary.
    await executeOwned({}, command, options);
  }
}

function resultIdentity(command: BioSensorModeCommand) {
  const { requestedAt: _requestedAt, expiresAt: _expiresAt, ...identity } = command;
  return identity;
}
