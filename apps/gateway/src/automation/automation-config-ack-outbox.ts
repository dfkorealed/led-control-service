import { randomUUID } from "node:crypto";
import {
  automationConfigAppliedDeliveryV1Schema,
  automationConfigAppliedReceiptV1Schema,
  automationConfigAppliedV1Schema,
  mqttTopics,
  type AutomationConfigAppliedDeliveryV1,
  type AutomationConfigAppliedReceiptV1,
  type AutomationConfigAppliedV1
} from "@led-control/shared";
import { readJsonFile, writeJsonAtomic } from "../mesh/mesh-store-file";
import { SerialTaskQueue } from "../runtime/serial-task-queue";
import type { AutomationScope } from "./automation-config-store";

const DEFAULT_RETRY_INITIAL_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
const DEFAULT_PUBLISH_TIMEOUT_MS = 10_000;

interface StoredAutomationConfigAcks {
  version: 2;
  scope: AutomationScope;
  records: AutomationConfigAppliedDeliveryV1[];
}

type AtomicJsonWriter = (path: string, value: unknown) => Promise<void>;

export class AutomationConfigAckOutbox {
  private state: StoredAutomationConfigAcks | undefined;
  private readonly queue = new SerialTaskQueue();

  constructor(
    private readonly path: string,
    private readonly scope: AutomationScope,
    private readonly write: AtomicJsonWriter = writeJsonAtomic,
    private readonly createAcknowledgementId: () => string = randomUUID
  ) {}

  initialize() {
    return this.queue.run(async () => { await this.load(); });
  }

  pending() {
    return this.queue.run(async () => structuredClone((await this.load()).records));
  }

  enqueue(value: AutomationConfigAppliedV1) {
    return this.queue.run(async () => {
      const acknowledgement = this.parseAcknowledgement(value);
      const state = await this.load();
      const existing = state.records.find((record) => sameResult(record.acknowledgement, acknowledgement));
      if (existing) return structuredClone(existing);
      const delivery = automationConfigAppliedDeliveryV1Schema.parse({
        schemaVersion: 1,
        acknowledgementId: this.createAcknowledgementId(),
        ...this.scope,
        acknowledgement
      }) as AutomationConfigAppliedDeliveryV1;
      state.records.push(delivery);
      try {
        await this.persist(state);
      } catch (error) {
        await this.reloadFromDisk();
        throw error;
      }
      return structuredClone(delivery);
    });
  }

  acknowledge(value: AutomationConfigAppliedReceiptV1) {
    return this.queue.run(async (): Promise<"deleted" | "missing" | "conflict"> => {
      const receipt = automationConfigAppliedReceiptV1Schema.parse(value) as AutomationConfigAppliedReceiptV1;
      if (receipt.siteId !== this.scope.siteId || receipt.gatewayId !== this.scope.gatewayId) {
        throw new Error("automation config receipt scope mismatch");
      }
      const state = await this.load();
      const index = state.records.findIndex((record) => record.acknowledgementId === receipt.acknowledgementId);
      if (index < 0) return "missing";
      const delivery = state.records[index];
      if (
        delivery.siteId !== receipt.siteId || delivery.gatewayId !== receipt.gatewayId ||
        !sameAck(delivery.acknowledgement, receipt.acknowledgement)
      ) return "conflict";
      state.records.splice(index, 1);
      try {
        await this.persist(state);
      } catch (error) {
        await this.reloadFromDisk();
        throw error;
      }
      return "deleted";
    });
  }

  private async load() {
    if (this.state) return this.state;
    let raw: unknown | null;
    try {
      raw = await readJsonFile(this.path);
    } catch (error) {
      throw new Error("invalid automation config ACK outbox", { cause: error });
    }
    if (raw === null) {
      this.state = { version: 2, scope: { ...this.scope }, records: [] };
      await this.persist(this.state);
      return this.state;
    }
    const parsed = parseStoredOutbox(raw, this.scope, this.createAcknowledgementId);
    this.state = parsed.state;
    if (parsed.migrated) await this.persist(this.state);
    return this.state;
  }

  private parseAcknowledgement(value: AutomationConfigAppliedV1) {
    const parsed = automationConfigAppliedV1Schema.parse(value);
    if (parsed.gatewayId !== this.scope.gatewayId) throw new Error("automation config ACK scope mismatch");
    return parsed as AutomationConfigAppliedV1;
  }

  private persist(state: StoredAutomationConfigAcks) {
    return this.write(this.path, state);
  }

