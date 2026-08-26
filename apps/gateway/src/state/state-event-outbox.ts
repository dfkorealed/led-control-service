import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  applicationStateIngestedAckV2Schema,
  fixtureStateV2Schema,
  mqttTopicsV2,
  type ApplicationStateIngestedAckV2,
  type FixtureStateV2
} from "@led-control/shared";
import { readJsonFile, writeJsonAtomic } from "../mesh/mesh-store-file";

const DEFAULT_MAX_RECORDS = 100_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 100 * 1024 * 1024;
const DEFAULT_RETRY_INITIAL_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
const DEFAULT_PUBLISH_TIMEOUT_MS = 10_000;

export interface StateEventOutboxScope {
  siteId: string;
  gatewayId: string;
}

export interface StoredStateEvent {
  topic: string;
  payload: FixtureStateV2;
  payloadBytes: number;
  enqueuedAt: string;
}

interface StoredOutbox {
  version: 1;
  scope: StateEventOutboxScope;
  records: StoredStateEvent[];
  totalPayloadBytes: number;
}

interface StoredOutboxManifest {
  version: 1;
  scope: StateEventOutboxScope;
}

export type StateEventOutboxErrorCode =
  | "STATE_OUTBOX_MISSING"
  | "STATE_OUTBOX_CORRUPT"
  | "STATE_OUTBOX_MANIFEST_CORRUPT"
  | "STATE_OUTBOX_PERMISSIONS"
  | "STATE_OUTBOX_CAPACITY";

export class StateEventOutboxError extends Error {
  constructor(
    readonly code: StateEventOutboxErrorCode,
    message: string
  ) {
    super(message);
    this.name = "StateEventOutboxError";
  }
}

export interface StateEventCapacityReservation {
  readonly id: string;
}

interface ReservationEntry {
  fixtureId: string;
  payloadBytes: number;
}

interface Reservation {
  entries: ReservationEntry[];
}

export class StateEventOutbox {
  private state: StoredOutbox | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly maxRecords: number;
  private readonly maxPayloadBytes: number;
  private readonly reservations = new Map<string, Reservation>();

  constructor(
    private readonly path: string,
    private readonly scope: StateEventOutboxScope,
    options: { maxRecords?: number; maxPayloadBytes?: number } = {}
  ) {
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    if (!Number.isInteger(this.maxRecords) || this.maxRecords <= 0) throw new Error("invalid state event outbox record limit");
    if (!Number.isInteger(this.maxPayloadBytes) || this.maxPayloadBytes <= 0) throw new Error("invalid state event outbox byte limit");
  }

  initialize() {
    return this.exclusive(async () => {
      await this.load();
    });
  }

  pending(): Promise<StoredStateEvent[]> {
    return this.exclusive(async () => (await this.load()).records.map(cloneRecord));
  }

  reserve(entries: ReservationEntry[]): Promise<StateEventCapacityReservation> {
    return this.exclusive(async () => {
      if (entries.length === 0 || entries.some((entry) => !entry.fixtureId || !Number.isInteger(entry.payloadBytes) || entry.payloadBytes <= 0)) {
        throw new Error("invalid state event outbox reservation");
      }
      const state = await this.load();
      const reserved = this.reservedCapacity();
      const requestedBytes = entries.reduce((sum, entry) => sum + entry.payloadBytes, 0);
      if (state.records.length + reserved.records + entries.length > this.maxRecords ||
          state.totalPayloadBytes + reserved.payloadBytes + requestedBytes > this.maxPayloadBytes) {
        throw capacityError();
      }
      const id = randomUUID();
      this.reservations.set(id, { entries: entries.map((entry) => ({ ...entry })) });
      return { id };
    });
  }

  release(reservation: StateEventCapacityReservation) {
    return this.exclusive(async () => this.reservations.delete(reservation.id));
  }

