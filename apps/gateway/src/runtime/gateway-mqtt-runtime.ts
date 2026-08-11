import type { IConnackPacket, MqttClient } from "mqtt";

type RuntimeMqttClient = Pick<MqttClient, "end" | "on" | "reconnect" | "removeListener" | "publish" | "subscribe">;
type TopicHandler = (payload: Buffer) => unknown;
type ErrorReporter = (error: unknown, context: string) => unknown;

export interface GatewayMqttIdentityTransaction {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface GatewayMqttRuntimeOptions {
  client: RuntimeMqttClient;
  heartbeatMs: number;
  candidateReadyTimeoutMs?: number;
  subscribe: (client: RuntimeMqttClient, sessionPresent: boolean, force: boolean) => unknown;
  publishHeartbeat: () => unknown;
  topicHandlers: Record<string, TopicHandler>;
  onMessageError: ErrorReporter;
  onConnect?: () => unknown;
  onClose?: () => unknown;
  onError?: (error: Error) => unknown;
  onRuntimeError?: ErrorReporter;
}

interface CandidateAttempt {
  client: RuntimeMqttClient;
  ready: Promise<void>;
  cancel(error: Error): void;
  cleanup(): void;
}

const DEFAULT_CANDIDATE_READY_TIMEOUT_MS = 10_000;

export class GatewayMqttRuntime {
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private stopping = false;
  private queue: Promise<void> = Promise.resolve();
  private activeCandidate: CandidateAttempt | undefined;
  private currentClient: RuntimeMqttClient;
  private readonly candidateReadyTimeoutMs: number;

  constructor(private readonly options: GatewayMqttRuntimeOptions) {
    this.currentClient = options.client;
    this.candidateReadyTimeoutMs = boundedCandidateReadyTimeout(options.candidateReadyTimeoutMs ?? DEFAULT_CANDIDATE_READY_TIMEOUT_MS);
  }

  get client() {
    return this.currentClient;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.addClientListeners(this.currentClient);
  }

  stop() {
    if (!this.started && !this.activeCandidate) return Promise.resolve();
    this.stopping = true;
    this.activeCandidate?.cancel(new Error("MQTT runtime is stopping"));
    return this.enqueue(async () => {
      this.started = false;
      this.clearHeartbeatTimer();
      this.removeClientListeners(this.currentClient);
      await this.endClient(this.currentClient);
    });
  }

  activate(candidate: RuntimeMqttClient, identity?: GatewayMqttIdentityTransaction): Promise<void> {
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
    if (!this.started || this.stopping) {
      await this.abortCandidate(attempt);
      throw new Error("MQTT runtime is stopping");
    }
    try {
      // A stable MQTT client ID lets a new connection evict the old one. End it first
      // so its automatic reconnect loop cannot evict the candidate during readiness.
      await this.quiesceClient(previous);
      this.throwIfStopping();
      attempt.client.reconnect();
      await attempt.ready;
      this.throwIfStopping();
      await identity?.commit();
      this.throwIfStopping();
      await this.commitCandidate(attempt, previous);
    } catch (error) {
      const rollbackSucceeded = await this.rollbackIdentity(identity);
      await this.abortCandidate(attempt);
      if (rollbackSucceeded && this.started && !this.stopping) this.resumeClient(previous);
      if (!rollbackSucceeded) await this.failClosed(previous);
      throw error;
    } finally {
      if (this.activeCandidate === attempt) this.activeCandidate = undefined;
    }
  }

  private readonly handleConnect = (packet: IConnackPacket) => {
    if (!packet.sessionPresent) this.run(() => this.options.subscribe(this.currentClient, false, false), "subscribe");
    this.connected();
  };

  private connected() {
    this.run(() => this.options.onConnect?.(), "connect");
    this.run(this.options.publishHeartbeat, "heartbeat");
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => this.run(this.options.publishHeartbeat, "heartbeat"), this.options.heartbeatMs);
  }

  private readonly handleClose = () => {
    this.clearHeartbeatTimer();
    this.run(() => this.options.onClose?.(), "close");
  };

  private readonly handleError = (error: Error) => {
    this.run(() => this.options.onError?.(error), "mqtt_error");
  };

  private readonly handleMessage = (topic: string, payload: Buffer) => {
    this.dispatchMessage(topic, payload);
  };

  private prepareCandidate(client: RuntimeMqttClient): CandidateAttempt {
    let settled = false;
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
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) rejectReady(error);
      else resolveReady();
    };
    const onConnect = (packet: IConnackPacket) => {
      if (subscriptionStarted) return;
      subscriptionStarted = true;
      void Promise.resolve(this.options.subscribe(client, packet.sessionPresent, true)).then(
        () => finish(),
        (error) => finish(error instanceof Error ? error : new Error(String(error)))
      );
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("replacement MQTT client closed before subscriptions were ready"));
    const onMessage = (topic: string, payload: Buffer) => {
      // MQTT.js may PUBACK immediately after this event. Dispatch through the normal
      // journal-backed handler now; do not synthesize a second local delivery later.
      this.dispatchMessage(topic, payload);
    };
    const timeout = setTimeout(() => finish(new Error("replacement MQTT client timed out")), this.candidateReadyTimeoutMs);
    client.on("message", onMessage);
    client.on("connect", onConnect);
    client.on("error", onError);
    client.on("close", onClose);
    return { client, ready, cancel: finish, cleanup };
  }

  private async commitCandidate(attempt: CandidateAttempt, previous: RuntimeMqttClient) {
    attempt.cleanup();
    this.currentClient = attempt.client;
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

  private async quiesceClient(client: RuntimeMqttClient) {
    this.clearHeartbeatTimer();
    await this.endClient(client);
  }

  private resumeClient(client: RuntimeMqttClient) {
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

  private async failClosed(client: RuntimeMqttClient) {
    this.started = false;
    this.clearHeartbeatTimer();
    this.removeClientListeners(client);
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

  private dispatchMessage(topic: string, payload: Buffer) {
    const handler = this.options.topicHandlers[topic];
    if (!handler) return;
    try {
      void Promise.resolve(handler(payload)).catch((error) => this.report(this.options.onMessageError, error, topic));
    } catch (error) {
      this.report(this.options.onMessageError, error, topic);
    }
  }

  private clearHeartbeatTimer() {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private addClientListeners(client: RuntimeMqttClient) {
    client.on("connect", this.handleConnect);
    client.on("close", this.handleClose);
    client.on("error", this.handleError);
    client.on("message", this.handleMessage);
  }

  private removeClientListeners(client: RuntimeMqttClient) {
    client.removeListener("connect", this.handleConnect);
    client.removeListener("close", this.handleClose);
    client.removeListener("error", this.handleError);
    client.removeListener("message", this.handleMessage);
  }

  private endClient(client: RuntimeMqttClient) {
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
