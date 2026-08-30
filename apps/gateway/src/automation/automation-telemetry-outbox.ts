import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  automationExecutionEventV1Schema,
  mqttTopics,
  type AutomationExecutionEventV1,
  type AutomationExecutionKind
} from "@led-control/shared";
import {
  AtomicJsonCommitUncertainError,
  readJsonFile,
  writeJsonAtomic
} from "../mesh/mesh-store-file";
import { SerialTaskQueue } from "../runtime/serial-task-queue";
import type { AutomationScope } from "./automation-config-store";
import type {
  AutomationLifecycleEvent,
  AutomationLifecycleHandoff,
  AutomationTerminalHandoff,
  DesiredLightingAction
} from "./schedule-runtime";

export const AUTOMATION_TELEMETRY_MAX_BYTES = 64 * 1024 * 1024;
const GAP_SLOT_BYTES = 1_536;
const DEFAULT_RETRY_INITIAL_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
const DEFAULT_PUBLISH_TIMEOUT_MS = 10_000;

export interface AutomationTelemetryInput {
  revision: number;
  ruleId: string | null;
  occurrenceKey: string | null;
  kind: AutomationExecutionKind;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface StoredAutomationTelemetryRecord {
  event: AutomationExecutionEventV1;
  reportPayloadHash: `sha256:${string}`;
  publishAttempted: boolean;
}

interface PendingTelemetryGap {
  eventId: string;
  sequence: number;
  revision: number;
  firstDroppedAt: string;
  lastDroppedAt: string;
  droppedCount: number;
}

interface StoredAutomationTelemetryOutbox {
  version: 1;
  scope: AutomationScope;
  nextSequence: number;
  records: StoredAutomationTelemetryRecord[];
  gap: PendingTelemetryGap | null;
}

type AtomicJsonWriter = (path: string, value: unknown) => Promise<void>;

export class AutomationTelemetryStoreError extends Error {
  readonly code = "automation_telemetry_store_failed";

  constructor(options?: ErrorOptions) {
    super("automation_telemetry_store_failed", options);
    this.name = "AutomationTelemetryStoreError";
  }
}

export class AutomationTelemetryCommitUncertainError extends Error {
  readonly code = "automation_telemetry_commit_uncertain";

  constructor(options?: ErrorOptions) {
    super("automation_telemetry_commit_uncertain", options);
    this.name = "AutomationTelemetryCommitUncertainError";
  }
}

export class AutomationTelemetryOutbox {
  private readonly queue = new SerialTaskQueue();
  private readonly maxBytes: number;
  private readonly write: AtomicJsonWriter;
  private readonly createEventId: () => string;
  private state: StoredAutomationTelemetryOutbox | undefined;
  private available = true;

  constructor(
    private readonly path: string,
    private readonly scope: AutomationScope,
    options: {
      maxBytes?: number;
      write?: AtomicJsonWriter;
      createEventId?: () => string;
    } = {}
  ) {
    this.maxBytes = options.maxBytes ?? AUTOMATION_TELEMETRY_MAX_BYTES;
    this.write = options.write ?? writeJsonAtomic;
    this.createEventId = options.createEventId ?? randomUUID;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 2 * GAP_SLOT_BYTES) {
      throw new Error("automation telemetry outbox byte limit is too small");
    }
  }

  initialize() {
    return this.queue.run(async () => { await this.load(); });
  }

  append(input: AutomationTelemetryInput) {
    return this.queue.run(async () => {
      const current = await this.load();
      const next = structuredClone(current);
      const sequence = next.nextSequence + 1;
      if (!Number.isSafeInteger(sequence)) throw new Error("automation telemetry sequence exceeded safe integer range");
      next.nextSequence = sequence;
      const event = automationExecutionEventV1Schema.parse({
        schemaVersion: 1,
        eventId: this.createEventId(),
        sequence,
        gatewayId: this.scope.gatewayId,
        ...input
      }) as AutomationExecutionEventV1;
      const record = storedRecord(event);

      if (event.kind === "event_extended") {
        const coalescedIndex = next.records.findIndex((candidate) =>
          !candidate.publishAttempted && candidate.event.kind === "event_extended" &&
          candidate.event.ruleId === event.ruleId && candidate.event.occurrenceKey === event.occurrenceKey
        );
        if (coalescedIndex >= 0) next.records.splice(coalescedIndex, 1);
      }

      next.records.push(record);
      if (!this.fitsNormalBudget(next)) {
        next.records.pop();
        mergeGap(next, event);
      }
      await this.commit(current, next);
      return cloneRecord(record);
    });
  }

