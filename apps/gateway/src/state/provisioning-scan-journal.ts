import { stat } from "node:fs/promises";
import {
  mqttTopicsV2,
  provisioningScanCompletedSchema,
  provisioningScanFailedSchema,
  provisioningScanStartSchema,
  type ProvisioningScanStartPayload
} from "@led-control/shared";
import { readJsonFile, writeJsonAtomic } from "../mesh/mesh-store-file";

const MAX_RECORDS = 1_000;
const RETENTION_MS = 24 * 60 * 60 * 1000;

export type ProvisioningScanTerminalEvent = {
  topic: string;
  payload: ReturnType<typeof provisioningScanCompletedSchema.parse> | ReturnType<typeof provisioningScanFailedSchema.parse>;
};

type StoredRecord = {
  command: ProvisioningScanStartPayload;
  state: "running" | "terminal";
  terminal?: ProvisioningScanTerminalEvent;
  deliveredAt?: string;
  updatedAt: string;
};

type StoredJournal = {
  version: 1;
  records: Record<string, StoredRecord>;
};

export type ProvisioningScanJournalBegin =
  | { kind: "new" }
  | { kind: "running" }
  | { kind: "recovered" }
  | { kind: "terminal"; terminal: ProvisioningScanTerminalEvent; delivered: boolean };

type JournalOptions = {
  now?: () => Date;
  maxRecords?: number;
  retentionMs?: number;
};

export class ProvisioningScanJournal {
  private readonly now: () => Date;
  private readonly maxRecords: number;
  private readonly retentionMs: number;
  private state: StoredJournal | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly localRunning = new Set<string>();

  constructor(
    private readonly path: string,
    options: JournalOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.maxRecords = options.maxRecords ?? MAX_RECORDS;
    this.retentionMs = options.retentionMs ?? RETENTION_MS;
    if (!Number.isInteger(this.maxRecords) || this.maxRecords <= 0) throw new Error("invalid provisioning scan journal record limit");
    if (!Number.isInteger(this.retentionMs) || this.retentionMs <= 0) throw new Error("invalid provisioning scan journal retention");
  }

  initialize() {
    return this.exclusive(async () => {
      await this.load();
    });
  }

  begin(command: ProvisioningScanStartPayload): Promise<ProvisioningScanJournalBegin> {
    return this.exclusive(async () => {
      const parsed = provisioningScanStartSchema.parse(command);
      const state = await this.load();
      if (this.prune(state)) await this.persist(state);
      const key = logicalScanKey(parsed);
      const existing = state.records[key];
      if (existing) {
        if (!sameCommand(existing.command, parsed)) throw new Error("provisioning scan journal logical key scope mismatch");
        if (existing.state === "terminal" && existing.terminal) {
          return { kind: "terminal", terminal: existing.terminal, delivered: Boolean(existing.deliveredAt) };
        }
        if (existing.state !== "running") throw new Error("invalid provisioning scan journal");
        return this.localRunning.has(key) ? { kind: "running" } : { kind: "recovered" };
      }
      if (this.prune(state, true)) await this.persist(state);
      if (Object.keys(state.records).length >= this.maxRecords) {
        throw new Error(`provisioning scan journal exceeds the supported limit (${this.maxRecords})`);
      }
      state.records[key] = { command: parsed, state: "running", updatedAt: this.now().toISOString() };
      await this.persist(state);
      this.localRunning.add(key);
      return { kind: "new" };
    });
  }

  complete(command: ProvisioningScanStartPayload, terminal: ProvisioningScanTerminalEvent): Promise<ProvisioningScanTerminalEvent> {
    return this.exclusive(async () => {
      const parsed = provisioningScanStartSchema.parse(command);
      const parsedTerminal = parseTerminal(parsed, terminal);
      const state = await this.load();
      const key = logicalScanKey(parsed);
      const existing = state.records[key];
      if (!existing || !sameCommand(existing.command, parsed)) throw new Error("provisioning scan must be journaled before terminal completion");
      if (existing.state === "terminal" && existing.terminal) return existing.terminal;
      state.records[key] = { command: parsed, state: "terminal", terminal: parsedTerminal, updatedAt: this.now().toISOString() };
      this.localRunning.delete(key);
      await this.persist(state);
      return parsedTerminal;
    });
  }

  recoverRunning(createTerminal: (command: ProvisioningScanStartPayload) => Promise<ProvisioningScanTerminalEvent>): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.load();
      const recovered = Object.entries(state.records)
        .filter(([, record]) => record.state === "running")
        .sort(([left], [right]) => left.localeCompare(right));
      if (recovered.length === 0) return;