  enqueue(payload: FixtureStateV2, reservation?: StateEventCapacityReservation): Promise<StoredStateEvent> {
    return this.exclusive(async () => {
      const parsed = fixtureStateV2Schema.parse(payload);
      this.assertScope(parsed);
      const state = await this.load();
      const existing = state.records.find((record) => record.payload.eventId === parsed.eventId);
      if (existing) {
        if (!sameEvent(existing.payload, parsed)) throw new Error("state event outbox event identity conflict");
        return cloneRecord(existing);
      }

      const payloadBytes = Buffer.byteLength(JSON.stringify(parsed), "utf8");
      const reservedEntry = reservation ? this.takeReservationEntry(reservation, parsed.fixtureId, payloadBytes) : undefined;
      const reserved = this.reservedCapacity();
      if (state.records.length + reserved.records + 1 > this.maxRecords ||
          state.totalPayloadBytes + reserved.payloadBytes + payloadBytes > this.maxPayloadBytes) {
        if (reservedEntry) this.restoreReservationEntry(reservation!, reservedEntry);
        throw capacityError();
      }

      const record: StoredStateEvent = {
        topic: mqttTopicsV2.fixtureState(this.scope.siteId, this.scope.gatewayId),
        payload: parsed,
        payloadBytes,
        enqueuedAt: new Date().toISOString()
      };
      state.records.push(record);
      state.totalPayloadBytes += payloadBytes;
      try {
        await this.persist(state);
      } catch (error) {
        state.records.pop();
        state.totalPayloadBytes -= payloadBytes;
        if (reservedEntry) this.restoreReservationEntry(reservation!, reservedEntry);
        throw error;
      }
      return cloneRecord(record);
    });
  }

  acknowledge(value: unknown): Promise<boolean> {
    return this.exclusive(async () => {
      const acknowledgement = applicationStateIngestedAckV2Schema.parse(value);
      const state = await this.load();
      const index = state.records.findIndex((record) => sameAcknowledgement(record.payload, acknowledgement));
      if (index < 0) return false;
      const [removed] = state.records.splice(index, 1);
      state.totalPayloadBytes -= removed.payloadBytes;
      try {
        await this.persist(state);
      } catch (error) {
        state.records.splice(index, 0, removed);
        state.totalPayloadBytes += removed.payloadBytes;
        throw error;
      }
      return true;
    });
  }

  async canAcceptIntake(records = 1, payloadBytes = 1) {
    return this.exclusive(async () => {
      const state = await this.load();
      const reserved = this.reservedCapacity();
      return state.records.length + reserved.records + records <= this.maxRecords &&
        state.totalPayloadBytes + reserved.payloadBytes + payloadBytes <= this.maxPayloadBytes;
    });
  }

  private async load() {
    if (this.state) return this.state;
    await this.assertOwnerOnlyDirectory();
    const manifestPath = this.manifestPath();
    let manifest: unknown;
    let raw: unknown;
    try {
      manifest = await readJsonFile(manifestPath);
    } catch {
      throw new StateEventOutboxError("STATE_OUTBOX_MANIFEST_CORRUPT", "invalid state event outbox manifest");
    }
    try {
      raw = await readJsonFile(this.path);
    } catch {
      throw new StateEventOutboxError("STATE_OUTBOX_CORRUPT", "invalid state event outbox");
    }

    if (manifest === null) {
      if (raw === null) {
        await this.persistManifest();
        this.state = { version: 1, scope: { ...this.scope }, records: [], totalPayloadBytes: 0 };
        await this.persist(this.state);
        return this.state;
      }

      // A valid pre-manifest outbox is adopted once during rolling upgrades.
      await this.assertOwnerOnlyFile(this.path);
      this.state = this.parseOutbox(raw);
      await this.persistManifest();
      return this.state;
    }

    await this.assertOwnerOnlyFile(manifestPath);
    parseStoredManifest(manifest, this.scope);
    if (raw === null) {
      throw new StateEventOutboxError(
        "STATE_OUTBOX_MISSING",
        "initialized state event outbox is missing; restore the file or follow the documented recovery procedure"
      );
    }
    await this.assertOwnerOnlyFile(this.path);
    this.state = this.parseOutbox(raw);
    return this.state;
  }

