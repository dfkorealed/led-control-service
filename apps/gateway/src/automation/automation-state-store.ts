import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  AtomicJsonCommitUncertainError,
  readJsonFile,
  writeJsonAtomic
} from "../mesh/mesh-store-file";
import type { StorageHeadroom } from "../storage/storage-headroom-manager";
import {
  automationTelemetryRecordsHash,
  createAutomationTelemetryHandoff,
  type AutomationTelemetryRecordInput,
  type PersistedAutomationTelemetryHandoff
} from "./automation-telemetry-handoff";
import type { AutomationTelemetryGapJournalLike } from "./automation-telemetry-gap-journal";
import type { BioConfigurationState, BioVerifiedLampTarget } from "../bio/bio-dongle-client";
import { temporaryControlCommandSchema, temporaryControlResultSchema, temporaryFixtureSnapshotSchema,
  type Generation, type StartTemporaryControlCommand, type EndTemporaryControlCommand, type TemporaryControlState, type TemporaryFixtureSnapshot,
  type TemporaryTargetEvidence, type TemporaryControlResult } from "@led-control/shared";
import { bioEnvelopeHash } from "../bio/bio-sensor-profile-catalog";

export interface PersistedOccurrenceState {
  key: string;
  startedAt: string;
  endsAt: string;
  preBrightness: Record<string, number>;
}

export interface PersistedManualOverrideState {
  sourceId: string;
  brightnessPercent: number;
  startedAt: string;
  overrideUntil: string;
  preBrightness: number;
}

export interface PersistedManualControlState {
  sourceId: string;
  brightnessPercent: number;
  requestedAt: string;
  preBrightness: number;
}

export interface PersistedManualAutomationSuppressionState {
  sourceId: string;
  appliedAt: string;
  schedules: Array<{ scheduleId: string; occurrenceKey: string }>;
  vehicleEvents: Array<{ ruleId: string; startedAt: string }>;
}

export interface ManualTerminalSourceContext {
  suppressions: Record<string, PersistedManualAutomationSuppressionState>;
}

// Terminal journals reuse the exact, bounded V6 suppression parser. Unknown
// fields or malformed identities must not silently fall back to UTC recovery.
export function parseManualTerminalSourceContext(value: unknown): ManualTerminalSourceContext {
  if (!hasExactKeys(value, ["suppressions"])) throw new Error("invalid manual terminal source context");
  return { suppressions: parseFixtureRecord(value.suppressions, parseManualSuppression) };
}

export interface PersistedVehicleRuleState {
  /** Present only on V7 BIO occurrences; legacy state always means BlueZ. */
  sensorProtocol?: "bio-usb-pulse";
  activeSourceFixtureIds: string[];
  targetFixtureIds: string[];
  brightnessPercent: number;
  startedAt: string;
  holdUntil: string | null;
  preBrightness: Record<string, number>;
}

export interface PersistedAutomationTelemetryGap {
  handoffId: string;
  provenance: "fixture_state_outbox";
  firstDroppedAt: string;
  lastDroppedAt: string;
  droppedCount: number;
}

export interface PersistedAutomationTransitionState {
  phase: "pending" | "terminal";
  brightnessPercent: number;
  sourceType: "manual_override" | "vehicle_event_rule" | "schedule" | "current" | "default";
  sourceId: string | null;
  occurrenceKey: string | null;
  attempt: number;
  startedAt: string;
  status: "succeeded" | "failed" | "timed_out" | null;
  terminalAt: string | null;
}

export interface VehicleSensorEventIdentity {
  sourceUnicast: number;
  bootId: number;
  sequence: number;
}

export interface PersistedVehicleSensorInboxSource {
  sourceUnicast: number;
  current: { bootId: number; highWaterSequence: number };
  recentBoots: Array<{ bootId: number; highWaterSequence: number }>;
}

const MAX_VEHICLE_SENSOR_INBOX_SOURCES = 10_000;
const MAX_RECENT_VEHICLE_SENSOR_BOOTS = 8;
const MAX_AUTOMATION_STATE_BYTES = 64 * 1024 * 1024;

export interface BioPulseReceipt {
  nativeUuid: string;
  logicalAddress: number;
  networkId: number;
  sequence: number;
  connectionEpoch: string;
  connectionGeneration: number;
}

export interface PersistedBioPulseInboxSource {
  receipt: BioPulseReceipt;
  // These timestamps are comparable only within receipt.connectionEpoch.
  lastReceivedMonotonicMs: number;
  recentReceipts: Array<{ sequence: number; receivedMonotonicMs: number }>;
}

export interface PersistedBioTargetResult {
  status: "pending" | "succeeded" | "failed" | "timed_out";
  attempt: number;
  at: string;
  observed: BioConfigurationState | null;
}

export interface PersistedBioTargetState {
  activationId: string;
  sourceFixtureId: string;
  eventBrightnessPercent: number;
  target: BioVerifiedLampTarget | null;
  preState: BioConfigurationState | null;
  applyResult: PersistedBioTargetResult;
  restoreResult: PersistedBioTargetResult | null;
}

/** Private local authorization identity; never project this record to MQTT. */
export interface BioSourceBinding {
  sourceFixtureId: string;
  nativeUuid: string;
  logicalAddress: number;
  networkId: number;
  capabilityRevision: number;
  snapshotRevision: number;
  profileId: string;
  firmwareFingerprint: string;
  sensorFingerprint: string;
}

export interface PersistedBioActivation {
  activationId: string;
  startedAt: string;
  snapshotHash: string;
  binding: BioSourceBinding;
  targetFixtureIds: string[];
  brightnessPercent: number;
  health: "healthy" | "degraded" | "unverified";
  healthReason: string;
  releaseReason: "hold_expired" | "operator_release" | "configuration_changed" | null;
  completed: boolean;
  retiredFixtureIds: string[];
  reportedResults: string;
}

export interface PersistedAutomationStateV9 {
  schemaVersion: 9;
  activeOccurrences: Record<string, PersistedOccurrenceState>;
  pendingManualControls: Record<string, PersistedManualControlState>;
  manualAutomationSuppressions: Record<string, PersistedManualAutomationSuppressionState>;
  vehicleRules: Record<string, PersistedVehicleRuleState>;
  currentByFixture: Record<string, number>;
  baseBrightnessByFixture: Record<string, number>;
  lastDesiredByFixture: Record<string, number>;
  unverifiedDesiredByFixture: Record<string, number>;
  transitionsByFixture: Record<string, PersistedAutomationTransitionState>;
  telemetryGap: PersistedAutomationTelemetryGap | null;
  pendingTelemetryHandoffs: PersistedAutomationTelemetryHandoff[];
  vehicleSensorInbox: PersistedVehicleSensorInboxSource[];
  bioPulseInbox: Record<string, PersistedBioPulseInboxSource>;
  bioTargetsByFixture: Record<string, PersistedBioTargetState>;
  bioActivationsByRule: Record<string, PersistedBioActivation>;
}

export type PersistedTemporaryTarget = {
  snapshot: TemporaryFixtureSnapshot; preState: BioConfigurationState | null; preActivationId: string | null;
  applyConfirmed: boolean; releaseConfirmed: boolean; configurationMayHaveChanged: boolean;
  partialMutation: TemporaryTargetEvidence["partialMutation"];
  applyResult: TemporaryControlResult | null; releaseResult: TemporaryControlResult | null;
  releaseAcknowledged: boolean;
};
export type PersistedBioNormalConfiguration = {
  identity: Pick<TemporaryFixtureSnapshot, "fixtureId" | "meshNodeId" | "nativeUuid" | "logicalAddress">;
  siteId: string; gatewayId: string; assignmentVersion: number; networkId: number;
  configuration: BioConfigurationState; observedAt: string; baselineBrightness: number | null;
  snapshotRevision: number; snapshotPayloadHash: string;
};
export type PersistedTemporarySession = { command: StartTemporaryControlCommand; sessionRevision: 1 | 2;
  state: TemporaryControlState; targets: Record<string, PersistedTemporaryTarget> };
export type PersistedFixtureLease = { sessionId: string | null; identity: TemporaryFixtureSnapshot;
  lastGeneration: Generation; applyGeneration: Generation; releaseGeneration: Generation; phase: TemporaryControlState };
export type PersistedAutomationStateV10 = Omit<PersistedAutomationStateV9, "schemaVersion"> & {
  schemaVersion: 10; temporarySessions: Record<string, PersistedTemporarySession>;
  fixtureLeases: Record<string, PersistedFixtureLease>; temporaryResultOutbox: Record<string, TemporaryControlResult>;
  temporaryEndTombstones: Record<string, EndTemporaryControlCommand>;
  /** Minimal RF0 proof survives result ACK cleanup and fences a late start. */
  temporaryEndProofs: Record<string, Record<string, TemporaryControlResult>>;
  bioNormalConfigurations: Record<string, PersistedBioNormalConfiguration>;
};

// Historical import names refer to the current in-memory schema; only the parser accepts older disk shapes.
export type PersistedAutomationStateV8 = PersistedAutomationStateV10;
export type PersistedAutomationStateV7 = PersistedAutomationStateV8;
export type PersistedAutomationStateV6 = PersistedAutomationStateV7;
export type PersistedAutomationStateV4 = PersistedAutomationStateV7;
export type PersistedAutomationStateV3 = PersistedAutomationStateV7;

type StateWriter = (path: string, value: unknown) => Promise<void>;

interface AutomationStateStoreOptions {
  headroom?: StorageHeadroom;
  gapJournal?: AutomationTelemetryGapJournalLike;
  onDurabilityChange?: (mode: "ready" | "degraded", reason: string | null) => void;
  onGapJournalError?: (error: unknown) => void;
}

export type AutomationStateDurabilityOutcome = "durable" | "memory_only";

export interface AutomationStateMutationResult {
  state: PersistedAutomationStateV4;
  durability: AutomationStateDurabilityOutcome;
}

export interface RetainedAutomationTelemetryGap {
  revision: number;
  gap: PersistedAutomationTelemetryGap;
}

export interface AutomationTelemetryGapAcceptanceResult extends RetainedAutomationTelemetryGap {
  accepted: boolean;
  acceptance: "state" | "journal" | "memory_retry";
  error?: unknown;
}

export class AutomationStateStoreError extends Error {
  constructor(
    readonly code: "automation_state_corrupt" | "automation_state_unavailable" | "automation_state_store_failed",
    options?: ErrorOptions
  ) {
    super(code, options);
    this.name = "AutomationStateStoreError";
  }
}

export class AutomationStateCommitUncertainError extends Error {
  readonly code = "automation_state_commit_uncertain";

