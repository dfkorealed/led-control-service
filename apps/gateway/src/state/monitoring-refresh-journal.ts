import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  fixturePresenceCheckCommandV1Schema, fixturePresenceCheckCompletedV1Schema,
  fixturePresenceCheckCompletedAckV1Schema, applicationStateIngestedAckV2Schema, fixturePresenceV2Schema, fixtureStateV2Schema, fixtureUnreachableV1Schema,
  type FixturePresenceCheckCommandV1, type FixturePresenceCheckCompletedV1
} from "@led-control/shared";
import { readJsonFile, writeJsonAtomic } from "../mesh/mesh-store-file";
import type { GatewayStateEvent, StateEventOutboxScope } from "./state-event-outbox";

export interface MonitoringRefreshTerminal {
  events: GatewayStateEvent[];
  completed?: FixturePresenceCheckCompletedV1;
  failure?: "transport_unavailable" | "interrupted" | "expired" | "invalid_probe_results";
}
interface StoredRecord {
  command: FixturePresenceCheckCommandV1;
  terminal?: MonitoringRefreshTerminal;
  handedOffEventIds: string[];
  acknowledgedEventIds: string[];
  handedOff: boolean;
  acknowledged: boolean;
}
interface StoredJournal { version: 1 | 2; scope: StateEventOutboxScope; sequence: number; records: StoredRecord[] }

/** Keep receipts through command expiry and all application handshakes; expired commands cannot reacquire hardware ownership. */
export class MonitoringRefreshJournal {
  private state?: StoredJournal;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly active = new Set<string>();
  private readonly now: () => Date;
  private readonly maxBytes: number;
  constructor(private readonly path: string, private readonly scope: StateEventOutboxScope,
    options: { now?: () => Date; maxBytes?: number } = {}) {
    this.now = options.now ?? (() => new Date());
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new Error("invalid monitoring refresh capacity");
  }

  initialize() { return this.exclusive(async () => { await this.prune(await this.load()); }); }

  accept(value: unknown) {
    return this.exclusive(async () => {
      const command = fixturePresenceCheckCommandV1Schema.parse(value);
      this.assertScope(command);
      if (Date.parse(command.expiresAt) <= this.now().getTime()) throw new Error("monitoring refresh expired");
      const state = await this.prune(await this.load());
      // API publisher retries can reorder batches. Retain each sequence's exact command identity,
      // rather than rejecting an unseen lower sequence using the diagnostic high-water mark.
      const existing = state.records.find((row) => row.command.batchId === command.batchId || row.command.idempotencyKey === command.idempotencyKey || row.command.sequence === command.sequence);
      if (existing) {
        if (JSON.stringify(existing.command) !== JSON.stringify(command)) throw new Error("monitoring refresh identity conflict");
        return { kind: existing.terminal ? "terminal" as const : this.active.has(command.batchId) ? "running" as const : "recovered" as const,
          terminal: existing.terminal ? structuredClone(existing.terminal) : undefined };
      }
      if (state.records.length >= 10_000) throw new Error("monitoring refresh journal capacity");
      await this.commit({ ...state, sequence: Math.max(state.sequence, command.sequence), records: [...state.records, { command, handedOffEventIds: [], acknowledgedEventIds: [], handedOff: false, acknowledged: false }] });
      this.active.add(command.batchId);
      return { kind: "accepted" as const, terminal: undefined };
    });
  }

  complete(command: FixturePresenceCheckCommandV1, terminal: MonitoringRefreshTerminal) {
    return this.exclusive(async () => {
      const state = await this.load();
      const row = state.records.find((record) => record.command.batchId === command.batchId);
      if (!row || JSON.stringify(row.command) !== JSON.stringify(fixturePresenceCheckCommandV1Schema.parse(command))) {
        throw new Error("monitoring refresh identity conflict");
      }
      const parsed = this.parseTerminal(terminal, row.command);
      if (row.terminal) {
        if (JSON.stringify(row.terminal) !== JSON.stringify(parsed)) throw new Error("monitoring refresh terminal conflict");
        return structuredClone(row.terminal);
      }
      await this.commit({ ...state, records: state.records.map((record) => record === row ? { ...record, terminal: parsed } : record) });
      this.active.delete(command.batchId);
      return structuredClone(parsed);
    });
  }

  pending() { return this.exclusive(async () => structuredClone((await this.prune(await this.load())).records.filter((row) => row.terminal?.completed && !row.acknowledged))); }

  acknowledgeEvent(value: unknown) {
    return this.exclusive(async () => {
      const ack = applicationStateIngestedAckV2Schema.parse(value);
      const state = await this.load();
      const row = state.records.find((record) => record.terminal?.events.some((event) =>
        event.eventId === ack.eventId && event.fixtureId === ack.fixtureId && event.sequence === ack.sequence));
      if (!row || row.acknowledgedEventIds.includes(ack.eventId)) return false;
      // Persist before removing the fixture outbox entry. A crash between these writes can only
      // replay the same event; it can never forget an ACK and strand a batch behind its completion.
      await this.commit({ ...state, records: state.records.map((record) => record === row
        ? { ...record, acknowledgedEventIds: [...record.acknowledgedEventIds, ack.eventId] } : record) });
      return true;
    });
  }