  recordGap(input: {
    revision: number;
    firstDroppedAt: string;
    lastDroppedAt: string;
    droppedCount: number;
  }) {
    return this.queue.run(async () => {
      validateGapInput(input);
      const current = await this.load();
      const next = structuredClone(current);
      if (!next.gap) {
        const sequence = next.nextSequence + 1;
        if (!Number.isSafeInteger(sequence)) throw new Error("automation telemetry sequence exceeded safe integer range");
        next.nextSequence = sequence;
        next.gap = {
          eventId: this.createEventId(),
          sequence,
          revision: input.revision,
          firstDroppedAt: input.firstDroppedAt,
          lastDroppedAt: input.lastDroppedAt,
          droppedCount: input.droppedCount
        };
      } else {
        next.gap.firstDroppedAt = earlierTimestamp(next.gap.firstDroppedAt, input.firstDroppedAt);
        next.gap.lastDroppedAt = laterTimestamp(next.gap.lastDroppedAt, input.lastDroppedAt);
        next.gap.droppedCount = Math.min(
          Number.MAX_SAFE_INTEGER,
          next.gap.droppedCount + input.droppedCount
        );
      }
      this.assertStrictCapacity(next);
      await this.commit(current, next);
      return structuredClone(next.gap);
    });
  }

  pending() {
    return this.queue.run(async () => {
      let current = await this.load();
      if (current.gap && !current.records.some((record) => record.event.kind === "telemetry_gap")) {
        const next = structuredClone(current);
        const gap = next.gap!;
        next.records.push(storedRecord(automationExecutionEventV1Schema.parse({
          schemaVersion: 1,
          eventId: gap.eventId,
          sequence: gap.sequence,
          gatewayId: this.scope.gatewayId,
          revision: gap.revision,
          ruleId: null,
          occurrenceKey: null,
          kind: "telemetry_gap",
          occurredAt: gap.firstDroppedAt,
          payload: {
            firstDroppedAt: gap.firstDroppedAt,
            lastDroppedAt: gap.lastDroppedAt,
            droppedCount: gap.droppedCount
          }
        }) as AutomationExecutionEventV1));
        next.gap = null;
        this.assertStrictCapacity(next);
        await this.commit(current, next);
        current = next;
      }
      return current.records.map(cloneRecord);
    });
  }

  inspect() {
    return this.queue.run(async () => structuredClone(await this.load()));
  }

  markPublishAttempt(record: Pick<StoredAutomationTelemetryRecord, "event" | "reportPayloadHash">) {
    return this.queue.run(async () => {
      const current = await this.load();
      const index = current.records.findIndex((candidate) => sameStoredIdentity(candidate, record));
      if (index < 0 || current.records[index]!.publishAttempted) return index >= 0;
      const next = structuredClone(current);
      next.records[index]!.publishAttempted = true;
      await this.commit(current, next);
      return true;
    });
  }

  markIngested(acknowledgement: {
    eventId: string;
    sequence: number;
    reportPayloadHash: string;
  }): Promise<"deleted" | "not_found" | "conflict"> {
    return this.queue.run(async () => {
      const current = await this.load();
      const index = current.records.findIndex((record) =>
        record.event.eventId === acknowledgement.eventId && record.event.sequence === acknowledgement.sequence
      );
      if (index < 0) return "not_found";
      if (current.records[index]!.reportPayloadHash !== acknowledgement.reportPayloadHash) return "conflict";
      const next = structuredClone(current);
      next.records.splice(index, 1);
      await this.commit(current, next);
      return "deleted";
    });
  }

