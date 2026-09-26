import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../mesh/mesh-store-file";

interface JournalRecord {
  state: "accepted" | "completed";
  command: unknown;
  result?: unknown;
  automationHandoff: "not_required" | "pending" | "completed";
  automationAbort?: "pending" | "completed";
  executionPhase?: "pre_rf" | "may_have_written";
  updatedAt: string;
}

interface FixtureSnapshot {
  fixtureId: string;
  status: string;
  brightness?: number;
  faultCode?: string;
  errorMessage?: string;
  rssi?: number | null;
  hopCount?: number | null;
  occurredAt: string;
}

interface JournalData {
  version: 3;
  records: Record<string, JournalRecord>;
  fixtureSnapshots: Record<string, FixtureSnapshot>;
}

interface JournalOptions {
  now?: () => Date;
  ttlMs?: number;
  maxRecords?: number;
  maxPendingAutomationRecords?: number;
}

export class CommandJournalAutomationCapacityError extends Error {
  readonly code = "COMMAND_AUTOMATION_HANDOFF_CAPACITY";

  constructor(readonly limit: number) {
    super("pending automation handoff capacity is full");
    this.name = "CommandJournalAutomationCapacityError";
  }
}

export class CommandJournal {
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly maxRecords: number;
  private readonly maxPendingAutomationRecords: number;

  constructor(
    private readonly path: string,
    options: JournalOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxRecords = options.maxRecords ?? 10_000;
    this.maxPendingAutomationRecords = positiveLimit(
      options.maxPendingAutomationRecords ?? 10_000,
      "maxPendingAutomationRecords"
    );
  }

  async get(idempotencyKey: string) {
    const data = await this.readData();
    const record = data.records[idempotencyKey];
    if (!record || (!isPendingAutomationRecovery(record) && this.isExpired(record))) return null;
    return {
      state: record.state,
      command: record.command,
      ...(record.result === undefined ? {} : { result: record.result }),
      ...(record.executionPhase ? { executionPhase: record.executionPhase } : {}),
      ...(record.automationAbort ? { automationAbort: record.automationAbort } : {}),
      ...(record.automationHandoff === "not_required" ? {} : { automationHandoff: record.automationHandoff })
    };
  }

  async latestFixtureSnapshots() {
    return Object.values((await this.readData()).fixtureSnapshots).sort((left, right) => left.fixtureId.localeCompare(right.fixtureId));
  }

  async accept(idempotencyKey: string, command: unknown, options: { terminalResult?: unknown; executionPhase?: "pre_rf" } = {}) {
    return this.enqueue(async () => {
      const data = await this.readData();
      this.prune(data);
      if (data.records[idempotencyKey]) return false;
      const terminal = options.terminalResult !== undefined;
      if (!terminal && isManualCommandWrapper(command)) this.assertAutomationCapacity(data);
      // Refusals have never acquired RF ownership. Persist their full result in
      // the first fsync so a restart cannot turn them into accepted/unknown work.
      data.records[idempotencyKey] = {
        state: terminal ? "completed" : "accepted",
        command,
        ...(terminal ? { result: options.terminalResult } : {}),
        ...(!terminal && options.executionPhase ? { executionPhase: options.executionPhase } : {}),
        automationHandoff: "not_required",
        updatedAt: this.now().toISOString()
      };
      this.prune(data);
      await this.writeData(data);
      return true;
    });
  }

  async complete(
    idempotencyKey: string,
    result: unknown,
    options: { automationHandoffPending?: boolean; automationAbortPending?: boolean } = {}
  ) {
    await this.enqueue(async () => {
      const data = await this.readData();
      const existing = data.records[idempotencyKey];
      if (!existing) throw new Error("command must be accepted before completion");
      if (options.automationHandoffPending && options.automationAbortPending) throw new Error("abort and handoff are mutually exclusive");
      if ((options.automationHandoffPending || options.automationAbortPending) && !isPendingAutomationRecovery(existing)) {
        this.assertAutomationCapacity(data);
      }
      data.records[idempotencyKey] = {
        ...existing,
        state: "completed",
        result,
        automationHandoff: options.automationHandoffPending ? "pending" : "not_required",
        ...(options.automationAbortPending ? { automationAbort: "pending" as const } : {}),
        updatedAt: this.now().toISOString()
      };
      this.updateSnapshots(data, result);
      this.prune(data);
      await this.writeData(data);
    });
  }