  private async assertOwnerOnlyDirectory() {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryState = await stat(directory);
    if (!directoryState.isDirectory() || (directoryState.mode & 0o777) !== 0o700 || !isOwnedByCurrentUser(directoryState.uid)) {
      throw new StateEventOutboxError("STATE_OUTBOX_PERMISSIONS", "unsafe state event outbox directory permissions");
    }
  }

  private async assertOwnerOnlyFile(path: string) {
    try {
      const file = await stat(path);
      if (!file.isFile() || (file.mode & 0o777) !== 0o600 || !isOwnedByCurrentUser(file.uid)) {
        throw new StateEventOutboxError("STATE_OUTBOX_PERMISSIONS", "unsafe state event outbox permissions");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new StateEventOutboxError("STATE_OUTBOX_MISSING", "initialized state event outbox is missing");
      }
      throw error;
    }
  }

  private parseOutbox(raw: unknown) {
    try {
      return parseStoredOutbox(raw, this.scope, this.maxRecords, this.maxPayloadBytes);
    } catch (error) {
      if (error instanceof StateEventOutboxError) throw error;
      throw new StateEventOutboxError("STATE_OUTBOX_CORRUPT", "invalid state event outbox");
    }
  }

  private assertScope(payload: FixtureStateV2) {
    if (payload.siteId !== this.scope.siteId || payload.gatewayId !== this.scope.gatewayId) {
      throw new Error("state event outbox scope mismatch");
    }
  }

  private takeReservationEntry(reservation: StateEventCapacityReservation, fixtureId: string, payloadBytes: number) {
    const stored = this.reservations.get(reservation.id);
    if (!stored) throw new Error("state event outbox reservation is not active");
    const index = stored.entries.findIndex((entry) =>
      (entry.fixtureId === fixtureId || entry.fixtureId === "*") && entry.payloadBytes >= payloadBytes
    );
    if (index < 0) throw new Error("state event outbox reservation mismatch");
    const [entry] = stored.entries.splice(index, 1);
    if (stored.entries.length === 0) this.reservations.delete(reservation.id);
    return entry;
  }

  private restoreReservationEntry(reservation: StateEventCapacityReservation, entry: ReservationEntry) {
    const stored = this.reservations.get(reservation.id) ?? { entries: [] };
    stored.entries.push(entry);
    this.reservations.set(reservation.id, stored);
  }

  private reservedCapacity() {
    let records = 0;
    let payloadBytes = 0;
    for (const reservation of this.reservations.values()) {
      records += reservation.entries.length;
      payloadBytes += reservation.entries.reduce((sum, entry) => sum + entry.payloadBytes, 0);
    }
    return { records, payloadBytes };
  }

  private persist(state: StoredOutbox) {
    return writeJsonAtomic(this.path, state);
  }

  private persistManifest() {
    return writeJsonAtomic(this.manifestPath(), {
      version: 1,
      scope: { ...this.scope }
    } satisfies StoredOutboxManifest);
  }

