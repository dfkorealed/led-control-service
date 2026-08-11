import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayMqttRuntime } from "./gateway-mqtt-runtime";

class FakeMqttClient extends EventEmitter {
  readonly end = vi.fn((_force?: boolean, callback?: (error?: Error) => void) => callback?.());
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
    expect(current.end).not.toHaveBeenCalled();
    expect(replacement.end).toHaveBeenCalledWith(true, expect.any(Function));
    await runtime.stop();
  });
});