  async pendingAutomationHandoffs() {
    const data = await this.readData();
    return Object.entries(data.records)
      .filter(([, record]) => record.state === "completed" && record.automationHandoff === "pending")
      .sort(([, left], [, right]) => left.updatedAt.localeCompare(right.updatedAt))
      .map(([idempotencyKey, record]) => ({
        idempotencyKey,
        command: record.command,
        result: record.result
      }));
  }

  async pendingAutomationRecoveries() {
    const data = await this.readData();
    return Object.entries(data.records)
      .filter(([, record]) => isPendingAutomationRecovery(record))
      .sort(([, left], [, right]) => left.updatedAt.localeCompare(right.updatedAt))
      .map(([idempotencyKey, record]) => ({
        idempotencyKey,
        state: record.state,
        ...(record.executionPhase ? { executionPhase: record.executionPhase } : {}),
        ...(record.automationAbort ? { automationAbort: record.automationAbort } : {}),
        command: record.command,
        ...(record.result === undefined ? {} : { result: record.result })
      }));
  }

  async markAutomationHandoffComplete(idempotencyKey: string) {
    await this.enqueue(async () => {
      const data = await this.readData();
      const existing = data.records[idempotencyKey];
      if (!existing || existing.state !== "completed") throw new Error("command must be completed before automation handoff");
      if (existing.automationHandoff === "completed") return;
      if (existing.automationHandoff !== "pending") throw new Error("automation handoff is not pending");
      existing.automationHandoff = "completed";
      existing.updatedAt = this.now().toISOString();
      await this.writeData(data);
    });
  }

  async markExecutionMayHaveStarted(idempotencyKey: string) {
    await this.enqueue(async () => {
      const data = await this.readData();
      const record = data.records[idempotencyKey];
      if (!record || record.state !== "accepted" || !record.executionPhase) throw new Error("command must have a durable pre-RF phase");
      // Commit before handing control to the adapter. A crash from here onward
      // cannot prove the absence of a physical write, even if submission failed.
      record.executionPhase = "may_have_written";
      record.updatedAt = this.now().toISOString();
      await this.writeData(data);
    });
  }

  async markAutomationAbortComplete(idempotencyKey: string) {
    await this.enqueue(async () => {
      const data = await this.readData();
      const record = data.records[idempotencyKey];
      if (!record || record.state !== "completed" || !record.automationAbort) throw new Error("automation abort is not pending");
      if (record.automationAbort === "completed") return;
      record.automationAbort = "completed";
      record.updatedAt = this.now().toISOString();
      await this.writeData(data);
    });
  }

  private updateSnapshots(data: JournalData, result: unknown) {
    if (!result || typeof result !== "object" || !("deviceStatus" in result)) return;
    if ((result as { fixtureStateObserved?: unknown }).fixtureStateObserved === false) return;
    const deviceStatus = (result as { deviceStatus?: unknown }).deviceStatus;
    if (!deviceStatus || typeof deviceStatus !== "object") return;
    const row = deviceStatus as { occurredAt?: unknown; results?: unknown };
    if (typeof row.occurredAt !== "string" || !Array.isArray(row.results)) return;
    const observedIds = (result as { observedFixtureIds?: string[] }).observedFixtureIds;
    for (const item of row.results) {
      if (!item || typeof item !== "object" || typeof (item as { fixtureId?: unknown }).fixtureId !== "string") continue;
      const fixture = item as Record<string, unknown> & { fixtureId: string };
      // Partial status checks must not replace the last actual observation of a
      // missing fixture with a timeout. Legacy results without IDs keep their format.
      if (observedIds && !observedIds.includes(fixture.fixtureId)) continue;
      data.fixtureSnapshots[fixture.fixtureId] = {
        fixtureId: fixture.fixtureId,
        status: typeof fixture.status === "string" ? fixture.status : "failed",
        ...(typeof fixture.brightness === "number" ? { brightness: fixture.brightness } : {}),
        ...(typeof fixture.faultCode === "string" ? { faultCode: fixture.faultCode } : {}),
        ...(typeof fixture.errorMessage === "string" ? { errorMessage: fixture.errorMessage } : {}),
        ...(typeof fixture.rssi === "number" || fixture.rssi === null ? { rssi: fixture.rssi } : {}),
        ...(typeof fixture.hopCount === "number" || fixture.hopCount === null ? { hopCount: fixture.hopCount } : {}),
        occurredAt: row.occurredAt
      };
    }
  }

