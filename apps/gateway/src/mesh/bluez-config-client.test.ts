import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { CONFIG_OPCODES } from "./bluez-config-codec";
import { BluezConfigClient } from "./bluez-config-client";

class FakeTransport {
  calls: Array<{ method: string; args: unknown[] }> = [];
  async call<T>(_service: string, _path: string, _interfaceName: string, method: string, args: unknown[]): Promise<T> {
    this.calls.push({ method, args });
    return undefined as T;
  }
}

it("configures composition, AppKey, Health/OnOff/Lightness bindings, and 60-second publications in order", async () => {
  const transport = new FakeTransport();
  const application = new EventEmitter();
  const client = new BluezConfigClient(transport, application, "/org/bluez/mesh/node1", { responseTimeoutMs: 100 });
  const configure = client.configureNode({ unicast: 0x1201, elementCount: 1 });

  await waitForCall(transport, "AddAppKey");
  application.emit("devKeyMessageReceived", { source: 0x1201, data: Uint8Array.from([...CONFIG_OPCODES.appKeyStatus, 0, 0, 0, 0]) });
  await waitForCallCount(transport, "DevKeySend", 1);
  application.emit("devKeyMessageReceived", { source: 0x1201, data: Uint8Array.from([0x02, 0x00, 0x34, 0x12]) });

  let expectedDevKeySendCount = 2;
  for (const modelId of [0x0002, 0x1000, 0x1300]) {
    await waitForCallCount(transport, "DevKeySend", expectedDevKeySendCount++);
    application.emit("devKeyMessageReceived", {
      source: 0x1201,
      data: Uint8Array.from([0x80, 0x3e, 0, 0x01, 0x12, 0, 0, modelId & 0xff, modelId >> 8])
    });
  }
  for (const modelId of [0x0002, 0x1000, 0x1300]) {
    await waitForCallCount(transport, "DevKeySend", expectedDevKeySendCount++);
    application.emit("devKeyMessageReceived", {
      source: 0x1201,
      data: Uint8Array.from([0x80, 0x19, 0, 0x01, 0x12, 0x01, 0, 0, 0, 5, 0x86, 0, modelId & 0xff, modelId >> 8])
    });
  }

  await expect(configure).resolves.toMatchObject({ unicast: 0x1201, elementCount: 1, compositionPage: 0 });
  expect(transport.calls.map((call) => call.method)).toEqual([
    "CreateAppKey", "AddAppKey", "DevKeySend", "DevKeySend", "DevKeySend", "DevKeySend", "DevKeySend", "DevKeySend", "DevKeySend"
  ]);
  for (const call of transport.calls.filter((call) => call.method === "DevKeySend").slice(-3)) {
    expect((call.args[5] as number[])[8]).toBe(0x86);
  }
});

it("rejects a publication status that does not confirm the requested 60-second configuration", async () => {
  const transport = new FakeTransport();
  const application = new EventEmitter();
  const client = new BluezConfigClient(transport, application, "/org/bluez/mesh/node1", { responseTimeoutMs: 100 });
  const configure = client.configureNode({ unicast: 0x1201, elementCount: 1 });

  await waitForCall(transport, "AddAppKey");
  application.emit("devKeyMessageReceived", { source: 0x1201, data: Uint8Array.from([...CONFIG_OPCODES.appKeyStatus, 0, 0, 0, 0]) });
  await waitForCallCount(transport, "DevKeySend", 1);
  application.emit("devKeyMessageReceived", { source: 0x1201, data: Uint8Array.from([0x02, 0x00, 0x34, 0x12]) });

  let expectedDevKeySendCount = 2;
  for (const modelId of [0x0002, 0x1000, 0x1300]) {
    await waitForCallCount(transport, "DevKeySend", expectedDevKeySendCount++);
    application.emit("devKeyMessageReceived", {
      source: 0x1201,
      data: Uint8Array.from([0x80, 0x3e, 0, 0x01, 0x12, 0, 0, modelId & 0xff, modelId >> 8])
    });
  }
  for (const modelId of [0x0002, 0x1000, 0x1300]) {
    await waitForCallCount(transport, "DevKeySend", expectedDevKeySendCount++);
    application.emit("devKeyMessageReceived", {
      source: 0x1201,
      data: Uint8Array.from([0x80, 0x19, 0, 0x01, 0x12, 0x01, 0, 0, 0, 4, 0x85, 0, modelId & 0xff, modelId >> 8])
    });
    break;
  }

  await expect(configure).rejects.toThrow("Config Model Publication Status does not match the request");
});

it("correlates concurrent AppKey Status messages to their target unicast addresses", async () => {
  const transport = new FakeTransport();
  const application = new EventEmitter();
  const first = new BluezConfigClient(transport, application, "/org/bluez/mesh/node1", { responseTimeoutMs: 500 });
  const second = new BluezConfigClient(transport, application, "/org/bluez/mesh/node1", { responseTimeoutMs: 500 });
  const firstConfigure = first.configureNode({ unicast: 0x1201, elementCount: 1 });
  const secondConfigure = second.configureNode({ unicast: 0x1202, elementCount: 1 });
  void secondConfigure.catch(() => undefined);
  await waitForCallCount(transport, "AddAppKey", 2);

  application.emit("devKeyMessageReceived", { source: 0x1201, data: Uint8Array.from([...CONFIG_OPCODES.appKeyStatus, 1, 0, 0, 0]) });
  await expect(firstConfigure).rejects.toThrow("Bluetooth Mesh Config status 0x01");
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(transport.calls.filter((call) => call.method === "DevKeySend")).toHaveLength(0);
  application.emit("devKeyMessageReceived", { source: 0x1202, data: Uint8Array.from([...CONFIG_OPCODES.appKeyStatus, 0, 0, 0, 0]) });
  await waitForCallCount(transport, "DevKeySend", 1);
});

it("rejects an AppKey Status with unexpected key indexes", async () => {
  const transport = new FakeTransport();
  const application = new EventEmitter();
  const client = new BluezConfigClient(transport, application, "/org/bluez/mesh/node1", { responseTimeoutMs: 100 });
  const configure = client.configureNode({ unicast: 0x1201, elementCount: 1 });
  await waitForCall(transport, "AddAppKey");

  application.emit("devKeyMessageReceived", { source: 0x1201, data: Uint8Array.from([...CONFIG_OPCODES.appKeyStatus, 0, 0, 0x10, 0]) });

  await expect(configure).rejects.toThrow("Config AppKey Status does not match the request");
  expect(transport.calls.filter((call) => call.method === "DevKeySend")).toHaveLength(0);
});

async function waitForCall(transport: FakeTransport, method: string) {
  await expect.poll(() => transport.calls.some((call) => call.method === method)).toBe(true);
}

async function waitForCallCount(transport: FakeTransport, method: string, count: number) {
  await expect.poll(() => transport.calls.filter((call) => call.method === method).length).toBeGreaterThanOrEqual(count);
}
