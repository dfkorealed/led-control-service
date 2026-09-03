import { stat } from "node:fs/promises";
import {
  applicationProvisioningDeviceTerminalIngestedAckV2Schema,
  mqttTopicsV2,
  provisioningDeviceCommandV2Schema,
  provisioningDeviceTerminalV2Schema,
  type ProvisioningDeviceCommandV2,
  type ProvisioningDeviceTerminalV2
} from "@led-control/shared";
import { readJsonFile, writeJsonAtomic } from "../mesh/mesh-store-file";

const MAX_RECORDS = 1_000;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PUBLISH_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_INITIAL_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

export type ProvisioningDeviceTerminalEvent = {
  topic: string;
  payload: ProvisioningDeviceTerminalV2;
};

type StoredRecord = {
  command: ProvisioningDeviceCommandV2;
  state: "accepted" | "terminal";
  terminal?: ProvisioningDeviceTerminalEvent;
  acknowledgedAt?: string;
  applicationIngestedAt?: string;
  updatedAt: string;
};

type StoredJournal = {
  version: 1;
  records: Record<string, StoredRecord>;
  pendingTerminalCommandIds: string[];
};

export type ProvisioningDeviceJournalAccept =
  | { kind: "new" }
  | { kind: "running" }
  | { kind: "recovered" }
  | { kind: "terminal"; terminal: ProvisioningDeviceTerminalEvent; pending: boolean };

type JournalOptions = {
  now?: () => Date;
  maxRecords?: number;
  retentionMs?: number;
  write?: typeof writeJsonAtomic;
};

type ProvisioningDeviceIdentityKey =
  | "commandId"
  | "sessionId"
  | "siteId"
  | "gatewayId"
  | "nodeId"
  | "deviceUuid"
  | "meshAddress";
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type ProvisioningDeviceTerminalDetails = DistributiveOmit<
  ProvisioningDeviceTerminalV2,
  ProvisioningDeviceIdentityKey
>;

