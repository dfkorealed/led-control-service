import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayMqttRuntime, type GatewayMqttClient } from "./gateway-mqtt-runtime";

class FakeMqttClient extends EventEmitter {
  connected = false;
  handleMessage = vi.fn((_packet: unknown, callback: (error?: Error) => void) => callback());
  readonly end = vi.fn((_force?: boolean, callback?: (error?: Error) => void) => callback?.());
  readonly publish = vi.fn((_topic: string, _payload: string, _options?: unknown, callback?: (error?: Error) => void) => callback?.());
  readonly unsubscribe = vi.fn((_topics: string | string[], callback?: (error?: Error) => void) => callback?.());
  readonly reconnect = vi.fn();
}

const topicHandlers = {
  "commands/dimming": vi.fn(),
  "commands/provisioning/scan-start": vi.fn(),
  "commands/provisioning/identify-device": vi.fn(),
  "commands/provisioning/provision-device": vi.fn(),
  "commands/automation/config-sync": vi.fn()
};

describe("GatewayMqttRuntime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("recovers an already-connected startup once after listeners and subscriptions are ready", async () => {
    const client = new FakeMqttClient();
    client.connected = true;
    const order: string[] = [];
    const subscribe = vi.fn(() => {
      expect(client.listenerCount("connect")).toBe(1);
      order.push("subscribed");
    });
    const onConnect = vi.fn(() => order.push("recovered"));
    const runtime = new GatewayMqttRuntime({
      client: client as never,
      heartbeatMs: 10_000,
      subscribe,
      publishHeartbeat: vi.fn(),
      topicHandlers,
      onMessageError: vi.fn(),
      onConnect
    });

    runtime.start();
    runtime.start();
    await vi.waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1));

    expect(subscribe).toHaveBeenCalledWith(client, false, false);
    expect(order).toEqual(["subscribed", "recovered"]);
    await runtime.stop();
  });

  it("keeps one heartbeat timer and subscribes only for a new persistent session after reconnects", async () => {
    vi.useFakeTimers();
    const client = new FakeMqttClient();
    const subscribe = vi.fn();
    const publishHeartbeat = vi.fn();
    const runtime = new GatewayMqttRuntime({
      client: client as never,
      heartbeatMs: 1_000,
      subscribe,
      publishHeartbeat,
      topicHandlers,
      onMessageError: vi.fn()
    });

    runtime.start();
    client.emit("connect", { sessionPresent: false });
    client.emit("connect", { sessionPresent: true });
    client.emit("connect", { sessionPresent: true });

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(publishHeartbeat).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(publishHeartbeat).toHaveBeenCalledTimes(4);
    await runtime.stop();
  });

  it("waits for a new-session subscription before publishing startup work", async () => {
    const client = new FakeMqttClient();
    let release!: () => void;
    const subscription = new Promise<void>((resolve) => { release = resolve; });
    const onConnect = vi.fn();
    const publishHeartbeat = vi.fn();
    const runtime = new GatewayMqttRuntime({
      client: client as never,
      heartbeatMs: 1_000,
      subscribe: vi.fn(() => subscription),
      publishHeartbeat,
      topicHandlers,
      onMessageError: vi.fn(),
      onConnect
    });

    runtime.start();
    client.emit("connect", { sessionPresent: false });
    await Promise.resolve();
    expect(onConnect).not.toHaveBeenCalled();
    expect(publishHeartbeat).not.toHaveBeenCalled();

    release();
    await vi.waitFor(() => expect(onConnect).toHaveBeenCalledTimes(1));
    expect(publishHeartbeat).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });

  it("retries a failed subscription on the same connection and cleans the retry timer", async () => {
    vi.useFakeTimers();
    const client = new FakeMqttClient();
    const subscribe = vi.fn()
      .mockRejectedValueOnce(new Error("SUBACK failed"))
      .mockResolvedValueOnce(undefined);
    const publishHeartbeat = vi.fn();
    const runtime = new GatewayMqttRuntime({
      client: client as never,
      heartbeatMs: 10_000,
      subscriptionRetryBaseMs: 100,
      subscribe,
      publishHeartbeat,
      topicHandlers,
      onMessageError: vi.fn(),
      onRuntimeError: vi.fn()
    });

    runtime.start();
    client.emit("connect", { sessionPresent: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(publishHeartbeat).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(publishHeartbeat).toHaveBeenCalledTimes(1));
    expect(subscribe).toHaveBeenCalledTimes(2);

    await runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forces subscription after a failed new-session SUBACK even when reconnect reports a persistent session", async () => {
    const client = new FakeMqttClient();
    let releaseSecond!: () => void;
    const secondSubscription = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const subscribe = vi.fn()
      .mockRejectedValueOnce(new Error("SUBACK failed"))
      .mockReturnValueOnce(secondSubscription);
    const publishHeartbeat = vi.fn();
    const runtime = new GatewayMqttRuntime({
      client: client as never,
      heartbeatMs: 10_000,
      subscribe,
      publishHeartbeat,
      topicHandlers,
      onMessageError: vi.fn(),
      onRuntimeError: vi.fn()
    });

    runtime.start();
    client.emit("connect", { sessionPresent: false });
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
    client.emit("close");
    client.emit("connect", { sessionPresent: true });
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2));
    expect(subscribe).toHaveBeenLastCalledWith(client, true, true);
    expect(publishHeartbeat).not.toHaveBeenCalled();

    releaseSecond();
    await vi.waitFor(() => expect(publishHeartbeat).toHaveBeenCalledTimes(1));
    await runtime.stop();
  });

  it("stops heartbeats while disconnected and starts one timer again after reconnect", async () => {
    vi.useFakeTimers();
    const client = new FakeMqttClient();
    const health = vi.fn();
    const publishHeartbeat = vi.fn(() => health("healthy"));
    const runtime = new GatewayMqttRuntime({
      client: client as never,
      heartbeatMs: 1_000,
      subscribe: vi.fn(),
      publishHeartbeat,
      topicHandlers,
      onMessageError: vi.fn(),
      onClose: () => health("unhealthy")
    });

    runtime.start();
    client.emit("connect", { sessionPresent: false });
    client.emit("close");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(publishHeartbeat).toHaveBeenCalledTimes(1);
    expect(health).toHaveBeenLastCalledWith("unhealthy");
    expect(vi.getTimerCount()).toBe(0);

    client.emit("connect", { sessionPresent: true });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(publishHeartbeat).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
    await runtime.stop();
  });

  it.each(Object.keys(topicHandlers))("reports rejected %s handlers without an unhandled rejection", async (topic) => {
    const client = new FakeMqttClient();
    const onMessageError = vi.fn();
    const unhandledRejection = vi.fn();
    const handlers = Object.fromEntries(
      Object.keys(topicHandlers).map((handlerTopic) => [
        handlerTopic,
        handlerTopic === topic ? async () => { throw new Error(`${handlerTopic} failed`); } : vi.fn()
      ])
    );
    const runtime = new GatewayMqttRuntime({
      client: client as never,
      heartbeatMs: 1_000,
      subscribe: vi.fn(),
      publishHeartbeat: vi.fn(),
      topicHandlers: handlers,
      onMessageError
    });
    process.once("unhandledRejection", unhandledRejection);

    runtime.start();
    client.emit("message", topic, Buffer.from("{}"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onMessageError).toHaveBeenCalledWith(new Error(`${topic} failed`), topic);
    expect(unhandledRejection).not.toHaveBeenCalled();
    expect(client.end).not.toHaveBeenCalled();

    process.removeListener("unhandledRejection", unhandledRejection);
    await runtime.stop();
  });

  it("holds the config QoS1 PUBACK boundary until its durable handler completes", async () => {
    const client = new FakeMqttClient();
    const order: string[] = [];
    let release!: () => void;
    const durable = new Promise<void>((resolve) => { release = resolve; });
    const runtime = new GatewayMqttRuntime({
      client: client as never,
      heartbeatMs: 1_000,
      subscribe: vi.fn(),
      publishHeartbeat: vi.fn(),
      topicHandlers: {
        "commands/automation/config-sync": async () => {
          await durable;
          order.push("ack-fsynced");
        },
        "commands/dimming": vi.fn()
      },
      deferredPubackTopics: ["commands/automation/config-sync"],
      onMessageError: vi.fn()
    });
    runtime.start();
    const packet = { cmd: "publish", qos: 1, messageId: 17 };

    client.emit("message", "commands/automation/config-sync", Buffer.from("{}"), packet);
    client.handleMessage(packet, () => order.push("puback"));
    await Promise.resolve();
    expect(order).toEqual([]);

    release();
    await vi.waitFor(() => expect(order).toEqual(["ack-fsynced", "puback"]));
    await runtime.stop();
  });

  it("releases dimming PUBACK at the handler's durable boundary while execution continues", async () => {
    const client = new FakeMqttClient();
    let release!: () => void;
    const handler = vi.fn((_payload, _source, _packet, control) => {
      control.acknowledgeDurable();
      return new Promise<void>((resolve) => { release = resolve; });
    });
    const runtime = new GatewayMqttRuntime({
      client: client as never,
      heartbeatMs: 1_000,
      subscribe: vi.fn(),
      publishHeartbeat: vi.fn(),
      topicHandlers: { "commands/dimming": handler },
      deferredPubackTopics: ["commands/automation/config-sync", "commands/dimming"],
      onMessageError: vi.fn()
    });
    runtime.start();
    const packet = {
      cmd: "publish",
      qos: 1,
      messageId: 18,
      properties: { messageExpiryInterval: 7 }
    };
    const puback = vi.fn();

    client.emit("message", "commands/dimming", Buffer.from("{}"), packet);
    client.handleMessage(packet, puback);

    await vi.waitFor(() => expect(puback).toHaveBeenCalledTimes(1));
    expect(handler).toHaveBeenCalledWith(
      Buffer.from("{}"),
      client,
      packet,
      expect.objectContaining({ acknowledgeDurable: expect.any(Function) })
    );
    release();
    await runtime.stop();
  });

  it("releases provisioning PUBACK after durable accept while RF execution continues", async () => {
    const client = new FakeMqttClient();
    let releaseRf!: () => void;
    const handler = vi.fn((_payload, _source, _packet, control) => {
      control.acknowledgeDurable();
      return new Promise<void>((resolve) => { releaseRf = resolve; });
    });
    const runtime = new GatewayMqttRuntime({
      client: client as never,
      heartbeatMs: 1_000,
      subscribe: vi.fn(),
      publishHeartbeat: vi.fn(),
      topicHandlers: { "commands/provisioning/provision-device": handler },
      deferredPubackTopics: ["commands/provisioning/provision-device"],
      onMessageError: vi.fn()
    });
    runtime.start();
    const packet = { qos: 1 } as never;
    const puback = vi.fn();

    client.emit("message", "commands/provisioning/provision-device", Buffer.from("{}"), packet);
    client.handleMessage(packet, puback);

    await vi.waitFor(() => expect(puback).toHaveBeenCalledTimes(1));
    expect(handler).toHaveBeenCalledWith(
      Buffer.from("{}"),
      client,
      packet,
      expect.objectContaining({ acknowledgeDurable: expect.any(Function) })
    );
    releaseRf();
    await runtime.stop();
  });

  it("clears its timer, removes client listeners, and ends the MQTT client on stop", async () => {
    vi.useFakeTimers();
    const client = new FakeMqttClient();
    const publishHeartbeat = vi.fn();
    const runtime = new GatewayMqttRuntime({
      client: client as never,
      heartbeatMs: 1_000,
      subscribe: vi.fn(),
      publishHeartbeat,
      topicHandlers,
      onMessageError: vi.fn()
    });

    runtime.start();
    client.emit("connect", { sessionPresent: false });
    await runtime.stop();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(publishHeartbeat).toHaveBeenCalledTimes(1);
    expect(client.listenerCount("connect")).toBe(0);
    expect(client.listenerCount("close")).toBe(0);
    expect(client.listenerCount("error")).toBe(0);
    expect(client.listenerCount("message")).toBe(0);
    expect(client.end).toHaveBeenCalledWith(true, expect.any(Function));
  });

  it("drains durable publishers before ending the active MQTT client", async () => {
    const client = new FakeMqttClient();
    let release!: () => void;
    const draining = new Promise<void>((resolve) => { release = resolve; });
    const onBeforeStop = vi.fn(() => draining);
    const runtime = new GatewayMqttRuntime({
      client: client as never,
      heartbeatMs: 1_000,
      subscribe: vi.fn(),
      publishHeartbeat: vi.fn(),
      topicHandlers,
      onMessageError: vi.fn(),
      onBeforeStop
    });
    runtime.start();

    const stopping = runtime.stop();
    await vi.waitFor(() => expect(onBeforeStop).toHaveBeenCalledTimes(1));
    expect(client.end).not.toHaveBeenCalled();

    release();
    await stopping;
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("keeps ACK intake and the durable PUBACK boundary for a command raced with quiesce", async () => {
    const client = new FakeMqttClient();
    let finishUnsubscribe!: () => void;
    client.unsubscribe.mockImplementation((_topics, callback) => {
      finishUnsubscribe = () => callback?.();
    });
    let acknowledgeDurable!: () => void;
    const handler = vi.fn((_payload, _source, _packet, control) => {
      acknowledgeDurable = control.acknowledgeDurable;
      return new Promise<void>(() => undefined);
    });
    const acknowledgement = vi.fn();
    const commandTopic = "commands/provisioning/provision-device";
    const runtime = new GatewayMqttRuntime({
      client: client as never,
      heartbeatMs: 1_000,
      subscribe: vi.fn(),
      publishHeartbeat: vi.fn(),
      topicHandlers: { [commandTopic]: handler, "acks/provisioning/device-terminal-ingested": acknowledgement },
      commandTopics: [commandTopic],
      deferredPubackTopics: [commandTopic],
      onMessageError: vi.fn()
    });
    runtime.start();

    const quiescing = runtime.quiesceCommandIntake();
    const packet = { qos: 1 } as never;
    const puback = vi.fn();
    client.emit("message", commandTopic, Buffer.from("{}"), packet);
    client.handleMessage(packet, puback);
    client.emit("message", "acks/provisioning/device-terminal-ingested", Buffer.from("{}"));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(puback).not.toHaveBeenCalled();
    expect(acknowledgement).toHaveBeenCalledTimes(1);
    expect(client.unsubscribe).toHaveBeenCalledWith([commandTopic], expect.any(Function));
    expect(client.end).not.toHaveBeenCalled();
    acknowledgeDurable();
    await vi.waitFor(() => expect(puback).toHaveBeenCalledTimes(1));
    finishUnsubscribe();
    await quiescing;
    await runtime.stop();
  });

  it("fails closed after unsubscribe rejection while keeping ACK intake and replay publishing alive", async () => {
    const client = new FakeMqttClient();
    const commandTopic = "commands/provisioning/provision-device";
    const acknowledgementTopic = "acks/provisioning/device-terminal-ingested";
    const handler = vi.fn();
    const acknowledgement = vi.fn();
    const replayPublished = vi.fn();
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => { releaseDrain = resolve; });
    const onBeforeStop = vi.fn(() => drain);
    client.unsubscribe.mockImplementation((_topics, callback) => callback?.(new Error("UNSUBACK failed")));
    client.publish.mockImplementation((_topic, _payload, _options, callback) => {
      replayPublished();
      callback?.();
    });
    const runtime = new GatewayMqttRuntime({
      client: client as never,
      heartbeatMs: 1_000,
      subscribe: vi.fn(),
      subscribeAcknowledgements: vi.fn(),
      publishHeartbeat: vi.fn(),
      topicHandlers: { [commandTopic]: handler, [acknowledgementTopic]: acknowledgement },
      commandTopics: [commandTopic],
      deferredPubackTopics: [commandTopic],
      onMessageError: vi.fn(),
      onBeforeStop
    });
    runtime.start();

    const stopping = runtime.stop();
    void stopping.catch(() => undefined);
    await vi.waitFor(() => expect(onBeforeStop).toHaveBeenCalledTimes(1));
    const packet = { qos: 1 } as never;
    const puback = vi.fn();
    const packetHandled = vi.fn((error?: Error) => {
      if (!error) puback();
    });
    client.emit("message", commandTopic, Buffer.from("{}"), packet);
    client.handleMessage(packet, packetHandled);
    client.emit("message", acknowledgementTopic, Buffer.from("{}"));
    client.publish("events/provisioning/device-terminal", "{}", { qos: 1 }, vi.fn());
    await Promise.resolve();
    await Promise.resolve();

    expect(handler).not.toHaveBeenCalled();
    expect(puback).not.toHaveBeenCalled();
    expect(packetHandled).toHaveBeenCalledWith(expect.any(Error));
    expect(acknowledgement).toHaveBeenCalledTimes(1);
    expect(replayPublished).toHaveBeenCalledTimes(1);
    expect(client.end).not.toHaveBeenCalled();

    releaseDrain();
    await expect(stopping).rejects.toThrow("UNSUBACK failed");
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("fails closed after unsubscribe timeout while onBeforeStop is still blocked", async () => {
    vi.useFakeTimers();
    const client = new FakeMqttClient();
    const commandTopic = "commands/provisioning/provision-device";
    const handler = vi.fn();
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => { releaseDrain = resolve; });
    const onBeforeStop = vi.fn(() => drain);
    client.unsubscribe.mockImplementation(() => undefined as never);
    const runtime = new GatewayMqttRuntime({
      client: client as never,
      heartbeatMs: 1_000,
      commandIntakeQuiesceTimeoutMs: 100,
      subscribe: vi.fn(),
      subscribeAcknowledgements: vi.fn(),
      publishHeartbeat: vi.fn(),
      topicHandlers: { [commandTopic]: handler },
      commandTopics: [commandTopic],
      deferredPubackTopics: [commandTopic],
      onMessageError: vi.fn(),
      onBeforeStop
    });
    runtime.start();

    const stopping = runtime.stop();
    void stopping.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(onBeforeStop).toHaveBeenCalledTimes(1);
    const packet = { qos: 1 } as never;
    const puback = vi.fn();
    const packetHandled = vi.fn((error?: Error) => {
      if (!error) puback();
    });
    client.emit("message", commandTopic, Buffer.from("{}"), packet);
    client.handleMessage(packet, packetHandled);
    await vi.advanceTimersByTimeAsync(0);

    expect(handler).not.toHaveBeenCalled();
    expect(puback).not.toHaveBeenCalled();
    expect(packetHandled).toHaveBeenCalledWith(expect.any(Error));
    expect(client.end).not.toHaveBeenCalled();

    releaseDrain();
    await expect(stopping).rejects.toThrow("MQTT command intake unsubscribe timed out after 100ms");
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("restores only acknowledgement subscriptions after a post-quiesce session loss", async () => {
    const client = new FakeMqttClient();
    const subscribe = vi.fn();
    const subscribeAcknowledgements = vi.fn();
    const commandTopic = "commands/provisioning/provision-device";
    const runtime = new GatewayMqttRuntime({
      client: client as never,
      heartbeatMs: 1_000,
      subscribe,
      subscribeAcknowledgements,
      publishHeartbeat: vi.fn(),
      topicHandlers: { [commandTopic]: vi.fn() },
      commandTopics: [commandTopic],
      onMessageError: vi.fn()
    });
    runtime.start();
    client.emit("connect", { sessionPresent: false });
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));

    await runtime.quiesceCommandIntake();
    client.emit("close");
    client.emit("connect", { sessionPresent: false });

    await vi.waitFor(() => expect(subscribeAcknowledgements).toHaveBeenCalledTimes(1));
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribeAcknowledgements).toHaveBeenCalledWith(client, false, false);
    await runtime.stop();
  });

  it("bounds an unresponsive unsubscribe and still drains before ending the client", async () => {
    vi.useFakeTimers();
    const client = new FakeMqttClient();
    const order: string[] = [];
    client.unsubscribe.mockImplementation(() => undefined as never);
    client.end.mockImplementation((_force, callback) => {
      order.push("end");
      callback?.();
    });
    const runtime = new GatewayMqttRuntime({
      client: client as never,
      heartbeatMs: 1_000,
      commandIntakeQuiesceTimeoutMs: 100,
      subscribe: vi.fn(),
      publishHeartbeat: vi.fn(),
      topicHandlers,
      commandTopics: ["commands/provisioning/provision-device"],
      onMessageError: vi.fn(),
      onBeforeStop: async () => { order.push("drain"); }
    });
    runtime.start();

    const stopping = runtime.stop().then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error })
    );
    const outcome = Promise.race([
      stopping,
      new Promise<{ kind: "blocked" }>((resolve) => setTimeout(() => resolve({ kind: "blocked" }), 101))
    ]);
    await vi.advanceTimersByTimeAsync(101);

    await expect(outcome).resolves.toMatchObject({
      kind: "rejected",
      error: new Error("MQTT command intake unsubscribe timed out after 100ms")
    });
    expect(order).toEqual(["drain", "end"]);
  });

  it("drains and ends the client after unsubscribe rejection before reporting the error", async () => {
    const client = new FakeMqttClient();
    const order: string[] = [];
    client.unsubscribe.mockImplementation((_topics, callback) => callback?.(new Error("UNSUBACK failed")));
    client.end.mockImplementation((_force, callback) => {
      order.push("end");
      callback?.();
    });
    const runtime = new GatewayMqttRuntime({
      client: client as never,
      heartbeatMs: 1_000,
      subscribe: vi.fn(),
      publishHeartbeat: vi.fn(),
      topicHandlers,
      commandTopics: ["commands/provisioning/provision-device"],
      onMessageError: vi.fn(),
      onBeforeStop: async () => { order.push("drain"); }
    });
    runtime.start();

    await expect(runtime.stop()).rejects.toThrow("UNSUBACK failed");
    expect(order).toEqual(["drain", "end"]);
  });

  it("reports an MQTT client shutdown failure to its caller", async () => {
    const client = new FakeMqttClient();
    client.end.mockImplementationOnce((_force, callback) => callback?.(new Error("MQTT shutdown failed")));
    const runtime = new GatewayMqttRuntime({
      client: client as never,
      heartbeatMs: 1_000,
      subscribe: vi.fn(),
      publishHeartbeat: vi.fn(),
      topicHandlers,
      onMessageError: vi.fn()
    });

    runtime.start();

    await expect(runtime.stop()).rejects.toThrow("MQTT shutdown failed");
  });

  it("keeps the active connection until a replacement has connected and subscribed", async () => {
    const current = new FakeMqttClient();
    const replacement = new FakeMqttClient();
    const subscribe = vi.fn((_client: FakeMqttClient, _sessionPresent: boolean, force: boolean) => {
      if (!force) return undefined;
      return Promise.resolve();
    });
    const runtime = new GatewayMqttRuntime({
      client: current as never,
      heartbeatMs: 1_000,
      subscribe: subscribe as never,
      publishHeartbeat: vi.fn(),
      topicHandlers,
      onMessageError: vi.fn()
    });
    runtime.start();

    const activating = runtime.activate(replacement as never);
    replacement.emit("connect", { sessionPresent: false });
    await activating;

    expect(runtime.client).toBe(replacement);
    expect(subscribe).toHaveBeenCalledWith(replacement, false, true);
    expect(current.end).toHaveBeenCalledWith(true, expect.any(Function));
    await runtime.stop();
  });

  it("retains the current connection when a replacement identity cannot connect", async () => {
    const current = new FakeMqttClient();
    const replacement = new FakeMqttClient();
    const runtime = new GatewayMqttRuntime({
      client: current as never,
      heartbeatMs: 1_000,
      subscribe: vi.fn() as never,
      publishHeartbeat: vi.fn(),
      topicHandlers,
      onMessageError: vi.fn()
    });
    runtime.start();

    const activating = runtime.activate(replacement as never);
    replacement.emit("error", new Error("candidate rejected"));

    await expect(activating).rejects.toThrow("candidate rejected");
    expect(runtime.client).toBe(current);
    expect(current.end).toHaveBeenCalledWith(true, expect.any(Function));
    expect(current.reconnect).toHaveBeenCalledTimes(1);
    expect(replacement.end).toHaveBeenCalledWith(true, expect.any(Function));
    await runtime.stop();
  });

  it("commits before candidate reconnect and keeps the candidate authoritative after CONNACK subscription failure", async () => {
    const current = new FakeMqttClient();
    const candidate = new FakeMqttClient();
    const commit = vi.fn().mockResolvedValue(undefined);
    const rollback = vi.fn().mockResolvedValue(undefined);
    const runtime = new GatewayMqttRuntime({
      client: current as never,
      heartbeatMs: 1_000,
      subscribe: vi.fn((_client, _sessionPresent, force) => force ? Promise.reject(new Error("SUBACK failed")) : undefined),
      publishHeartbeat: vi.fn(),
      topicHandlers,
      onMessageError: vi.fn()
    });
    runtime.start();

    const activating = runtime.activate(candidate as never, {
      commit,
      rollback
    });
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(candidate.reconnect).toHaveBeenCalledTimes(1));
    expect(current.end).toHaveBeenCalledWith(true, expect.any(Function));
    expect(commit.mock.invocationCallOrder[0]).toBeLessThan(candidate.reconnect.mock.invocationCallOrder[0]);

    candidate.emit("connect", { sessionPresent: true });
    await expect(activating).rejects.toThrow("SUBACK failed");
    expect(candidate.end).toHaveBeenCalledWith(true, expect.any(Function));
    expect(runtime.client).toBe(candidate);
    expect(rollback).not.toHaveBeenCalled();
    expect(current.reconnect).not.toHaveBeenCalled();
  });

  it("routes every candidate command topic exactly once through the candidate source while subscription readiness is pending", async () => {
    let finishSubscription!: () => void;
    const current = new FakeMqttClient();
    const candidate = new FakeMqttClient();
    const topics = ["commands/dimming", "commands/scan", "commands/identify", "commands/provision"];
    const deliveries: Array<{ topic: string; source: GatewayMqttClient }> = [];
    const handlers = Object.fromEntries(topics.map((topic) => [topic, (_payload: Buffer, source: GatewayMqttClient) => {
      source.publish(`events/${topic}`, "{}", { qos: 1 });
      deliveries.push({ topic, source });
    }]));
    const runtime = new GatewayMqttRuntime({
      client: current as never,
      heartbeatMs: 1_000,
      subscribe: () => new Promise<void>((resolve) => { finishSubscription = resolve; }),
      publishHeartbeat: vi.fn(),
      topicHandlers: handlers,
      onMessageError: vi.fn()
    });
    runtime.start();

    const activating = runtime.activate(candidate as never, {
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined)
    });
    await vi.waitFor(() => expect(candidate.reconnect).toHaveBeenCalledTimes(1));
    candidate.emit("connect", { sessionPresent: true });
    for (const topic of topics) candidate.emit("message", topic, Buffer.from(topic));
    await Promise.resolve();

    expect(deliveries).toEqual(topics.map((topic) => ({ topic, source: candidate })));
    expect(candidate.publish).toHaveBeenCalledTimes(topics.length);
    expect(current.publish).not.toHaveBeenCalled();

    finishSubscription();
    await activating;
    expect(runtime.client).toBe(candidate);
    await runtime.stop();
  });

  it("times out a silent candidate and keeps the current client active", async () => {
    vi.useFakeTimers();
    const current = new FakeMqttClient();
    const candidate = new FakeMqttClient();
    const runtime = new GatewayMqttRuntime({
      client: current as never,
      heartbeatMs: 1_000,
      candidateReadyTimeoutMs: 100,
      subscribe: vi.fn(),
      publishHeartbeat: vi.fn(),
      topicHandlers,
      onMessageError: vi.fn()
    });
    runtime.start();

    const activating = runtime.activate(candidate as never);
    await vi.advanceTimersByTimeAsync(100);

    await expect(activating).rejects.toThrow("replacement MQTT client timed out");
    expect(runtime.client).toBe(current);
    expect(candidate.end).toHaveBeenCalledWith(true, expect.any(Function));
    await runtime.stop();
  });

  it("serializes shutdown behind an in-flight activation and closes its candidate", async () => {
    const current = new FakeMqttClient();
    const candidate = new FakeMqttClient();
    const runtime = new GatewayMqttRuntime({
      client: current as never,
      heartbeatMs: 1_000,
      candidateReadyTimeoutMs: 10_000,
      subscribe: () => new Promise<void>(() => undefined),
      publishHeartbeat: vi.fn(),
      topicHandlers,
      onMessageError: vi.fn()
    });
    runtime.start();

    const activating = runtime.activate(candidate as never);
    candidate.emit("connect", { sessionPresent: false });
    const stopping = runtime.stop();

    await expect(activating).rejects.toThrow("MQTT runtime is stopping");
    await stopping;
    expect(candidate.end).toHaveBeenCalledWith(true, expect.any(Function));
    expect(current.end).toHaveBeenCalledWith(true, expect.any(Function));
    expect(candidate.listenerCount("message")).toBe(0);
  });

  it("rolls back a failed identity commit before candidate reconnect", async () => {
    const current = new FakeMqttClient();
    const candidate = new FakeMqttClient();
    const received: string[] = [];
    const rollback = vi.fn().mockResolvedValue(undefined);
    const runtime = new GatewayMqttRuntime({
      client: current as never,
      heartbeatMs: 1_000,
      subscribe: vi.fn(),
      publishHeartbeat: vi.fn(),
      topicHandlers: { "commands/dimming": (payload) => received.push(payload.toString()) },
      onMessageError: vi.fn()
    });
    runtime.start();

    const activating = runtime.activate(candidate as never, {
      commit: async () => { throw new Error("pointer commit failed"); },
      rollback
    });

    await expect(activating).rejects.toThrow("pointer commit failed");
    await Promise.resolve();
    expect(runtime.client).toBe(current);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(candidate.reconnect).not.toHaveBeenCalled();
    expect(received).toEqual([]);
    await runtime.stop();
  });
});
