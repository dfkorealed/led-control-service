import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { BLUEZ_APPLICATION_PATHS } from "./bluez-dbus-application";
import { CONFIG_OPCODES } from "./bluez-config-codec";
import { BluezConfigClient } from "./bluez-config-client";
import {
  TEST_BLUETOOTH_COMPANY_ID,
  TEST_BLUETOOTH_COMPANY_ID_LE
} from "../test-fixtures/vehicle-sensor-protocol";

const CONFIG_OPTIONS = { responseTimeoutMs: 100, companyId: TEST_BLUETOOTH_COMPANY_ID };

class FakeTransport {
  calls: Array<{ method: string; args: unknown[] }> = [];
  async call<T>(_service: string, _path: string, _interfaceName: string, method: string, args: unknown[]): Promise<T> {
    this.calls.push({ method, args });
    return undefined as T;
  }
}

it("binds local receiving client models with the provisioner address device key", async () => {
  const transport = new FakeTransport();
  const application = new EventEmitter();
  const client = new BluezConfigClient(transport, application, "/org/bluez/mesh/node1", CONFIG_OPTIONS);
  const prepare = client.prepareLocalNode();

  await waitForCallCount(transport, "DevKeySend", 1);
  const clientModels = [0x0003, 0x1001, 0x1102, 0x1302];
  for (let index = 0; index < clientModels.length; index += 1) {
    const modelId = clientModels[index]!;
    const call = transport.calls.filter(({ method }) => method === "DevKeySend")[index]!;
    expect(call.args[1]).toBe(0x0001);
    expect(call.args[2]).toBe(true);
    application.emit("devKeyMessageReceived", {
      source: 0x0001,
      data: Uint8Array.from([0x80, 0x3e, 0, 0x01, 0, 0, 0, modelId & 0xff, modelId >> 8])
    });
    await waitForCallCount(transport, "DevKeySend", index + 2);
  }

  const vendorCall = transport.calls.filter(({ method }) => method === "DevKeySend")[4]!;
  expect(vendorCall.args[2]).toBe(true);
  application.emit("devKeyMessageReceived", {
    source: 0x0001,
    data: Uint8Array.from([
      0x80, 0x3e, 0, 0x01, 0, 0, 0,
      ...TEST_BLUETOOTH_COMPANY_ID_LE,
      0x01, 0x00
    ])
  });

  await expect(prepare).resolves.toBeUndefined();
  expect(transport.calls.map(({ method }) => method)).toEqual([
    "CreateAppKey", "DevKeySend", "DevKeySend", "DevKeySend", "DevKeySend", "DevKeySend"
  ]);
});

it("configures composition, AppKey, Health/OnOff/Lightness bindings, and 60-second publications in order", async () => {
  const transport = new FakeTransport();
  const application = new EventEmitter();
  const client = new BluezConfigClient(transport, application, "/org/bluez/mesh/node1", CONFIG_OPTIONS);
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
  const client = new BluezConfigClient(transport, application, "/org/bluez/mesh/node1", CONFIG_OPTIONS);
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
  const first = new BluezConfigClient(transport, application, "/org/bluez/mesh/node1", { ...CONFIG_OPTIONS, responseTimeoutMs: 500 });
  const second = new BluezConfigClient(transport, application, "/org/bluez/mesh/node1", { ...CONFIG_OPTIONS, responseTimeoutMs: 500 });
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
  const client = new BluezConfigClient(transport, application, "/org/bluez/mesh/node1", CONFIG_OPTIONS);
  const configure = client.configureNode({ unicast: 0x1201, elementCount: 1 });
  await waitForCall(transport, "AddAppKey");

  application.emit("devKeyMessageReceived", { source: 0x1201, data: Uint8Array.from([...CONFIG_OPCODES.appKeyStatus, 0, 0, 0x10, 0]) });

  await expect(configure).rejects.toThrow("Config AppKey Status does not match the request");
  expect(transport.calls.filter((call) => call.method === "DevKeySend")).toHaveLength(0);
});

