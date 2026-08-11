import type { IConnackPacket, MqttClient } from "mqtt";

type RuntimeMqttClient = Pick<MqttClient, "end" | "on" | "removeListener" | "publish" | "subscribe">;
type TopicHandler = (payload: Buffer) => unknown;
type ErrorReporter = (error: unknown, context: string) => unknown;

export interface GatewayMqttRuntimeOptions {
  client: RuntimeMqttClient;
  heartbeatMs: number;
  subscribe: (client: RuntimeMqttClient, sessionPresent: boolean, force: boolean) => unknown;
  publishHeartbeat: () => unknown;
  topicHandlers: Record<string, TopicHandler>;
  onMessageError: ErrorReporter;
  onConnect?: () => unknown;
  onClose?: () => unknown;
  onError?: (error: Error) => unknown;
  onRuntimeError?: ErrorReporter;
}

export class GatewayMqttRuntime {
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private replacing: Promise<void> | undefined;
  private currentClient: RuntimeMqttClient;

  constructor(private readonly options: GatewayMqttRuntimeOptions) {
    this.currentClient = options.client;
  }

  get client() {
    return this.currentClient;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.addClientListeners(this.currentClient);
  }

  async stop() {
    if (!this.started) return;
    this.started = false;
    this.clearHeartbeatTimer();
    this.removeClientListeners(this.currentClient);
    await this.endClient(this.currentClient);
  }

  activate(candidate: RuntimeMqttClient): Promise<void> {
    if (!this.started) return Promise.reject(new Error("MQTT runtime is not started"));
    this.replacing ??= this.replaceClient(candidate).finally(() => { this.replacing = undefined; });
    return this.replacing;
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
    const handler = this.options.topicHandlers[topic];
    if (!handler) return;
    try {
      void Promise.resolve(handler(payload)).catch((error) => this.report(this.options.onMessageError, error, topic));
    } catch (error) {
      this.report(this.options.onMessageError, error, topic);
    }
  };

  private clearHeartbeatTimer() {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private async replaceClient(candidate: RuntimeMqttClient) {
    try {
      await this.waitForReady(candidate);
    } catch (error) {
      try {
        await this.endClient(candidate);
      } catch (shutdownError) {
        this.report(this.options.onRuntimeError, shutdownError, "mqtt_candidate_shutdown");
      }
      throw error;
    }
    const previous = this.currentClient;
    this.currentClient = candidate;
    this.addClientListeners(candidate);
    this.connected();
    this.removeClientListeners(previous);
    try {
      await this.endClient(previous);
    } catch (error) {
      this.report(this.options.onRuntimeError, error, "mqtt_previous_client_shutdown");
    }
  }

  private waitForReady(candidate: RuntimeMqttClient) {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        candidate.removeListener("connect", onConnect);
        candidate.removeListener("error", onError);
        candidate.removeListener("close", onClose);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onConnect = (packet: IConnackPacket) => {
        void Promise.resolve(this.options.subscribe(candidate, packet.sessionPresent, true)).then(
          () => finish(),
          (error) => finish(error instanceof Error ? error : new Error(String(error)))
        );
      };
      const onError = (error: Error) => finish(error);
      const onClose = () => finish(new Error("replacement MQTT client closed before subscriptions were ready"));
      candidate.on("connect", onConnect);
      candidate.on("error", onError);
      candidate.on("close", onClose);
    });
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