  constructor(options?: ErrorOptions) {
    super("automation_state_commit_uncertain", options);
    this.name = "AutomationStateCommitUncertainError";
  }
}

export class FileAutomationStateStore {
  private state: PersistedAutomationStateV4 | null = null;
  private available = false;
  private initialization: Promise<PersistedAutomationStateV4> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private telemetryGapQueue: Promise<unknown> = Promise.resolve();
  // One cumulative source bounds memory while preserving every not-yet-accepted drop.
  private retainedGap: RetainedAutomationTelemetryGap | null = null;
  private durabilityState: { mode: "ready" | "degraded"; reason: string | null } = {
    mode: "ready",
    reason: null
  };

  constructor(
    private readonly path: string,
    private readonly write: StateWriter = writeJsonAtomic,
    private readonly createHandoffId: () => string = randomUUID,
    private readonly options: AutomationStateStoreOptions = {}
  ) {}

  initialize() {
    this.initialization ??= this.restore();
    return this.initialization;
  }

  read(): PersistedAutomationStateV4 {
    if (!this.available || !this.state) {
      throw new AutomationStateStoreError("automation_state_unavailable");
    }
    return structuredClone(this.state);
  }

  durability() {
    return { ...this.durabilityState };
  }

  updateControlState(
    mutation: (state: PersistedAutomationStateV4) => PersistedAutomationStateV4
  ): Promise<AutomationStateMutationResult> {
    return this.mutate(mutation, true);
  }

  updateDurable(
    mutation: (state: PersistedAutomationStateV4) => PersistedAutomationStateV4
  ): Promise<AutomationStateMutationResult & { durability: "durable" }> {
    return this.mutate(mutation, false);
  }

  updateVehicleSensorEvent(
    identity: VehicleSensorEventIdentity,
    mutation: (state: PersistedAutomationStateV4) => PersistedAutomationStateV4
  ): Promise<AutomationStateMutationResult & { durability: "durable"; applied: boolean }> {
    assertVehicleSensorIdentity(identity);
    let applied = false;
    return this.mutate((state) => {
      applied = recordVehicleSensorReceipt(state, identity);
      return applied ? mutation(state) : state;
    }, false, "adopt-next").then((result) => ({ ...result, applied }));
  }

  private mutate(
    mutation: (state: PersistedAutomationStateV4) => PersistedAutomationStateV4,
    allowMemoryOnly: false,
    uncertainPolicy?: "rollback" | "adopt-next"
  ): Promise<AutomationStateMutationResult & { durability: "durable" }>;
  private mutate(
    mutation: (state: PersistedAutomationStateV4) => PersistedAutomationStateV4,
    allowMemoryOnly: true,
    uncertainPolicy?: "rollback" | "adopt-next"
  ): Promise<AutomationStateMutationResult>;
  private async mutate(
    mutation: (state: PersistedAutomationStateV4) => PersistedAutomationStateV4,
    allowMemoryOnly: boolean,
    uncertainPolicy: "rollback" | "adopt-next" = "rollback"
  ): Promise<AutomationStateMutationResult> {
    await this.initialize();
    return this.exclusive(async () => {
      const previous = this.read();
      const next = parseAutomationState(mutation(structuredClone(previous)));
      if (isDeepStrictEqual(previous, next) && this.durabilityState.mode === "ready" &&
        (!this.retainedGap || isDeepStrictEqual(previous.telemetryGap, this.retainedGap.gap))) {
        return { state: previous, durability: "durable" as const };
      }

      try {
        await this.writeState(next);
      } catch (error) {
        if (isEnospc(error) && allowMemoryOnly && this.options.gapJournal) {
          return this.commitInMemoryAfterEnospc(previous, next, error);
        }
        if (!(error instanceof AtomicJsonCommitUncertainError)) {
          throw new AutomationStateStoreError("automation_state_store_failed", { cause: error });
        }
        if (uncertainPolicy === "adopt-next" && await this.reconcileAdoptNext(previous, next, error)) {
          return { state: structuredClone(next), durability: "durable" as const };
        }
        if (allowMemoryOnly) await this.reconcileUncertainCommit(previous, next, error);
        else await this.reconcileDurableRequiredUncertainCommit(previous, next, error);
        throw new AutomationStateCommitUncertainError({ cause: error });
      }

      this.state = next;
      this.available = true;
      if (this.retainedGap && !isDeepStrictEqual(next.telemetryGap, this.retainedGap.gap)) {
        this.setDurability("degraded", "telemetry_gap_retry_pending");
      } else {
        this.setDurability("ready", null);
      }
      return { state: structuredClone(next), durability: "durable" as const };
    });
  }

  private async reconcileAdoptNext(
    previous: PersistedAutomationStateV4,
    next: PersistedAutomationStateV4,
    commitError: AtomicJsonCommitUncertainError
  ) {
    const visible = await this.readVisibleState();
    if (isDeepStrictEqual(visible, previous)) {
      this.state = previous;
      this.available = true;
      return false;
    }
    if (!isDeepStrictEqual(visible, next)) {
      this.available = false;
      throw new AutomationStateCommitUncertainError({ cause: commitError });
    }
    try {
      await this.writeState(next);
    } catch (error) {
      this.state = next;
      this.available = true;
      this.setDurability("degraded", "atomic_json_commit_uncertain");
      throw new AutomationStateCommitUncertainError({ cause: error });
    }
    this.state = next;
    this.available = true;
    this.setDurability("ready", null);
    return true;
  }

  recordTelemetryGap(
    firstDroppedAt: string,
    droppedCount: number,
    lastDroppedAt = firstDroppedAt,
    revision: number | null = 0
  ) {
    const firstTimestamp = parseTimestamp(firstDroppedAt);
    const lastTimestamp = parseTimestamp(lastDroppedAt);
    if (Date.parse(firstTimestamp) > Date.parse(lastTimestamp)) throw new Error("invalid telemetry gap interval");
    if (!Number.isSafeInteger(droppedCount) || droppedCount <= 0) {
      throw new Error("invalid telemetry gap count");
    }
    const normalizedRevision = parseGapRevision(revision);
    return this.exclusiveTelemetryGap(async () => {
      await this.initialize();
      const base = this.retainedGap?.gap ?? this.read().telemetryGap;
      this.retainedGap = {
        revision: this.retainedGap
          ? Math.max(this.retainedGap.revision, normalizedRevision)
          : normalizedRevision,
        gap: mergeTelemetryGap(
          base,
          firstTimestamp,
          droppedCount,
          lastTimestamp,
          this.createHandoffId
        )
      };
      return this.acceptRetainedTelemetryGap();
    });
  }

  retryRetainedTelemetryGap() {
    return this.exclusiveTelemetryGap(async () => {
      if (!this.retainedGap) return null;
      return this.acceptRetainedTelemetryGap();
    });
  }

  retainedTelemetryGap(): RetainedAutomationTelemetryGap | null {
    return structuredClone(this.retainedGap);
  }

  createTelemetryHandoff(records: AutomationTelemetryRecordInput[]) {
    return createAutomationTelemetryHandoff(records, this.createHandoffId);
  }

  async completeTelemetryHandoff(handoffId: string, recordsHash: string) {
    let completed = false;
    const result = await this.updateDurable((state) => {
      const index = state.pendingTelemetryHandoffs.findIndex((handoff) =>
        handoff.handoffId === handoffId && handoff.recordsHash === recordsHash
      );
      if (index < 0) return state;
      state.pendingTelemetryHandoffs.splice(index, 1);
      completed = true;
      return state;
    });
    return { completed, durability: result.durability };
  }

  async clearTelemetryGap(expected: PersistedAutomationTelemetryGap) {
    let cleared = false;
    const result = await this.updateDurable((state) => {
      if (!isDeepStrictEqual(state.telemetryGap, expected)) return state;
      state.telemetryGap = null;
      cleared = true;
      return state;
    });
    return { cleared, durability: result.durability };
  }

  private async acceptRetainedTelemetryGap(): Promise<AutomationTelemetryGapAcceptanceResult> {
    const retained = structuredClone(this.retainedGap!);
    try {
      await this.updateDurable((state) => {
        if (state.telemetryGap && state.telemetryGap.handoffId !== retained.gap.handoffId) {
          throw new Error("automation telemetry gap identity conflict");
        }
        state.telemetryGap = structuredClone(retained.gap);
        return state;
      });
      this.retainedGap = null;
      this.setDurability("ready", null);
      return { ...retained, accepted: true, acceptance: "state" };
    } catch (stateError) {
      if (stateError instanceof AutomationStateCommitUncertainError) {
        this.setDurability("degraded", stateError.code);
        return { ...retained, accepted: false, acceptance: "memory_retry", error: stateError };
      }
      if (!(stateError instanceof AutomationStateStoreError)) throw stateError;
      if (!isEnospc(stateError.cause)) {
        this.setDurability("degraded", "telemetry_gap_retry_pending");
        return { ...retained, accepted: false, acceptance: "memory_retry", error: stateError };
      }
      this.setDurability("degraded", "ENOSPC");
      try {
        if (!this.options.gapJournal) {
          throw new Error("automation telemetry gap journal is unavailable");
        }
        await this.options.gapJournal.record({
          handoffId: retained.gap.handoffId,
          recordsHash: automationTelemetryGapRecordsHash(retained.revision, retained.gap),
          provenance: retained.gap.provenance,
          revision: retained.revision,
          firstDroppedAt: retained.gap.firstDroppedAt,
          lastDroppedAt: retained.gap.lastDroppedAt,
          droppedCount: retained.gap.droppedCount
        });
        // The journal is the durable acceptance proof. Mirror its cumulative source
        // in process memory so later drops do not restart from stale on-disk state.
        const memoryState = this.read();
        memoryState.telemetryGap = structuredClone(retained.gap);
        this.state = memoryState;
        this.available = true;
        this.retainedGap = null;
        return { ...retained, accepted: true, acceptance: "journal", error: stateError };
      } catch (journalError) {
        const error = new AggregateError(
          [stateError, journalError],
          "automation telemetry gap acceptance pending"
        );
        this.options.onGapJournalError?.(journalError);
        this.setDurability("degraded", "telemetry_gap_retry_pending");
        return { ...retained, accepted: false, acceptance: "memory_retry", error };
      }
    }
  }