it("adds a Light Lightness Server subscription and validates source, element, group, and model", async () => {
  const transport = new FakeTransport();
  const application = new EventEmitter();
  const client = new BluezConfigClient(transport, application, "/org/bluez/mesh/node1", CONFIG_OPTIONS);
  const subscribe = client.addModelSubscription({ unicast: 0x0100, groupAddress: 0xc000 });

  await waitForCallCount(transport, "DevKeySend", 1);
  application.emit("devKeyMessageReceived", {
    source: 0x0100,
    data: Uint8Array.from([0x80, 0x1f, 0x00, 0x00, 0x01, 0x00, 0xc0, 0x00, 0x13])
  });

  await expect(subscribe).resolves.toEqual({
    elementAddress: 0x0100,
    groupAddress: 0xc000,
    modelId: 0x1300
  });
  expect(transport.calls[0]).toEqual({
    method: "DevKeySend",
    args: [
      BLUEZ_APPLICATION_PATHS.element,
      0x0100,
      true,
      0,
      [],
      [0x80, 0x1b, 0x00, 0x01, 0x00, 0xc0, 0x00, 0x13]
    ]
  });
});

it("deletes a Light Lightness Server subscription and validates its exact status tuple", async () => {
  const transport = new FakeTransport();
  const application = new EventEmitter();
  const client = new BluezConfigClient(transport, application, "/org/bluez/mesh/node1", CONFIG_OPTIONS);
  const unsubscribe = client.removeModelSubscription({ unicast: 0x0100, groupAddress: 0xc000 });

  await waitForCallCount(transport, "DevKeySend", 1);
  application.emit("devKeyMessageReceived", {
    source: 0x0100,
    data: Uint8Array.from([0x80, 0x1f, 0x00, 0x00, 0x01, 0x00, 0xc0, 0x00, 0x13])
  });

  await expect(unsubscribe).resolves.toEqual({
    elementAddress: 0x0100,
    groupAddress: 0xc000,
    modelId: 0x1300
  });
  expect(transport.calls[0]).toEqual({
    method: "DevKeySend",
    args: [
      BLUEZ_APPLICATION_PATHS.element,
      0x0100,
      true,
      0,
      [],
      [0x80, 0x1c, 0x00, 0x01, 0x00, 0xc0, 0x00, 0x13]
    ]
  });
});

it("rejects a subscription status that does not confirm the requested target", async () => {
  const transport = new FakeTransport();
  const application = new EventEmitter();
  const client = new BluezConfigClient(transport, application, "/org/bluez/mesh/node1", CONFIG_OPTIONS);
  const subscribe = client.addModelSubscription({ unicast: 0x0100, groupAddress: 0xc000 });

  await waitForCallCount(transport, "DevKeySend", 1);
  application.emit("devKeyMessageReceived", {
    source: 0x0101,
    data: Uint8Array.from([0x80, 0x1f, 0x00, 0x01, 0x01, 0x00, 0xc0, 0x00, 0x13])
  });

  await expect(subscribe).rejects.toThrow("Bluetooth Mesh Config response timed out");
});

it("correlates concurrent subscription statuses by requested group address even when responses arrive in reverse order", async () => {
  const transport = new FakeTransport();
  const application = new EventEmitter();
  const client = new BluezConfigClient(transport, application, "/org/bluez/mesh/node1", CONFIG_OPTIONS);
  const first = client.addModelSubscription({ unicast: 0x0100, groupAddress: 0xc000 });
  const second = client.addModelSubscription({ unicast: 0x0100, groupAddress: 0xc001 });

  await waitForCallCount(transport, "DevKeySend", 2);
  application.emit("devKeyMessageReceived", {
    source: 0x0100,
    data: Uint8Array.from([0x80, 0x1f, 0x00, 0x00, 0x01, 0x01, 0xc0, 0x00, 0x13])
  });
  application.emit("devKeyMessageReceived", {
    source: 0x0100,
    data: Uint8Array.from([0x80, 0x1f, 0x00, 0x00, 0x01, 0x00, 0xc0, 0x00, 0x13])
  });

  await expect(first).resolves.toEqual({
    elementAddress: 0x0100,
    groupAddress: 0xc000,
    modelId: 0x1300
  });
  await expect(second).resolves.toEqual({
    elementAddress: 0x0100,
    groupAddress: 0xc001,
    modelId: 0x1300
  });
});

