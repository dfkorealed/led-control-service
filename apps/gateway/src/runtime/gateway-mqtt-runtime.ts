import type { IConnackPacket, IPublishPacket, MqttClient } from "mqtt";

export type GatewayMqttClient = Pick<
  MqttClient,
  "connected" | "end" | "handleMessage" | "on" | "reconnect" | "removeListener" | "publish" | "subscribe"
>;
type TopicHandler = (payload: Buffer, source: GatewayMqttClient) => unknown;
type ErrorReporter = (error: unknown, context: string) => unknown;

export interface GatewayMqttIdentityTransaction {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface GatewayMqttRuntimeOptions {
  client: GatewayMqttClient;
  heartbeatMs: number;
  candidateReadyTimeoutMs?: number;
  subscriptionRetryBaseMs?: number;
  subscribe: (client: GatewayMqttClient, sessionPresent: boolean, force: boolean) => unknown;
  publishHeartbeat: () => unknown;
  topicHandlers: Record<string, TopicHandler>;
  deferredPubackTopics?: readonly string[];
  onMessageError: ErrorReporter;
  onConnect?: () => unknown;
  onClose?: () => unknown;
  onError?: (error: Error) => unknown;
  onRuntimeError?: ErrorReporter;
}

interface CandidateAttempt {
  client: GatewayMqttClient;
  ready: Promise<void>;
  cancel(error: Error): void;
  cleanup(): void;
  hasConnected(): boolean;
}

const DEFAULT_CANDIDATE_READY_TIMEOUT_MS = 10_000;

export class GatewayMqttRuntime {
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private stopping = false;
  private queue: Promise<void> = Promise.resolve();
  private activeCandidate: CandidateAttempt | undefined;
  private currentClient: GatewayMqttClient;
  private readonly clientListeners = new Map<GatewayMqttClient, {
    connect: (packet: IConnackPacket) => void;
    close: () => void;
    error: (error: Error) => void;
    message: (topic: string, payload: Buffer, packet?: IPublishPacket) => void;
  }>();
  private readonly originalHandleMessage = new Map<GatewayMqttClient, GatewayMqttClient["handleMessage"]>();
  private readonly deferredHandlers = new WeakMap<object, Promise<void>>();
  private readonly deferredPubackTopics: ReadonlySet<string>;
  private readonly candidateReadyTimeoutMs: number;
  private connectionEpoch = 0;
  private subscriptionRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private subscriptionRetryAttempt = 0;
  private readonly subscriptionRetryBaseMs: number;
  private subscriptionsReady = false;

  constructor(private readonly options: GatewayMqttRuntimeOptions) {
    this.currentClient = options.client;
    this.candidateReadyTimeoutMs = boundedCandidateReadyTimeout(options.candidateReadyTimeoutMs ?? DEFAULT_CANDIDATE_READY_TIMEOUT_MS);
    this.subscriptionRetryBaseMs = boundedSubscriptionRetry(options.subscriptionRetryBaseMs ?? 1_000);
    this.deferredPubackTopics = new Set(options.deferredPubackTopics ?? []);
  }

  get client() {
    return this.currentClient;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.addClientListeners(this.currentClient);
    if (this.currentClient.connected && this.connectionEpoch === 0) {
      this.handleConnect(this.currentClient, { sessionPresent: false });
    }
  }

  stop() {
    if (!this.started && !this.activeCandidate) return Promise.resolve();
    this.stopping = true;
    this.activeCandidate?.cancel(new Error("MQTT runtime is stopping"));
    return this.enqueue(async () => {
      this.started = false;
      this.clearHeartbeatTimer();
      this.clearSubscriptionRetry();
      this.removeClientListeners(this.currentClient);
      await this.endClient(this.currentClient);
    });
  }

  activate(candidate: GatewayMqttClient, identity?: GatewayMqttIdentityTransaction): Promise<void> {
    if (!this.started || this.stopping) {
      return this.endClient(candidate).catch(() => undefined).then(() => {
        throw new Error("MQTT runtime is stopping");
      });
    }
    if (this.activeCandidate) {
      return this.endClient(candidate).catch(() => undefined).then(() => {
        throw new Error("MQTT runtime replacement is already in progress");
      });
    }
    const attempt = this.prepareCandidate(candidate);
    this.activeCandidate = attempt;
    return this.enqueue(() => this.activateInternal(attempt, identity));
  }

