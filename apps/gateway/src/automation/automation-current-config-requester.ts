import { randomUUID } from "node:crypto";
import {
  automationCurrentConfigRequestV1Schema,
  mqttTopics,
  type AutomationCurrentConfigRequestV1,
  type AutomationSnapshotV1
} from "@led-control/shared";
import type { AutomationScope } from "./automation-config-store";

const DEFAULT_RETRY_INITIAL_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;
const DEFAULT_PUBLISH_TIMEOUT_MS = 10_000;

type RequestPublish = (topic: string, request: AutomationCurrentConfigRequestV1) => Promise<void>;

export class AutomationCurrentConfigRequester {
  private publish: RequestPublish | undefined;
  private request: AutomationCurrentConfigRequestV1 | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private retryDelayMs: number;
  private readonly retryInitialDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly publishTimeoutMs: number;
  private readonly createRequestId: () => string;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly onError: (error: unknown) => void;

  constructor(
    private readonly scope: AutomationScope,
    options: {
      retryInitialDelayMs?: number;
      retryMaxDelayMs?: number;
      publishTimeoutMs?: number;
      createRequestId?: () => string;
      now?: () => Date;
      random?: () => number;
      onError?: (error: unknown) => void;
    } = {}
  ) {
    this.retryInitialDelayMs = options.retryInitialDelayMs ?? DEFAULT_RETRY_INITIAL_DELAY_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.publishTimeoutMs = options.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
    this.createRequestId = options.createRequestId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.onError = options.onError ?? (() => undefined);
    this.retryDelayMs = this.retryInitialDelayMs;
  }

  connect(publish: RequestPublish) {
    const generation = ++this.generation;
    this.publish = publish;
    this.retryDelayMs = this.retryInitialDelayMs;
    this.clearTimer();
    this.request = automationCurrentConfigRequestV1Schema.parse({
      schemaVersion: 1,
      requestId: this.createRequestId(),
      ...this.scope,
      requestedAt: this.now().toISOString()
    }) as AutomationCurrentConfigRequestV1;
    return this.publishOnce(generation);
  }

  disconnect() {
    this.generation += 1;
    this.publish = undefined;
    this.request = undefined;
    this.clearTimer();
  }

  confirm(snapshot: Pick<AutomationSnapshotV1, "siteId" | "gatewayId">) {
    if (snapshot.siteId !== this.scope.siteId || snapshot.gatewayId !== this.scope.gatewayId || !this.request) return false;
    this.request = undefined;
    this.clearTimer();
    return true;
  }

  private async publishOnce(generation: number) {
    const publish = this.publish;
    const request = this.request;
    if (!publish || !request || generation !== this.generation) return;
    try {
      await withTimeout(
        publish(mqttTopics.automationCurrentConfigRequest(this.scope.siteId, this.scope.gatewayId), request),
        this.publishTimeoutMs
      );
    } catch (error) {
      if (this.isCurrent(generation, publish, request)) this.scheduleRetry(generation);
      throw error;
    }
    if (this.isCurrent(generation, publish, request)) this.scheduleRetry(generation);
  }

  private scheduleRetry(generation: number) {
    this.clearTimer();
    const baseDelay = this.retryDelayMs;
    const jitter = Math.floor(baseDelay * 0.2 * this.random());
    this.retryDelayMs = Math.min(baseDelay * 2, this.retryMaxDelayMs);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.publishOnce(generation).catch((error) => this.onError(error));
    }, baseDelay + jitter);
  }

  private isCurrent(
    generation: number,
    publish: RequestPublish,
    request: AutomationCurrentConfigRequestV1
  ) {
    return generation === this.generation && publish === this.publish && request === this.request;
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`automation current-config request timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}
