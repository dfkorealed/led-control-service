import { randomUUID } from "node:crypto";
import {
  fixturePresenceCheckCommandV1Schema, fixturePresenceCheckCompletedV1Schema, fixturePresenceV2Schema,
  fixtureStateV2Schema, fixtureUnreachableV1Schema, mqttTopicsV2,
  type FixturePresenceCheckCommandV1, type FixturePresenceCheckCompletedV1
} from "@led-control/shared";
import type { BleMeshAdapter, BleMeshFixtureProbeResult } from "../gateway";
import { MonitoringRefreshJournal, type MonitoringRefreshTerminal } from "../state/monitoring-refresh-journal";
import { StateEventOutbox, type GatewayStateEvent } from "../state/state-event-outbox";

type CompletionPublish = (topic: string, event: FixturePresenceCheckCompletedV1) => Promise<void>;

/** Journal → durable fixture outbox → completion publish. MQTT PUBACK never deletes either journal. */
export class MonitoringRefreshEventPublisher {
  private publish?: CompletionPublish;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private controller = new AbortController();
  constructor(private readonly journal: MonitoringRefreshJournal, private readonly outbox: StateEventOutbox,
    private readonly options: { retryMs?: number; publishTimeoutMs?: number; wakeStateOutbox?: () => void; onError?: (error: unknown) => void } = {}) {}

