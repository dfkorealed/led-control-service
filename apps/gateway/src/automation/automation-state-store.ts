import { isDeepStrictEqual } from "node:util";
import {
  AtomicJsonCommitUncertainError,
  readJsonFile,
  writeJsonAtomic
} from "../mesh/mesh-store-file";

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

export interface PersistedVehicleRuleState {
  activeSourceFixtureIds: string[];
  targetFixtureIds: string[];
  brightnessPercent: number;
  startedAt: string;
  holdUntil: string | null;
  preBrightness: Record<string, number>;
}

export interface PersistedAutomationTelemetryGap {
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

export interface PersistedAutomationStateV3 {
  schemaVersion: 3;
  activeOccurrences: Record<string, PersistedOccurrenceState>;
  manualOverrides: Record<string, PersistedManualOverrideState>;
  vehicleRules: Record<string, PersistedVehicleRuleState>;
  currentByFixture: Record<string, number>;
  baseBrightnessByFixture: Record<string, number>;
  lastDesiredByFixture: Record<string, number>;
  unverifiedDesiredByFixture: Record<string, number>;
  transitionsByFixture: Record<string, PersistedAutomationTransitionState>;
  telemetryGap: PersistedAutomationTelemetryGap | null;
}

type StateWriter = (path: string, value: unknown) => Promise<void>;

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
  private state: PersistedAutomationStateV3 | null = null;
  private available = false;
  private initialization: Promise<PersistedAutomationStateV3> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly write: StateWriter = writeJsonAtomic
  ) {}

  initialize() {
    this.initialization ??= this.restore();
    return this.initialization;
  }

  read(): PersistedAutomationStateV3 {
    if (!this.available || !this.state) {
      throw new AutomationStateStoreError("automation_state_unavailable");
    }
    return structuredClone(this.state);
  }

  async update(
    mutation: (state: PersistedAutomationStateV3) => PersistedAutomationStateV3
  ): Promise<PersistedAutomationStateV3> {
    await this.initialize();
    return this.exclusive(async () => {
      const previous = this.read();
      const next = parseAutomationState(mutation(structuredClone(previous)));
      if (isDeepStrictEqual(previous, next)) return previous;

      try {
        await this.write(this.path, next);
      } catch (error) {
        if (!(error instanceof AtomicJsonCommitUncertainError)) {
          throw new AutomationStateStoreError("automation_state_store_failed", { cause: error });
        }
        await this.recoverPrevious(previous, error);
        throw new AutomationStateCommitUncertainError({ cause: error });
      }

      this.state = next;
      this.available = true;
      return structuredClone(next);
    });
  }

  recordTelemetryGap(firstDroppedAt: string, droppedCount: number, lastDroppedAt = firstDroppedAt) {
    const firstTimestamp = parseTimestamp(firstDroppedAt);
    const lastTimestamp = parseTimestamp(lastDroppedAt);
    if (Date.parse(firstTimestamp) > Date.parse(lastTimestamp)) throw new Error("invalid telemetry gap interval");
    if (!Number.isSafeInteger(droppedCount) || droppedCount <= 0) {
      throw new Error("invalid telemetry gap count");
    }
    return this.update((state) => {
      const current = state.telemetryGap;
      state.telemetryGap = current ? {
        firstDroppedAt: Date.parse(firstTimestamp) < Date.parse(current.firstDroppedAt)
          ? firstTimestamp
          : current.firstDroppedAt,
        lastDroppedAt: Date.parse(lastTimestamp) > Date.parse(current.lastDroppedAt)
          ? lastTimestamp
          : current.lastDroppedAt,
        droppedCount: Math.min(Number.MAX_SAFE_INTEGER, current.droppedCount + droppedCount)
      } : {
        firstDroppedAt: firstTimestamp,
        lastDroppedAt: lastTimestamp,
        droppedCount
      };
      return state;
    });
  }

  async clearTelemetryGap(expected: PersistedAutomationTelemetryGap) {
    let cleared = false;
    await this.update((state) => {
      if (!isDeepStrictEqual(state.telemetryGap, expected)) return state;
      state.telemetryGap = null;
      cleared = true;
      return state;
    });
    return cleared;
  }

  private async restore(): Promise<PersistedAutomationStateV3> {
    let raw: unknown | null;
    try {
      raw = await readJsonFile(this.path);
    } catch (error) {
      throw new AutomationStateStoreError("automation_state_corrupt", { cause: error });
    }

    if (raw === null) {
      const initial = emptyAutomationState();
      try {
        await this.write(this.path, initial);
      } catch (error) {
        if (error instanceof AtomicJsonCommitUncertainError) {
          throw new AutomationStateCommitUncertainError({ cause: error });
        }
        throw new AutomationStateStoreError("automation_state_store_failed", { cause: error });
      }
      this.state = initial;
      this.available = true;
      return structuredClone(initial);
    }

    try {
      this.state = parseAutomationState(raw);
      this.available = true;
      return structuredClone(this.state);
    } catch (error) {
      throw new AutomationStateStoreError("automation_state_corrupt", { cause: error });
    }
  }

  private async recoverPrevious(previous: PersistedAutomationStateV3, commitError: unknown) {
    let rollbackError: unknown;
    try {
      await this.write(this.path, previous);
    } catch (error) {
      rollbackError = error;
    }

    let visible: PersistedAutomationStateV3 | null = null;
    let readbackError: unknown;
    try {
      const raw = await readJsonFile(this.path);
      visible = raw === null ? null : parseAutomationState(raw);
    } catch (error) {
      readbackError = error;
    }

    if (!isDeepStrictEqual(visible, previous)) {
      this.available = false;
      throw new AutomationStateCommitUncertainError({
        cause: new AggregateError(
          [commitError, rollbackError, readbackError].filter(Boolean),
          "automation state visibility recovery failed"
        )
      });
    }
    this.state = previous;
    this.available = true;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function emptyAutomationState(): PersistedAutomationStateV3 {
  return {
    schemaVersion: 3,
    activeOccurrences: {},
    manualOverrides: {},
    vehicleRules: {},
    currentByFixture: {},
    baseBrightnessByFixture: {},
    lastDesiredByFixture: {},
    unverifiedDesiredByFixture: {},
    transitionsByFixture: {},
    telemetryGap: null
  };
}

export function parseAutomationState(value: unknown): PersistedAutomationStateV3 {
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
      null
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
      parseTelemetryGap(value.telemetryGap)
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
    "telemetryGap"
  ]) || value.schemaVersion !== 3) throw new Error("invalid automation state");
  return parseAutomationStateFields(
    value,
    parseBrightnessRecord(value.lastDesiredByFixture),
    parseBrightnessRecord(value.unverifiedDesiredByFixture),
    parseRecord(value.transitionsByFixture, parseTransition),
    parseTelemetryGap(value.telemetryGap)
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
  telemetryGap: PersistedAutomationTelemetryGap | null
): PersistedAutomationStateV3 {
  return {
    schemaVersion: 3,
    activeOccurrences: parseRecord(value.activeOccurrences, parseOccurrence),
    manualOverrides: parseRecord(value.manualOverrides, parseManualOverride),
    vehicleRules: parseRecord(value.vehicleRules, parseVehicleRule),
    currentByFixture: parseBrightnessRecord(value.currentByFixture),
    baseBrightnessByFixture: parseBrightnessRecord(value.baseBrightnessByFixture),
    lastDesiredByFixture,
    unverifiedDesiredByFixture,
    transitionsByFixture,
    telemetryGap
  };
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

function parseTelemetryGap(value: unknown): PersistedAutomationTelemetryGap | null {
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
  return { firstDroppedAt, lastDroppedAt, droppedCount: value.droppedCount as number };
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
