import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayMqttRuntime, type GatewayMqttClient } from "./gateway-mqtt-runtime";

class FakeMqttClient extends EventEmitter {
  readonly end = vi.fn((_force?: boolean, callback?: (error?: Error) => void) => callback?.());
  readonly publish = vi.fn((_topic: string, _payload: string, _options?: unknown, callback?: (error?: Error) => void) => callback?.());
  readonly reconnect = vi.fn();
}

const topicHandlers = {
  "commands/dimming": vi.fn(),
  "commands/provisioning-scan-start": vi.fn(),
  "commands/identify-device": vi.fn(),
  "commands/provision-device": vi.fn()
};

describe("GatewayMqttRuntime", () => {
  afterEach(() => {
    vi.useRealTimers();
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

    process.removeListener("unhandledRejection", unhandledRejection);
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
