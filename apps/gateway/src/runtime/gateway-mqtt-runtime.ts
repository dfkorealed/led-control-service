import type { IConnackPacket, IPublishPacket, MqttClient } from "mqtt";

export type GatewayMqttClient = Pick<
  MqttClient,
  "connected" | "end" | "handleMessage" | "on" | "reconnect" | "removeListener" | "publish" | "subscribe" | "unsubscribe"
>;
export interface GatewayDeferredMessageControl {
  acknowledgeDurable(): void;
}

type TopicHandler = (
  payload: Buffer,
  source: GatewayMqttClient,
  packet?: IPublishPacket,
  control?: GatewayDeferredMessageControl
) => unknown;
type ErrorReporter = (error: unknown, context: string) => unknown;

export interface GatewayMqttIdentityTransaction {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface GatewayMqttRuntimeOptions {
  client: GatewayMqttClient;
  heartbeatMs: number;
  candidateReadyTimeoutMs?: number;
  commandIntakeQuiesceTimeoutMs?: number;
  subscriptionRetryBaseMs?: number;
  subscribe: (client: GatewayMqttClient, sessionPresent: boolean, force: boolean) => unknown;
  subscribeAcknowledgements?: (client: GatewayMqttClient, sessionPresent: boolean, force: boolean) => unknown;
  publishHeartbeat: () => unknown;
  topicHandlers: Record<string, TopicHandler>;
  commandTopics?: readonly string[];
  deferredPubackTopics?: readonly string[];
  onMessageError: ErrorReporter;
  onConnect?: () => unknown;
  onClose?: () => unknown;
  onBeforeStop?: () => Promise<unknown> | unknown;
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
const DEFAULT_COMMAND_INTAKE_QUIESCE_TIMEOUT_MS = 5_000;

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
  private readonly blockedCommandPubacks = new WeakSet<object>();
  private readonly deferredPubackTopics: ReadonlySet<string>;
  private readonly commandTopics: ReadonlySet<string>;
  private readonly candidateReadyTimeoutMs: number;
  private readonly commandIntakeQuiesceTimeoutMs: number;
  private connectionEpoch = 0;
  private subscriptionRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private subscriptionRetryAttempt = 0;
  private readonly subscriptionRetryBaseMs: number;
  private subscriptionsReady = false;
  private commandIntakeQuiesced = false;
  private commandIntakeClosed = false;
  private commandIntakeQuiescing: Promise<void> | undefined;

  constructor(private readonly options: GatewayMqttRuntimeOptions) {
    this.currentClient = options.client;
    this.candidateReadyTimeoutMs = boundedCandidateReadyTimeout(options.candidateReadyTimeoutMs ?? DEFAULT_CANDIDATE_READY_TIMEOUT_MS);
    this.commandIntakeQuiesceTimeoutMs = boundedCommandIntakeQuiesceTimeout(
      options.commandIntakeQuiesceTimeoutMs ?? DEFAULT_COMMAND_INTAKE_QUIESCE_TIMEOUT_MS
    );
    this.subscriptionRetryBaseMs = boundedSubscriptionRetry(options.subscriptionRetryBaseMs ?? 1_000);
    this.deferredPubackTopics = new Set(options.deferredPubackTopics ?? []);
    this.commandTopics = new Set(options.commandTopics ?? []);
  }

