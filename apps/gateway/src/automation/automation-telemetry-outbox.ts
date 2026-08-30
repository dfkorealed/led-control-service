import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  automationExecutionEventV1Schema,
  mqttTopics,
  type AutomationExecutionEventV1
} from "@led-control/shared";
import {
  AtomicJsonCommitUncertainError,
  readJsonFile,
  writeJsonAtomic
} from "../mesh/mesh-store-file";
import { SerialTaskQueue } from "../runtime/serial-task-queue";
import {
  StorageHeadroomManager,
  type StorageHeadroom
} from "../storage/storage-headroom-manager";
import type { AutomationScope } from "./automation-config-store";
import type {
  AutomationLifecycleHandoff,
  AutomationTerminalHandoff
} from "./schedule-runtime";
import {
  automationTelemetryRecordsHash,
  createAutomationTelemetryHandoff,
  lifecycleTelemetryRecords,
  terminalTelemetryRecords,
  type AutomationTelemetryRecordInput,
  type PersistedAutomationTelemetryHandoff
} from "./automation-telemetry-handoff";
import {
  AUTOMATION_TELEMETRY_GAP_JOURNAL_BYTES,
  AutomationTelemetryGapJournal,
  type AutomationTelemetryGapInput,
  type AutomationTelemetryGapJournalLike
} from "./automation-telemetry-gap-journal";

export { AUTOMATION_TELEMETRY_GAP_JOURNAL_BYTES } from "./automation-telemetry-gap-journal";

export const AUTOMATION_TELEMETRY_MAX_BYTES = 64 * 1024 * 1024;
const GAP_SLOT_BYTES = 1_536;
const DEFAULT_RETRY_INITIAL_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
const DEFAULT_PUBLISH_TIMEOUT_MS = 10_000;

export type AutomationTelemetryInput = AutomationTelemetryRecordInput;

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

interface AcceptedTelemetryHandoff {
  recordsHash: string;
  outcome: "records" | "gap";
  provenance: string;
  droppedCount: number;
}

interface StoredAutomationTelemetryOutbox {
  version: 2;
  scope: AutomationScope;
  nextSequence: number;
  records: StoredAutomationTelemetryRecord[];
  gap: PendingTelemetryGap | null;
  acceptedHandoffs: Record<string, AcceptedTelemetryHandoff>;
}

export interface AutomationTelemetryAppendBatchResult {
  status: "accepted" | "duplicate";
  storedRecords: StoredAutomationTelemetryRecord[];
  droppedRecords: AutomationTelemetryRecordInput[];
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
  private readonly headroom: StorageHeadroom;
  private readonly gapJournal: AutomationTelemetryGapJournalLike;
  private state: StoredAutomationTelemetryOutbox | undefined;
  private initialized = false;
  private available = true;
  private gapJournalAvailable = false;
  private unresolvedCommit: AutomationTelemetryCommitUncertainError | undefined;