  markEventHandedOff(batchId: string, eventId: string) {
    return this.exclusive(async () => {
      const state = await this.load();
      const row = state.records.find((record) => record.command.batchId === batchId);
      if (!row?.terminal?.completed || !row.terminal.events.some((event) => event.eventId === eventId)) {
        throw new Error("monitoring refresh terminal event missing");
      }
      if (!row.handedOffEventIds.includes(eventId)) await this.commit({ ...state, records: state.records.map((record) => record === row
        ? { ...record, handedOffEventIds: [...record.handedOffEventIds, eventId] } : record) });
    });
  }

  markHandedOff(batchId: string) {
    return this.exclusive(async () => {
      const state = await this.load();
      const row = state.records.find((record) => record.command.batchId === batchId);
      if (!row?.terminal?.completed) throw new Error("monitoring refresh terminal missing");
      if (row.handedOffEventIds.length !== row.terminal.events.length) throw new Error("monitoring refresh event handoff incomplete");
      if (!row.handedOff) await this.commit({ ...state, records: state.records.map((record) => record === row ? { ...record, handedOff: true } : record) });
    });
  }

  acknowledge(value: unknown) {
    return this.exclusive(async () => {
      const ack = fixturePresenceCheckCompletedAckV1Schema.parse(value);
      this.assertScope(ack);
      const state = await this.load();
      const row = state.records.find((record) => record.command.batchId === ack.batchId && record.command.refreshId === ack.refreshId);
      if (!row?.terminal?.completed || !row.handedOff || row.acknowledged || row.acknowledgedEventIds.length !== row.terminal.events.length) return false;
      await this.commit({ ...state, records: state.records.map((record) => record === row ? { ...record, acknowledged: true } : record) });
      return true;
    });
  }

  recoverInterrupted() {
    return this.exclusive(async () => {
      const state = await this.load();
      const records = state.records.map((row) => !row.terminal && !this.active.has(row.command.batchId)
        ? { ...row, terminal: { events: [], failure: "interrupted" as const } } : row);
      if (records.some((row, index) => row !== state.records[index])) await this.commit({ ...state, records });
      await this.prune(this.state!);
    });
  }

  private assertScope(value: StateEventOutboxScope) {
    if (value.siteId !== this.scope.siteId || value.gatewayId !== this.scope.gatewayId) throw new Error("monitoring refresh scope mismatch");
  }

  private parseTerminal(value: MonitoringRefreshTerminal, command: FixturePresenceCheckCommandV1): MonitoringRefreshTerminal {
    if (!value || !Array.isArray(value.events) || value.events.length > 64 || Boolean(value.completed) === Boolean(value.failure)) {
      throw new Error("invalid monitoring refresh terminal");
    }
    if (value.failure) {
      if (!["transport_unavailable", "interrupted", "expired", "invalid_probe_results"].includes(value.failure) || value.events.length) {
        throw new Error("invalid monitoring refresh failure");
      }
      return { events: [], failure: value.failure };
    }
    const completed = fixturePresenceCheckCompletedV1Schema.parse(value.completed);
    this.assertScope(completed);
    if (completed.batchId !== command.batchId || completed.refreshId !== command.refreshId ||
      JSON.stringify(completed.targetFixtureIds) !== JSON.stringify(command.targetFixtureIds)) throw new Error("invalid monitoring refresh terminal identity");
    const events = value.events.map((event) => {
      const parsed = "reason" in event ? fixtureUnreachableV1Schema.parse(event)
        : "brightness" in event ? fixtureStateV2Schema.parse(event) : fixturePresenceV2Schema.parse(event);
      this.assertScope(parsed);
      if (parsed.refreshId !== command.refreshId || parsed.batchId !== command.batchId || !command.targetFixtureIds.includes(parsed.fixtureId)) {
        throw new Error("invalid monitoring refresh fixture identity");
      }
      return parsed;
    });
    if (events.length !== command.targetFixtureIds.length || new Set(events.map((event) => event.fixtureId)).size !== events.length ||
      new Set(events.map((event) => event.eventId)).size !== events.length || new Set(events.map((event) => event.sequence)).size !== events.length ||
      events.some((event) => event.sequence >= completed.sequence || event.eventId === completed.eventId)) {
      throw new Error("invalid monitoring refresh terminal coverage");
    }
    return { events, completed };
  }