  private manifestPath() {
    return `${this.path}.manifest.json`;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class StateEventReservationSlot {
  private current: StateEventCapacityReservation | undefined;

  constructor(private readonly outbox: Pick<StateEventOutbox, "release">) {}

  async attach(candidate: StateEventCapacityReservation) {
    if (this.current?.id === candidate.id) return true;
    if (!this.compareAndSet(undefined, candidate)) {
      await this.outbox.release(candidate);
      return false;
    }
    return true;
  }

  isCurrent(candidate: StateEventCapacityReservation) {
    return this.current?.id === candidate.id;
  }

  take(candidate: StateEventCapacityReservation) {
    if (!this.compareAndSet(candidate, undefined)) return undefined;
    return candidate;
  }

  async release(candidate?: StateEventCapacityReservation) {
    const current = this.current;
    if (!current || (candidate && current.id !== candidate.id)) return false;
    if (!this.compareAndSet(current, undefined)) return false;
    await this.outbox.release(current);
    return true;
  }

  private compareAndSet(
    expected: StateEventCapacityReservation | undefined,
    next: StateEventCapacityReservation | undefined
  ) {
    if (this.current?.id !== expected?.id) return false;
    this.current = next;
    return true;
  }
}

export class StateEventCapacityGate {
  private blocked = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly payloadBytesPerEvent: number;
  private readonly onBlocked: (reason: string) => Promise<void> | void;
  private readonly onRecovered: () => Promise<void> | void;

  constructor(
    private readonly outbox: StateEventOutbox,
    options: {
      payloadBytesPerEvent?: number;
      onBlocked?: (reason: string) => Promise<void> | void;
      onRecovered?: () => Promise<void> | void;
    } = {}
  ) {
    this.payloadBytesPerEvent = options.payloadBytesPerEvent ?? 2_048;
    this.onBlocked = options.onBlocked ?? (() => undefined);
    this.onRecovered = options.onRecovered ?? (() => undefined);
  }

  async initialize() {
    if (!await this.outbox.canAcceptIntake(1, this.payloadBytesPerEvent)) {
      await this.markBlocked();
    }
  }

  isBlocked() {
    return this.blocked;
  }

  reserve(fixtureIds: string[]) {
    return this.exclusive(async () => {
      if (this.blocked) throw capacityError();
      try {
        return await this.outbox.reserve(fixtureIds.map((fixtureId) => ({
          fixtureId,
          payloadBytes: this.payloadBytesPerEvent
        })));
      } catch (error) {
        if (isCapacityError(error)) await this.markBlocked();
        throw error;
      }
    });
  }

  async run<T>(fixtureIds: string[], operation: (reservation: StateEventCapacityReservation) => Promise<T>) {
    const reservation = await this.reserve(fixtureIds);
    try {
      return await operation(reservation);
    } finally {
      await this.outbox.release(reservation);
    }
  }

  tryRecover() {
    return this.exclusive(async () => {
      if (!this.blocked) return false;
      if (!await this.outbox.canAcceptIntake(1, this.payloadBytesPerEvent)) return false;
      this.blocked = false;
      try {
        await this.onRecovered();
        return true;
      } catch (error) {
        await this.markBlocked();
        throw error;
      }
    });
  }

  recoverAndReserve(fixtureIds: string[]) {
    return this.exclusive(async () => {
      if (!this.blocked) return null;
      let reservation: StateEventCapacityReservation | undefined;
      try {
        reservation = await this.outbox.reserve(fixtureIds.map((fixtureId) => ({
          fixtureId,
          payloadBytes: this.payloadBytesPerEvent
        })));
        this.blocked = false;
        await this.onRecovered();
        return reservation;
      } catch (error) {
        if (reservation) await this.outbox.release(reservation);
        await this.markBlocked();
        throw error;
      }
    });
  }

  block() {
    return this.exclusive(() => this.markBlocked());
  }

  private async markBlocked() {
    this.blocked = true;
    await this.onBlocked("state_outbox_capacity");
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class StateEventOutboxPublisher {
  private publish: ((topic: string, payload: FixtureStateV2) => Promise<void>) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private retryDelayMs: number;
  private drainPromise: Promise<void> | undefined;
  private readonly retryInitialDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly publishTimeoutMs: number;
  private readonly onError: (error: unknown) => void;

  constructor(
    private readonly outbox: StateEventOutbox,
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

  async connect(publish: (topic: string, payload: FixtureStateV2) => Promise<void>) {
    this.generation += 1;
    this.publish = publish;
    this.retryDelayMs = this.retryInitialDelayMs;
    this.clearTimer();
    await this.drain(this.generation);
  }

  disconnect() {
    this.generation += 1;
    this.publish = undefined;
    this.clearTimer();
  }

  async acknowledge(value: unknown) {
    const removed = await this.outbox.acknowledge(value);
    if (removed && this.publish) {
      this.retryDelayMs = this.retryInitialDelayMs;
      this.clearTimer();
      await this.drain(this.generation);
    }
    return removed;
  }

  wake() {
    if (!this.publish) return;
    this.clearTimer();
    this.runDrain(this.generation);
  }

  private drain(generation: number): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drainOnce(generation).finally(() => {
      this.drainPromise = undefined;
    });
    return this.drainPromise;
  }

  private async drainOnce(generation: number) {
    const publish = this.publish;
    if (!publish || generation !== this.generation) return;
    const [head] = await this.outbox.pending();
    if (!head) return;
    try {
      await withTimeout(publish(head.topic, head.payload), this.publishTimeoutMs);
    } finally {
      if (publish === this.publish && generation === this.generation) this.scheduleRetry(generation);
    }
  }

  private scheduleRetry(generation: number) {
    this.clearTimer();
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.retryMaxDelayMs);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.runDrain(generation);
    }, delay);
  }

  private runDrain(generation: number) {
    void this.drain(generation).catch((error) => this.onError(error));
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function parseStoredOutbox(
  value: unknown,
  scope: StateEventOutboxScope,
  maxRecords: number,
  maxPayloadBytes: number
): StoredOutbox {
  if (!isRecord(value) || value.version !== 1 || !sameScope(value.scope, scope) || !Array.isArray(value.records) ||
      !Number.isInteger(value.totalPayloadBytes) || (value.totalPayloadBytes as number) < 0) {
    throw new Error("invalid state event outbox");
  }
  if (value.records.length > maxRecords) throw new Error("invalid state event outbox");
  const eventIds = new Set<string>();
  const records = value.records.map((raw) => {
    if (!isRecord(raw) || typeof raw.topic !== "string" || typeof raw.enqueuedAt !== "string" ||
        Number.isNaN(Date.parse(raw.enqueuedAt)) || !Number.isInteger(raw.payloadBytes)) {
      throw new Error("invalid state event outbox");
    }
    const payload = fixtureStateV2Schema.parse(raw.payload);
    if (payload.siteId !== scope.siteId || payload.gatewayId !== scope.gatewayId ||
        raw.topic !== mqttTopicsV2.fixtureState(scope.siteId, scope.gatewayId) || eventIds.has(payload.eventId)) {
      throw new Error("invalid state event outbox");
    }
    eventIds.add(payload.eventId);
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    if (raw.payloadBytes !== payloadBytes) throw new Error("invalid state event outbox");
    return { topic: raw.topic, payload, payloadBytes, enqueuedAt: raw.enqueuedAt };
  });
  const totalPayloadBytes = records.reduce((sum, record) => sum + record.payloadBytes, 0);
  if (value.totalPayloadBytes !== totalPayloadBytes || totalPayloadBytes > maxPayloadBytes) {
    throw new Error("invalid state event outbox");
  }
  return { version: 1, scope: { ...scope }, records, totalPayloadBytes };
}

function parseStoredManifest(value: unknown, scope: StateEventOutboxScope): StoredOutboxManifest {
  if (!isRecord(value) || value.version !== 1 || !sameScope(value.scope, scope) || Object.keys(value).some((key) => !["version", "scope"].includes(key))) {
    throw new StateEventOutboxError("STATE_OUTBOX_MANIFEST_CORRUPT", "invalid state event outbox manifest");
  }
  return { version: 1, scope: { ...scope } };
}

function capacityError() {
  return new StateEventOutboxError("STATE_OUTBOX_CAPACITY", "state event outbox capacity exceeded");
}

function isCapacityError(error: unknown): error is StateEventOutboxError {
  return error instanceof StateEventOutboxError && error.code === "STATE_OUTBOX_CAPACITY";
}

function isOwnedByCurrentUser(uid: number) {
  return typeof process.geteuid !== "function" || uid === process.geteuid();
}

function cloneRecord(record: StoredStateEvent): StoredStateEvent {
  return { ...record, payload: { ...record.payload, health: record.payload.health ? { ...record.payload.health } : undefined } };
}

function sameEvent(left: FixtureStateV2, right: FixtureStateV2) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameAcknowledgement(payload: FixtureStateV2, acknowledgement: ApplicationStateIngestedAckV2) {
  return payload.eventId === acknowledgement.eventId &&
    payload.sequence === acknowledgement.sequence &&
    payload.fixtureId === acknowledgement.fixtureId;
}

function sameScope(value: unknown, scope: StateEventOutboxScope) {
  return isRecord(value) && value.siteId === scope.siteId && value.gatewayId === scope.gatewayId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`state event publish timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}