  private async restore(): Promise<PersistedAutomationStateV4> {
    let raw: unknown | null;
    try {
      raw = await readJsonFile(this.path, { maxBytes: MAX_AUTOMATION_STATE_BYTES });
    } catch (error) {
      throw new AutomationStateStoreError("automation_state_corrupt", { cause: error });
    }

    if (raw === null) {
      const initial = emptyAutomationState();
      try {
        await this.writeState(initial);
      } catch (error) {
        if (isEnospc(error) && this.options.gapJournal) {
          this.state = initial;
          this.available = true;
          this.setDurability("degraded", "ENOSPC");
          return structuredClone(initial);
        }
        if (error instanceof AtomicJsonCommitUncertainError) {
          throw new AutomationStateCommitUncertainError({ cause: error });
        }
        throw new AutomationStateStoreError("automation_state_store_failed", { cause: error });
      }
      this.state = initial;
      this.available = true;
      this.setDurability("ready", null);
      return structuredClone(initial);
    }

    try {
      this.state = parseAutomationState(raw);
      this.available = true;
      this.setDurability("ready", null);
      return structuredClone(this.state);
    } catch (error) {
      throw new AutomationStateStoreError("automation_state_corrupt", { cause: error });
    }
  }

  private async reconcileUncertainCommit(
    previous: PersistedAutomationStateV4,
    next: PersistedAutomationStateV4,
    commitError: AtomicJsonCommitUncertainError
  ) {
    let visible = await this.readVisibleState();
    if (isDeepStrictEqual(visible, next)) {
      try {
        await this.writeState(previous);
      } catch {
        // The visible target below is authoritative for process state. The original
        // atomic uncertainty remains the caller-facing taxonomy even if rollback storage is full.
      }
      visible = await this.readVisibleState();
    }
    if (isDeepStrictEqual(visible, previous)) {
      this.state = previous;
      this.available = true;
      this.setDurability("ready", null);
      return;
    }
    if (isDeepStrictEqual(visible, next)) {
      this.state = next;
      this.available = true;
      this.setDurability("degraded", commitError.code);
      return;
    }
    this.available = false;
    throw new AutomationStateCommitUncertainError({ cause: commitError });
  }

  private async reconcileDurableRequiredUncertainCommit(
    previous: PersistedAutomationStateV4,
    next: PersistedAutomationStateV4,
    commitError: AtomicJsonCommitUncertainError
  ) {
    let visible = await this.readVisibleState();
    if (isDeepStrictEqual(visible, next)) {
      try {
        await this.writeState(previous);
      } catch {
        // The durable protocol source stays pending in memory and its outbox receipt
        // remains authoritative until a later full-state write is confirmed.
      }
      visible = await this.readVisibleState();
    }
    this.state = previous;
    this.available = true;
    this.setDurability(
      isDeepStrictEqual(visible, previous) ? "ready" : "degraded",
      isDeepStrictEqual(visible, previous) ? null : commitError.code
    );
  }

  private async readVisibleState() {
    try {
      const raw = await readJsonFile(this.path, { maxBytes: MAX_AUTOMATION_STATE_BYTES });
      return raw === null ? null : parseAutomationState(raw);
    } catch {
      return null;
    }
  }

  private writeState(value: PersistedAutomationStateV4) {
    const operation = () => this.write(this.path, value);
    return this.options.headroom ? this.options.headroom.runWithHeadroom(operation) : operation();
  }

  private async commitInMemoryAfterEnospc(
    previous: PersistedAutomationStateV4,
    next: PersistedAutomationStateV4,
    error: NodeJS.ErrnoException
  ) {
    const memoryState = structuredClone(next);
    const previousHandoffs = new Set(previous.pendingTelemetryHandoffs.map(handoffIdentity));
    const dropped = new Set<string>();
    for (const handoff of memoryState.pendingTelemetryHandoffs) {
      const identity = handoffIdentity(handoff);
      if (previousHandoffs.has(identity)) continue;
      const timestamps = handoff.records.map((record) => record.occurredAt).sort();
      try {
        await this.options.gapJournal!.record({
          handoffId: handoff.handoffId,
          recordsHash: handoff.recordsHash,
          provenance: "automation_state_storage",
          revision: Math.max(...handoff.records.map((record) => record.revision)),
          firstDroppedAt: timestamps[0]!,
          lastDroppedAt: timestamps.at(-1)!,
          droppedCount: handoff.records.length
        });
        dropped.add(identity);
      } catch (journalError) {
        this.options.onGapJournalError?.(journalError);
      }
    }
    memoryState.pendingTelemetryHandoffs = memoryState.pendingTelemetryHandoffs
      .filter((handoff) => !dropped.has(handoffIdentity(handoff)));
    this.state = memoryState;
    this.available = true;
    this.setDurability("degraded", error.code ?? "ENOSPC");
    return {
      state: structuredClone(memoryState),
      durability: "memory_only" as const
    };
  }

