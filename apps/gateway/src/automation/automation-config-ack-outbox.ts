import {
  automationConfigAppliedV1Schema,
  mqttTopics,
  type AutomationConfigAppliedV1
} from "@led-control/shared";
import { readJsonFile, writeJsonAtomic } from "../mesh/mesh-store-file";
import { SerialTaskQueue } from "../runtime/serial-task-queue";
import type { AutomationScope } from "./automation-config-store";

const DEFAULT_RETRY_INITIAL_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
const DEFAULT_PUBLISH_TIMEOUT_MS = 10_000;

interface StoredAutomationConfigAcks {
  version: 1;
  scope: AutomationScope;
  records: AutomationConfigAppliedV1[];
}

export class AutomationConfigAckOutbox {
  private state: StoredAutomationConfigAcks | undefined;
  private readonly queue = new SerialTaskQueue();

  constructor(
    private readonly path: string,
    private readonly scope: AutomationScope
  ) {}

  initialize() {
    return this.queue.run(async () => { await this.load(); });
  }

  pending() {
    return this.queue.run(async () => (await this.load()).records.map((record) => ({ ...record })));
  }

  enqueue(value: AutomationConfigAppliedV1) {
    return this.queue.run(async () => {
      const acknowledgement = this.parse(value);
      const state = await this.load();
      const existing = state.records.find((record) => sameResult(record, acknowledgement));
      if (existing) return { ...existing };
      state.records.push(acknowledgement);
      try {
        await this.persist(state);
      } catch (error) {
        state.records.pop();
        throw error;
      }
      return { ...acknowledgement };
    });
  }

  markPublished(value: AutomationConfigAppliedV1) {
    return this.queue.run(async () => {
      const state = await this.load();
      const index = state.records.findIndex((record) => sameAck(record, value));
      if (index < 0) return false;
      const [removed] = state.records.splice(index, 1);
      try {
        await this.persist(state);
      } catch (error) {
        state.records.splice(index, 0, removed);
        throw error;
      }
      return true;
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
      this.state = { version: 1, scope: { ...this.scope }, records: [] };
      await this.persist(this.state);
      return this.state;
    }
    this.state = parseStoredOutbox(raw, this.scope);
    return this.state;
  }

  private parse(value: AutomationConfigAppliedV1) {
    const parsed = automationConfigAppliedV1Schema.parse(value);
    if (parsed.gatewayId !== this.scope.gatewayId) throw new Error("automation config ACK scope mismatch");
    return parsed as AutomationConfigAppliedV1;
  }

  private persist(state: StoredAutomationConfigAcks) {
    return writeJsonAtomic(this.path, state);
  }
}

export class AutomationConfigAckPublisher {
  private publish: ((topic: string, payload: AutomationConfigAppliedV1) => Promise<void>) | undefined;
  private drainPromise: Promise<void> | undefined;
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

  connect(publish: (topic: string, payload: AutomationConfigAppliedV1) => Promise<void>) {
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
    this.clearTimer();
    return this.drain(this.generation);
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
    try {
      while (publish === this.publish && generation === this.generation) {
        const [head] = await this.outbox.pending();
        if (!head) return;
        await withTimeout(
          publish(mqttTopics.automationConfigApplied(this.scope.siteId, this.scope.gatewayId), head),
          this.publishTimeoutMs
        );
        await this.outbox.markPublished(head);
        this.retryDelayMs = this.retryInitialDelayMs;
      }
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

function parseStoredOutbox(value: unknown, scope: AutomationScope): StoredAutomationConfigAcks {
  if (!isRecord(value) || value.version !== 1 || !sameScope(value.scope, scope) || !Array.isArray(value.records)) {
    throw new Error("invalid automation config ACK outbox");
  }
  const records = value.records.map((record) => {
    const parsed = automationConfigAppliedV1Schema.parse(record);
    if (parsed.gatewayId !== scope.gatewayId) throw new Error("invalid automation config ACK outbox");
    return parsed as AutomationConfigAppliedV1;
  });
  return { version: 1, scope: { ...scope }, records };
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
