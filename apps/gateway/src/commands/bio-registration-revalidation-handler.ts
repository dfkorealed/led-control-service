import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { bioRegistrationRevalidationCommandSchema, bioRegistrationRevalidationResultSchema,
  type BioRegistrationRevalidationCommand, type BioRegistrationRevalidationResult, type BioSensorModeCommand } from "@led-control/shared";
import type { BleMeshAdapter } from "../gateway";
import type { CommandJournal } from "./command-journal";
import type { StateEventOutbox } from "../state/state-event-outbox";

export type BioRegistrationRevalidationHandlerOptions = {
  journal: CommandJournal; outbox: StateEventOutbox; nextSequence: () => Promise<number>;
  scope: { siteId: string; gatewayId: string; assignmentVersion: number };
  clockTrusted: () => Promise<boolean>; now?: () => Date; signal?: AbortSignal; onDurableReceipt?: () => void;
};
type Owned = { command: BioRegistrationRevalidationCommand; receipt: Promise<void>; promise: Promise<void> };
const running = new WeakMap<CommandJournal, Map<string, Owned>>();

export async function handleBioRegistrationRevalidation(adapter: Pick<BleMeshAdapter, "sensorModeOperation">,
  input: BioRegistrationRevalidationCommand, options: BioRegistrationRevalidationHandlerOptions): Promise<void> {
  const command = bioRegistrationRevalidationCommandSchema.parse(input);
  if (!inScope(command, options)) throw new Error("registration revalidation command scope mismatch");
  return executeOwned(adapter, command, options);
}

// Live delivery, recovery and capacity retries share ownership, including the
// durable receipt promise, so none can issue a second GET or mint another event.
async function executeOwned(adapter: Pick<BleMeshAdapter, "sensorModeOperation">,
  command: BioRegistrationRevalidationCommand, options: BioRegistrationRevalidationHandlerOptions) {
  let active = running.get(options.journal);
  if (!active) { active = new Map(); running.set(options.journal, active); }
  const previous = active.get(command.commandId);
  if (previous) {
    if (!isDeepStrictEqual(previous.command, command)) throw new Error("registration revalidation command identity conflict");
    await previous.receipt;
    options.onDurableReceipt?.();
    return previous.promise;
  }
  let acknowledge!: () => void, reject!: (error: unknown) => void;
  const receipt = new Promise<void>((resolve, fail) => { acknowledge = resolve; reject = fail; });
  void receipt.catch(() => undefined);
  const promise = execute(adapter, command, { ...options, onDurableReceipt: () => {
    acknowledge(); options.onDurableReceipt?.();
  } }).catch((error: unknown) => { reject(error); throw error; }).finally(() => active.delete(command.commandId));
  active.set(command.commandId, { command, receipt, promise });
  return promise;
}

async function execute(adapter: Pick<BleMeshAdapter, "sensorModeOperation">,
  command: BioRegistrationRevalidationCommand, options: BioRegistrationRevalidationHandlerOptions) {
  const wrapper = { kind: "bio_registration_revalidation", command };
  let previous = await options.journal.get(command.commandId);
  if (!previous && !await options.journal.accept(command.commandId, wrapper)) previous = await options.journal.get(command.commandId);
  if (previous && !isDeepStrictEqual(previous.command, wrapper)) throw new Error("registration revalidation command identity conflict");
  options.onDurableReceipt?.();
  if (previous?.state === "completed") return handoff(bioRegistrationRevalidationResultSchema.parse(previous.result), options);
  const now = options.now ?? (() => new Date());
  const { requestedAt: _requestedAt, expiresAt: _expiresAt, ...identity } = command;
  // Allocate durably before observing: waiting for sequence persistence after
  // the final clock/TTL/abort check would leave a gap in fresh proof validation.
  const sequence = await options.nextSequence();
  let detail = previous
    ? { status: "unknown" as const, errorCode: "GATEWAY_RESTART" as const }
    : await observe(adapter, command, options, now);
  if (detail.status === "observed") {
    if (options.signal?.aborted) detail = { status: "unknown", errorCode: "GATEWAY_SHUTDOWN" };
    else if (now().getTime() < Date.parse(command.requestedAt) || now().getTime() >= Date.parse(command.expiresAt)) {
      detail = { status: "timed_out", errorCode: "COMMAND_EXPIRED" };
    } else if (!inScope(command, options)) detail = { status: "unknown", errorCode: "MODE_GET_UNCONFIRMED" };
  }
  const result = bioRegistrationRevalidationResultSchema.parse({ ...identity, ...detail,
    eventId: randomUUID(), sequence, occurredAt: now().toISOString() });
  await options.journal.complete(command.commandId, result);
  await handoff(result, options);
}