  private setDurability(mode: "ready" | "degraded", reason: string | null) {
    if (this.durabilityState.mode === mode && this.durabilityState.reason === reason) return;
    this.durabilityState = { mode, reason };
    this.options.onDurabilityChange?.(mode, reason);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private exclusiveTelemetryGap<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.telemetryGapQueue.then(operation, operation);
    this.telemetryGapQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function automationTelemetryGapRecordsHash(
  revision: number,
  gap: PersistedAutomationTelemetryGap
) {
  return `sha256:${createHash("sha256").update(JSON.stringify({ revision, ...gap })).digest("hex")}` as const;
}

function mergeTelemetryGap(
  current: PersistedAutomationTelemetryGap | null,
  firstDroppedAt: string,
  droppedCount: number,
  lastDroppedAt: string,
  createHandoffId: () => string
): PersistedAutomationTelemetryGap {
  if (!current) {
    return {
      handoffId: createHandoffId(),
      provenance: "fixture_state_outbox",
      firstDroppedAt,
      lastDroppedAt,
      droppedCount
    };
  }
  return {
    handoffId: current.handoffId,
    provenance: current.provenance,
    firstDroppedAt: Date.parse(firstDroppedAt) < Date.parse(current.firstDroppedAt)
      ? firstDroppedAt
      : current.firstDroppedAt,
    lastDroppedAt: Date.parse(lastDroppedAt) > Date.parse(current.lastDroppedAt)
      ? lastDroppedAt
      : current.lastDroppedAt,
    droppedCount: Math.min(Number.MAX_SAFE_INTEGER, current.droppedCount + droppedCount)
  };
}

function parseGapRevision(value: number | null) {
  const revision = value ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("invalid telemetry gap revision");
  return revision;
}

function handoffIdentity(handoff: PersistedAutomationTelemetryHandoff) {
  return `${handoff.handoffId}:${handoff.recordsHash}`;
}

function isEnospc(error: unknown): error is NodeJS.ErrnoException {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOSPC";
}

export function emptyAutomationState(): PersistedAutomationStateV4 {
  return {
    schemaVersion: 10,
    temporarySessions: {}, fixtureLeases: {}, temporaryResultOutbox: {}, temporaryEndTombstones: {}, temporaryEndProofs: {}, bioNormalConfigurations: {},
    activeOccurrences: {},
    pendingManualControls: {},
    manualAutomationSuppressions: {},
    vehicleRules: {},
    currentByFixture: {},
    baseBrightnessByFixture: {},
    lastDesiredByFixture: {},
    unverifiedDesiredByFixture: {},
    transitionsByFixture: {},
    telemetryGap: null,
    pendingTelemetryHandoffs: [],
    vehicleSensorInbox: [],
    bioPulseInbox: {},
    bioTargetsByFixture: {},
    bioActivationsByRule: {}
  };
}

function temporaryState(value: unknown): TemporaryControlState {
  if (typeof value !== "string" || !["pending", "applying", "holding", "partial", "unknown", "releasing", "restored",
    "recovery_pending", "rejected", "cancelled"].includes(value)) throw new Error("invalid temporary state");
  return value as TemporaryControlState;
}

function parseTemporaryResult(value: unknown): TemporaryControlResult {
  const result = temporaryControlResultSchema.parse(value);
  const { resultHash, ...payload } = result;
  if (bioEnvelopeHash(payload) !== resultHash) throw new Error("invalid temporary result hash");
  return result;
}

function parseTemporaryEnd(value: unknown): EndTemporaryControlCommand {
  const command = temporaryControlCommandSchema.parse(value);
  if (command.kind !== "end") throw new Error("invalid temporary end tombstone");
  const { payloadHash, ...payload } = command;
  if (bioEnvelopeHash(payload) !== payloadHash) throw new Error("invalid temporary end hash");
  return command;
}

function parseTemporaryTarget(value: unknown): PersistedTemporaryTarget {
  if (isRecord(value) && !Object.hasOwn(value, "releaseAcknowledged")) value = { ...value, releaseAcknowledged: false };
  if (!hasExactKeys(value, ["snapshot", "preState", "preActivationId", "applyConfirmed", "releaseConfirmed",
    "configurationMayHaveChanged", "partialMutation", "applyResult", "releaseResult", "releaseAcknowledged"])) throw new Error("invalid temporary target");
  if (typeof value.applyConfirmed !== "boolean" || typeof value.releaseConfirmed !== "boolean" ||
    typeof value.configurationMayHaveChanged !== "boolean" || typeof value.releaseAcknowledged !== "boolean" ||
    !["none", "high_brightness", "mode", "unverified"].includes(String(value.partialMutation)) ||
    !(value.preActivationId === null || (typeof value.preActivationId === "string" && value.preActivationId.length > 0 && value.preActivationId.length <= 512))) {
    throw new Error("invalid temporary evidence");
  }
  const row: PersistedTemporaryTarget = { snapshot: temporaryFixtureSnapshotSchema.parse(value.snapshot),
    preState: value.preState === null ? null : parseBioConfigurationState(value.preState),
    preActivationId: value.preActivationId as string | null,
    applyConfirmed: value.applyConfirmed, releaseConfirmed: value.releaseConfirmed,
    configurationMayHaveChanged: value.configurationMayHaveChanged,
    partialMutation: value.partialMutation as PersistedTemporaryTarget["partialMutation"],
    applyResult: value.applyResult === null ? null : parseTemporaryResult(value.applyResult),
    releaseResult: value.releaseResult === null ? null : parseTemporaryResult(value.releaseResult), releaseAcknowledged: value.releaseAcknowledged };
  if ((row.partialMutation !== "none" && !row.configurationMayHaveChanged) ||
    (row.configurationMayHaveChanged && !row.preState) ||
    (row.applyConfirmed && (!row.applyResult?.applyConfirmed || row.partialMutation !== "none")) ||
    (row.releaseConfirmed && (!row.releaseResult?.releaseConfirmed || row.partialMutation !== "none")) ||
    (row.releaseAcknowledged && (!row.releaseResult || (!row.releaseConfirmed &&
      (row.configurationMayHaveChanged || row.releaseResult.rfWriteEvidence !== "not_started"))))) {
    throw new Error("invalid temporary confirmation");
  }
  return row;
}

function parseTemporarySession(value: unknown): PersistedTemporarySession {
  if (!hasExactKeys(value, ["command", "sessionRevision", "state", "targets"]) ||
    (value.sessionRevision !== 1 && value.sessionRevision !== 2)) throw new Error("invalid temporary session");
  const command = temporaryControlCommandSchema.parse(value.command);
  if (command.kind !== "start") throw new Error("temporary session requires immutable start");
  const { payloadHash, ...payload } = command;
  if (bioEnvelopeHash(payload) !== payloadHash) throw new Error("invalid temporary command hash");
  const targets = parseFixtureRecord(value.targets, parseTemporaryTarget);
  if (Object.keys(targets).length !== command.targets.length || command.targets.some(snapshot =>
    !isDeepStrictEqual(targets[snapshot.fixtureId]?.snapshot, snapshot))) throw new Error("invalid temporary snapshots");
  const state = temporaryState(value.state);
  const rows = Object.values(targets);
  if ((state === "holding" && (value.sessionRevision !== 1 || rows.some(row => !row.applyConfirmed))) ||
    (["restored", "rejected", "cancelled"].includes(state) && rows.some(row =>
      !row.releaseConfirmed && (row.configurationMayHaveChanged ||
        (row.applyResult?.rfWriteEvidence !== "not_started" && row.releaseResult?.rfWriteEvidence !== "not_started"))))) {
    throw new Error("invalid temporary terminal evidence");
  }
  return { command, targets, sessionRevision: value.sessionRevision, state };
}

function parseFixtureLease(value: unknown): PersistedFixtureLease {
  if (!hasExactKeys(value, ["sessionId", "identity", "lastGeneration", "applyGeneration", "releaseGeneration", "phase"])) {
    throw new Error("invalid fixture lease");
  }
  const identity = temporaryFixtureSnapshotSchema.parse(value.identity);
  if (!(value.sessionId === null || (typeof value.sessionId === "string" && /^[0-9a-f-]{36}$/.test(value.sessionId))) ||
    value.applyGeneration !== identity.applyGeneration || value.releaseGeneration !== identity.releaseGeneration ||
    (value.lastGeneration !== identity.applyGeneration && value.lastGeneration !== identity.releaseGeneration)) throw new Error("invalid fixture generation");
  const phase = temporaryState(value.phase);
  if (value.sessionId === null && !["restored", "rejected", "cancelled"].includes(phase)) throw new Error("unresolved lease missing owner");
  return { sessionId: value.sessionId, identity, lastGeneration: value.lastGeneration,
    applyGeneration: identity.applyGeneration, releaseGeneration: identity.releaseGeneration, phase };
}

function validateTemporaryResult(session: PersistedTemporarySession, result: TemporaryControlResult) {
  const command = session.command;
  const target = session.targets[result.fixtureId];
  if (!target || result.sessionId !== command.sessionId || result.siteId !== command.siteId || result.gatewayId !== command.gatewayId ||
    result.assignmentVersion !== command.assignmentVersion || result.admissionRevision !== command.admissionRevision ||
    result.originCommandHash !== command.payloadHash || result.originSequence !== command.sequence ||
    result.sessionRevision > session.sessionRevision ||
    result.targetGeneration !== (result.sessionRevision === 1 ? target.snapshot.applyGeneration : target.snapshot.releaseGeneration)) {
    throw new Error("invalid temporary result attribution");
  }
  // Revision1 confirmation proves the immutable requested apply, not merely a
  // syntactically valid configuration. Zero changes mode only and preserves high.
  if (result.sessionRevision === 1 && result.applyConfirmed && (!target.preState ||
    !isDeepStrictEqual(result.configurationReadback, bioEventConfiguration(target.preState, command.brightness)))) {
    throw new Error("invalid temporary apply configuration");
  }
}

function validateTemporaryEndProof(end: EndTemporaryControlCommand | undefined, result: TemporaryControlResult) {
  const target = end?.targets.find(target => target.fixtureId === result.fixtureId);
  if (!end || !target || result.sessionId !== end.sessionId || result.siteId !== end.siteId || result.gatewayId !== end.gatewayId ||
    result.assignmentVersion !== end.assignmentVersion || result.admissionRevision !== end.admissionRevision ||
    result.originCommandHash !== end.originCommandHash || result.originSequence !== end.originSequence ||
    result.sessionRevision !== 2 || result.kind !== "release" || result.targetGeneration !== target.releaseGeneration ||
    result.applyConfirmed || result.releaseConfirmed || result.configurationMayHaveChanged || result.partialMutation !== "none" ||
    result.rfWriteEvidence !== "not_started" || result.configurationReadback !== null || result.restorationRevision !== null ||
    result.restorationPayloadHash !== null) throw new Error("invalid temporary end proof");
}

function parseBioNormalConfiguration(value: unknown): PersistedBioNormalConfiguration {
  if (!hasExactKeys(value, ["identity", "siteId", "gatewayId", "assignmentVersion", "networkId", "configuration", "observedAt",
    "baselineBrightness", "snapshotRevision", "snapshotPayloadHash"]) ||
    !hasExactKeys(value.identity, ["fixtureId", "meshNodeId", "nativeUuid", "logicalAddress"]) ||
    typeof value.identity.nativeUuid !== "string" || !/^[0-9a-f]{12}$/.test(value.identity.nativeUuid) ||
    typeof value.identity.logicalAddress !== "string" || !/^0x[0-7][0-9a-f]{3}$/.test(value.identity.logicalAddress) || value.identity.logicalAddress === "0x0000" ||
    !Number.isSafeInteger(value.assignmentVersion) || (value.assignmentVersion as number) < 1 ||
    !Number.isInteger(value.networkId) || (value.networkId as number) < 0 || (value.networkId as number) > 65535 ||
    !Number.isSafeInteger(value.snapshotRevision) || (value.snapshotRevision as number) < 0 ||
    typeof value.snapshotPayloadHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.snapshotPayloadHash)) throw new Error("invalid BIO normal proof");
  return { identity: { fixtureId: parseUuid(value.identity.fixtureId), meshNodeId: parseUuid(value.identity.meshNodeId),
    nativeUuid: value.identity.nativeUuid, logicalAddress: value.identity.logicalAddress },
    siteId: parseUuid(value.siteId), gatewayId: parseUuid(value.gatewayId), assignmentVersion: value.assignmentVersion as number,
    networkId: value.networkId as number, configuration: parseBioConfigurationState(value.configuration), observedAt: parseTimestamp(value.observedAt),
    baselineBrightness: value.baselineBrightness === null ? null : parseBrightness(value.baselineBrightness),
    snapshotRevision: value.snapshotRevision as number, snapshotPayloadHash: value.snapshotPayloadHash };
}

export function parseAutomationState(value: unknown): PersistedAutomationStateV4 {
  if (isRecord(value) && value.schemaVersion === 10) {
    const { temporarySessions, fixtureLeases, temporaryResultOutbox, temporaryEndTombstones, temporaryEndProofs, bioNormalConfigurations, ...legacy } = value;
    const state = parseAutomationState({ ...legacy, schemaVersion: 9 });
    state.temporarySessions = parseFixtureRecord(temporarySessions, parseTemporarySession);
    state.fixtureLeases = parseFixtureRecord(fixtureLeases, parseFixtureLease);
    state.temporaryResultOutbox = parseFixtureRecord(temporaryResultOutbox, parseTemporaryResult);
    state.temporaryEndTombstones = parseFixtureRecord(temporaryEndTombstones, parseTemporaryEnd);
    // Only absent new fields migrate; explicit malformed values remain corrupt.
    state.temporaryEndProofs = parseFixtureRecord(!Object.hasOwn(value, "temporaryEndProofs") ? {} : temporaryEndProofs,
      value => parseFixtureRecord(value, parseTemporaryResult));
    state.bioNormalConfigurations = parseFixtureRecord(!Object.hasOwn(value, "bioNormalConfigurations") ? {} : bioNormalConfigurations, parseBioNormalConfiguration);
    for (const [id, proof] of Object.entries(state.bioNormalConfigurations)) if (proof.identity.fixtureId !== id) throw new Error("invalid BIO normal proof identity");
    for (const [id, proofs] of Object.entries(state.temporaryEndProofs)) for (const [fixtureId, proof] of Object.entries(proofs)) {
      if (proof.fixtureId !== fixtureId || proof.sessionId !== id) throw new Error("invalid temporary end proof identity");
      validateTemporaryEndProof(state.temporaryEndTombstones[id], proof);
      const known = state.temporarySessions[id]?.targets[fixtureId];
      if (known?.configurationMayHaveChanged || known?.preState) throw new Error("temporary end proof conflicts with possible write");
    }
    for (const [id, end] of Object.entries(state.temporaryEndTombstones)) {
      if (id !== end.sessionId) throw new Error("invalid temporary tombstone identity");
      const session = state.temporarySessions[id];
      const start = session?.command;
      if (start && (end.originCommandHash !== start.payloadHash || end.originSequence !== start.sequence ||
        end.siteId !== start.siteId || end.gatewayId !== start.gatewayId || end.assignmentVersion !== start.assignmentVersion ||
        end.admissionRevision !== start.admissionRevision || end.endsAt !== start.endsAt || !isDeepStrictEqual(end.targets, start.targets))) {
        throw new Error("invalid temporary tombstone origin");
      }
      for (const target of end.targets) {
        const lease = state.fixtureLeases[target.fixtureId];
        const exact = lease && isDeepStrictEqual(lease.identity, target);
        const reserved = exact && lease.sessionId === id && lease.lastGeneration === target.releaseGeneration;
        // A known RF0-settled start may accept end after clearing its owner at
        // revision1. Its validated terminal evidence still retains the full pair.
        const settled = exact && session && lease.sessionId === null && (
          (session.targets[target.fixtureId]?.releaseAcknowledged && lease.lastGeneration === target.releaseGeneration &&
            lease.phase === (session.targets[target.fixtureId]!.releaseConfirmed ? "restored" : "cancelled")) ||
          (["restored", "rejected", "cancelled"].includes(session.state) && lease.phase === session.state && lease.lastGeneration ===
            (session.sessionRevision === 1 ? target.applyGeneration : target.releaseGeneration)));
        const newerFence = lease && BigInt(lease.applyGeneration) > BigInt(target.releaseGeneration);
        // Iterating only existing leases misses a deleted reservation on restart.
        // End-only metadata is never evidence that RF0 or restoration was proved.
        const provedUnchanged = exact && state.temporaryEndProofs[id]?.[target.fixtureId] && lease.sessionId === null &&
          lease.phase === "cancelled" && lease.lastGeneration === target.releaseGeneration;
        if (!reserved && !settled && !provedUnchanged && !newerFence) throw new Error("invalid temporary tombstone fence");
      }
    }
    for (const [id, session] of Object.entries(state.temporarySessions)) {
      if (id !== session.command.sessionId) throw new Error("invalid temporary session identity");
      for (const [fixtureId, target] of Object.entries(session.targets)) {
        const lease = state.fixtureLeases[fixtureId];
        if (!lease || (lease.sessionId === id && (!isDeepStrictEqual(lease.identity, target.snapshot) ||
          lease.phase !== session.state || lease.lastGeneration !== (session.sessionRevision === 1
            ? target.snapshot.applyGeneration : target.snapshot.releaseGeneration)))) throw new Error("invalid temporary lease ownership");
        const acknowledged = target.releaseAcknowledged && session.sessionRevision === 2 && lease &&
          ((lease.sessionId === null && isDeepStrictEqual(lease.identity, target.snapshot) && lease.lastGeneration === target.snapshot.releaseGeneration &&
            lease.phase === (target.releaseConfirmed ? "restored" : "cancelled")) || BigInt(lease.applyGeneration) > BigInt(target.snapshot.releaseGeneration));
        if (!["restored", "rejected", "cancelled"].includes(session.state) && lease.sessionId !== id && !acknowledged) {
          throw new Error("unresolved temporary target lost owner");
        }
        for (const [slot, revision] of [["applyResult", 1], ["releaseResult", 2]] as const) {
          const result = target[slot];
          if (!result) continue;
          if (result.sessionRevision !== revision) throw new Error("invalid temporary result slot");
          validateTemporaryResult(session, result);
        }
      }
    }
    for (const [fixtureId, lease] of Object.entries(state.fixtureLeases)) {
      const tombstone = lease.sessionId && state.temporaryEndTombstones[lease.sessionId];
      const tombstoneTarget = tombstone && tombstone.targets.find(target => target.fixtureId === fixtureId);
      if (lease.identity.fixtureId !== fixtureId || (lease.sessionId !== null &&
        !state.temporarySessions[lease.sessionId]?.targets[fixtureId] &&
        !(tombstoneTarget && isDeepStrictEqual(tombstoneTarget, lease.identity) && lease.phase === "releasing" &&
          lease.lastGeneration === tombstoneTarget.releaseGeneration))) throw new Error("invalid fixture lease identity");
    }
    for (const [eventId, result] of Object.entries(state.temporaryResultOutbox)) {
      const session = state.temporarySessions[result.sessionId];
      if (eventId !== result.eventId) throw new Error("invalid temporary result owner");
      if (session) validateTemporaryResult(session, result);
      else {
        validateTemporaryEndProof(state.temporaryEndTombstones[result.sessionId], result);
        if (!isDeepStrictEqual(state.temporaryEndProofs[result.sessionId]?.[result.fixtureId], result)) throw new Error("invalid temporary result owner");
      }
    }
    return state;
  }
  if (isRecord(value) && value.schemaVersion === 9) {
    const { bioActivationsByRule, ...legacy } = value;
    const state = parseAutomationState({ ...legacy, schemaVersion: 8 });
    state.bioActivationsByRule = parseFixtureRecord(bioActivationsByRule, parseBioActivation);
    for (const [ruleId, row] of Object.entries(state.bioActivationsByRule)) {
      if (row.activationId !== `${ruleId}:${row.startedAt}`) throw new Error("invalid BIO activation identity");
      const vehicle = state.vehicleRules[ruleId];
      if (row.releaseReason === null && (!vehicle || vehicle.sensorProtocol !== "bio-usb-pulse" ||
        vehicle.startedAt !== row.startedAt || vehicle.brightnessPercent !== row.brightnessPercent ||
        !isDeepStrictEqual(vehicle.targetFixtureIds, row.targetFixtureIds))) throw new Error("invalid BIO active occurrence");
      for (const fixtureId of row.targetFixtureIds) {
        const target = state.bioTargetsByFixture[fixtureId];
        if (row.completed && !row.retiredFixtureIds.includes(fixtureId) &&
          (target?.activationId !== row.activationId || target.restoreResult?.status !== "succeeded")) {
          throw new Error("invalid BIO release completion");
        }
        if (target?.activationId !== row.activationId) continue;
        if (row.retiredFixtureIds.includes(fixtureId) || target.sourceFixtureId !== row.binding.sourceFixtureId ||
          target.eventBrightnessPercent !== row.brightnessPercent) throw new Error("invalid BIO target ownership");
      }
    }
    return state;
  }
  if (isRecord(value) && value.schemaVersion === 8) {
    // Strip only the new V8 field; V7/V6 retain their exact-key disk contracts.
    const { bioTargetsByFixture, ...legacy } = value;
    const state = parseAutomationState({ ...legacy, schemaVersion: 7 });
    state.bioTargetsByFixture = parseFixtureRecord(bioTargetsByFixture, parseBioTargetState);
    for (const [fixtureId, row] of Object.entries(state.bioTargetsByFixture)) {
      if (fixtureId.toLowerCase() === row.sourceFixtureId.toLowerCase()) throw new Error("BIO source cannot be a target");
    }
    return state;
  }
  if (isRecord(value) && value.schemaVersion === 7) {
    // Reuse the strict historical V6 parser after removing precisely the V7 field.
    // Unknown keys still fail there; a missing journal fails its own strict parser.
    const { bioPulseInbox, ...legacy } = value;
    const vehicleRules = parseRecord(value.vehicleRules, parseVehicleRuleV7);
    const legacyVehicleRules = Object.fromEntries(Object.entries(vehicleRules).map(([id, rule]) => {
      const { sensorProtocol: _sensorProtocol, ...legacyRule } = rule;
      return [id, legacyRule];
    }));
    const state = parseAutomationState({ ...legacy, schemaVersion: 6, vehicleRules: legacyVehicleRules });
    state.vehicleRules = vehicleRules;
    state.bioPulseInbox = parseFixtureRecord(bioPulseInbox, parseBioPulseInboxSource);
    return state;
  }
  if (hasExactKeys(value, [
    "schemaVersion", "activeOccurrences", "pendingManualControls", "manualAutomationSuppressions",
    "vehicleRules", "currentByFixture", "baseBrightnessByFixture", "lastDesiredByFixture",
    "unverifiedDesiredByFixture", "transitionsByFixture", "telemetryGap", "pendingTelemetryHandoffs",
    "vehicleSensorInbox"
  ]) && value.schemaVersion === 6) {
    return {
      schemaVersion: 10,
      temporarySessions: {}, fixtureLeases: {}, temporaryResultOutbox: {}, temporaryEndTombstones: {}, temporaryEndProofs: {}, bioNormalConfigurations: {},
      activeOccurrences: parseRecord(value.activeOccurrences, parseOccurrence),
      pendingManualControls: parseFixtureRecord(value.pendingManualControls, parseManualControl),
      manualAutomationSuppressions: parseFixtureRecord(value.manualAutomationSuppressions, parseManualSuppression),
      vehicleRules: parseRecord(value.vehicleRules, parseVehicleRule),
      currentByFixture: parseBrightnessRecord(value.currentByFixture),
      baseBrightnessByFixture: parseBrightnessRecord(value.baseBrightnessByFixture),
      lastDesiredByFixture: parseBrightnessRecord(value.lastDesiredByFixture),
      unverifiedDesiredByFixture: parseBrightnessRecord(value.unverifiedDesiredByFixture),
      transitionsByFixture: parseRecord(value.transitionsByFixture, parseTransition),
      telemetryGap: parseTelemetryGap(value.telemetryGap),
      pendingTelemetryHandoffs: parseTelemetryHandoffs(value.pendingTelemetryHandoffs),
      vehicleSensorInbox: parseVehicleSensorInbox(value.vehicleSensorInbox),
      bioPulseInbox: {},
      bioTargetsByFixture: {},
      bioActivationsByRule: {}
    };
  }
  if (hasExactKeys(value, [
    "schemaVersion",
    "activeOccurrences",
    "manualOverrides",
    "vehicleRules",
    "currentByFixture",
    "baseBrightnessByFixture",
    "lastDesiredByFixture"
  ]) && value.schemaVersion === 1) {
    return parseAutomationStateFields(
      value,
      {},
      parseBrightnessRecord(value.lastDesiredByFixture),
      {},
      null,
      []
    );
  }
  if (hasExactKeys(value, [
    "schemaVersion",
    "activeOccurrences",
    "manualOverrides",
    "vehicleRules",
    "currentByFixture",
    "baseBrightnessByFixture",
    "lastDesiredByFixture",
    "transitionsByFixture",
    "telemetryGap"
  ]) && value.schemaVersion === 2) {
    const transitionsByFixture = parseRecord(value.transitionsByFixture, parseTransition);
    const desired = migrateV2Desired(
      parseBrightnessRecord(value.lastDesiredByFixture),
      transitionsByFixture
    );
    return parseAutomationStateFields(
      value,
      desired.confirmed,
      desired.unverified,
      transitionsByFixture,
      parseLegacyTelemetryGap(value.telemetryGap),
      []
    );
  }
  if (hasExactKeys(value, [
    "schemaVersion",
    "activeOccurrences",
    "manualOverrides",
    "vehicleRules",
    "currentByFixture",
    "baseBrightnessByFixture",
    "lastDesiredByFixture",
    "unverifiedDesiredByFixture",
    "transitionsByFixture",
    "telemetryGap"
  ]) && value.schemaVersion === 3) {
    return parseAutomationStateFields(
      value,
      parseBrightnessRecord(value.lastDesiredByFixture),
      parseBrightnessRecord(value.unverifiedDesiredByFixture),
      parseRecord(value.transitionsByFixture, parseTransition),
      parseLegacyTelemetryGap(value.telemetryGap),
      []
    );
  }
  if (hasExactKeys(value, [
    "schemaVersion",
    "activeOccurrences",
    "manualOverrides",
    "vehicleRules",
    "currentByFixture",
    "baseBrightnessByFixture",
    "lastDesiredByFixture",
    "unverifiedDesiredByFixture",
    "transitionsByFixture",
    "telemetryGap",
    "pendingTelemetryHandoffs"
  ]) && value.schemaVersion === 4) {
    return parseAutomationStateFields(
      value,
      parseBrightnessRecord(value.lastDesiredByFixture),
      parseBrightnessRecord(value.unverifiedDesiredByFixture),
      parseRecord(value.transitionsByFixture, parseTransition),
      parseTelemetryGap(value.telemetryGap),
      parseTelemetryHandoffs(value.pendingTelemetryHandoffs),
      []
    );
  }
  if (!hasExactKeys(value, [
    "schemaVersion",
    "activeOccurrences",
    "manualOverrides",
    "vehicleRules",
    "currentByFixture",
    "baseBrightnessByFixture",
    "lastDesiredByFixture",
    "unverifiedDesiredByFixture",
    "transitionsByFixture",
    "telemetryGap",
    "pendingTelemetryHandoffs",
    "vehicleSensorInbox"
  ]) || value.schemaVersion !== 5) throw new Error("invalid automation state");
  return parseAutomationStateFields(
    value,
    parseBrightnessRecord(value.lastDesiredByFixture),
    parseBrightnessRecord(value.unverifiedDesiredByFixture),
    parseRecord(value.transitionsByFixture, parseTransition),
    parseTelemetryGap(value.telemetryGap),
    parseTelemetryHandoffs(value.pendingTelemetryHandoffs),
    parseVehicleSensorInbox(value.vehicleSensorInbox)
  );
}

function migrateV2Desired(
  lastDesiredByFixture: Record<string, number>,
  transitionsByFixture: Record<string, PersistedAutomationTransitionState>
) {
  const confirmed: Record<string, number> = {};
  const unverified: Record<string, number> = {};
  for (const [fixtureId, brightness] of Object.entries(lastDesiredByFixture)) {
    if (transitionsByFixture[fixtureId]) confirmed[fixtureId] = brightness;
    else unverified[fixtureId] = brightness;
  }
  return { confirmed, unverified };
}

function parseAutomationStateFields(
  value: Record<string, unknown>,
  lastDesiredByFixture: Record<string, number>,
  unverifiedDesiredByFixture: Record<string, number>,
  transitionsByFixture: Record<string, PersistedAutomationTransitionState>,
  telemetryGap: PersistedAutomationTelemetryGap | null,
  pendingTelemetryHandoffs: PersistedAutomationTelemetryHandoff[],
  vehicleSensorInbox: PersistedVehicleSensorInboxSource[] = []
): PersistedAutomationStateV4 {
  // Validate every legacy field before dropping timed overrides, including entries that cannot migrate.
  const manualOverrides = parseRecord(value.manualOverrides, parseManualOverride);
  const state: PersistedAutomationStateV6 = {
    schemaVersion: 10,
    temporarySessions: {}, fixtureLeases: {}, temporaryResultOutbox: {}, temporaryEndTombstones: {}, temporaryEndProofs: {}, bioNormalConfigurations: {},
    activeOccurrences: parseRecord(value.activeOccurrences, parseOccurrence),
    pendingManualControls: {},
    manualAutomationSuppressions: {},
    vehicleRules: parseRecord(value.vehicleRules, parseVehicleRule),
    currentByFixture: parseBrightnessRecord(value.currentByFixture),
    baseBrightnessByFixture: parseBrightnessRecord(value.baseBrightnessByFixture),
    lastDesiredByFixture,
    unverifiedDesiredByFixture,
    transitionsByFixture,
    telemetryGap,
    pendingTelemetryHandoffs,
    vehicleSensorInbox,
    bioPulseInbox: {},
    bioTargetsByFixture: {},
    bioActivationsByRule: {}
  };
  return migrateV5ManualState(state, manualOverrides);
}

function migrateV5ManualState(
  state: PersistedAutomationStateV6,
  manualOverrides: Record<string, PersistedManualOverrideState>
): PersistedAutomationStateV6 {
  for (const [fixtureId, manual] of Object.entries(manualOverrides)) {
    const transition = state.transitionsByFixture[fixtureId];
    const sameCommand = transition?.sourceType === "manual_override" && transition.sourceId === manual.sourceId;
    // Explicit failure of this command wins even when its transition brightness is contradictory.
    if (sameCommand && (transition.status === "failed" || transition.status === "timed_out")) continue;
    const matchingTransition = sameCommand && transition.brightnessPercent === manual.brightnessPercent
      ? transition : undefined;
    if (matchingTransition?.phase === "pending") {
      state.pendingManualControls[parseUuid(fixtureId)] = parseManualControl({
        sourceId: manual.sourceId, brightnessPercent: manual.brightnessPercent,
        requestedAt: manual.startedAt, preBrightness: manual.preBrightness
      });
      continue;
    }
    // Missing/contradictory transitions cannot prove success, but confirmed observations still can.
    // Provisional preBrightness and unverified desired values are never completion evidence.
    const succeeded = matchingTransition?.phase === "terminal" && matchingTransition.status === "succeeded";
    if (!succeeded && state.currentByFixture[fixtureId] !== manual.brightnessPercent &&
      state.lastDesiredByFixture[fixtureId] !== manual.brightnessPercent) continue;
    const schedules = Object.entries(state.activeOccurrences)
      .filter(([, occurrence]) => Object.hasOwn(occurrence.preBrightness, fixtureId))
      .map(([scheduleId, occurrence]) => ({ scheduleId, occurrenceKey: occurrence.key }))
      .sort((left, right) => compareIdentity([left.scheduleId, left.occurrenceKey], [right.scheduleId, right.occurrenceKey]));
    const vehicleEvents = Object.entries(state.vehicleRules)
      .filter(([, rule]) => rule.targetFixtureIds.includes(fixtureId))
      .map(([ruleId, rule]) => ({ ruleId, startedAt: rule.startedAt }))
      .sort((left, right) => compareIdentity([left.ruleId, left.startedAt], [right.ruleId, right.startedAt]));
    state.manualAutomationSuppressions[parseUuid(fixtureId)] = parseManualSuppression({
      sourceId: manual.sourceId,
      // Older observation-only state has no acknowledgement time; retain request time without consulting expiry.
      appliedAt: succeeded ? matchingTransition.terminalAt! : manual.startedAt,
      schedules, vehicleEvents
    });
    state.baseBrightnessByFixture[fixtureId] = manual.brightnessPercent;
  }
  return state;
}

function recordVehicleSensorReceipt(
  state: PersistedAutomationStateV4,
  identity: VehicleSensorEventIdentity
) {
  let source = state.vehicleSensorInbox.find((candidate) => candidate.sourceUnicast === identity.sourceUnicast);
  if (!source) {
    if (state.vehicleSensorInbox.length >= MAX_VEHICLE_SENSOR_INBOX_SOURCES) {
      throw new Error("vehicle_sensor_inbox_capacity");
    }
    source = {
      sourceUnicast: identity.sourceUnicast,
      current: { bootId: identity.bootId, highWaterSequence: identity.sequence },
      recentBoots: []
    };
    state.vehicleSensorInbox.push(source);
    state.vehicleSensorInbox.sort((left, right) => left.sourceUnicast - right.sourceUnicast);
    return true;
  }
  if (source.current.bootId === identity.bootId) {
    if (identity.sequence <= source.current.highWaterSequence) return false;
    source.current.highWaterSequence = identity.sequence;
    return true;
  }
  const recent = source.recentBoots.find((boot) => boot.bootId === identity.bootId);
  if (recent) {
    recent.highWaterSequence = Math.max(recent.highWaterSequence, identity.sequence);
    return false;
  }
  source.recentBoots.unshift(source.current);
  source.recentBoots = source.recentBoots.slice(0, MAX_RECENT_VEHICLE_SENSOR_BOOTS);
  source.current = { bootId: identity.bootId, highWaterSequence: identity.sequence };
  return true;
}

function parseVehicleSensorInbox(value: unknown): PersistedVehicleSensorInboxSource[] {
  if (!Array.isArray(value) || value.length > MAX_VEHICLE_SENSOR_INBOX_SOURCES) {
    throw new Error("invalid vehicle sensor inbox");
  }
  const sources = value.map((candidate) => {
    if (!hasExactKeys(candidate, ["sourceUnicast", "current", "recentBoots"]) ||
      !isVehicleSensorUnicast(candidate.sourceUnicast) || !Array.isArray(candidate.recentBoots) ||
      candidate.recentBoots.length > MAX_RECENT_VEHICLE_SENSOR_BOOTS) {
      throw new Error("invalid vehicle sensor inbox");
    }
    const current = parseVehicleSensorBoot(candidate.current);
    const recentBoots = candidate.recentBoots.map(parseVehicleSensorBoot);
    if (recentBoots.some((boot) => boot.bootId === current.bootId) ||
      new Set(recentBoots.map((boot) => boot.bootId)).size !== recentBoots.length) {
      throw new Error("invalid vehicle sensor inbox");
    }
    return { sourceUnicast: candidate.sourceUnicast, current, recentBoots };
  });
  if (new Set(sources.map((source) => source.sourceUnicast)).size !== sources.length) {
    throw new Error("invalid vehicle sensor inbox");
  }
  return sources.sort((left, right) => left.sourceUnicast - right.sourceUnicast);
}

export function parseBioPulseReceipt(value: unknown): BioPulseReceipt {
  if (!hasExactKeys(value, ["nativeUuid", "logicalAddress", "networkId", "sequence", "connectionEpoch", "connectionGeneration"]) ||
    typeof value.nativeUuid !== "string" || !/^[0-9a-f]{12}$/.test(value.nativeUuid) ||
    !isVehicleSensorUnicast(value.logicalAddress) || !isUint32(value.networkId) || value.networkId > 0xffff ||
    !isUint32(value.sequence) || value.sequence > 255 ||
    !Number.isSafeInteger(value.connectionGeneration) || (value.connectionGeneration as number) < 1) {
    throw new Error("invalid BIO pulse receipt");
  }
  return {
    nativeUuid: value.nativeUuid, logicalAddress: value.logicalAddress, networkId: value.networkId,
    sequence: value.sequence, connectionEpoch: parseString(value.connectionEpoch),
    connectionGeneration: value.connectionGeneration as number
  };
}

function parseBioPulseInboxSource(value: unknown): PersistedBioPulseInboxSource {
  if (!hasExactKeys(value, ["receipt", "lastReceivedMonotonicMs", "recentReceipts"]) ||
    !isMonotonicTimestamp(value.lastReceivedMonotonicMs) || !Array.isArray(value.recentReceipts) ||
    value.recentReceipts.length === 0 || value.recentReceipts.length > 256) {
    throw new Error("invalid BIO pulse inbox");
  }
  const receipt = parseBioPulseReceipt(value.receipt);
  const lastReceivedMonotonicMs = value.lastReceivedMonotonicMs;
  const recentReceipts = value.recentReceipts.map(entry => {
    if (!hasExactKeys(entry, ["sequence", "receivedMonotonicMs"]) ||
      !isUint32(entry.sequence) || entry.sequence > 255 || !isMonotonicTimestamp(entry.receivedMonotonicMs) ||
      entry.receivedMonotonicMs > lastReceivedMonotonicMs) throw new Error("invalid BIO recent receipt");
    return { sequence: entry.sequence, receivedMonotonicMs: entry.receivedMonotonicMs };
  });
  if (new Set(recentReceipts.map(entry => entry.sequence)).size !== recentReceipts.length ||
    !recentReceipts.some(entry => entry.sequence === receipt.sequence && entry.receivedMonotonicMs === lastReceivedMonotonicMs)) {
    throw new Error("invalid BIO receipt history");
  }
  return { receipt, lastReceivedMonotonicMs, recentReceipts };
}

function isMonotonicTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseVehicleSensorBoot(value: unknown) {
  if (!hasExactKeys(value, ["bootId", "highWaterSequence"]) ||
    !isUint32(value.bootId) || !isUint32(value.highWaterSequence)) {
    throw new Error("invalid vehicle sensor inbox");
  }
  return { bootId: value.bootId, highWaterSequence: value.highWaterSequence };
}

function assertVehicleSensorIdentity(identity: VehicleSensorEventIdentity) {
  if (!isVehicleSensorUnicast(identity.sourceUnicast) || !isUint32(identity.bootId) || !isUint32(identity.sequence)) {
    throw new Error("invalid_vehicle_sensor_identity");
  }
}

function isVehicleSensorUnicast(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 0x7fff;
}

function isUint32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function parseTransition(value: unknown): PersistedAutomationTransitionState {
  if (!hasExactKeys(value, [
    "phase",
    "brightnessPercent",
    "sourceType",
    "sourceId",
    "occurrenceKey",
    "attempt",
    "startedAt",
    "status",
    "terminalAt"
  ])) throw new Error("invalid automation transition");
  if (value.phase !== "pending" && value.phase !== "terminal") throw new Error("invalid transition phase");
  if (!isLightingSource(value.sourceType)) throw new Error("invalid transition source");
  if (!Number.isSafeInteger(value.attempt) || (value.attempt as number) <= 0) throw new Error("invalid transition attempt");
  const status = value.status;
  if (status !== null && status !== "succeeded" && status !== "failed" && status !== "timed_out") {
    throw new Error("invalid transition status");
  }
  if ((value.phase === "pending" && (status !== null || value.terminalAt !== null)) ||
    (value.phase === "terminal" && (status === null || value.terminalAt === null))) {
    throw new Error("invalid transition terminal state");
  }
  return {
    phase: value.phase,
    brightnessPercent: parseBrightness(value.brightnessPercent),
    sourceType: value.sourceType,
    sourceId: value.sourceId === null ? null : parseString(value.sourceId),
    occurrenceKey: value.occurrenceKey === null ? null : parseString(value.occurrenceKey),
    attempt: value.attempt as number,
    startedAt: parseTimestamp(value.startedAt),
    status,
    terminalAt: value.terminalAt === null ? null : parseTimestamp(value.terminalAt)
  };
}

export function parseBioConfigurationState(value: unknown): BioConfigurationState {
  if (!hasExactKeys(value, ["configuredHighBrightnessPercent", "bioMode"]) ||
    !["sensor", "force-on", "force-off"].includes(value.bioMode as string)) {
    throw new Error("invalid BIO configuration");
  }
  return { configuredHighBrightnessPercent: parseBrightness(value.configuredHighBrightnessPercent),
    bioMode: value.bioMode as BioConfigurationState["bioMode"] };
}

export function parseBioSourceBinding(value: unknown): BioSourceBinding {
  if (!hasExactKeys(value, ["sourceFixtureId", "nativeUuid", "logicalAddress", "networkId", "capabilityRevision",
    "snapshotRevision", "profileId", "firmwareFingerprint", "sensorFingerprint"]) ||
    !isUint32(value.capabilityRevision) || !isUint32(value.snapshotRevision)) throw new Error("invalid BIO source binding");
  const receipt = parseBioPulseReceipt({ nativeUuid: value.nativeUuid, logicalAddress: value.logicalAddress,
    networkId: value.networkId, sequence: 0, connectionEpoch: "validation", connectionGeneration: 1 });
  return { sourceFixtureId: parseUuid(value.sourceFixtureId), nativeUuid: receipt.nativeUuid,
    logicalAddress: receipt.logicalAddress, networkId: receipt.networkId, capabilityRevision: value.capabilityRevision,
    snapshotRevision: value.snapshotRevision, profileId: parseString(value.profileId),
    firmwareFingerprint: parseString(value.firmwareFingerprint), sensorFingerprint: parseString(value.sensorFingerprint) };
}

function parseBioActivation(value: unknown): PersistedBioActivation {
  if (!hasExactKeys(value, ["activationId", "startedAt", "snapshotHash", "binding", "targetFixtureIds", "brightnessPercent", "health",
    "healthReason", "releaseReason", "completed", "retiredFixtureIds", "reportedResults"]) ||
    !["healthy", "degraded", "unverified"].includes(value.health as string) ||
    ![null, "hold_expired", "operator_release", "configuration_changed"].includes(value.releaseReason as null) ||
    typeof value.completed !== "boolean" || (value.completed && value.releaseReason === null) ||
    typeof value.reportedResults !== "string" || value.reportedResults.length > 128 ||
    typeof value.snapshotHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.snapshotHash)) throw new Error("invalid BIO activation");
  const binding = parseBioSourceBinding(value.binding);
  const fixtures = (input: unknown) => {
    if (!Array.isArray(input) || input.length > 10_000) throw new Error("invalid BIO activation fixtures");
    const ids = input.map(parseUuid);
    if (ids.some(id => id !== id.toLowerCase()) || new Set(ids).size !== ids.length) throw new Error("invalid BIO activation fixtures");
    return ids;
  };
  const targetFixtureIds = fixtures(value.targetFixtureIds);
  const retiredFixtureIds = fixtures(value.retiredFixtureIds);
  if (!targetFixtureIds.length || targetFixtureIds.includes(binding.sourceFixtureId.toLowerCase()) ||
    retiredFixtureIds.some(id => !targetFixtureIds.includes(id))) throw new Error("invalid BIO activation fixtures");
  const healthReason = parseString(value.healthReason);
  if (!["qualified", "health_unverified", "usb_disconnected", "identity_changed", "liveness_failed", "decoder_failed",
    "fingerprint_changed", "connection_changed"].includes(healthReason)) throw new Error("invalid BIO health reason");
  return { activationId: parseString(value.activationId), startedAt: parseTimestamp(value.startedAt), snapshotHash: value.snapshotHash, binding,
    targetFixtureIds, brightnessPercent: parseBrightness(value.brightnessPercent), health: value.health as PersistedBioActivation["health"],
    healthReason, releaseReason: value.releaseReason as PersistedBioActivation["releaseReason"], completed: value.completed,
    retiredFixtureIds, reportedResults: value.reportedResults };
}