  private async load(): Promise<StoredJournal> {
    if (this.state) return this.state;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await this.assertPermissions(dirname(this.path), 0o700);
    const manifestPath = `${this.path}.manifest.json`;
    const manifest = await readJsonFile(manifestPath);
    const raw = await readJsonFile(this.path, { maxBytes: this.maxBytes }) as StoredJournal | null;
    if (!manifest && !raw) {
      // Manifest goes first: a crash in initialization fails closed instead of silently resetting dedup history.
      await writeJsonAtomic(manifestPath, { version: 1, scope: this.scope });
      await this.commit({ version: 2, scope: this.scope, sequence: -1, records: [] });
      return this.state!;
    }
    if (!manifest || !raw) throw new Error("monitoring refresh journal missing");
    await this.assertPermissions(manifestPath, 0o600);
    await this.assertPermissions(this.path, 0o600);
    if (JSON.stringify(manifest) !== JSON.stringify({ version: 1, scope: this.scope })) throw new Error("monitoring refresh manifest mismatch");
    this.assertScope(raw.scope);
    if (![1, 2].includes(raw.version) || !Number.isSafeInteger(raw.sequence) || !Array.isArray(raw.records) || raw.records.length > 10_000) throw new Error("invalid monitoring refresh journal");
    const batches = new Set<string>(); const keys = new Set<string>(); const sequences = new Set<number>();
    for (const row of raw.records) {
      row.command = fixturePresenceCheckCommandV1Schema.parse(row.command);
      this.assertScope(row.command);
      if (batches.has(row.command.batchId) || keys.has(row.command.idempotencyKey) || sequences.has(row.command.sequence) ||
        row.command.sequence > raw.sequence || typeof row.handedOff !== "boolean" || typeof row.acknowledged !== "boolean" ||
        (row.acknowledged && !row.handedOff) || (row.handedOff && !row.terminal?.completed)) throw new Error("invalid monitoring refresh journal");
      batches.add(row.command.batchId); keys.add(row.command.idempotencyKey); sequences.add(row.command.sequence);
      if (row.terminal) row.terminal = this.parseTerminal(row.terminal, row.command);
      // Existing v1 journals recorded only whole-batch handoff. Their completed handoffs remain
      // authoritative; incomplete legacy handoffs retry the same IDs under outbox/API deduplication.
      if (row.handedOffEventIds === undefined) {
        row.handedOffEventIds = row.handedOff ? row.terminal!.events.map((event) => event.eventId) : [];
      }
      if (!Array.isArray(row.handedOffEventIds) || new Set(row.handedOffEventIds).size !== row.handedOffEventIds.length ||
        row.handedOffEventIds.some((id) => !row.terminal?.events.some((event) => event.eventId === id)) ||
        (row.handedOff && row.handedOffEventIds.length !== row.terminal!.events.length)) {
        throw new Error("invalid monitoring refresh handoff progress");
      }
      if (raw.version === 1) {
        // v1 did not persist result ACKs. Only a completion ACK proves all results committed.
        // Otherwise replay all exact IDs, including events already removed from the old outbox.
        row.acknowledgedEventIds = row.acknowledged ? row.terminal!.events.map((event) => event.eventId) : [];
        if (!row.acknowledged) { row.handedOffEventIds = []; row.handedOff = false; }
      }
      if (!Array.isArray(row.acknowledgedEventIds) || new Set(row.acknowledgedEventIds).size !== row.acknowledgedEventIds.length ||
        row.acknowledgedEventIds.some((id) => !row.terminal?.events.some((event) => event.eventId === id)) ||
        (row.acknowledged && row.acknowledgedEventIds.length !== row.terminal!.events.length)) {
        throw new Error("invalid monitoring refresh acknowledgement progress");
      }
    }
    if (raw.version === 1) { await this.commit({ ...raw, version: 2 }); return this.state!; }
    this.state = raw;
    return raw;
  }

  private async assertPermissions(path: string, mode: number) {
    const file = await stat(path);
    if ((file.mode & 0o777) !== mode || (process.geteuid && file.uid !== process.geteuid())) throw new Error("monitoring refresh unsafe permissions");
  }
  private async prune(state: StoredJournal): Promise<StoredJournal> {
    const now = this.now().getTime();
    const records = state.records.filter((row) => Date.parse(row.command.expiresAt) > now ||
      (!row.acknowledged && !row.terminal?.failure));
    if (records.length === state.records.length) return state;
    const compacted = { ...state, records };
    // Atomic replacement preserves either the complete pre-prune or post-prune history on crash.
    // Unacknowledged completions survive indefinitely and can drain through the API retired ACK.
    await this.commit(compacted);
    return compacted;
  }
  private async commit(state: StoredJournal) {
    // Match writeJsonAtomic's formatted bytes, so every committed file remains readable after restart.
    if (Buffer.byteLength(`${JSON.stringify(state, null, 2)}\n`) > this.maxBytes) throw new Error("monitoring refresh journal capacity");
    await writeJsonAtomic(this.path, state);
    this.state = state;
  }
  private exclusive<T>(operation: () => Promise<T>) {
    const result = this.queue.then(operation, operation); this.queue = result.then(() => undefined, () => undefined); return result;
  }
}
