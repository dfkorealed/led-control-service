import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fixtureRegistrationRemovalAckSchema, fixtureRegistrationRemovalCanonicalJson,
  fixtureRegistrationRemovalCommandSchema, fixtureRegistrationRemovalTerminalSchema, matchesFixtureRegistrationRemovalAck,
  type FixtureRegistrationRemovalCommand, type FixtureRegistrationRemovalTerminal } from "@led-control/shared";
import { readJsonFile, writeJsonAtomic } from "../mesh/mesh-store-file";

export function registrationRemovalHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(fixtureRegistrationRemovalCanonicalJson(value)).digest("hex")}`;
}
export interface RemovalRecord {
  command: FixtureRegistrationRemovalCommand;
  terminal: FixtureRegistrationRemovalTerminal | null;
  acknowledged: boolean;
  admitted: boolean;
  previousTerminals: FixtureRegistrationRemovalTerminal[];
}
interface State { version: 1; records: RemovalRecord[] }
const MAX_BYTES = 16 * 1024 * 1024;

/** No TTL pruning: removal identity and unacknowledged results are durable fences. */
export class FixtureRegistrationRemovalJournal {
  private queue: Promise<unknown> = Promise.resolve();
  private execution: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string, private readonly write = writeJsonAtomic) {}

  serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.execution.then(operation, operation); this.execution = run.catch(() => undefined); return run;
  }
  initialize(): Promise<void> { return this.exclusive(async () => { await this.read(true); }); }
  records(): Promise<RemovalRecord[]> { return this.exclusive(async () => structuredClone((await this.read()).records)); }
  accept(command: FixtureRegistrationRemovalCommand): Promise<{ record: RemovalRecord; fresh: boolean }> {
    return this.exclusive(async () => {
      command = fixtureRegistrationRemovalCommandSchema.parse(command);
      const state = await this.read(), existing = state.records.find(row => row.command.operationId === command.operationId);
      if (existing) {
        if (!isDeepStrictEqual(existing.command, command)) throw new Error("REMOVAL_OPERATION_CONFLICT");
        await this.persist(state);
        return { record: structuredClone(existing), fresh: false };
      }
      if (state.records.length >= 10_000) throw new Error("REMOVAL_JOURNAL_CAPACITY");
      const record: RemovalRecord = { command, terminal: null, acknowledged: false, admitted: false, previousTerminals: [] };
      state.records.push(record); await this.persist(state);
      return { record: structuredClone(record), fresh: true };
    });
  }
  admit(operationId: string): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.read(), row = state.records.find(row => row.command.operationId === operationId);
      if (!row || row.terminal) throw new Error("REMOVAL_NOT_ACCEPTED");
      row.admitted = true; await this.persist(state);
    });
  }
  complete(terminal: FixtureRegistrationRemovalTerminal): Promise<FixtureRegistrationRemovalTerminal> {
    return this.exclusive(async () => {
      terminal = fixtureRegistrationRemovalTerminalSchema.parse(terminal);
      const state = await this.read(), row = state.records.find(row => row.command.operationId === terminal.operationId);
      if (!row || !sameTerminalCommand(row.command, terminal)) throw new Error("REMOVAL_TERMINAL_CONFLICT");
      if (row.terminal) {
        if (row.terminal.status !== "reconcile_required" || terminal.status !== "removed") return row.terminal;
        row.previousTerminals.push(row.terminal);
      }
      row.terminal = terminal; row.acknowledged = false; await this.persist(state); return terminal;
    });
  }
  acknowledge(raw: unknown): Promise<boolean> {
    return this.exclusive(async () => {
      const ack = fixtureRegistrationRemovalAckSchema.parse(raw), state = await this.read();
      const row = state.records.find(row => row.command.operationId === ack.operationId);
      if (!row?.terminal || !matchesFixtureRegistrationRemovalAck(row.terminal, ack, registrationRemovalHash(row.terminal))) return false;
      if (!row.acknowledged) { row.acknowledged = true; await this.persist(state); }
      return true;
    });
  }
  private async read(initialize = false): Promise<State> {
    const value = await readJsonFile(this.path, { maxBytes: MAX_BYTES });
    const marker = await readJsonFile(`${this.path}.manifest`);
    if (value === null && marker === null && initialize) {
      const state: State = { version: 1, records: [] };
      await this.write(`${this.path}.manifest`, { version: 1 }); await this.persist(state); return state;
    }
    if (!isDeepStrictEqual(marker, { version: 1 }) || !value || typeof value !== "object"
      || Object.keys(value).sort().join() !== "records,version") throw new Error("REMOVAL_JOURNAL_UNAVAILABLE");
    const state = value as State;
    if (state.version !== 1 || !Array.isArray(state.records) || state.records.length > 10_000) throw new Error("REMOVAL_JOURNAL_INVALID");
    const ids = new Set<string>();
    for (const row of state.records) {
      if (!row || Object.keys(row).sort().join() !== "acknowledged,admitted,command,previousTerminals,terminal"
        || typeof row.acknowledged !== "boolean" || typeof row.admitted !== "boolean" || !Array.isArray(row.previousTerminals)
        || row.previousTerminals.length > 1) throw new Error("REMOVAL_JOURNAL_INVALID");
      fixtureRegistrationRemovalCommandSchema.parse(row.command);
      if (ids.has(row.command.operationId)) throw new Error("REMOVAL_JOURNAL_INVALID"); ids.add(row.command.operationId);
      if (row.terminal !== null) {
        fixtureRegistrationRemovalTerminalSchema.parse(row.terminal);
        if (!sameTerminalCommand(row.command, row.terminal)) throw new Error("REMOVAL_JOURNAL_INVALID");
      } else if (row.acknowledged) throw new Error("REMOVAL_JOURNAL_INVALID");
      for (const previous of row.previousTerminals) {
        fixtureRegistrationRemovalTerminalSchema.parse(previous);
        if (previous.status !== "reconcile_required" || !sameTerminalCommand(row.command, previous)) throw new Error("REMOVAL_JOURNAL_INVALID");
      }
    }
    return state;
  }
  private persist(state: State) {
    if (Buffer.byteLength(JSON.stringify(state, null, 2)) + 1 > MAX_BYTES) throw new Error("REMOVAL_JOURNAL_CAPACITY");
    return this.write(this.path, state);
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation); this.queue = run.catch(() => undefined); return run;
  }
}
function sameTerminalCommand(command: FixtureRegistrationRemovalCommand, terminal: FixtureRegistrationRemovalTerminal) {
  const { commandHash, eventId: _eventId, occurredAt: _occurredAt, status: _status, errorCode: _errorCode, ...identity } = terminal;
  return isDeepStrictEqual(command, identity) && commandHash === registrationRemovalHash(command);
}
