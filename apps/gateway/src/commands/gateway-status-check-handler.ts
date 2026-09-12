import { randomUUID } from "node:crypto";
import {
  acceptanceAckV2Schema,
  deviceStatusAckV2Schema,
  deriveDeviceStatusAckStatus,
  isGatewayCommandExpired,
  type AcceptanceAckV2,
  type GatewayStatusCheckCommandV2Compatible
} from "@led-control/shared";
import type { BleMeshAdapter } from "../gateway";
import type { CommandJournal } from "./command-journal";
import type { GatewayCommandOptions, GatewayCommandResult } from "./gateway-command-handler";

export interface GatewayStatusCheckOptions extends Pick<GatewayCommandOptions,
  "timeoutMs" | "receipt" | "monotonicClock" | "isCommandExpired" | "onDurableReceipt"> {
  signal?: AbortSignal;
}

type StatusAdapter = Pick<BleMeshAdapter, "onLightingObservation" | "resyncLightingFixtures">;
type StatusJournal = Pick<CommandJournal, "get" | "accept" | "complete">;
interface ActiveStatusCheck {
  durableReceipt: Promise<void>;
  result: Promise<GatewayCommandResult>;
}
const inFlight = new WeakMap<StatusJournal, Map<string, ActiveStatusCheck>>();

export function handleGatewayStatusCheck(
  adapter: StatusAdapter,
  journal: StatusJournal,
  command: GatewayStatusCheckCommandV2Compatible,
  onAccepted?: (acceptance: AcceptanceAckV2) => Promise<void>,
  options: GatewayStatusCheckOptions = {}
): Promise<GatewayCommandResult> {
  let running = inFlight.get(journal);
  if (!running) {
    running = new Map();
    inFlight.set(journal, running);
  }
  const existing = running.get(command.idempotencyKey);
  // Live duplicate deliveries share the original execution; only a persisted receipt
  // without an in-process owner is recovered as indeterminate after a restart.
  // MQTT.js serial packet intake can put the first acceptance PUBACK behind a
  // duplicate PUBLISH. Its durable callback must not wait for terminal completion.
  if (existing) return Promise.all([
    existing.result,
    existing.durableReceipt.then(() => options.onDurableReceipt?.())
  ]).then(([result]) => result);
  let receiptPersisted!: () => void;
  let receiptFailed!: (error: unknown) => void;
  const durableReceipt = new Promise<void>((resolve, reject) => {
    receiptPersisted = resolve;
    receiptFailed = reject;
  });
  // The receipt may fail before a duplicate exists; the terminal promise remains
  // the original caller's error boundary while duplicates also observe that failure.
  void durableReceipt.catch(() => undefined);
  const handling = executeStatusCheck(adapter, journal, command, onAccepted, {
    ...options,
    onDurableReceipt: () => {
      receiptPersisted();
      options.onDurableReceipt?.();
    }
  }).catch((error: unknown) => {
    receiptFailed(error);
    throw error;
  })
    .finally(() => running.delete(command.idempotencyKey));
  running.set(command.idempotencyKey, { durableReceipt, result: handling });
  return handling;
}

async function executeStatusCheck(
  adapter: StatusAdapter, journal: StatusJournal, command: GatewayStatusCheckCommandV2Compatible,
  onAccepted: ((acceptance: AcceptanceAckV2) => Promise<void>) | undefined, options: GatewayStatusCheckOptions
): Promise<GatewayCommandResult> {
  const existing = await journal.get(command.idempotencyKey);
  if (existing) {
    options.onDurableReceipt?.();
    if (existing.state === "completed") return existing.result as GatewayCommandResult;
    const stored = existing.command as { acceptance: AcceptanceAckV2 };
    const result = terminal(command, stored.acceptance, new Map(), "GATEWAY_RESTART_INDETERMINATE");
    await journal.complete(command.idempotencyKey, result);
    return result;
  }
  const expired = await isExpired(command, options);
  const acceptance = acceptanceAckV2Schema.parse({
    ...identity(command), eventId: randomUUID(), status: expired ? "rejected" : "accepted",
    acceptedAt: new Date().toISOString(), ...(expired ? { errorCode: "COMMAND_EXPIRED" } : {})
  });
  if (!await journal.accept(command.idempotencyKey, { command, acceptance })) {
    return executeStatusCheck(adapter, journal, command, onAccepted, options);
  }
  options.onDurableReceipt?.();
  if (!expired) await onAccepted?.(acceptance);
  const observations = new Map<string, number>();
  const expiredBeforeGet = expired || await isExpired(command, options);
  if (!expiredBeforeGet && !options.signal?.aborted) {
    await observeTargets(adapter, command, observations, options);
  }
  const result = terminal(command, acceptance, observations,
    expiredBeforeGet ? "COMMAND_EXPIRED" : options.signal?.aborted ? "GATEWAY_SHUTDOWN" : "STATUS_TIMEOUT");
  await journal.complete(command.idempotencyKey, result);
  return result;
}