it("binds vehicle sensor models with stack Sensor and vendor publication periods disabled", async () => {
  const transport = new FakeTransport();
  const application = new EventEmitter();
  const client = new BluezConfigClient(transport, application, "/org/bluez/mesh/node1", CONFIG_OPTIONS);
  const configure = client.configureVehicleSensorModels({ unicast: 0x1201, elementCount: 1 });

  await waitForCallCount(transport, "DevKeySend", 1);
  expect(transport.calls.find(({ method }) => method === "AddAppKey")).toBeUndefined();
  application.emit("devKeyMessageReceived", {
    source: 0x1201,
    data: Uint8Array.from([
      0x02, 0x00,
      ...TEST_BLUETOOTH_COMPANY_ID_LE, 0x01, 0x00, 0x01, 0x00, 0x40, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x01, 0x01,
      0x00, 0x11,
      ...TEST_BLUETOOTH_COMPANY_ID_LE, 0x00, 0x00
    ])
  });
  await waitForCallCount(transport, "DevKeySend", 2);
  application.emit("devKeyMessageReceived", {
    source: 0x1201,
    data: Uint8Array.from([0x80, 0x3e, 0x00, 0x01, 0x12, 0x00, 0x00, 0x00, 0x11])
  });
  await waitForCallCount(transport, "DevKeySend", 3);
  application.emit("devKeyMessageReceived", {
    source: 0x1201,
    data: Uint8Array.from([0x80, 0x19, 0, 0x01, 0x12, 0x01, 0, 0, 0, 5, 0x00, 0, 0x00, 0x11])
  });
  await waitForCallCount(transport, "DevKeySend", 4);
  application.emit("devKeyMessageReceived", {
    source: 0x1201,
    data: Uint8Array.from([0x80, 0x3e, 0x00, 0x01, 0x12, 0x00, 0x00, ...TEST_BLUETOOTH_COMPANY_ID_LE, 0x00, 0x00])
  });
  await waitForCallCount(transport, "DevKeySend", 5);
  application.emit("devKeyMessageReceived", {
    source: 0x1201,
    data: Uint8Array.from([
      0x80, 0x19, 0x00, 0x01, 0x12, 0x01, 0x00, 0x00, 0x00, 0x05, 0x00, 0x00,
      ...TEST_BLUETOOTH_COMPANY_ID_LE, 0x00, 0x00
    ])
  });

  await expect(configure).resolves.toEqual({
    sensorServerBound: true,
    vendorVehicleEventModelBound: true
  });
  expect(transport.calls.find(({ method }) => method === "CreateAppKey")?.args).toEqual([0, 0]);
  expect(transport.calls.find(({ method }) => method === "AddAppKey")).toBeUndefined();
  expect(transport.calls.filter(({ method }) => method === "DevKeySend").map(({ args }) => args[5])).toEqual([
    [0x80, 0x08, 0x00],
    [0x80, 0x3d, 0x01, 0x12, 0x00, 0x00, 0x00, 0x11],
    [0x03, 0x01, 0x12, 0x01, 0x00, 0x00, 0x00, 0x05, 0x00, 0x00, 0x00, 0x11],
    [0x80, 0x3d, 0x01, 0x12, 0x00, 0x00, ...TEST_BLUETOOTH_COMPANY_ID_LE, 0x00, 0x00],
    [0x03, 0x01, 0x12, 0x01, 0x00, 0x00, 0x00, 0x05, 0x00, 0x00, ...TEST_BLUETOOTH_COMPANY_ID_LE, 0x00, 0x00]
  ]);
});