export class ProvisioningDeviceJournal {
  private readonly now: () => Date;
  private readonly maxRecords: number;
  private readonly retentionMs: number;
  private readonly write: typeof writeJsonAtomic;
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
    this.write = options.write ?? writeJsonAtomic;
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1) {
      throw new Error("invalid provisioning device journal record limit");
    }
    if (!Number.isSafeInteger(this.retentionMs) || this.retentionMs < 1) {
      throw new Error("invalid provisioning device journal retention");
    }
  }

  initialize() {
    return this.exclusive(async () => {
      await this.load();
    });
  }

  accept(command: ProvisioningDeviceCommandV2): Promise<ProvisioningDeviceJournalAccept> {
    return this.exclusive(async () => {
      const parsed = provisioningDeviceCommandV2Schema.parse(command);
      const current = await this.load();
      const next = cloneJournal(current);
      const changed = this.prune(next);
      const existing = next.records[parsed.commandId];
      if (existing) {
        if (!sameCommand(existing.command, parsed)) {
          throw new Error("provisioning device command identity conflict");
        }
        if (changed) await this.persist(next);
        if (existing.state === "terminal" && existing.terminal) {
          return {
            kind: "terminal",
            terminal: existing.terminal,
            pending: next.pendingTerminalCommandIds.includes(parsed.commandId)
          };
        }
        if (existing.state !== "accepted") throw new Error("invalid provisioning device journal");
        return this.localRunning.has(parsed.commandId) ? { kind: "running" } : { kind: "recovered" };
      }

      if (Object.keys(next.records).length >= this.maxRecords) {
        throw new Error(`provisioning device journal exceeds the supported limit (${this.maxRecords})`);
      }
      next.records[parsed.commandId] = {
        command: parsed,
        state: "accepted",
        updatedAt: this.now().toISOString()
      };
      await this.persist(next);
      this.localRunning.add(parsed.commandId);
      return { kind: "new" };
    });
  }

  complete(
    command: ProvisioningDeviceCommandV2,
    terminal: ProvisioningDeviceTerminalEvent
  ): Promise<ProvisioningDeviceTerminalEvent> {
    return this.exclusive(async () => {
      const parsed = provisioningDeviceCommandV2Schema.parse(command);
      const parsedTerminal = parseTerminal(parsed, terminal);
      const current = await this.load();
      const existing = current.records[parsed.commandId];
      if (!existing || !sameCommand(existing.command, parsed)) {
        throw new Error("provisioning device command must be accepted before terminal completion");
      }
      if (existing.state === "terminal" && existing.terminal) return existing.terminal;
      if (existing.state !== "accepted") throw new Error("invalid provisioning device journal");

      const next = cloneJournal(current);
      next.records[parsed.commandId] = {
        command: parsed,
        state: "terminal",
        terminal: parsedTerminal,
        updatedAt: this.now().toISOString()
      };
      if (!next.pendingTerminalCommandIds.includes(parsed.commandId)) {
        next.pendingTerminalCommandIds.push(parsed.commandId);
      }
      await this.persist(next);
      this.localRunning.delete(parsed.commandId);
      return parsedTerminal;
    });
  }

  recoverAccepted(
    createTerminal: (command: ProvisioningDeviceCommandV2) => Promise<ProvisioningDeviceTerminalEvent>
  ): Promise<void> {
    return this.exclusive(async () => {
      const current = await this.load();
      const accepted = Object.values(current.records)
        .filter((record) => record.state === "accepted" && !this.localRunning.has(record.command.commandId))
        .sort((left, right) => left.command.commandId.localeCompare(right.command.commandId));
      if (accepted.length === 0) return;

      const recovered = await Promise.all(accepted.map(async (record) => ({
        command: record.command,
        terminal: parseTerminal(record.command, await createTerminal(record.command))
      })));
      const next = cloneJournal(current);
      const updatedAt = this.now().toISOString();
      for (const { command, terminal } of recovered) {
        next.records[command.commandId] = {
          command,
          state: "terminal",
          terminal,
          updatedAt
        };
        if (!next.pendingTerminalCommandIds.includes(command.commandId)) {
          next.pendingTerminalCommandIds.push(command.commandId);
        }
      }
      await this.persist(next);
    });
  }

  pendingTerminals(): Promise<ProvisioningDeviceTerminalEvent[]> {
    return this.exclusive(async () => {
      const current = await this.load();
      const next = cloneJournal(current);
      if (this.prune(next)) await this.persist(next);
      return next.pendingTerminalCommandIds
        .map((commandId) => next.records[commandId])
        .filter((record): record is StoredRecord & { terminal: ProvisioningDeviceTerminalEvent } =>
          record?.state === "terminal" && Boolean(record.terminal))
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
        .map((record) => record.terminal);
    });
  }

  acknowledgeTerminal(acknowledgement: unknown): Promise<boolean> {
    return this.exclusive(async () => {
      const ack = applicationProvisioningDeviceTerminalIngestedAckV2Schema.parse(acknowledgement);
      const current = await this.load();
      const record = current.records[ack.commandId];
      if (!record || record.state !== "terminal" || !record.terminal) return false;
      if (!current.pendingTerminalCommandIds.includes(ack.commandId)) return false;
      if (!sameTerminalAcknowledgement(record.terminal, ack)) return false;

      const next = cloneJournal(current);
      next.pendingTerminalCommandIds = next.pendingTerminalCommandIds.filter((commandId) => commandId !== ack.commandId);
      const nextRecord = next.records[ack.commandId]!;
      const acknowledgedAt = this.now().toISOString();
      nextRecord.acknowledgedAt = acknowledgedAt;
      nextRecord.applicationIngestedAt = ack.ingestedAt;
      nextRecord.updatedAt = acknowledgedAt;
      await this.persist(next);
      return true;
    });
  }

  private async load() {
    if (this.state) return this.state;
    await this.assertOwnerOnlyPermissions();
    try {
      const raw = await readJsonFile(this.path);
      this.state = raw === null
        ? { version: 1, records: {}, pendingTerminalCommandIds: [] }
        : parseJournal(raw, this.maxRecords);
      return this.state;
    } catch {
      throw new Error("invalid provisioning device journal");
    }
  }

  private async assertOwnerOnlyPermissions() {
    try {
      const file = await stat(this.path);
      if ((file.mode & 0o777) !== 0o600) {
        throw new Error("unsafe provisioning device journal permissions");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  private prune(state: StoredJournal) {
    const pending = new Set(state.pendingTerminalCommandIds);
    const now = this.now().getTime();
    let changed = false;
    for (const [commandId, record] of Object.entries(state.records)) {
      if (record.state === "terminal" && !pending.has(commandId) && record.acknowledgedAt &&
        now - new Date(record.acknowledgedAt).getTime() > this.retentionMs) {
        delete state.records[commandId];
        changed = true;
      }
    }

    return changed;
  }

  private async persist(next: StoredJournal) {
    await this.write(this.path, next);
    this.state = next;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export async function handleDurableProvisioningDevice(input: {
  journal: ProvisioningDeviceJournal;
  command: ProvisioningDeviceCommandV2;
  execute: (command: ProvisioningDeviceCommandV2) => Promise<{
    firmwareVersion?: string;
    rssi?: number | null;
    hopCount?: number | null;
  }>;
  nextEnvelope: () => Promise<{ eventId: string; sequence: number; occurredAt: string }>;
  onDurableAccept?: () => void;
  onTerminalPersisted?: () => void;
  onCompleted?: (terminal: ProvisioningDeviceTerminalV2) => void;
}) {
  const accepted = await input.journal.accept(input.command);
  input.onDurableAccept?.();
  if (accepted.kind === "running") return;
  if (accepted.kind === "terminal") {
    if (accepted.pending) input.onTerminalPersisted?.();
    return;
  }

  let terminal: ProvisioningDeviceTerminalEvent;
  if (accepted.kind === "recovered") {
    terminal = createProvisioningOutcomeUnknownTerminal(input.command, await input.nextEnvelope());
  } else {
    try {
      const result = await input.execute(input.command);
      terminal = createCompletedTerminal(input.command, result, await input.nextEnvelope());
    } catch {
      terminal = createFailedTerminal(input.command, await input.nextEnvelope());
    }
  }

  const durable = await input.journal.complete(input.command, terminal);
  input.onTerminalPersisted?.();
  if (durable.payload.status === "completed") input.onCompleted?.(durable.payload);
}

export function createProvisioningOutcomeUnknownTerminal(
  command: ProvisioningDeviceCommandV2,
  envelope: { eventId: string; sequence: number; occurredAt: string }
): ProvisioningDeviceTerminalEvent {
  return terminalEvent(command, {
    ...envelope,
    status: "failed",
    errorCode: "provisioning_outcome_unknown",
    errorMessage: "Gateway restarted before the provisioning result was durably recorded."
  });
}

export class ProvisioningDeviceReplayPublisher {
  private connected = false;
  private generation = 0;
  private activeDrain: { promise: Promise<void>; controller: AbortController } | undefined;
  private connectedDrain: { generation: number; promise: Promise<void> } | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelayMs: number;
  private publish: ((topic: string, payload: ProvisioningDeviceTerminalV2) => Promise<void>) | undefined;
  private onError: ((error: unknown) => unknown) | undefined;
  private readonly publishTimeoutMs: number;
  private readonly retryInitialDelayMs: number;
  private readonly retryMaxDelayMs: number;

  constructor(
    private readonly journal: ProvisioningDeviceJournal,
    options: { publishTimeoutMs?: number; retryInitialDelayMs?: number; retryMaxDelayMs?: number } = {}
  ) {
    this.publishTimeoutMs = positiveInteger(options.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS, "publish timeout");
    this.retryInitialDelayMs = positiveInteger(options.retryInitialDelayMs ?? DEFAULT_RETRY_INITIAL_DELAY_MS, "retry delay");
    this.retryMaxDelayMs = positiveInteger(options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS, "retry max delay");
    if (this.retryMaxDelayMs < this.retryInitialDelayMs) throw new Error("invalid provisioning device replay retry delays");
    this.retryDelayMs = this.retryInitialDelayMs;
  }

  connect(
    publish: (topic: string, payload: ProvisioningDeviceTerminalV2) => Promise<void>,
    onError?: (error: unknown) => unknown
  ) {
    if (this.connected) return this.connectedDrain?.promise ?? Promise.resolve();
    this.connected = true;
    const generation = ++this.generation;
    this.publish = publish;
    this.onError = onError;
    this.retryDelayMs = this.retryInitialDelayMs;
    this.clearRetry();
    return this.runConnectedDrain(generation);
  }

  scheduleRetry() {
    void this.wake();
  }

  wake() {
    if (!this.connected) return Promise.resolve();
    this.clearRetry();
    return this.runConnectedDrain(this.generation);
  }

  async acknowledgeTerminal(acknowledgement: unknown) {
    const acknowledged = await this.journal.acknowledgeTerminal(acknowledgement);
    if (acknowledged && (await this.journal.pendingTerminals()).length === 0) {
      this.clearRetry();
      this.retryDelayMs = this.retryInitialDelayMs;
    }
    return acknowledged;
  }

  drain(publish: (topic: string, payload: ProvisioningDeviceTerminalV2) => Promise<void>) {
    if (this.activeDrain) return this.activeDrain.promise;
    const controller = new AbortController();
    const promise = (async () => {
      for (const terminal of await this.journal.pendingTerminals()) {
        await publishWithTimeout(publish, terminal, this.publishTimeoutMs, controller.signal);
      }
    })();
    const active = { promise, controller };
    this.activeDrain = active;
    void promise.finally(() => {
      if (this.activeDrain === active) this.activeDrain = undefined;
    }).catch(() => undefined);
    return promise;
  }

  async stopAndDrain() {
    const generation = this.generation;
    this.clearRetry();
    if (this.connected) await this.runConnectedDrain(generation);
    this.disconnect();
  }

  disconnect() {
    this.connected = false;
    this.generation += 1;
    this.publish = undefined;
    this.onError = undefined;
    this.connectedDrain = undefined;
    this.clearRetry();
    const active = this.activeDrain;
    this.activeDrain = undefined;
    active?.controller.abort(new Error("provisioning device terminal replay disconnected"));
  }

  private runConnectedDrain(generation: number): Promise<void> {
    const current = this.connectedDrain;
    if (current?.generation === generation) return current.promise;
    const publish = this.publish;
    if (!publish || !this.isCurrent(generation)) return Promise.resolve();
    const active = { generation, promise: Promise.resolve() };
    active.promise = (async () => {
      let retry = false;
      try {
        await this.drain(publish);
        retry = (await this.journal.pendingTerminals()).length > 0;
      } catch (error) {
        retry = true;
        if (this.isCurrent(generation)) this.report(error);
      }
      if (this.connectedDrain !== active) return;
      this.connectedDrain = undefined;
      if (this.isCurrent(generation) && retry) this.armRetry(generation, this.retryDelayMs);
    })();
    this.connectedDrain = active;
    return active.promise;
  }

  private armRetry(generation: number, delay: number) {
    if (this.retryTimer || this.connectedDrain || !this.isCurrent(generation)) return;
    if (delay > 0) this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.retryMaxDelayMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.isCurrent(generation)) void this.runConnectedDrain(generation);
    }, delay);
  }

  private clearRetry() {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private isCurrent(generation: number) {
    return this.connected && this.generation === generation;
  }

  private report(error: unknown) {
    try {
      this.onError?.(error);
    } catch {
      // Replay ownership remains local even when observability reporting fails.
    }
  }
}

function createCompletedTerminal(
  command: ProvisioningDeviceCommandV2,
  result: { firmwareVersion?: string; rssi?: number | null; hopCount?: number | null },
  envelope: { eventId: string; sequence: number; occurredAt: string }
) {
  return terminalEvent(command, {
    ...envelope,
    status: "completed",
    ...(result.firmwareVersion === undefined ? {} : { firmwareVersion: result.firmwareVersion }),
    ...(result.rssi === undefined ? {} : { rssi: result.rssi }),
    ...(result.hopCount === undefined ? {} : { hopCount: result.hopCount })
  });
}

function createFailedTerminal(
  command: ProvisioningDeviceCommandV2,
  envelope: { eventId: string; sequence: number; occurredAt: string }
) {
  return terminalEvent(command, {
    ...envelope,
    status: "failed",
    errorCode: "provisioning_failed",
    errorMessage: "Provisioning failed."
  });
}

function terminalEvent(
  command: ProvisioningDeviceCommandV2,
  terminal: ProvisioningDeviceTerminalDetails
): ProvisioningDeviceTerminalEvent {
  const { requestedAt: _requestedAt, ...identity } = command;
  return {
    topic: mqttTopicsV2.provisioningDeviceTerminal(command.siteId, command.gatewayId),
    payload: provisioningDeviceTerminalV2Schema.parse({ ...identity, ...terminal })
  };
}

function parseJournal(value: unknown, maxRecords: number): StoredJournal {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.records) ||
    !Array.isArray(value.pendingTerminalCommandIds)) {
    throw new Error("invalid provisioning device journal");
  }
  const entries = Object.entries(value.records);
  if (entries.length > maxRecords) throw new Error("invalid provisioning device journal");
  const records: Record<string, StoredRecord> = {};
  for (const [commandId, raw] of entries) {
    if (!isRecord(raw) || (raw.state !== "accepted" && raw.state !== "terminal") ||
      typeof raw.updatedAt !== "string" || Number.isNaN(Date.parse(raw.updatedAt))) {
      throw new Error("invalid provisioning device journal");
    }
    const command = provisioningDeviceCommandV2Schema.parse(raw.command);
    if (commandId !== command.commandId) throw new Error("invalid provisioning device journal");
    if (raw.state === "accepted") {
      if (raw.terminal !== undefined || raw.acknowledgedAt !== undefined || raw.applicationIngestedAt !== undefined) {
        throw new Error("invalid provisioning device journal");
      }
      records[commandId] = { command, state: "accepted", updatedAt: raw.updatedAt };
      continue;
    }
    if (raw.acknowledgedAt !== undefined &&
      (typeof raw.acknowledgedAt !== "string" || Number.isNaN(Date.parse(raw.acknowledgedAt)))) {
      throw new Error("invalid provisioning device journal");
    }
    if (raw.applicationIngestedAt !== undefined &&
      (typeof raw.applicationIngestedAt !== "string" || Number.isNaN(Date.parse(raw.applicationIngestedAt)))) {
      throw new Error("invalid provisioning device journal");
    }
    records[commandId] = {
      command,
      state: "terminal",
      terminal: parseTerminal(command, raw.terminal),
      updatedAt: raw.updatedAt,
      ...(typeof raw.acknowledgedAt === "string" ? { acknowledgedAt: raw.acknowledgedAt } : {}),
      ...(typeof raw.applicationIngestedAt === "string" ? { applicationIngestedAt: raw.applicationIngestedAt } : {})
    };
  }
  const pendingTerminalCommandIds = value.pendingTerminalCommandIds.map((commandId) => {
    if (typeof commandId !== "string" || records[commandId]?.state !== "terminal") {
      throw new Error("invalid provisioning device journal");
    }
    return commandId;
  });
  if (new Set(pendingTerminalCommandIds).size !== pendingTerminalCommandIds.length) {
    throw new Error("invalid provisioning device journal");
  }
  const pending = new Set(pendingTerminalCommandIds);
  for (const [commandId, record] of Object.entries(records)) {
    if (record.state !== "terminal") continue;
    if (pending.has(commandId) === Boolean(record.acknowledgedAt)) {
      throw new Error("invalid provisioning device journal");
    }
  }
  return { version: 1, records, pendingTerminalCommandIds };
}