  drain() {
    return this.queue.run(async () => undefined);
  }

  private async load() {
    if (!this.available) throw new AutomationTelemetryCommitUncertainError();
    if (this.state) return this.state;
    let raw: unknown | null;
    try {
      raw = await readJsonFile(this.path);
    } catch (error) {
      throw new AutomationTelemetryStoreError({ cause: error });
    }
    if (raw === null) {
      const initial: StoredAutomationTelemetryOutbox = {
        version: 1,
        scope: { ...this.scope },
        nextSequence: 0,
        records: [],
        gap: null
      };
      if (!this.fitsNormalBudget(initial)) throw new Error("automation telemetry outbox byte limit is too small");
      try {
        await this.write(this.path, initial);
      } catch (error) {
        if (error instanceof AtomicJsonCommitUncertainError) {
          this.available = false;
          throw new AutomationTelemetryCommitUncertainError({ cause: error });
        }
        throw new AutomationTelemetryStoreError({ cause: error });
      }
      this.state = initial;
      return initial;
    }
    const parsed = parseStoredOutbox(raw, this.scope, this.maxBytes);
    this.state = parsed;
    return parsed;
  }

  private fitsNormalBudget(state: StoredAutomationTelemetryOutbox) {
    return storedBytes(state) <= this.maxBytes - (2 * GAP_SLOT_BYTES);
  }

  private assertStrictCapacity(state: StoredAutomationTelemetryOutbox) {
    if (storedBytes(state) > this.maxBytes) throw new Error("automation telemetry outbox capacity invariant failed");
  }

  private async commit(previous: StoredAutomationTelemetryOutbox, next: StoredAutomationTelemetryOutbox) {
    this.assertStrictCapacity(next);
    try {
      await this.write(this.path, next);
      this.state = next;
    } catch (error) {
      if (!(error instanceof AtomicJsonCommitUncertainError)) {
        throw new AutomationTelemetryStoreError({ cause: error });
      }
      await this.recoverPrevious(previous, error);
      throw new AutomationTelemetryCommitUncertainError({ cause: error });
    }
  }

  private async recoverPrevious(previous: StoredAutomationTelemetryOutbox, commitError: unknown) {
    const errors = [commitError];
    try {
      await this.write(this.path, previous);
    } catch (error) {
      errors.push(error);
    }
    try {
      const visible = await readJsonFile(this.path);
      if (isDeepStrictEqual(visible, previous)) {
        this.state = previous;
        this.available = true;
        return;
      }
    } catch (error) {
      errors.push(error);
    }
    this.state = undefined;
    this.available = false;
    throw new AutomationTelemetryCommitUncertainError({
      cause: new AggregateError(errors, "automation telemetry visibility recovery failed")
    });
  }
}

export class AutomationTelemetryRecorder {
  constructor(private readonly outbox: AutomationTelemetryOutbox) {}

  async recordLifecycle(handoff: AutomationLifecycleHandoff) {
    const records: StoredAutomationTelemetryRecord[] = [];
    for (const event of handoff.events) {
      records.push(await this.outbox.append({
        revision: event.revision ?? handoff.revision,
        ruleId: event.ruleId,
        occurrenceKey: event.occurrenceKey,
        kind: event.kind,
        occurredAt: event.occurredAt,
        payload: event.payload
      }));
    }
    return records;
  }