function identity(command: GatewayStatusCheckCommandV2Compatible) {
  const { commandId, dispatchId, idempotencyKey, sequence, siteId, gatewayId } = command;
  return { commandId, dispatchId, idempotencyKey, sequence, siteId, gatewayId };
}

function receiptRemainingMs(options: GatewayStatusCheckOptions) {
  if (!options.receipt) return Infinity;
  return options.receipt.receivedAtMonotonicMs + options.receipt.brokerRemainingTtlMs -
    (options.monotonicClock?.() ?? performance.now());
}

async function isExpired(command: GatewayStatusCheckCommandV2Compatible, options: GatewayStatusCheckOptions) {
  const expired = receiptRemainingMs(options) <= 0 || (options.isCommandExpired
    ? await options.isCommandExpired(command.expiresAt) : isGatewayCommandExpired(command.expiresAt));
  // Clock-trust validation may await storage while the broker delivery TTL elapses.
  return expired || receiptRemainingMs(options) <= 0;
}

function observationRemainingMs(command: GatewayStatusCheckCommandV2Compatible, options: GatewayStatusCheckOptions) {
  return Math.min(receiptRemainingMs(options),
    // With an untrusted wall clock the broker receipt remains the deadline authority.
    options.isCommandExpired ? Infinity : new Date(command.expiresAt).getTime() - Date.now());
}

async function observeTargets(
  adapter: StatusAdapter, command: GatewayStatusCheckCommandV2Compatible,
  observations: Map<string, number>, options: GatewayStatusCheckOptions
) {
  const timeoutMs = Math.min(options.timeoutMs ?? 8000, observationRemainingMs(command, options));
  if (timeoutMs <= 0) return;
  const controller = new AbortController();
  const targets = new Set(command.targetFixtureIds);
  let finish!: () => void;
  const ended = new Promise<void>((resolve) => { finish = resolve; });
  const abort = () => { controller.abort(); finish(); };
  const timer = setTimeout(abort, timeoutMs);
  let detach: (() => void) | undefined;
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal?.aborted) { abort(); return; }
    detach = adapter.onLightingObservation((observation) => {
      if (!controller.signal.aborted && targets.has(observation.fixtureId)) {
        observations.set(observation.fixtureId, observation.powerOn ? observation.brightness : 0);
      }
    });
    if (controller.signal.aborted || observationRemainingMs(command, options) <= 0) return;
    // The adapter sends Generic OnOff/Lightness Get and may finish early when all
    // replies arrive. A rejected/unfinished resync leaves missing targets unknown.
    await Promise.race([
      adapter.resyncLightingFixtures(command.targetFixtureIds, controller.signal).catch(() => undefined), ended
    ]);
  } finally {
    clearTimeout(timer);
    detach?.();
    options.signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}

function terminal(command: GatewayStatusCheckCommandV2Compatible, acceptance: AcceptanceAckV2,
  observations: Map<string, number>, faultCode: string): GatewayCommandResult {
  const results = command.targetFixtureIds.map((fixtureId) => observations.has(fixtureId)
    ? { fixtureId, status: "succeeded" as const, brightness: observations.get(fixtureId)! }
    : { fixtureId, status: "timed_out" as const, faultCode });
  return {
    acceptance,
    deviceStatus: deviceStatusAckV2Schema.parse({
      ...identity(command), eventId: randomUUID(), status: deriveDeviceStatusAckStatus(results),
      occurredAt: new Date().toISOString(), results
    }),
    fixtureStateObserved: observations.size > 0,
    observedFixtureIds: command.targetFixtureIds.filter((id) => observations.has(id))
  };
}