function parseBioTargetResult(value: unknown): PersistedBioTargetResult {
  if (!hasExactKeys(value, ["status", "attempt", "at", "observed"]) ||
    !["pending", "succeeded", "failed", "timed_out"].includes(value.status as string) ||
    !Number.isSafeInteger(value.attempt) || (value.attempt as number) <= 0) throw new Error("invalid BIO target result");
  const observed = value.observed === null ? null : parseBioConfigurationState(value.observed);
  if ((value.status === "pending" && observed !== null) || (value.status === "succeeded" && observed === null)) {
    throw new Error("invalid BIO target observation");
  }
  return { status: value.status as PersistedBioTargetResult["status"], attempt: value.attempt as number,
    at: parseTimestamp(value.at), observed };
}

function parseBioTargetState(value: unknown): PersistedBioTargetState {
  if (!hasExactKeys(value, ["activationId", "sourceFixtureId", "eventBrightnessPercent", "target", "preState", "applyResult", "restoreResult"])) {
    throw new Error("invalid BIO target state");
  }
  const preState = value.preState === null ? null : parseBioConfigurationState(value.preState);
  let target: BioVerifiedLampTarget | null = null;
  if (value.target !== null) {
    const candidate = value.target;
    if (!hasExactKeys(candidate, ["kind", "nativeUuid", "logicalAddress", "networkId"]) || candidate.kind !== "unicast" ||
      typeof candidate.nativeUuid !== "string" || !/^[0-9a-f]{12}$/.test(candidate.nativeUuid) ||
      !isVehicleSensorUnicast(candidate.logicalAddress) || !Number.isInteger(candidate.networkId) ||
      (candidate.networkId as number) < 0 || (candidate.networkId as number) > 0xffff) throw new Error("invalid BIO target identity");
    target = { kind: "unicast", nativeUuid: candidate.nativeUuid, logicalAddress: candidate.logicalAddress as number,
      networkId: candidate.networkId as number };
  }
  const applyResult = parseBioTargetResult(value.applyResult);
  const restoreResult = value.restoreResult === null ? null : parseBioTargetResult(value.restoreResult);
  const eventBrightnessPercent = parseBrightness(value.eventBrightnessPercent);
  if ((preState === null) !== (target === null) ||
    (preState === null && (applyResult.status !== "failed" || applyResult.observed !== null ||
      (restoreResult !== null && (restoreResult.status !== "failed" || restoreResult.observed !== null))))) {
    // A null-base target can be explicitly closed after capture failure, but cannot
    // acquire an invented observation or a pending/successful restoration result.
    throw new Error("unverified BIO target base");
  }
  if (preState && applyResult.status === "succeeded" && !isDeepStrictEqual(applyResult.observed, bioEventConfiguration(preState, eventBrightnessPercent))) {
    throw new Error("BIO applied configuration mismatch");
  }
  if (restoreResult?.status === "succeeded" && !isDeepStrictEqual(restoreResult.observed, preState)) {
    throw new Error("BIO restored configuration mismatch");
  }
  return { activationId: parseString(value.activationId), sourceFixtureId: parseUuid(value.sourceFixtureId),
    eventBrightnessPercent, target, preState, applyResult, restoreResult };
}