  async recordTerminal(handoff: AutomationTerminalHandoff) {
    const groups = new Map<string, {
      sourceType: "schedule" | "vehicle_event_rule" | "manual_override";
      sourceId: string;
      occurrenceKey: string | null;
      revision: number;
      results: AutomationTerminalHandoff["results"];
    }>();
    for (const [index, action] of handoff.actions.entries()) {
      const result = handoff.results[index];
      if (!result || result.fixtureId !== action.fixtureId) {
        throw new Error("automation terminal handoff result order mismatch");
      }
      const source = terminalSource(action, handoff.causes ?? [], handoff.revision);
      if (!source) continue;
      const key = `${source.sourceType}:${source.sourceId}:${source.occurrenceKey ?? ""}`;
      const group = groups.get(key) ?? { ...source, results: [] };
      group.results.push(result);
      groups.set(key, group);
    }

    const records: StoredAutomationTelemetryRecord[] = [];
    for (const group of groups.values()) {
      const occurredAt = group.results
        .map((result) => result.occurredAt)
        .sort()
        .at(-1)!;
      records.push(await this.outbox.append({
        revision: group.revision,
        ruleId: group.sourceType === "manual_override" ? null : group.sourceId,
        occurrenceKey: group.occurrenceKey,
        kind: "action_result",
        occurredAt,
        payload: {
          sourceType: group.sourceType,
          sourceId: group.sourceId,
          results: [...group.results].sort((left, right) => left.fixtureId.localeCompare(right.fixtureId))
        }
      }));
    }
    return records;
  }
}

export interface AutomationTelemetryMqttClient {
  publish(
    topic: string,
    payload: string,
    options: { qos: 1 },
    callback: (error?: Error) => void
  ): unknown;
}

export class AutomationTelemetryPublisher {
  private client: AutomationTelemetryMqttClient | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly drains = new Map<number, Promise<void>>();
  private generation = 0;
  private stopping = false;
  private retryDelayMs: number;
  private readonly retryInitialDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly publishTimeoutMs: number;
  private readonly onError: (error: unknown) => void;

  constructor(
    private readonly outbox: AutomationTelemetryOutbox,
    private readonly scope: AutomationScope,
    options: {
      retryInitialDelayMs?: number;
      retryMaxDelayMs?: number;
      publishTimeoutMs?: number;
      onError?: (error: unknown) => void;
    } = {}
  ) {
    this.retryInitialDelayMs = options.retryInitialDelayMs ?? DEFAULT_RETRY_INITIAL_DELAY_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.publishTimeoutMs = options.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
    this.onError = options.onError ?? (() => undefined);
    this.retryDelayMs = this.retryInitialDelayMs;
  }

  connect(client: AutomationTelemetryMqttClient) {
    if (this.stopping) return Promise.reject(new Error("automation telemetry publisher is stopping"));
    this.generation += 1;
    this.client = client;
    this.retryDelayMs = this.retryInitialDelayMs;
    this.clearTimer();
    return this.drain(this.generation, true);
  }

  disconnect() {
    this.generation += 1;
    this.client = undefined;
    this.clearTimer();
  }

  wake() {
    if (!this.client || this.stopping) return Promise.resolve();
    this.clearTimer();
    return this.drain(this.generation, true);
  }

  async stopAndDrain() {
    if (this.stopping) {
      await Promise.allSettled([...this.drains.values()]);
      return this.outbox.drain();
    }
    this.stopping = true;
    this.clearTimer();
    const generation = this.generation;
    if (this.client) await this.drain(generation, false).catch((error) => this.onError(error));
    await Promise.allSettled([...this.drains.values()]);
    await this.outbox.drain();
    this.disconnect();
  }

  private drain(generation: number, retry: boolean) {
    const existing = this.drains.get(generation);
    if (existing) return existing;
    const operation = this.drainOnce(generation, retry).finally(() => {
      if (this.drains.get(generation) === operation) this.drains.delete(generation);
    });
    this.drains.set(generation, operation);
    return operation;
  }

  private async drainOnce(generation: number, retry: boolean) {
    const client = this.client;
    if (!client || generation !== this.generation) return;
    try {
      const records = await this.outbox.pending();
      for (const record of records) {
        if (client !== this.client || generation !== this.generation) return;
        if (!await this.outbox.markPublishAttempt(record)) continue;
        await withTimeout(publishQos1(client, mqttTopics.automationExecution(
          this.scope.siteId,
          this.scope.gatewayId
        ), record.event), this.publishTimeoutMs);
      }
      if (retry && records.length > 0 && client === this.client && generation === this.generation) {
        this.scheduleRetry(generation);
      }
    } catch (error) {
      if (retry && client === this.client && generation === this.generation) this.scheduleRetry(generation);
      throw error;
    }
  }