function parseTerminal(
  command: ProvisioningDeviceCommandV2,
  value: unknown
): ProvisioningDeviceTerminalEvent {
  if (!isRecord(value) || typeof value.topic !== "string") throw new Error("invalid provisioning device journal");
  const payload = provisioningDeviceTerminalV2Schema.parse(value.payload);
  if (!sameTerminalCommand(payload, command) ||
    value.topic !== mqttTopicsV2.provisioningDeviceTerminal(command.siteId, command.gatewayId)) {
    throw new Error("invalid provisioning device journal");
  }
  return { topic: value.topic, payload };
}

function sameCommand(left: ProvisioningDeviceCommandV2, right: ProvisioningDeviceCommandV2) {
  return left.commandId === right.commandId &&
    left.sessionId === right.sessionId &&
    left.siteId === right.siteId &&
    left.gatewayId === right.gatewayId &&
    left.nodeId === right.nodeId &&
    left.deviceUuid === right.deviceUuid &&
    left.meshAddress === right.meshAddress &&
    left.requestedAt === right.requestedAt;
}

function sameTerminalCommand(
  terminal: ProvisioningDeviceTerminalV2,
  command: ProvisioningDeviceCommandV2
) {
  return terminal.commandId === command.commandId &&
    terminal.sessionId === command.sessionId &&
    terminal.siteId === command.siteId &&
    terminal.gatewayId === command.gatewayId &&
    terminal.nodeId === command.nodeId &&
    terminal.deviceUuid === command.deviceUuid &&
    terminal.meshAddress === command.meshAddress;
}