      const terminals = await Promise.all(recovered.map(async ([key, record]) => ({
        key,
        command: record.command,
        terminal: parseTerminal(record.command, await createTerminal(record.command))
      })));
      const updatedAt = this.now().toISOString();
      for (const { key, command, terminal } of terminals) {
        state.records[key] = { command, state: "terminal", terminal, updatedAt };
        this.localRunning.delete(key);
      }
      await this.persist(state);
    });
  }

  pendingTerminals(): Promise<ProvisioningScanTerminalEvent[]> {
    return this.exclusive(async () => {
      const state = await this.load();
      if (this.prune(state)) await this.persist(state);
      return Object.entries(state.records)
        .filter(([, record]) => record.state === "terminal" && record.terminal && !record.deliveredAt)
        .sort(([, left], [, right]) => left.updatedAt.localeCompare(right.updatedAt))
        .map(([, record]) => record.terminal!);
    });
  }

  markDelivered(terminal: ProvisioningScanTerminalEvent): Promise<boolean> {
    return this.exclusive(async () => {
      const state = await this.load();
      const payload = terminal.payload;
      const key = `${payload.sessionId}:${payload.scanCorrelationId}:${payload.scanAttempt}`;
      const record = state.records[key];
      if (!record || record.state !== "terminal" || !record.terminal) return false;
      const parsed = parseTerminal(record.command, terminal);
      if (!sameTerminal(record.terminal, parsed) || record.deliveredAt) return false;
      record.deliveredAt = this.now().toISOString();
      record.updatedAt = record.deliveredAt;
      await this.persist(state);
      return true;
    });
  }

  private async load() {
    if (this.state) return this.state;
    await this.assertOwnerOnlyPermissions();
    try {
      const raw = await readJsonFile(this.path);
      if (raw === null) {
        this.state = { version: 1, records: {} };
        return this.state;
      }
      this.state = parseJournal(raw, this.maxRecords);
      return this.state;
    } catch {
      throw new Error("invalid provisioning scan journal");
    }
  }

  private async assertOwnerOnlyPermissions() {
    try {
      const file = await stat(this.path);
      if ((file.mode & 0o777) !== 0o600) throw new Error("unsafe provisioning scan journal permissions");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  private prune(state: StoredJournal, reserveSlot = false) {
    const now = this.now().getTime();
    let changed = false;
    for (const [key, record] of Object.entries(state.records)) {
      if (record.state === "terminal" && now - new Date(record.updatedAt).getTime() > this.retentionMs) {
        delete state.records[key];
        changed = true;
      }
    }
    const terminalRecords = Object.entries(state.records)
      .filter(([, record]) => record.state === "terminal")
      .sort(([, left], [, right]) => left.updatedAt.localeCompare(right.updatedAt));
    // Running entries are never evicted: losing one would permit a duplicate physical scan after restart.
    const limit = reserveSlot ? this.maxRecords - 1 : this.maxRecords;
    while (Object.keys(state.records).length > limit && terminalRecords.length > 0) {
      const oldest = terminalRecords.shift();
      if (!oldest) break;
      delete state.records[oldest[0]];
      changed = true;
    }
    return changed;
  }

  private async persist(state: StoredJournal) {
    await writeJsonAtomic(this.path, state);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function parseJournal(value: unknown, maxRecords: number): StoredJournal {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.records)) throw new Error("invalid provisioning scan journal");
  const entries = Object.entries(value.records);
  if (entries.length > maxRecords) throw new Error("invalid provisioning scan journal");
  const records: Record<string, StoredRecord> = {};
  for (const [key, value] of entries) {
    if (!isRecord(value) || (value.state !== "running" && value.state !== "terminal") || typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt))) {
      throw new Error("invalid provisioning scan journal");
    }
    const command = provisioningScanStartSchema.parse(value.command);
    if (key !== logicalScanKey(command)) throw new Error("invalid provisioning scan journal");
    if (value.state === "running") {
      if (value.terminal !== undefined) throw new Error("invalid provisioning scan journal");
      records[key] = { command, state: "running", updatedAt: value.updatedAt };
      continue;
    }
    if (value.deliveredAt !== undefined && (typeof value.deliveredAt !== "string" || Number.isNaN(Date.parse(value.deliveredAt)))) {
      throw new Error("invalid provisioning scan journal");
    }
    records[key] = {
      command,
      state: "terminal",
      terminal: parseTerminal(command, value.terminal),
      updatedAt: value.updatedAt,
      ...(value.deliveredAt ? { deliveredAt: value.deliveredAt } : {})
    };
  }
  return { version: 1, records };
}

function parseTerminal(command: ProvisioningScanStartPayload, value: unknown): ProvisioningScanTerminalEvent {
  if (!isRecord(value) || typeof value.topic !== "string") throw new Error("invalid provisioning scan journal");
  const completed = provisioningScanCompletedSchema.safeParse(value.payload);
  const failed = completed.success ? null : provisioningScanFailedSchema.safeParse(value.payload);
  const payload = completed.success ? completed.data : failed?.success ? failed.data : null;
  if (!payload) throw new Error("invalid provisioning scan journal");
  if (
    payload.sessionId !== command.sessionId ||
    payload.siteId !== command.siteId ||
    payload.gatewayId !== command.gatewayId ||
    payload.scanCorrelationId !== command.scanCorrelationId ||
    payload.scanAttempt !== command.scanAttempt
  ) throw new Error("invalid provisioning scan journal");
  const expectedTopic = completed.success
    ? mqttTopicsV2.provisioningScanCompleted(command.siteId, command.gatewayId)
    : mqttTopicsV2.provisioningScanFailed(command.siteId, command.gatewayId);
  if (value.topic !== expectedTopic) throw new Error("invalid provisioning scan journal");
  return { topic: value.topic, payload };
}

function logicalScanKey(command: ProvisioningScanStartPayload) {
  return `${command.sessionId}:${command.scanCorrelationId}:${command.scanAttempt}`;
}

function sameCommand(left: ProvisioningScanStartPayload, right: ProvisioningScanStartPayload) {
  return left.sessionId === right.sessionId &&
    left.scanCorrelationId === right.scanCorrelationId &&
    left.scanAttempt === right.scanAttempt &&
    left.siteId === right.siteId &&
    left.gatewayId === right.gatewayId &&
    left.floorId === right.floorId;
}

function sameTerminal(left: ProvisioningScanTerminalEvent, right: ProvisioningScanTerminalEvent) {
  return left.topic === right.topic &&
    left.payload.eventId === right.payload.eventId &&
    left.payload.sequence === right.payload.sequence &&
    left.payload.occurredAt === right.payload.occurredAt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