  private async activateInternal(attempt: CandidateAttempt, identity?: GatewayMqttIdentityTransaction) {
    const previous = this.currentClient;
    let promoted = false;
    if (!this.started || this.stopping) {
      await this.abortCandidate(attempt);
      throw new Error("MQTT runtime is stopping");
    }
    try {
      // A stable MQTT client ID lets a new connection evict the old one. End it first
      // so its automatic reconnect loop cannot evict the candidate during readiness.
      await this.quiesceClient(previous);
      this.throwIfStopping();
      await identity?.commit();
      this.throwIfStopping();
      this.currentClient = attempt.client;
      promoted = true;
      attempt.client.reconnect();
      await attempt.ready;
      await this.commitCandidate(attempt, previous);
    } catch (error) {
      if (attempt.hasConnected()) {
        await this.abortCandidate(attempt);
        await this.failClosed(attempt.client, previous, true);
        throw error;
      }
      const rollbackSucceeded = await this.rollbackIdentity(identity);
      await this.abortCandidate(attempt);
      if (promoted) this.currentClient = previous;
      if (rollbackSucceeded && this.started && !this.stopping) this.resumeClient(previous);
      if (!rollbackSucceeded) await this.failClosed(previous, attempt.client);
      throw error;
    } finally {
      if (this.activeCandidate === attempt) this.activeCandidate = undefined;
    }
  }

  private handleConnect(client: GatewayMqttClient, packet: Pick<IConnackPacket, "sessionPresent">) {
    if (this.currentClient !== client) return;
    const epoch = ++this.connectionEpoch;
    this.clearSubscriptionRetry();
    this.subscriptionRetryAttempt = 0;
    if (!packet.sessionPresent) this.subscriptionsReady = false;
    if (packet.sessionPresent && this.subscriptionsReady) {
      this.connected();
      return;
    }
    this.subscribeActiveConnection(client, epoch, packet.sessionPresent);
  }

  private subscribeActiveConnection(client: GatewayMqttClient, epoch: number, sessionPresent: boolean) {
    let subscription: unknown;
    try {
      subscription = this.options.subscribe(client, sessionPresent, sessionPresent);
    } catch (error) {
      this.report(this.options.onRuntimeError, error, "subscribe");
      this.scheduleSubscriptionRetry(client, epoch, sessionPresent);
      return;
    }
    if (!isPromiseLike(subscription)) {
      this.subscriptionsReady = true;
      this.connected();
      return;
    }
    void Promise.resolve(subscription).then(
      () => {
        if (this.isActiveConnection(client, epoch)) {
          this.clearSubscriptionRetry();
          this.subscriptionRetryAttempt = 0;
          this.subscriptionsReady = true;
          this.connected();
        }
      },
      (error) => {
        this.report(this.options.onRuntimeError, error, "subscribe");
        this.scheduleSubscriptionRetry(client, epoch, sessionPresent);
      }
    );
  }

  private scheduleSubscriptionRetry(client: GatewayMqttClient, epoch: number, sessionPresent: boolean) {
    if (!this.isActiveConnection(client, epoch) || this.subscriptionRetryTimer) return;
    const delay = Math.min(this.subscriptionRetryBaseMs * (2 ** this.subscriptionRetryAttempt), 30_000);
    this.subscriptionRetryAttempt += 1;
    this.subscriptionRetryTimer = setTimeout(() => {
      this.subscriptionRetryTimer = undefined;
      if (this.isActiveConnection(client, epoch)) this.subscribeActiveConnection(client, epoch, sessionPresent);
    }, delay);
  }

  private isActiveConnection(client: GatewayMqttClient, epoch: number) {
    return this.currentClient === client && this.started && !this.stopping && this.connectionEpoch === epoch;
  }