it("rejects a nonzero stack publication period for the vehicle Sensor Server", async () => {
  const transport = new FakeTransport();
  const application = new EventEmitter();
  const client = new BluezConfigClient(transport, application, "/org/bluez/mesh/node1", CONFIG_OPTIONS);
  const configure = client.configureVehicleSensorModels({ unicast: 0x1201, elementCount: 1 });

  await waitForCallCount(transport, "DevKeySend", 1);
  application.emit("devKeyMessageReceived", {
    source: 0x1201,
    data: Uint8Array.from([
      0x02, 0x00,
      0xff, 0xff, 0x01, 0x00, 0x01, 0x00, 0x40, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x01, 0x00,
      0x00, 0x11
    ])
  });
  await waitForCallCount(transport, "DevKeySend", 2);
  application.emit("devKeyMessageReceived", {
    source: 0x1201,
    data: Uint8Array.from([0x80, 0x3e, 0x00, 0x01, 0x12, 0x00, 0x00, 0x00, 0x11])
  });
  await waitForCallCount(transport, "DevKeySend", 3);
  application.emit("devKeyMessageReceived", {
    source: 0x1201,
    data: Uint8Array.from([0x80, 0x19, 0, 0x01, 0x12, 0x01, 0, 0, 0, 5, 0x86, 0, 0x00, 0x11])
  });

  await expect(configure).rejects.toThrow("Vehicle Sensor Server publication does not match the request");
});

it("rejects a nonzero publication retransmit for the vehicle Sensor Server", async () => {
  const transport = new FakeTransport();
  const application = new EventEmitter();
  const client = new BluezConfigClient(transport, application, "/org/bluez/mesh/node1", CONFIG_OPTIONS);
  const configure = client.configureVehicleSensorModels({ unicast: 0x1201, elementCount: 1 });

  await waitForCallCount(transport, "DevKeySend", 1);
  application.emit("devKeyMessageReceived", {
    source: 0x1201,
    data: Uint8Array.from([
      0x02, 0x00,
      0xff, 0xff, 0x01, 0x00, 0x01, 0x00, 0x40, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x01, 0x00,
      0x00, 0x11
    ])
  });
  await waitForCallCount(transport, "DevKeySend", 2);
  application.emit("devKeyMessageReceived", {
    source: 0x1201,
    data: Uint8Array.from([0x80, 0x3e, 0x00, 0x01, 0x12, 0x00, 0x00, 0x00, 0x11])
  });
  await waitForCallCount(transport, "DevKeySend", 3);
  application.emit("devKeyMessageReceived", {
    source: 0x1201,
    data: Uint8Array.from([0x80, 0x19, 0, 0x01, 0x12, 0x01, 0, 0, 0, 5, 0, 1, 0x00, 0x11])
  });

  await expect(configure).rejects.toThrow("Vehicle Sensor Server publication does not match the request");
});

it("reports absent vehicle sensor models as unsupported without issuing model configuration", async () => {
  const transport = new FakeTransport();
  const application = new EventEmitter();
  const client = new BluezConfigClient(transport, application, "/org/bluez/mesh/node1", CONFIG_OPTIONS);
  const configure = client.configureVehicleSensorModels({ unicast: 0x1201, elementCount: 1 });

  await waitForCallCount(transport, "DevKeySend", 1);
  application.emit("devKeyMessageReceived", {
    source: 0x1201,
    data: Uint8Array.from([
      0x02, 0x00,
      0xff, 0xff, 0x01, 0x00, 0x01, 0x00, 0x40, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00
    ])
  });

  await expect(configure).resolves.toEqual({
    sensorServerBound: false,
    vendorVehicleEventModelBound: false
  });
  expect(transport.calls.filter(({ method }) => method === "DevKeySend")).toHaveLength(1);
});

async function waitForCall(transport: FakeTransport, method: string) {
  await expect.poll(() => transport.calls.some((call) => call.method === method)).toBe(true);
}

async function waitForCallCount(transport: FakeTransport, method: string, count: number) {
  await expect.poll(() => transport.calls.filter((call) => call.method === method).length).toBeGreaterThanOrEqual(count);
}