async function observe(adapter: Pick<BleMeshAdapter, "sensorModeOperation">, command: BioRegistrationRevalidationCommand,
  options: BioRegistrationRevalidationHandlerOptions, now: () => Date) {
  const expiresAt = Date.parse(command.expiresAt), requestedAt = Date.parse(command.requestedAt);
  const deadlineAt = Math.min(expiresAt, now().getTime() + 8_000);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const expired = () => now().getTime() < requestedAt || now().getTime() >= expiresAt;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop!: () => void;
  try {
    if (expired()) return { status: "timed_out" as const, errorCode: "COMMAND_EXPIRED" as const };
    if (controller.signal.aborted) return { status: "unknown" as const, errorCode: "GATEWAY_SHUTDOWN" as const };
    const cancelled = new Promise<never>((_, reject) => {
      stop = () => reject(new Error("registration revalidation deadline"));
      controller.signal.addEventListener("abort", stop, { once: true });
      timer = setTimeout(abort, Math.max(0, deadlineAt - now().getTime()));
    });
    const read = async () => {
      if (!await options.clockTrusted()) return { status: "unknown" as const, errorCode: "GATEWAY_CLOCK_UNTRUSTED" as const };
      if (controller.signal.aborted) throw new Error("cancelled before GET");
      if (expired()) return { status: "timed_out" as const, errorCode: "COMMAND_EXPIRED" as const };
      if (!inScope(command, options)) throw new Error("assignment changed");
      if (!adapter.sensorModeOperation) return { status: "unknown" as const, errorCode: "UNSUPPORTED_ADAPTER" as const };
      // Explicitly remove the registration purpose. The low-level DTO is query
      // only and cannot invoke the sensor-mode handler's capability observer.
      const { purpose: _purpose, ...query } = command;
      const mode = await adapter.sensorModeOperation(query satisfies BioSensorModeCommand, { signal: controller.signal, deadlineAt });
      if (!await options.clockTrusted()) return { status: "unknown" as const, errorCode: "GATEWAY_CLOCK_UNTRUSTED" as const };
      if (controller.signal.aborted || now().getTime() >= deadlineAt) throw new Error("cancelled GET");
      if (expired()) return { status: "timed_out" as const, errorCode: "COMMAND_EXPIRED" as const };
      if (!inScope(command, options)) throw new Error("assignment changed");
      if (mode !== "sensor" && mode !== "force-on" && mode !== "force-off") throw new Error("unconfirmed mode GET");
      return { status: "observed" as const, evidence: "mode_get" as const, observedMode: mode };
    };
    return await Promise.race([read(), cancelled]);
  } catch {
    return { status: options.signal?.aborted ? "unknown" as const : controller.signal.aborted || expired() ? "timed_out" as const : "unknown" as const,
      errorCode: options.signal?.aborted ? "GATEWAY_SHUTDOWN" as const : expired() ? "COMMAND_EXPIRED" as const : "MODE_GET_UNCONFIRMED" as const };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (stop) controller.signal.removeEventListener("abort", stop);
    controller.abort();
  }
}

async function handoff(result: BioRegistrationRevalidationResult, options: BioRegistrationRevalidationHandlerOptions) {
  await options.outbox.enqueue(result);
  await options.journal.markBioRegistrationRevalidationHandedOff(result.commandId);
}

export async function recoverBioRegistrationRevalidations(options: BioRegistrationRevalidationHandlerOptions): Promise<void> {
  for (const record of await options.journal.pendingBioRegistrationRevalidations()) {
    const command = bioRegistrationRevalidationCommandSchema.parse((record.command as { command: unknown }).command);
    if (!inScope(command, options)) continue;
    // Accepted-only work lost its owner. A restart produces unknown without RF;
    // terminal work hands off the exact persisted event without extending time.
    await executeOwned({}, command, options);
  }
}

function inScope(command: BioRegistrationRevalidationCommand, options: BioRegistrationRevalidationHandlerOptions) {
  return command.siteId === options.scope.siteId && command.gatewayId === options.scope.gatewayId &&
    command.assignmentVersion === options.scope.assignmentVersion;
}
