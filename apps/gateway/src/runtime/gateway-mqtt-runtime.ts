import type { IConnackPacket, MqttClient } from "mqtt";

type RuntimeMqttClient = Pick<MqttClient, "end" | "on" | "removeListener">;
type TopicHandler = (payload: Buffer) => unknown;
type ErrorReporter = (error: unknown, context: string) => unknown;

export interface GatewayMqttRuntimeOptions {
  client: RuntimeMqttClient;
  heartbeatMs: number;
  subscribe: (sessionPresent: boolean) => unknown;
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

  constructor(private readonly options: GatewayMqttRuntimeOptions) {}

  start() {
    if (this.started) return;
    this.started = true;
    this.options.client.on("connect", this.handleConnect);
    this.options.client.on("close", this.handleClose);
    this.options.client.on("error", this.handleError);
    this.options.client.on("message", this.handleMessage);
  }

  async stop() {
    if (!this.started) return;
    this.started = false;
    this.clearHeartbeatTimer();
    this.options.client.removeListener("connect", this.handleConnect);
    this.options.client.removeListener("close", this.handleClose);
    this.options.client.removeListener("error", this.handleError);
    this.options.client.removeListener("message", this.handleMessage);
    await new Promise<void>((resolve, reject) => {
      this.options.client.end(true, (error) => (error ? reject(error) : resolve()));
    });
  }

  private readonly handleConnect = (packet: IConnackPacket) => {
    if (!packet.sessionPresent) this.run(() => this.options.subscribe(false), "subscribe");
    this.run(() => this.options.onConnect?.(), "connect");
    this.run(this.options.publishHeartbeat, "heartbeat");
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => this.run(this.options.publishHeartbeat, "heartbeat"), this.options.heartbeatMs);
  };

  private readonly handleClose = () => {
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