export function bioEventConfiguration(base: BioConfigurationState, brightnessPercent: number): BioConfigurationState {
  return { configuredHighBrightnessPercent: brightnessPercent === 0 ? base.configuredHighBrightnessPercent : parseBrightness(brightnessPercent),
    bioMode: brightnessPercent === 0 ? "force-off" : "force-on" };
}

function parseTelemetryGap(value: unknown): PersistedAutomationTelemetryGap | null {
  if (value === null) return null;
  if (!hasExactKeys(value, [
    "handoffId", "provenance", "firstDroppedAt", "lastDroppedAt", "droppedCount"
  ]) || value.provenance !== "fixture_state_outbox") {
    throw new Error("invalid automation telemetry gap");
  }
  const firstDroppedAt = parseTimestamp(value.firstDroppedAt);
  const lastDroppedAt = parseTimestamp(value.lastDroppedAt);
  if (Date.parse(firstDroppedAt) > Date.parse(lastDroppedAt) ||
    !Number.isSafeInteger(value.droppedCount) || (value.droppedCount as number) <= 0) {
    throw new Error("invalid automation telemetry gap");
  }
  return {
    handoffId: parseString(value.handoffId),
    provenance: value.provenance,
    firstDroppedAt,
    lastDroppedAt,
    droppedCount: value.droppedCount as number
  };
}