  private connected() {
    this.run(() => this.options.onConnect?.(), "connect");
    this.run(this.options.publishHeartbeat, "heartbeat");
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => this.run(this.options.publishHeartbeat, "heartbeat"), this.options.heartbeatMs);
  }

  private handleClose(client: GatewayMqttClient) {
    if (this.currentClient !== client) return;
    this.connectionEpoch += 1;
    this.clearSubscriptionRetry();
    this.clearHeartbeatTimer();
    this.run(() => this.options.onClose?.(), "close");
  }

  private handleError(client: GatewayMqttClient, error: Error) {
    if (this.currentClient !== client) return;
    this.run(() => this.options.onError?.(error), "mqtt_error");
  }

  private handleMessage(client: GatewayMqttClient, topic: string, payload: Buffer, packet?: IPublishPacket) {
    const handled = this.dispatchMessage(topic, payload, client);
    if (packet?.qos === 1 && this.deferredPubackTopics.has(topic)) {
      this.deferredHandlers.set(packet, handled);
      return;
    }
    void handled.catch(() => undefined);
  }

  private prepareCandidate(client: GatewayMqttClient): CandidateAttempt {
    this.installDeferredPubackBoundary(client);
    let settled = false;
    let connected = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    let subscriptionStarted = false;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void ready.catch(() => undefined);
    const cleanup = () => {
      clearTimeout(timeout);
      client.removeListener("connect", onConnect);
      client.removeListener("error", onError);
      client.removeListener("close", onClose);
      client.removeListener("message", onMessage);
      this.restoreHandleMessage(client);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) rejectReady(error);
      else resolveReady();
    };
    const onConnect = (packet: IConnackPacket) => {
      if (subscriptionStarted) return;
      connected = true;
      subscriptionStarted = true;
      void Promise.resolve(this.options.subscribe(client, packet.sessionPresent, true)).then(
        () => finish(),
        (error) => finish(error instanceof Error ? error : new Error(String(error)))
      );
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("replacement MQTT client closed before subscriptions were ready"));
    const onMessage = (topic: string, payload: Buffer, packet?: IPublishPacket) => {
      // MQTT.js may PUBACK immediately after this event. Dispatch through the normal
      // journal-backed handler now; do not synthesize a second local delivery later.
      this.handleMessage(client, topic, payload, packet);
    };
    const timeout = setTimeout(() => finish(new Error("replacement MQTT client timed out")), this.candidateReadyTimeoutMs);
    client.on("message", onMessage);
    client.on("connect", onConnect);
    client.on("error", onError);
    client.on("close", onClose);
    return { client, ready, cancel: finish, cleanup, hasConnected: () => connected };
  }

  private async commitCandidate(attempt: CandidateAttempt, previous: GatewayMqttClient) {
    attempt.cleanup();
    this.currentClient = attempt.client;
    this.subscriptionsReady = true;
    this.addClientListeners(attempt.client);
    this.connected();
    this.removeClientListeners(previous);
  }

  private async abortCandidate(attempt: CandidateAttempt) {
    attempt.cleanup();
    try {
      await this.endClient(attempt.client);
    } catch (error) {
      this.report(this.options.onRuntimeError, error, "mqtt_candidate_shutdown");
    }
  }

  private throwIfStopping() {
    if (this.stopping || !this.started) throw new Error("MQTT runtime is stopping");
  }

  private async quiesceClient(client: GatewayMqttClient) {
    this.clearHeartbeatTimer();
    this.clearSubscriptionRetry();
    await this.endClient(client);
  }

  private resumeClient(client: GatewayMqttClient) {
    try {
      client.reconnect();
    } catch (error) {
      this.report(this.options.onRuntimeError, error, "mqtt_previous_client_reconnect");
    }
  }

  private async rollbackIdentity(identity: GatewayMqttIdentityTransaction | undefined) {
    try {
      await identity?.rollback();
      return true;
    } catch (error) {
      this.report(this.options.onRuntimeError, error, "mqtt_identity_rollback");
      return false;
    }
  }

  private async failClosed(client: GatewayMqttClient, previous?: GatewayMqttClient, clientAlreadyEnded = false) {
    this.started = false;
    this.clearHeartbeatTimer();
    this.clearSubscriptionRetry();
    this.removeClientListeners(client);
    if (previous && previous !== client) this.removeClientListeners(previous);
    if (clientAlreadyEnded) return;
    try {
      await this.endClient(client);
    } catch (error) {
      this.report(this.options.onRuntimeError, error, "mqtt_fail_closed_shutdown");
    }
  }

  private enqueue<T>(operation: () => Promise<T>) {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private dispatchMessage(topic: string, payload: Buffer, source: GatewayMqttClient): Promise<void> {
    const handler = this.options.topicHandlers[topic];
    if (!handler) return Promise.resolve();
    try {
      return Promise.resolve(handler(payload, source)).then(
        () => undefined,
        (error) => {
          this.report(this.options.onMessageError, error, topic);
          throw error;
        }
      );
    } catch (error) {
      this.report(this.options.onMessageError, error, topic);
      return Promise.reject(error);
    }
  }

  private clearHeartbeatTimer() {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private clearSubscriptionRetry() {
    if (!this.subscriptionRetryTimer) return;
    clearTimeout(this.subscriptionRetryTimer);
    this.subscriptionRetryTimer = undefined;
  }

  private addClientListeners(client: GatewayMqttClient) {
    if (this.clientListeners.has(client)) return;
    this.installDeferredPubackBoundary(client);
    const listeners = {
      connect: (packet: IConnackPacket) => this.handleConnect(client, packet),
      close: () => this.handleClose(client),
      error: (error: Error) => this.handleError(client, error),
      message: (topic: string, payload: Buffer, packet?: IPublishPacket) => this.handleMessage(client, topic, payload, packet)
    };
    this.clientListeners.set(client, listeners);
    client.on("connect", listeners.connect);
    client.on("close", listeners.close);
    client.on("error", listeners.error);
    client.on("message", listeners.message);
  }

  private removeClientListeners(client: GatewayMqttClient) {
    const listeners = this.clientListeners.get(client);
    if (!listeners) return;
    client.removeListener("connect", listeners.connect);
    client.removeListener("close", listeners.close);
    client.removeListener("error", listeners.error);
    client.removeListener("message", listeners.message);
    this.clientListeners.delete(client);
    this.restoreHandleMessage(client);
  }

  private installDeferredPubackBoundary(client: GatewayMqttClient) {
    if (this.originalHandleMessage.has(client) || this.deferredPubackTopics.size === 0) return;
    const original = client.handleMessage;
    this.originalHandleMessage.set(client, original);
    client.handleMessage = (packet, callback) => {
      const deferred = this.deferredHandlers.get(packet);
      if (!deferred) {
        original.call(client, packet, callback);
        return;
      }
      this.deferredHandlers.delete(packet);
      void deferred.then(
        () => original.call(client, packet, callback),
        (error) => callback(error instanceof Error ? error : new Error(String(error)))
      );
    };
  }

  private restoreHandleMessage(client: GatewayMqttClient) {
    const original = this.originalHandleMessage.get(client);
    if (!original) return;
    client.handleMessage = original;
    this.originalHandleMessage.delete(client);
  }

  private endClient(client: GatewayMqttClient) {
    return new Promise<void>((resolve, reject) => {
      client.end(true, (error) => (error ? reject(error) : resolve()));
    });
  }

  private run(action: () => unknown, context: string) {
    try {
      void Promise.resolve(action()).catch((error) => this.report(this.options.onRuntimeError, error, context));
    } catch (error) {
      this.report(this.options.onRuntimeError, error, context);
    }
  }

  private report(reporter: ErrorReporter | undefined, error: unknown, context: string) {
    try {
      void Promise.resolve(reporter?.(error, context)).catch(() => undefined);
    } catch {
      // Error reporting must not create another unhandled rejection on the MQTT event loop.
    }
  }
}

function boundedCandidateReadyTimeout(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 60_000) throw new Error("invalid MQTT candidate readiness timeout");
  return value;
}

function boundedSubscriptionRetry(value: number) {
  if (!Number.isInteger(value) || value < 10 || value > 30_000) throw new Error("invalid MQTT subscription retry interval");
  return value;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function") && "then" in value;
}