  get client() {
    return this.currentClient;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.commandIntakeQuiesced = false;
    this.commandIntakeClosed = false;
    this.commandIntakeQuiescing = undefined;
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
      this.clearHeartbeatTimer();
      this.clearSubscriptionRetry();
      let quiesceError: unknown;
      try {
        await this.quiesceCommandIntake();
      } catch (error) {
        quiesceError = error;
        this.commandIntakeQuiesced = true;
      }
      let drainError: unknown;
      try {
        await this.options.onBeforeStop?.();
      } catch (error) {
        drainError = error;
      }
      this.started = false;
      this.removeClientListeners(this.currentClient);
      let shutdownError: unknown;
      try {
        await this.endClient(this.currentClient);
      } catch (error) {
        shutdownError = error;
      }
      const errors = [quiesceError, drainError, shutdownError].filter((error) => error !== undefined);
      if (errors.length > 1) throw new AggregateError(errors, "MQTT quiesce, drain, or shutdown failed");
      if (quiesceError) throw quiesceError;
      if (drainError) throw drainError;
      if (shutdownError) throw shutdownError;
    });
  }

  quiesceCommandIntake() {
    if (this.commandIntakeQuiescing) return this.commandIntakeQuiescing;
    if (this.commandIntakeQuiesced) return Promise.resolve();
    // Switch reconnect policy before waiting for UNSUBACK. A command already in
    // flight still follows the normal durable handler instead of being locally dropped.
    this.commandIntakeQuiesced = true;
    this.clearSubscriptionRetry();
    this.connectionEpoch += 1;
    const client = this.currentClient;
    const topics = [...this.commandTopics];
    const quiescing = topics.length === 0
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
        client.unsubscribe(topics, (error) => (error ? reject(error) : resolve()));
      });
    this.commandIntakeQuiescing = withTimeout(
      quiescing,
      this.commandIntakeQuiesceTimeoutMs,
      `MQTT command intake unsubscribe timed out after ${this.commandIntakeQuiesceTimeoutMs}ms`
    ).then(() => {
      if (client !== this.currentClient) throw new Error("MQTT client changed while command intake was quiescing");
    }).finally(() => {
      // Once unsubscribe has a terminal result, no later command may enter RF.
      // QoS1 packets are left unacknowledged so the broker redelivers on restart.
      this.commandIntakeClosed = true;
    });
    return this.commandIntakeQuiescing;
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
    // reconnect마다 generation을 올린다. 이전 연결의 늦은 subscribe 완료 callback이
    // 새 연결의 준비 상태를 덮어 heartbeat나 command intake를 중복 시작하는 일을
    // isActiveConnection 검사로 막는다.
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
      const subscribe = this.commandIntakeQuiesced
        ? this.options.subscribeAcknowledgements
        : this.options.subscribe;
      subscription = subscribe?.(client, sessionPresent, sessionPresent);
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
    if (this.commandIntakeClosed && this.commandTopics.has(topic)) {
      if (packet?.qos === 1) this.blockedCommandPubacks.add(packet);
      return;
    }
    if (packet?.qos === 1 && this.deferredPubackTopics.has(topic)) {
      let acknowledgeDurable!: () => void;
      let retryDelivery!: (error: Error) => void;
      const durable = new Promise<void>((resolve, reject) => {
        acknowledgeDurable = resolve;
        retryDelivery = reject;
      });
      const handled = this.dispatchMessage(topic, payload, client, packet, { acknowledgeDurable });
      this.deferredHandlers.set(packet, durable);
      void handled.then(
        acknowledgeDurable,
        (error) => retryDelivery(error instanceof Error ? error : new Error(String(error)))
      );
      return;
    }
    const handled = this.dispatchMessage(topic, payload, client, packet);
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
      const subscribe = this.commandIntakeQuiesced
        ? this.options.subscribeAcknowledgements
        : this.options.subscribe;
      void Promise.resolve(subscribe?.(client, packet.sessionPresent, true)).then(
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
    // identity 교체·중지·재연결은 한 줄로 직렬화한다. 동시에 실행하면 이전 client의
    // 자동 reconnect가 후보 client를 밀어내거나 rollback 뒤 연결을 되살릴 수 있어,
    // cloud MQTT 다음 계층에 서로 다른 session이 섞이지 않게 한다.
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private dispatchMessage(
    topic: string,
    payload: Buffer,
    source: GatewayMqttClient,
    packet?: IPublishPacket,
    control?: GatewayDeferredMessageControl
  ): Promise<void> {
    const handler = this.options.topicHandlers[topic];
    if (!handler) return Promise.resolve();
    try {
      return Promise.resolve(handler(payload, source, packet, control)).then(
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
    if (this.originalHandleMessage.has(client) ||
      (this.deferredPubackTopics.size === 0 && this.commandTopics.size === 0)) return;
    const original = client.handleMessage;
    this.originalHandleMessage.set(client, original);
    client.handleMessage = (packet, callback) => {
      if (this.blockedCommandPubacks.has(packet)) {
        callback(new Error("MQTT command intake is closed"));
        return;
      }
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

function boundedCommandIntakeQuiesceTimeout(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 60_000) {
    throw new Error("invalid MQTT command intake quiesce timeout");
  }
  return value;
}

function boundedSubscriptionRetry(value: number) {
  if (!Number.isInteger(value) || value < 10 || value > 30_000) throw new Error("invalid MQTT subscription retry interval");
  return value;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function") && "then" in value;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}