function parseLegacyTelemetryGap(value: unknown): PersistedAutomationTelemetryGap | null {
  if (value === null) return null;
  if (!hasExactKeys(value, ["firstDroppedAt", "lastDroppedAt", "droppedCount"])) {
    throw new Error("invalid automation telemetry gap");
  }
  const firstDroppedAt = parseTimestamp(value.firstDroppedAt);
  const lastDroppedAt = parseTimestamp(value.lastDroppedAt);
  if (Date.parse(firstDroppedAt) > Date.parse(lastDroppedAt) ||
    !Number.isSafeInteger(value.droppedCount) || (value.droppedCount as number) <= 0) {
    throw new Error("invalid automation telemetry gap");
  }
  const identity = JSON.stringify({ firstDroppedAt, lastDroppedAt, droppedCount: value.droppedCount });
  return {
    handoffId: `legacy-gap-${createHash("sha256").update(identity).digest("hex")}`,
    provenance: "fixture_state_outbox",
    firstDroppedAt,
    lastDroppedAt,
    droppedCount: value.droppedCount as number
  };
}

function parseTelemetryHandoffs(value: unknown): PersistedAutomationTelemetryHandoff[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error("invalid telemetry handoffs");
  const ids = new Set<string>();
  return value.map((candidate) => {
    if (!hasExactKeys(candidate, ["handoffId", "recordsHash", "records"]) || !Array.isArray(candidate.records) ||
      candidate.records.length === 0 || candidate.records.length > 1_000) {
      throw new Error("invalid telemetry handoff");
    }
    const handoffId = parseString(candidate.handoffId);
    if (ids.has(handoffId)) throw new Error("duplicate telemetry handoff");
    ids.add(handoffId);
    const records = candidate.records.map(parseTelemetryRecord);
    const recordsHash = automationTelemetryRecordsHash(records);
    if (candidate.recordsHash !== recordsHash) throw new Error("invalid telemetry handoff hash");
    return { handoffId, recordsHash, records };
  });
}