function sameTerminalAcknowledgement(
  terminal: ProvisioningDeviceTerminalEvent,
  acknowledgement: ReturnType<typeof applicationProvisioningDeviceTerminalIngestedAckV2Schema.parse>
) {
  return terminal.payload.eventId === acknowledgement.eventId &&
    terminal.payload.sequence === acknowledgement.sequence &&
    terminal.payload.commandId === acknowledgement.commandId &&
    terminal.payload.sessionId === acknowledgement.sessionId &&
    terminal.payload.siteId === acknowledgement.siteId &&
    terminal.payload.gatewayId === acknowledgement.gatewayId &&
    terminal.payload.nodeId === acknowledgement.nodeId &&
    terminal.payload.deviceUuid === acknowledgement.deviceUuid &&
    terminal.payload.meshAddress === acknowledgement.meshAddress;
}

function cloneJournal(value: StoredJournal): StoredJournal {
  return structuredClone(value);
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid provisioning device replay ${name}`);
  return value;
}

function publishWithTimeout(
  publish: (topic: string, payload: ProvisioningDeviceTerminalV2) => Promise<void>,
  terminal: ProvisioningDeviceTerminalEvent,
  timeoutMs: number,
  signal: AbortSignal
) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(signal.reason instanceof Error
      ? signal.reason
      : new Error("provisioning device terminal replay disconnected"));
    const timeout = setTimeout(
      () => finish(new Error(`provisioning device terminal replay timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) return onAbort();
    void Promise.resolve()
      .then(() => publish(terminal.topic, terminal.payload))
      .then(() => finish(), finish);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
