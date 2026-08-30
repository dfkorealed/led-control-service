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

export interface PersistedAutomationStateV1 {
  schemaVersion: 1;
  activeOccurrences: Record<string, PersistedOccurrenceState>;
  manualOverrides: Record<string, PersistedManualOverrideState>;
  vehicleRules: Record<string, PersistedVehicleRuleState>;
  currentByFixture: Record<string, number>;
  baseBrightnessByFixture: Record<string, number>;
  lastDesiredByFixture: Record<string, number>;
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
  private state: PersistedAutomationStateV1 | null = null;
  private available = false;
  private initialization: Promise<PersistedAutomationStateV1> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly write: StateWriter = writeJsonAtomic
  ) {}

  initialize() {
    this.initialization ??= this.restore();
    return this.initialization;
  }

  read(): PersistedAutomationStateV1 {
    if (!this.available || !this.state) {
      throw new AutomationStateStoreError("automation_state_unavailable");
    }
    return structuredClone(this.state);
  }

  async update(
    mutation: (state: PersistedAutomationStateV1) => PersistedAutomationStateV1
  ): Promise<PersistedAutomationStateV1> {
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

  private async restore(): Promise<PersistedAutomationStateV1> {
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

  private async recoverPrevious(previous: PersistedAutomationStateV1, commitError: unknown) {
    let rollbackError: unknown;
    try {
      await this.write(this.path, previous);
    } catch (error) {
      rollbackError = error;
    }

    let visible: PersistedAutomationStateV1 | null = null;
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

export function emptyAutomationState(): PersistedAutomationStateV1 {
  return {
    schemaVersion: 1,
    activeOccurrences: {},
    manualOverrides: {},
    vehicleRules: {},
    currentByFixture: {},
    baseBrightnessByFixture: {},
    lastDesiredByFixture: {}
  };
}

export function parseAutomationState(value: unknown): PersistedAutomationStateV1 {
  if (!hasExactKeys(value, [
    "schemaVersion",
    "activeOccurrences",
    "manualOverrides",
    "vehicleRules",
    "currentByFixture",
    "baseBrightnessByFixture",
    "lastDesiredByFixture"
  ]) || value.schemaVersion !== 1) throw new Error("invalid automation state");
  return {
    schemaVersion: 1,
    activeOccurrences: parseRecord(value.activeOccurrences, parseOccurrence),
    manualOverrides: parseRecord(value.manualOverrides, parseManualOverride),
    vehicleRules: parseRecord(value.vehicleRules, parseVehicleRule),
    currentByFixture: parseBrightnessRecord(value.currentByFixture),
    baseBrightnessByFixture: parseBrightnessRecord(value.baseBrightnessByFixture),
    lastDesiredByFixture: parseBrightnessRecord(value.lastDesiredByFixture)
  };
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

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