  private scheduleRetry(generation: number) {
    this.clearTimer();
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.retryMaxDelayMs);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain(generation, true).catch((error) => this.onError(error));
    }, delay);
    this.timer.unref?.();
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function mergeGap(state: StoredAutomationTelemetryOutbox, event: AutomationExecutionEventV1) {
  if (!state.gap) {
    state.gap = {
      eventId: event.eventId,
      sequence: event.sequence,
      revision: event.revision,
      firstDroppedAt: event.occurredAt,
      lastDroppedAt: event.occurredAt,
      droppedCount: 1
    };
    return;
  }
  state.gap.firstDroppedAt = earlierTimestamp(state.gap.firstDroppedAt, event.occurredAt);
  state.gap.lastDroppedAt = laterTimestamp(state.gap.lastDroppedAt, event.occurredAt);
  state.gap.droppedCount = Math.min(Number.MAX_SAFE_INTEGER, state.gap.droppedCount + 1);
}

function terminalSource(
  action: DesiredLightingAction,
  causes: AutomationLifecycleEvent[],
  defaultRevision: number
): {
  sourceType: "schedule" | "vehicle_event_rule" | "manual_override";
  sourceId: string;
  occurrenceKey: string | null;
  revision: number;
} | null {
  if ((action.sourceType === "schedule" || action.sourceType === "vehicle_event_rule" ||
    action.sourceType === "manual_override") && action.sourceId) {
    return {
      sourceType: action.sourceType,
      sourceId: action.sourceId,
      occurrenceKey: action.occurrenceKey,
      revision: defaultRevision
    };
  }
  const cause = [...causes].reverse().find((candidate) =>
    (candidate.kind === "schedule_ended" || candidate.kind === "event_ended") &&
    payloadTargets(candidate.payload).includes(action.fixtureId)
  );
  if (!cause) return null;
  return {
    sourceType: cause.kind === "schedule_ended" ? "schedule" : "vehicle_event_rule",
    sourceId: cause.ruleId,
    occurrenceKey: cause.occurrenceKey,
    revision: cause.revision ?? defaultRevision
  };
}

function payloadTargets(payload: Record<string, unknown>) {
  return Array.isArray(payload.targetFixtureIds)
    ? payload.targetFixtureIds.filter((value): value is string => typeof value === "string")
    : [];
}

function validateGapInput(input: {
  revision: number;
  firstDroppedAt: string;
  lastDroppedAt: string;
  droppedCount: number;
}) {
  if (!Number.isSafeInteger(input.revision) || input.revision < 0 ||
    Number.isNaN(Date.parse(input.firstDroppedAt)) || Number.isNaN(Date.parse(input.lastDroppedAt)) ||
    Date.parse(input.firstDroppedAt) > Date.parse(input.lastDroppedAt) ||
    !Number.isSafeInteger(input.droppedCount) || input.droppedCount <= 0) {
    throw new Error("invalid automation telemetry gap");
  }
}