  constructor(
    private readonly path: string,
    private readonly scope: AutomationScope,
    options: {
      maxBytes?: number;
      write?: AtomicJsonWriter;
      createEventId?: () => string;
      headroomBytes?: number;
      headroom?: StorageHeadroom;
      gapJournal?: AutomationTelemetryGapJournalLike;
    } = {}
  ) {
    this.maxBytes = options.maxBytes ?? AUTOMATION_TELEMETRY_MAX_BYTES;
    this.write = options.write ?? writeJsonAtomic;
    this.createEventId = options.createEventId ?? randomUUID;
    this.headroom = options.headroom ?? new StorageHeadroomManager(
      `${path}.reserve`,
      options.headroomBytes ?? this.maxBytes
    );
    this.gapJournal = options.gapJournal ?? new AutomationTelemetryGapJournal(`${path}.gap`);
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 2 * GAP_SLOT_BYTES) {
      throw new Error("automation telemetry outbox byte limit is too small");
    }
  }

  initialize() {
    return this.queue.run(() => this.initializeUnlocked());
  }

  async append(input: AutomationTelemetryInput) {
    const handoff = createAutomationTelemetryHandoff([input]);
    if (!handoff) throw new Error("automation telemetry append requires one record");
    const result = await this.appendBatch(handoff);
    return result.storedRecords[0] ?? null;
  }

  appendBatch(handoff: PersistedAutomationTelemetryHandoff): Promise<AutomationTelemetryAppendBatchResult> {
    return this.queue.run(async () => {
      await this.ensureInitialized();
      this.assertCommitResolved();
      validateHandoff(handoff);
      const current = this.state;
      const receipt = current?.acceptedHandoffs[handoff.handoffId];
      if (receipt) {
        if (receipt.recordsHash !== handoff.recordsHash) {
          throw new Error("automation telemetry handoff identity conflict");
        }
        return {
          status: "duplicate",
          storedRecords: [],
          droppedRecords: receipt.outcome === "gap" ? structuredClone(handoff.records) : []
        };
      }
      if (!current || !this.available) return this.journalDroppedHandoff(handoff, "automation_handoff_storage");

      const next = structuredClone(current);
      const records: StoredAutomationTelemetryRecord[] = [];
      for (const input of handoff.records) {
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
          next.records = next.records.filter((candidate) => !(
            !candidate.publishAttempted && candidate.event.kind === "event_extended" &&
            candidate.event.ruleId === event.ruleId && candidate.event.occurrenceKey === event.occurrenceKey
          ));
        }
        next.records.push(record);
        records.push(record);
      }
      next.acceptedHandoffs[handoff.handoffId] = {
        recordsHash: handoff.recordsHash,
        outcome: "records",
        provenance: "automation_state_handoff",
        droppedCount: 0
      };
      if (!this.fitsNormalBudget(next)) {
        return this.journalDroppedHandoff(handoff, "automation_handoff_capacity");
      }
      try {
        await this.commit(current, next);
      } catch (error) {
        if (error instanceof AutomationTelemetryStoreError) {
          return this.journalDroppedHandoff(handoff, "automation_handoff_storage");
        }
        throw error;
      }
      return { status: "accepted", storedRecords: records.map(cloneRecord), droppedRecords: [] };
    });
  }

  recordGap(input: {
    handoffId?: string;
    recordsHash?: string;
    provenance?: "automation_state_gap" | "fixture_state_outbox";
    revision: number;
    firstDroppedAt: string;
    lastDroppedAt: string;
    droppedCount: number;
  }) {
    return this.queue.run(async () => {
      await this.ensureInitialized();
      this.assertCommitResolved();
      const normalized = normalizeGapInput(input);
      if (!this.state || !this.available) return this.gapJournal.record(normalized);
      const current = this.state;
      const receipt = current.acceptedHandoffs[normalized.handoffId];
      if (receipt?.recordsHash === normalized.recordsHash) return structuredClone(current.gap);
      const next = applyGapToState(current, normalized, this.createEventId);
      this.assertStrictCapacity(next);
      try {
        await this.commit(current, next);
      } catch (error) {
        if (error instanceof AutomationTelemetryStoreError) {
          return this.gapJournal.record(normalized);
        }
        throw error;
      }
      return structuredClone(next.gap);
    });
  }

  pending() {
    return this.queue.run(async () => {
      await this.ensureInitialized();
      this.assertCommitResolved();
      if (!this.state) throw new AutomationTelemetryStoreError();
      await this.importGapJournal();
      let current = this.state;
      if (current.gap) {
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
    return this.queue.run(async () => {
      await this.ensureInitialized();
      this.assertCommitResolved();
      if (!this.state) throw new AutomationTelemetryStoreError();
      const snapshot = structuredClone(this.state);
      if (!snapshot.gap && this.gapJournalAvailable) {
        const journal = await this.gapJournal.read();
        if (journal) snapshot.gap = {
          eventId: journal.gapHandoffId,
          sequence: 0,
          revision: journal.revision,
          firstDroppedAt: journal.firstDroppedAt,
          lastDroppedAt: journal.lastDroppedAt,
          droppedCount: journal.droppedCount
        };
      }
      return snapshot;
    });
  }

  markPublishAttempt(record: Pick<StoredAutomationTelemetryRecord, "event" | "reportPayloadHash">) {
    return this.queue.run(async () => {
      await this.ensureWritable();
      const current = this.state!;
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
      await this.ensureWritable();
      const current = this.state!;
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

  recoverGapJournal() {
    return this.queue.run(async () => {
      await this.ensureInitialized();
      return this.importGapJournal();
    });
  }

  releaseHandoff(handoffId: string, recordsHash: string) {
    return this.queue.run(async () => {
      await this.ensureInitialized();
      const current = this.state;
      const receipt = current?.acceptedHandoffs[handoffId];
      if (!current || !receipt || receipt.recordsHash !== recordsHash || !this.available) return false;
      const next = structuredClone(current);
      delete next.acceptedHandoffs[handoffId];
      await this.commit(current, next);
      return true;
    });
  }

  reconcileHandoffReceipts(activeHandoffIds: string[]) {
    return this.queue.run(async () => {
      await this.ensureInitialized();
      const current = this.state;
      if (!current || !this.available) return false;
      const active = new Set(activeHandoffIds);
      const stale = Object.keys(current.acceptedHandoffs).filter((handoffId) => !active.has(handoffId));
      if (stale.length === 0) return false;
      const next = structuredClone(current);
      for (const handoffId of stale) delete next.acceptedHandoffs[handoffId];
      await this.commit(current, next);
      return true;
    });
  }

  private async initializeUnlocked() {
    if (this.initialized) {
      return {
        mode: this.available && this.headroom.snapshot().status === "available"
          ? "ready" as const
          : "degraded" as const
      };
    }
    const reasons: string[] = [];
    try {
      await this.gapJournal.initialize();
      this.gapJournalAvailable = true;
    } catch (error) {
      reasons.push(errorCode(error, "gap_journal_unavailable"));
    }
    const headroom = await this.headroom.initialize();
    if (headroom.mode === "degraded") reasons.push("headroom_unavailable");
    try {
      await this.load();
    } catch (error) {
      this.available = false;
      reasons.push(errorCode(error, "outbox_unavailable"));
    }
    if (!this.gapJournalAvailable && !reasons.includes("gap_journal_unavailable")) {
      reasons.push("gap_journal_unavailable");
    }
    if (!this.available && !reasons.includes("outbox_unavailable")) reasons.push("outbox_unavailable");
    if (this.headroom.snapshot().status !== "available" && !reasons.includes("headroom_unavailable")) {
      reasons.push("headroom_unavailable");
    }
    this.initialized = true;
    return reasons.length === 0
      ? { mode: "ready" as const, reasons }
      : { mode: "degraded" as const, reasons };
  }

  private async ensureInitialized() {
    if (!this.initialized) await this.initializeUnlocked();
  }

  private async ensureWritable() {
    await this.ensureInitialized();
    this.assertCommitResolved();
    if (!this.available || !this.state) throw new AutomationTelemetryStoreError();
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
        version: 2,
        scope: { ...this.scope },
        nextSequence: 0,
        records: [],
        gap: null,
        acceptedHandoffs: {}
      };
      if (!this.fitsNormalBudget(initial)) throw new Error("automation telemetry outbox byte limit is too small");
      try {
        await this.writeWithHeadroom(initial);
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
      await this.writeWithHeadroom(next);
      this.state = next;
    } catch (error) {
      if (!(error instanceof AtomicJsonCommitUncertainError)) {
        throw new AutomationTelemetryStoreError({ cause: error });
      }
      await this.reconcileVisible(previous, next, error);
    }
  }

  private async reconcileVisible(
    previous: StoredAutomationTelemetryOutbox,
    next: StoredAutomationTelemetryOutbox,
    commitError: AtomicJsonCommitUncertainError
  ): Promise<never> {
    try {
      const visible = await readJsonFile(this.path);
      if (isDeepStrictEqual(visible, next)) {
        this.state = next;
        this.available = true;
        this.unresolvedCommit = undefined;
      } else if (isDeepStrictEqual(visible, previous)) {
        this.state = previous;
        this.available = true;
        this.unresolvedCommit = undefined;
      } else {
        this.state = undefined;
        this.available = false;
      }
    } catch {
      this.state = undefined;
      this.available = false;
    }
    const uncertain = new AutomationTelemetryCommitUncertainError({
      cause: commitError
    });
    if (!this.available) this.unresolvedCommit = uncertain;
    throw uncertain;
  }

  private assertCommitResolved() {
    if (this.unresolvedCommit) throw this.unresolvedCommit;
  }

  private async writeWithHeadroom(value: StoredAutomationTelemetryOutbox) {
    await this.headroom.runWithHeadroom(() => this.write(this.path, value));
  }

  private async journalDroppedHandoff(
    handoff: PersistedAutomationTelemetryHandoff,
    provenance: "automation_handoff_capacity" | "automation_handoff_storage"
  ): Promise<AutomationTelemetryAppendBatchResult> {
    if (!this.gapJournalAvailable) throw new AutomationTelemetryStoreError();
    const timestamps = handoff.records.map((record) => record.occurredAt).sort();
    await this.gapJournal.record({
      handoffId: handoff.handoffId,
      recordsHash: handoff.recordsHash,
      provenance,
      revision: Math.max(...handoff.records.map((record) => record.revision)),
      firstDroppedAt: timestamps[0]!,
      lastDroppedAt: timestamps.at(-1)!,
      droppedCount: handoff.records.length
    });
    return { status: "accepted", storedRecords: [], droppedRecords: structuredClone(handoff.records) };
  }

  private async importGapJournal() {
    if (!this.gapJournalAvailable || !this.state || !this.available) return false;
    const journal = await this.gapJournal.read();
    if (!journal) return false;
    const current = this.state;
    const next = applyGapToState(current, {
      handoffId: journal.gapHandoffId,
      recordsHash: journal.gapRecordsHash,
      provenance: "automation_state_gap",
      revision: journal.revision,
      firstDroppedAt: journal.firstDroppedAt,
      lastDroppedAt: journal.lastDroppedAt,
      droppedCount: journal.droppedCount
    }, this.createEventId);
    // The source handoff can still be pending in automation state when this journal is imported.
    // Move its receipt with the aggregate gap so clearing the journal cannot make replay append the exact records again.
    const sourceReceipt = next.acceptedHandoffs[journal.lastSourceHandoffId];
    if (sourceReceipt && (
      sourceReceipt.recordsHash !== journal.lastSourceRecordsHash ||
      sourceReceipt.outcome !== "gap" ||
      sourceReceipt.droppedCount !== journal.lastSourceDroppedCount
    )) {
      throw new Error("automation telemetry journal source handoff conflict");
    }
    next.acceptedHandoffs[journal.lastSourceHandoffId] = {
      recordsHash: journal.lastSourceRecordsHash,
      outcome: "gap",
      provenance: journal.provenance,
      droppedCount: journal.lastSourceDroppedCount
    };
    await this.commit(current, next);
    await this.gapJournal.clear(journal.gapHandoffId, journal.gapRecordsHash);
    return true;
  }
}

export class AutomationTelemetryRecorder {
  constructor(private readonly outbox: AutomationTelemetryOutbox) {}

  async recordLifecycle(handoff: AutomationLifecycleHandoff) {
    const pending = createAutomationTelemetryHandoff(lifecycleTelemetryRecords(handoff));
    if (!pending) return { status: "accepted" as const, storedRecords: [], droppedRecords: [] };
    return this.outbox.appendBatch(pending);
  }

  async recordTerminal(handoff: AutomationTerminalHandoff) {
    const pending = createAutomationTelemetryHandoff(terminalTelemetryRecords(handoff));
    if (!pending) return { status: "accepted" as const, storedRecords: [], droppedRecords: [] };
    return this.outbox.appendBatch(pending);
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

function normalizeGapInput(input: {
  handoffId?: string;
  recordsHash?: string;
  provenance?: "automation_state_gap" | "fixture_state_outbox";
  revision: number;
  firstDroppedAt: string;
  lastDroppedAt: string;
  droppedCount: number;
}): AutomationTelemetryGapInput {
  const provenance = input.provenance ?? "automation_state_gap";
  const exact = {
    provenance,
    revision: input.revision,
    firstDroppedAt: input.firstDroppedAt,
    lastDroppedAt: input.lastDroppedAt,
    droppedCount: input.droppedCount
  };
  const normalized = {
    ...exact,
    handoffId: input.handoffId ?? randomUUID(),
    recordsHash: input.recordsHash ?? `sha256:${createHash("sha256").update(JSON.stringify(sortJson(exact))).digest("hex")}`
  } as AutomationTelemetryGapInput;
  validateNormalizedGap(normalized);
  return normalized;
}

function validateNormalizedGap(input: AutomationTelemetryGapInput) {
  if (!Number.isSafeInteger(input.revision) || input.revision < 0 ||
    !/^sha256:[a-f0-9]{64}$/.test(input.recordsHash) ||
    Number.isNaN(Date.parse(input.firstDroppedAt)) || Number.isNaN(Date.parse(input.lastDroppedAt)) ||
    Date.parse(input.firstDroppedAt) > Date.parse(input.lastDroppedAt) ||
    !Number.isSafeInteger(input.droppedCount) || input.droppedCount <= 0) {
    throw new Error("invalid automation telemetry gap");
  }
}

function applyGapToState(
  current: StoredAutomationTelemetryOutbox,
  input: AutomationTelemetryGapInput,
  createEventId: () => string
) {
  validateNormalizedGap(input);
  const receipt = current.acceptedHandoffs[input.handoffId];
  if (receipt?.recordsHash === input.recordsHash) return structuredClone(current);
  if (receipt && (receipt.provenance !== input.provenance || input.droppedCount < receipt.droppedCount)) {
    throw new Error("automation telemetry gap handoff identity conflict");
  }
  const next = structuredClone(current);
  const addedCount = input.droppedCount - (receipt?.droppedCount ?? 0);
  if (addedCount > 0 && !next.gap) {
    const sequence = next.nextSequence + 1;
    if (!Number.isSafeInteger(sequence)) throw new Error("automation telemetry sequence exceeded safe integer range");
    next.nextSequence = sequence;
    next.gap = {
      eventId: createEventId(),
      sequence,
      revision: input.revision,
      firstDroppedAt: input.firstDroppedAt,
      lastDroppedAt: input.lastDroppedAt,
      droppedCount: addedCount
    };
  } else if (addedCount > 0) {
    next.gap!.firstDroppedAt = earlierTimestamp(next.gap!.firstDroppedAt, input.firstDroppedAt);
    next.gap!.lastDroppedAt = laterTimestamp(next.gap!.lastDroppedAt, input.lastDroppedAt);
    next.gap!.droppedCount = Math.min(Number.MAX_SAFE_INTEGER, next.gap!.droppedCount + addedCount);
  }
  next.acceptedHandoffs[input.handoffId] = {
    recordsHash: input.recordsHash,
    outcome: "gap",
    provenance: input.provenance,
    droppedCount: input.droppedCount
  };
  return next;
}

function validateHandoff(handoff: PersistedAutomationTelemetryHandoff) {
  if (handoff.handoffId.length === 0 || handoff.handoffId.length > 512 || handoff.records.length === 0 ||
    handoff.records.length > 1_000 || automationTelemetryRecordsHash(handoff.records) !== handoff.recordsHash) {
    throw new Error("invalid automation telemetry handoff");
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
  const legacy = hasExactKeys(value, ["version", "scope", "nextSequence", "records", "gap"]) && value.version === 1;
  const current = hasExactKeys(value, [
    "version", "scope", "nextSequence", "records", "gap", "acceptedHandoffs"
  ]) && value.version === 2;
  if ((!legacy && !current) ||
    !sameScope(value.scope, scope) || !Number.isSafeInteger(value.nextSequence) || (value.nextSequence as number) < 0 ||
    !Array.isArray(value.records)) {
    throw new AutomationTelemetryStoreError();
  }
  const records = value.records.map((candidate) => parseStoredRecord(candidate, scope));
  const gap = parsePendingGap(value.gap);
  const parsed: StoredAutomationTelemetryOutbox = {
    version: 2,
    scope: { ...scope },
    nextSequence: value.nextSequence as number,
    records,
    gap,
    acceptedHandoffs: legacy ? {} : parseAcceptedHandoffs(value.acceptedHandoffs)
  };
  const maxSequence = Math.max(0, ...records.map((record) => record.event.sequence), gap?.sequence ?? 0);
  if (parsed.nextSequence < maxSequence || storedBytes(parsed) > maxBytes) {
    throw new AutomationTelemetryStoreError();
  }
  return parsed;
}

function parseStoredRecord(value: unknown, scope: AutomationScope): StoredAutomationTelemetryRecord {
  if (!isRecord(value) || !hasExactKeys(value, ["event", "reportPayloadHash", "publishAttempted"]) ||
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

function parseAcceptedHandoffs(value: unknown) {
  if (!isRecord(value) || Object.keys(value).length > 10_000) throw new AutomationTelemetryStoreError();
  return Object.fromEntries(Object.entries(value).map(([handoffId, receipt]) => {
    if (!hasExactKeys(receipt, ["recordsHash", "outcome", "provenance", "droppedCount"]) ||
      !/^sha256:[a-f0-9]{64}$/.test(String(receipt.recordsHash)) ||
      (receipt.outcome !== "records" && receipt.outcome !== "gap") || typeof receipt.provenance !== "string" ||
      !Number.isSafeInteger(receipt.droppedCount) || (receipt.droppedCount as number) < 0) {
      throw new AutomationTelemetryStoreError();
    }
    return [parseNonemptyString(handoffId), receipt as unknown as AcceptedTelemetryHandoff];
  }));
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

function parseNonemptyString(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new AutomationTelemetryStoreError();
  }
  return value;
}

function errorCode(error: unknown, fallback: string) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