  async connect(publish: CompletionPublish) {
    this.disconnect();
    await this.active;
    this.publish = publish;
    this.controller = new AbortController();
    await this.wake();
  }
  disconnect() {
    this.publish = undefined;
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  async stopAndDrain() { this.disconnect(); await this.active; }
  async acknowledge(value: unknown) {
    const removed = await this.journal.acknowledge(value);
    if (removed && !(await this.journal.pending()).length && this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    return removed;
  }
  async replay(_terminal: MonitoringRefreshTerminal) { await this.wake(); }
  async persistAndPublish(_terminal: MonitoringRefreshTerminal) { await this.wake(); }

  wake(): Promise<void> {
    if (this.active) return this.active;
    const signal = this.controller.signal;
    const publish = this.publish;
    this.active = (async () => {
      try {
        for (const row of await this.journal.pending()) {
          const terminal = row.terminal!;
          if (!row.handedOff) {
            // Persist each successful enqueue before advancing. ACKed events must not be re-enqueued
            // after capacity frees up or a restart, otherwise a one-slot outbox cannot make progress.
            for (const event of terminal.events) {
              if (row.handedOffEventIds.includes(event.eventId)) continue;
              await this.outbox.enqueue(event);
              try {
                await this.journal.markEventHandedOff(row.command.batchId, event.eventId);
              } finally {
                // Even a subsequent enqueue/progress-write failure must let durable events reach
                // the API and release capacity via the existing fixture-scoped application ACK.
                this.options.wakeStateOutbox?.();
              }
            }
            await this.journal.markHandedOff(row.command.batchId);
          }
          if (publish && !signal.aborted) {
            await abortablePublish(publish(mqttTopicsV2.fixturePresenceCheckCompleted(row.command.siteId, row.command.gatewayId), terminal.completed!),
              signal, this.options.publishTimeoutMs ?? 5_000);
          }
        }
      } catch (error) {
        if (!signal.aborted) this.options.onError?.(error);
      } finally {
        this.active = undefined;
        if (publish === this.publish && !signal.aborted && (await this.journal.pending()).length) {
          if (this.timer) clearTimeout(this.timer);
          this.timer = setTimeout(() => { this.timer = undefined; void this.wake(); }, this.options.retryMs ?? 1_000);
        }
      }
    })();
    return this.active;
  }
}

export async function handleFixturePresenceCheck(
  adapter: Pick<BleMeshAdapter, "probeFixturePresence">,
  journal: MonitoringRefreshJournal,
  value: FixturePresenceCheckCommandV1,
  publisher: Pick<MonitoringRefreshEventPublisher, "replay" | "persistAndPublish">,
  options: { retryDelayMs?: number; now?: () => Date; signal?: AbortSignal;
    nextSequence: () => Promise<number>; onDurableReceipt?: () => void }
): Promise<void> {
  const command = fixturePresenceCheckCommandV1Schema.parse(value);
  const now = options.now ?? (() => new Date());
  const accepted = await journal.accept(command);
  options.onDurableReceipt?.();
  if (accepted.terminal) return publisher.replay(accepted.terminal);
  if (accepted.kind === "running") return;
  if (accepted.kind === "recovered") {
    await journal.complete(command, { events: [], failure: "interrupted" });
    return;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const remaining = Date.parse(command.expiresAt) - now().getTime();
  const timeout = setTimeout(abort, Math.max(0, Math.min(remaining, 2_147_483_647)));
  let results: BleMeshFixtureProbeResult[];
  try {
    ensureActive();
    if (!adapter.probeFixturePresence) throw new Error("transport_unavailable");
    const first = await abortableProbe(adapter.probeFixturePresence(command.targetFixtureIds, controller.signal), controller.signal);
    ensureActive();
    validateResults(first, command.targetFixtureIds);
    const retryIds = first.filter((row) => row.outcome !== "online").map((row) => row.fixtureId);
    let second: BleMeshFixtureProbeResult[] = [];
    if (retryIds.length) {
      await abortableDelay(options.retryDelayMs ?? 250, controller.signal);
      ensureActive();
      second = await abortableProbe(adapter.probeFixturePresence(retryIds, controller.signal), controller.signal);
      ensureActive();
      validateResults(second, retryIds);
    }
    // Only failures present in both verified, complete passes can become unreachable.
    results = first.map((row) => row.outcome === "online" ? row : second.find((retry) => retry.fixtureId === row.fixtureId)!);
  } catch (error) {
    const failure = Date.parse(command.expiresAt) <= now().getTime() ? "expired" as const
      : options.signal?.aborted ? "interrupted" as const
      : error instanceof Error && error.message === "invalid_probe_results" ? "invalid_probe_results" as const : "transport_unavailable" as const;
    await journal.complete(command, { events: [], failure });
    return;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
  const identity = { siteId: command.siteId, gatewayId: command.gatewayId, refreshId: command.refreshId, batchId: command.batchId };
  const events: GatewayStateEvent[] = [];
  for (const result of results) {
    const envelope = { ...identity, eventId: randomUUID(), sequence: await options.nextSequence(), occurredAt: now().toISOString() };
    if (result.outcome !== "online") {
      events.push(fixtureUnreachableV1Schema.parse({ ...envelope, fixtureId: result.fixtureId, reason: result.outcome }));
    } else if (result.presence) {
      const { observedAt, ...presence } = result.presence;
      events.push(fixturePresenceV2Schema.parse({ ...envelope, ...presence, occurredAt: observedAt }));
    } else {
      const { observedAt, ...observation } = result.lightingObservation!;
      events.push(fixtureStateV2Schema.parse({ ...envelope, ...observation, occurredAt: observedAt, status: "online", rssi: null, hopCount: null }));
    }
  }
  const completed = fixturePresenceCheckCompletedV1Schema.parse({ ...identity, eventId: randomUUID(),
    sequence: await options.nextSequence(), occurredAt: now().toISOString(), targetFixtureIds: command.targetFixtureIds });
  // Sequence persistence can yield long enough to cross a deadline or shutdown boundary.
  // In that case even two earlier read failures no longer authorize a terminal unreachable event.
  if (options.signal?.aborted || Date.parse(command.expiresAt) <= now().getTime()) {
    await journal.complete(command, { events: [], failure: options.signal?.aborted ? "interrupted" : "expired" });
    return;
  }
  await publisher.persistAndPublish(await journal.complete(command, { events, completed }));

  function ensureActive() {
    controller.signal.throwIfAborted();
    if (Date.parse(command.expiresAt) <= now().getTime()) throw new Error("expired");
  }
}

function validateResults(results: BleMeshFixtureProbeResult[], fixtureIds: string[]) {
  if (!Array.isArray(results) || results.length !== fixtureIds.length || new Set(results.map((row) => row.fixtureId)).size !== fixtureIds.length ||
    results.some((row) => !fixtureIds.includes(row.fixtureId) || !["online", "not_found", "read_timeout", "read_failed"].includes(row.outcome) ||
      (row.outcome === "online" && ((!row.presence && !row.lightingObservation) ||
        (row.presence && row.presence.fixtureId !== row.fixtureId) || (row.lightingObservation && row.lightingObservation.fixtureId !== row.fixtureId))))) {
    throw new Error("invalid_probe_results");
  }
}

function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const abort = () => { finish(); reject(new Error("interrupted")); };
    const timer = setTimeout(() => { finish(); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function abortableProbe(promise: Promise<BleMeshFixtureProbeResult[]>, signal: AbortSignal) {
  return new Promise<BleMeshFixtureProbeResult[]>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("interrupted")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    // Do not cancel a shared transport queue. The adapter receives only this operation's signal;
    // any late result is consumed here and cannot become a fixture-offline event after shutdown.
    void promise.then((value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

function abortablePublish(promise: Promise<void>, signal: AbortSignal, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => { clearTimeout(timer); signal.removeEventListener("abort", abort); error ? reject(error) : resolve(); };
    const abort = () => finish(new Error("monitoring refresh publisher disconnected"));
    const timer = setTimeout(() => finish(new Error("monitoring refresh publish timeout")), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void promise.then(() => finish(), finish);
  });
}