  private async reloadFromDisk() {
    this.state = undefined;
    await this.load();
  }
}

export class AutomationConfigAckPublisher {
  private publish: ((topic: string, payload: AutomationConfigAppliedDeliveryV1) => Promise<void>) | undefined;
  private drainPromise: Promise<void> | undefined;
  private drainGeneration: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private retryDelayMs: number;
  private readonly retryInitialDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly publishTimeoutMs: number;
  private readonly onError: (error: unknown) => void;

  constructor(
    private readonly outbox: AutomationConfigAckOutbox,
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

  connect(publish: (topic: string, payload: AutomationConfigAppliedDeliveryV1) => Promise<void>) {
    this.generation += 1;
    this.publish = publish;
    this.retryDelayMs = this.retryInitialDelayMs;
    this.clearTimer();
    return this.drain(this.generation);
  }

  disconnect() {
    this.generation += 1;
    this.publish = undefined;
    this.clearTimer();
  }

  wake() {
    if (!this.publish) return Promise.resolve();
    this.retryDelayMs = this.retryInitialDelayMs;
    this.clearTimer();
    return this.drain(this.generation);
  }

  private drain(generation: number): Promise<void> {
    if (this.drainPromise && this.drainGeneration === generation) return this.drainPromise;
    const drain = this.drainOnce(generation).finally(() => {
      if (this.drainPromise === drain) {
        this.drainPromise = undefined;
        this.drainGeneration = undefined;
      }
    });
    this.drainPromise = drain;
    this.drainGeneration = generation;
    return drain;
  }

  private async drainOnce(generation: number) {
    const publish = this.publish;
    if (!publish || generation !== this.generation) return;
    try {
      const records = await this.outbox.pending();
      for (const record of records) {
        if (publish !== this.publish || generation !== this.generation) return;
        await withTimeout(
          publish(mqttTopics.automationConfigApplied(this.scope.siteId, this.scope.gatewayId), record),
          this.publishTimeoutMs
        );
      }
      if (
        publish === this.publish && generation === this.generation &&
        (await this.outbox.pending()).length > 0
      ) this.scheduleRetry(generation);
    } catch (error) {
      if (publish === this.publish && generation === this.generation) this.scheduleRetry(generation);
      throw error;
    }
  }

  private scheduleRetry(generation: number) {
    this.clearTimer();
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.retryMaxDelayMs);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain(generation).catch((error) => this.onError(error));
    }, delay);
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function parseStoredOutbox(
  value: unknown,
  scope: AutomationScope,
  createAcknowledgementId: () => string
): { state: StoredAutomationConfigAcks; migrated: boolean } {
  if (!isRecord(value) || !sameScope(value.scope, scope) || !Array.isArray(value.records)) {
    throw new Error("invalid automation config ACK outbox");
  }
  if (value.version === 1) {
    const records = value.records.map((record) => automationConfigAppliedDeliveryV1Schema.parse({
      schemaVersion: 1,
      acknowledgementId: createAcknowledgementId(),
      ...scope,
      acknowledgement: automationConfigAppliedV1Schema.parse(record)
    }) as AutomationConfigAppliedDeliveryV1);
    return { state: { version: 2, scope: { ...scope }, records }, migrated: true };
  }
  if (value.version !== 2) throw new Error("invalid automation config ACK outbox");
  const records = value.records.map((record) => automationConfigAppliedDeliveryV1Schema.parse(record) as AutomationConfigAppliedDeliveryV1);
  if (records.some((record) => record.siteId !== scope.siteId || record.gatewayId !== scope.gatewayId)) {
    throw new Error("invalid automation config ACK outbox");
  }
  if (new Set(records.map(({ acknowledgementId }) => acknowledgementId)).size !== records.length) {
    throw new Error("invalid automation config ACK outbox");
  }
  return { state: { version: 2, scope: { ...scope }, records }, migrated: false };
}

function sameResult(left: AutomationConfigAppliedV1, right: AutomationConfigAppliedV1) {
  return left.gatewayId === right.gatewayId && left.revision === right.revision &&
    left.payloadHash === right.payloadHash && left.status === right.status && left.errorCode === right.errorCode;
}

function sameAck(left: AutomationConfigAppliedV1, right: AutomationConfigAppliedV1) {
  return sameResult(left, right) && left.appliedAt === right.appliedAt;
}

function sameScope(value: unknown, scope: AutomationScope) {
  return isRecord(value) && value.siteId === scope.siteId && value.gatewayId === scope.gatewayId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`automation config ACK publish timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}