  private prune(data: JournalData) {
    for (const [key, record] of Object.entries(data.records)) {
      if (!isPendingAutomationRecovery(record) && this.isExpired(record)) delete data.records[key];
    }
    const overflow = Object.entries(data.records)
      .filter(([, record]) => !isPendingAutomationRecovery(record))
      .sort(([, left], [, right]) => left.updatedAt.localeCompare(right.updatedAt));
    while (overflow.length > this.maxRecords) {
      const oldest = overflow.shift();
      if (oldest) delete data.records[oldest[0]];
    }
  }

  private isExpired(record: JournalRecord) {
    return this.now().getTime() - new Date(record.updatedAt).getTime() > this.ttlMs;
  }

  private assertAutomationCapacity(data: JournalData) {
    const pending = Object.values(data.records).filter(isPendingAutomationRecovery).length;
    if (pending >= this.maxPendingAutomationRecords) {
      throw new CommandJournalAutomationCapacityError(this.maxPendingAutomationRecords);
    }
  }

  private async readData(): Promise<JournalData> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid command journal");
      const row = parsed as {
        version?: number;
        records?: Record<string, Omit<JournalRecord, "automationHandoff"> & {
          automationHandoff?: JournalRecord["automationHandoff"];
        }>;
        fixtureSnapshots?: Record<string, FixtureSnapshot>;
      };
      if (row.version === 3 && row.records && row.fixtureSnapshots) return row as JournalData;

      if (row.version === 2 && row.records && row.fixtureSnapshots) {
        return {
          version: 3,
          fixtureSnapshots: row.fixtureSnapshots,
          records: Object.fromEntries(Object.entries(row.records).map(([key, record]) => [key, {
            ...record,
            automationHandoff: needsConservativeHandoff(record) ? "pending" : "not_required"
          }]))
        };
      }

      const migrated: JournalData = { version: 3, records: {}, fixtureSnapshots: {} };
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== "object") continue;
        const legacy = value as { state?: unknown; command?: unknown; result?: unknown };
        if (legacy.state !== "accepted" && legacy.state !== "completed") continue;
        migrated.records[key] = {
          state: legacy.state,
          command: legacy.command,
          ...(legacy.result === undefined ? {} : { result: legacy.result }),
          automationHandoff: "not_required",
          updatedAt: this.now().toISOString()
        };
        if (legacy.result !== undefined) this.updateSnapshots(migrated, legacy.result);
      }
      return migrated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 3, records: {}, fixtureSnapshots: {} };
      throw error;
    }
  }

  private async writeData(data: JournalData) {
    await writeJsonAtomic(this.path, data);
  }

  private enqueue<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(mutation, mutation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

function needsConservativeHandoff(record: Pick<JournalRecord, "state" | "command">) {
  if (record.state !== "completed") return false;
  return isManualCommandWrapper(record.command);
}

function isManualCommandWrapper(value: unknown) {
  const wrapper = value as { command?: { overrideUntil?: unknown; targetFixtureIds?: unknown; brightness?: unknown } };
  const command = wrapper?.command;
  // Legacy journals identify timed controls by overrideUntil; new controls have target and brightness only.
  return typeof command?.overrideUntil === "string" ||
    (Array.isArray(command?.targetFixtureIds) && typeof command?.brightness === "number");
}

function isPendingAutomationRecovery(record: Pick<JournalRecord, "state" | "command" | "automationHandoff" | "automationAbort">) {
  return record.automationAbort === "pending" || (record.state === "completed" && record.automationHandoff === "pending") ||
    (record.state === "accepted" && isManualCommandWrapper(record.command));
}

function positiveLimit(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}