function earlierTimestamp(left: string, right: string) {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function laterTimestamp(left: string, right: string) {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function storedRecord(event: AutomationExecutionEventV1): StoredAutomationTelemetryRecord {
  return {
    event: structuredClone(event),
    reportPayloadHash: canonicalExecutionPayloadHash(event),
    publishAttempted: false
  };
}

function canonicalExecutionPayloadHash(event: AutomationExecutionEventV1) {
  const value = event.kind === "action_result" && Array.isArray(event.payload.results)
    ? {
      ...event,
      payload: {
        ...event.payload,
        results: [...event.payload.results].sort((left, right) => {
          const leftId = isRecord(left) && typeof left.fixtureId === "string" ? left.fixtureId : "";
          const rightId = isRecord(right) && typeof right.fixtureId === "string" ? right.fixtureId : "";
          return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
        })
      }
    }
    : event;
  return `sha256:${createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex")}` as const;
}

function parseStoredOutbox(value: unknown, scope: AutomationScope, maxBytes: number): StoredAutomationTelemetryOutbox {
  if (!hasExactKeys(value, ["version", "scope", "nextSequence", "records", "gap"]) || value.version !== 1 ||
    !sameScope(value.scope, scope) || !Number.isSafeInteger(value.nextSequence) || (value.nextSequence as number) < 0 ||
    !Array.isArray(value.records)) {
    throw new AutomationTelemetryStoreError();
  }
  const records = value.records.map((candidate) => parseStoredRecord(candidate, scope));
  const gap = parsePendingGap(value.gap);
  const parsed: StoredAutomationTelemetryOutbox = {
    version: 1,
    scope: { ...scope },
    nextSequence: value.nextSequence as number,
    records,
    gap
  };
  const maxSequence = Math.max(0, ...records.map((record) => record.event.sequence), gap?.sequence ?? 0);
  if (parsed.nextSequence < maxSequence || records.filter((record) => record.event.kind === "telemetry_gap").length > 1 ||
    storedBytes(parsed) > maxBytes) {
    throw new AutomationTelemetryStoreError();
  }
  return parsed;
}

function parseStoredRecord(value: unknown, scope: AutomationScope): StoredAutomationTelemetryRecord {
  if (!hasExactKeys(value, ["event", "reportPayloadHash", "publishAttempted"]) ||
    typeof value.publishAttempted !== "boolean") throw new AutomationTelemetryStoreError();
  const event = automationExecutionEventV1Schema.parse(value.event) as AutomationExecutionEventV1;
  if (event.gatewayId !== scope.gatewayId || value.reportPayloadHash !== canonicalExecutionPayloadHash(event)) {
    throw new AutomationTelemetryStoreError();
  }
  return {
    event,
    reportPayloadHash: value.reportPayloadHash as `sha256:${string}`,
    publishAttempted: value.publishAttempted
  };
}

function parsePendingGap(value: unknown): PendingTelemetryGap | null {
  if (value === null) return null;
  if (!hasExactKeys(value, [
    "eventId", "sequence", "revision", "firstDroppedAt", "lastDroppedAt", "droppedCount"
  ]) || typeof value.eventId !== "string" || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0 ||
    !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
    typeof value.firstDroppedAt !== "string" || typeof value.lastDroppedAt !== "string" ||
    Number.isNaN(Date.parse(value.firstDroppedAt)) || Number.isNaN(Date.parse(value.lastDroppedAt)) ||
    Date.parse(value.firstDroppedAt) > Date.parse(value.lastDroppedAt) ||
    !Number.isSafeInteger(value.droppedCount) || (value.droppedCount as number) <= 0) {
    throw new AutomationTelemetryStoreError();
  }
  return value as unknown as PendingTelemetryGap;
}

function cloneRecord(record: StoredAutomationTelemetryRecord) {
  return structuredClone(record);
}

function sameStoredIdentity(
  left: StoredAutomationTelemetryRecord,
  right: Pick<StoredAutomationTelemetryRecord, "event" | "reportPayloadHash">
) {
  return left.event.eventId === right.event.eventId && left.event.sequence === right.event.sequence &&
    left.reportPayloadHash === right.reportPayloadHash;
}

function publishQos1(client: AutomationTelemetryMqttClient, topic: string, event: AutomationExecutionEventV1) {
  return new Promise<void>((resolve, reject) => {
    client.publish(topic, JSON.stringify(event), { qos: 1 }, (error) => error ? reject(error) : resolve());
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`automation telemetry publish timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function storedBytes(value: StoredAutomationTelemetryOutbox) {
  return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, sortJson(child)])
  );
}

function sameScope(value: unknown, scope: AutomationScope) {
  return isRecord(value) && value.siteId === scope.siteId && value.gatewayId === scope.gatewayId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