function parseTelemetryRecord(value: unknown): AutomationTelemetryRecordInput {
  if (!hasExactKeys(value, [
    "revision", "ruleId", "occurrenceKey", "kind", "occurredAt", "payload"
  ]) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
    !isAutomationExecutionKind(value.kind) || !isRecord(value.payload)) {
    throw new Error("invalid telemetry record");
  }
  return {
    revision: value.revision as number,
    ruleId: value.ruleId === null ? null : parseString(value.ruleId),
    occurrenceKey: value.occurrenceKey === null ? null : parseString(value.occurrenceKey),
    kind: value.kind,
    occurredAt: parseTimestamp(value.occurredAt),
    payload: structuredClone(value.payload)
  };
}

function isAutomationExecutionKind(value: unknown): value is AutomationTelemetryRecordInput["kind"] {
  return value === "schedule_started" || value === "schedule_ended" || value === "vehicle_detected" ||
    value === "event_started" || value === "event_extended" || value === "event_ended" ||
    value === "action_result" || value === "telemetry_gap";
}

function parseOccurrence(value: unknown): PersistedOccurrenceState {
  if (!hasExactKeys(value, ["key", "startedAt", "endsAt", "preBrightness"])) {
    throw new Error("invalid occurrence state");
  }
  return {
    key: parseString(value.key),
    startedAt: parseTimestamp(value.startedAt),
    endsAt: parseTimestamp(value.endsAt),
    preBrightness: parseBrightnessRecord(value.preBrightness)
  };
}

function parseManualOverride(value: unknown): PersistedManualOverrideState {
  if (!hasExactKeys(value, ["sourceId", "brightnessPercent", "startedAt", "overrideUntil", "preBrightness"])) {
    throw new Error("invalid manual override state");
  }
  const startedAt = parseTimestamp(value.startedAt);
  const overrideUntil = parseTimestamp(value.overrideUntil);
  if (Date.parse(startedAt) >= Date.parse(overrideUntil)) throw new Error("invalid manual override interval");
  return {
    sourceId: parseString(value.sourceId),
    brightnessPercent: parseBrightness(value.brightnessPercent),
    startedAt,
    overrideUntil,
    preBrightness: parseBrightness(value.preBrightness)
  };
}

function parseManualControl(value: unknown): PersistedManualControlState {
  if (!hasExactKeys(value, ["sourceId", "brightnessPercent", "requestedAt", "preBrightness"])) {
    throw new Error("invalid manual control state");
  }
  return {
    sourceId: parseUuid(value.sourceId), brightnessPercent: parseBrightness(value.brightnessPercent),
    requestedAt: parseTimestamp(value.requestedAt), preBrightness: parseBrightness(value.preBrightness)
  };
}

function parseManualSuppression(value: unknown): PersistedManualAutomationSuppressionState {
  if (!hasExactKeys(value, ["sourceId", "appliedAt", "schedules", "vehicleEvents"])) {
    throw new Error("invalid manual suppression state");
  }
  const schedules = parseSortedIdentities(value.schedules, (item) => {
    if (!hasExactKeys(item, ["scheduleId", "occurrenceKey"])) throw new Error("invalid schedule suppression");
    return { scheduleId: parseUuid(item.scheduleId), occurrenceKey: parseString(item.occurrenceKey) };
  }, (item) => [item.scheduleId, item.occurrenceKey]);
  const vehicleEvents = parseSortedIdentities(value.vehicleEvents, (item) => {
    if (!hasExactKeys(item, ["ruleId", "startedAt"])) throw new Error("invalid vehicle suppression");
    return { ruleId: parseUuid(item.ruleId), startedAt: parseTimestamp(item.startedAt) };
  }, (item) => [item.ruleId, item.startedAt]);
  return { sourceId: parseUuid(value.sourceId), appliedAt: parseTimestamp(value.appliedAt), schedules, vehicleEvents };
}

function compareIdentity(left: [string, string], right: [string, string]) {
  for (let index = 0; index < 2; index += 1) {
    if (left[index]! < right[index]!) return -1;
    if (left[index]! > right[index]!) return 1;
  }
  return 0;
}

function parseSortedIdentities<T>(value: unknown, parse: (item: unknown) => T, identity: (item: T) => [string, string]): T[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error("invalid suppression identities");
  const entries = value.map(parse);
  if (entries.some((entry, index) => index > 0 && compareIdentity(identity(entries[index - 1]!), identity(entry)) >= 0)) {
    throw new Error("suppression identities must be sorted and unique");
  }
  return entries;
}

function parseFixtureRecord<T>(value: unknown, parse: (entry: unknown) => T): Record<string, T> {
  const result = parseRecord(value, parse);
  Object.keys(result).forEach(parseUuid);
  return result;
}

function parseUuid(value: unknown): string {
  const id = parseString(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("invalid UUID");
  }
  return id;
}

function parseVehicleRule(value: unknown): PersistedVehicleRuleState {
  if (!hasExactKeys(value, [
    "activeSourceFixtureIds",
    "targetFixtureIds",
    "brightnessPercent",
    "startedAt",
    "holdUntil",
    "preBrightness"
  ]) || !Array.isArray(value.activeSourceFixtureIds) || !Array.isArray(value.targetFixtureIds)) {
    throw new Error("invalid vehicle rule state");
  }
  const activeSourceFixtureIds = value.activeSourceFixtureIds.map(parseString);
  const targetFixtureIds = value.targetFixtureIds.map(parseString);
  if (new Set(activeSourceFixtureIds).size !== activeSourceFixtureIds.length ||
    new Set(targetFixtureIds).size !== targetFixtureIds.length || targetFixtureIds.length === 0) {
    throw new Error("invalid vehicle rule fixtures");
  }
  return {
    activeSourceFixtureIds,
    targetFixtureIds,
    brightnessPercent: parseBrightness(value.brightnessPercent),
    startedAt: parseTimestamp(value.startedAt),
    holdUntil: value.holdUntil === null ? null : parseTimestamp(value.holdUntil),
    preBrightness: parseBrightnessRecord(value.preBrightness)
  };
}

function parseVehicleRuleV7(value: unknown): PersistedVehicleRuleState {
  if (!isRecord(value) || !Object.hasOwn(value, "sensorProtocol")) return parseVehicleRule(value);
  const { sensorProtocol, ...legacy } = value;
  const parsed = parseVehicleRule(legacy);
  if (sensorProtocol !== "bio-usb-pulse" || parsed.activeSourceFixtureIds.length !== 0 || parsed.holdUntil === null) {
    throw new Error("invalid BIO vehicle state");
  }
  return { ...parsed, sensorProtocol };
}

function parseRecord<T>(value: unknown, parse: (entry: unknown) => T): Record<string, T> {
  if (!isRecord(value) || Object.keys(value).length > 10_000) throw new Error("invalid automation state record");
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [parseString(key), parse(entry)]));
}

function parseBrightnessRecord(value: unknown): Record<string, number> {
  return parseRecord(value, parseBrightness);
}

function parseBrightness(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error("invalid brightness");
  }
  return value;
}

function parseTimestamp(value: unknown): string {
  const timestamp = parseString(value);
  if (Number.isNaN(Date.parse(timestamp))) throw new Error("invalid timestamp");
  return timestamp;
}

function parseString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) throw new Error("invalid string");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLightingSource(value: unknown): value is PersistedAutomationTransitionState["sourceType"] {
  return value === "manual_override" || value === "vehicle_event_rule" || value === "schedule" ||
    value === "current" || value === "default";
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
