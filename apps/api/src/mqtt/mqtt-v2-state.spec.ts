import { MqttService } from "./mqtt.service";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";

const mqttHandlePublish = require(
  join(dirname(require.resolve("mqtt")), "lib/handlers/publish.js")
).default as (client: Record<string, unknown>, packet: Record<string, unknown>, done: () => void) => void;

const scope = {
  siteId: "22222222-2222-4222-8222-222222222222",
  gatewayId: "55555555-5555-4555-8555-555555555555"
};

describe("MqttService v2 ordered state", () => {
  it("serializes automation and fixture-state ingestion for the same Gateway", async () => {
    let releaseAutomation!: () => void;
    let markAutomationStarted!: () => void;
    const automationStarted = new Promise<void>((resolve) => { markAutomationStarted = resolve; });
    const automationBlocked = new Promise<void>((resolve) => { releaseAutomation = resolve; });
    const ingestion = {
      ingest: jest.fn().mockResolvedValue({
        eventId: fixtureEvent(9).eventId,
        sequence: 9,
        fixtureId: fixtureEvent(9).fixtureId,
        status: "ingested"
      })
    };
    const automation = {
      handleMessage: jest.fn(async () => {
        markAutomationStarted();
        await automationBlocked;
      })
    };
    const service = new MqttService(
      {} as never,
      { attachProvisionedNode: jest.fn() } as never,
      ingestion as never,
      automation as never
    );
    jest.spyOn(service, "publishTopic").mockResolvedValue();
    const internal = service as unknown as {
      startInboundHandler(topic: string, payload: Buffer): void;
      createCustomHandleAcks(): (
        topic: string,
        payload: Buffer,
        packet: { qos: number },
        done: (reasonCode: number) => void
      ) => void;
    };

    internal.startInboundHandler(
      `sites/${scope.siteId}/gateways/${scope.gatewayId}/events/automation/execution`,
      Buffer.from("{}")
    );
    await automationStarted;
    const done = jest.fn();
    internal.createCustomHandleAcks()(
      `sites/${scope.siteId}/gateways/${scope.gatewayId}/state/fixtures`,
      Buffer.from(JSON.stringify(fixtureEvent(9))),
      { qos: 1 },
      done
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(ingestion.ingest).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();

    releaseAutomation();
    await service.stopInboundAndDrain();
    expect(ingestion.ingest).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(0);
  });

  it("reserves bounded capacity before MQTT.js emits the listener and PUBACKs the 257th QoS1 packet", async () => {
    const topic = `sites/${scope.siteId}/gateways/${scope.gatewayId}/events/automation/execution`;
    const release = deferred<void>();
    const handled: number[] = [];
    const service = new MqttService(
      {} as never,
      { attachProvisionedNode: jest.fn() } as never,
      undefined,
      { handleMessage: jest.fn(async (_topic, payload) => handled.push(Number(payload.toString()))) } as never
    );
    const client = mqttClientHarness(service) as ReturnType<typeof mqttClientHarness> & {
      options: Record<string, unknown>;
      log: jest.Mock;
      noop: jest.Mock;
      handleMessage: jest.Mock;
      _sendPacket: jest.Mock;
    };
    const internal = mqttInternals(service);
    client.options = { protocolVersion: 5, customHandleAcks: internal.createCustomHandleAcks() };
    client.log = jest.fn();
    client.noop = jest.fn();
    client.handleMessage = jest.fn((_packet, callback) => callback());
    client._sendPacket = jest.fn((packet, callback) => {
      order.push(packet.cmd);
      callback?.();
    });
    for (let index = 0; index < 256; index += 1) {
      void internal.runInGatewayInboundQueue(topic, () => release.promise);
    }
    const order: string[] = [];
    client.on("message", () => {
      order.push("listener");
    });
    const packet = { cmd: "publish", topic, payload: Buffer.from("257"), qos: 1, messageId: 257 };
    const done = jest.fn();

    mqttHandlePublish(client as unknown as Record<string, unknown>, packet, done);
    await flushPromises();

    expect(done).not.toHaveBeenCalled();
    expect(order).toEqual([]);
    expect(handled).toEqual([]);

    release.resolve();
    await waitFor(() => handled.includes(257));
    await service.stopInboundAndDrain();

    expect(done).toHaveBeenCalledTimes(1);
    expect(client._sendPacket).toHaveBeenCalledWith(
      { cmd: "puback", messageId: 257, reasonCode: 0 },
      done
    );
    expect(order).toEqual(["listener", "puback"]);
    expect(internal.gatewayInboundQueues.size).toBe(0);
    expect(internal.inboundPacketPermits.size).toBe(0);
  });

  it("fails closed before PUBACK when the listener receives a different packet identity", async () => {
    const topic = `sites/${scope.siteId}/gateways/${scope.gatewayId}/events/automation/execution`;
    const service = new MqttService({} as never, { attachProvisionedNode: jest.fn() } as never);
    const client = mqttClientHarness(service);
    const internal = mqttInternals(service);
    const packet = { qos: 1, messageId: 31 };
    const order: string[] = [];

    internal.createCustomHandleAcks()(topic, Buffer.from("{}"), packet, () => {
      client.emit("message", topic, Buffer.from("{}"), { ...packet });
      order.push("puback");
    });
    await flushPromises();

    expect(order).toEqual([]);
    expect(client.stream.destroy).toHaveBeenCalledTimes(1);
    expect(internal.gatewayInboundQueues.size).toBe(0);
    expect(internal.inboundPacketPermits.size).toBe(0);
  });

  it("fails closed before PUBACK when the reserved packet is emitted on a different topic", async () => {
    const topic = `sites/${scope.siteId}/gateways/${scope.gatewayId}/events/automation/execution`;
    const service = new MqttService({} as never, { attachProvisionedNode: jest.fn() } as never);
    const client = mqttClientHarness(service);
    const internal = mqttInternals(service);
    const packet = { qos: 1, messageId: 36 };
    const order: string[] = [];

    internal.createCustomHandleAcks()(topic, Buffer.from("{}"), packet, () => {
      client.emit("message", `${topic}/wrong`, Buffer.from("{}"), packet);
      order.push("puback");
    });
    await flushPromises();

    expect(order).toEqual([]);
    expect(client.stream.destroy).toHaveBeenCalledTimes(1);
    expect(internal.gatewayInboundQueues.size).toBe(0);
    expect(internal.inboundPacketPermits.size).toBe(0);
  });

  it("consumes a packet permit exactly once when the same listener delivery is duplicated", async () => {
    const topic = `sites/${scope.siteId}/gateways/${scope.gatewayId}/events/automation/execution`;
    const handled = jest.fn().mockResolvedValue(undefined);
    const service = new MqttService(
      {} as never,
      { attachProvisionedNode: jest.fn() } as never,
      undefined,
      { handleMessage: handled } as never
    );
    const client = mqttClientHarness(service);
    const internal = mqttInternals(service);
    const packet = { qos: 1, messageId: 32 };
    const done = jest.fn((reasonCode: number) => {
      client.emit("message", topic, Buffer.from("{}"), packet);
      client.emit("message", topic, Buffer.from("{}"), packet);
      expect(reasonCode).toBe(0);
    });

    const customHandleAcks = internal.createCustomHandleAcks();
    customHandleAcks(topic, Buffer.from("{}"), packet, done);
    customHandleAcks(topic, Buffer.from("{}"), packet, done);
    await waitFor(() => handled.mock.calls.length === 1);
    await service.stopInboundAndDrain();

    expect(done).toHaveBeenCalledTimes(1);
    expect(handled).toHaveBeenCalledTimes(1);
    expect(client.stream.destroy).not.toHaveBeenCalled();
    expect(internal.gatewayInboundQueues.size).toBe(0);
    expect(internal.inboundPacketPermits.size).toBe(0);
  });

  it.each(["transport abort", "shutdown"])(
    "releases a saturated pre-ACK waiter on %s without acknowledging it",
    async (ending) => {
      const topic = `sites/${scope.siteId}/gateways/${scope.gatewayId}/events/automation/execution`;
      const release = deferred<void>();
      const service = new MqttService({} as never, { attachProvisionedNode: jest.fn() } as never);
      const client = mqttClientHarness(service);
      const internal = mqttInternals(service);
      for (let index = 0; index < 256; index += 1) {
        void internal.runInGatewayInboundQueue(topic, () => release.promise);
      }
      const packet = { qos: 1, messageId: ending === "transport abort" ? 33 : 34 };
      const done = jest.fn();
      internal.createCustomHandleAcks()(topic, Buffer.from("{}"), packet, done);
      await flushPromises();
      expect(done).not.toHaveBeenCalled();

      const stopping = ending === "shutdown" ? service.stopInboundAndDrain() : undefined;
      if (ending === "transport abort") client.emit("close");
      release.resolve();
      await stopping;
      await waitFor(() => internal.gatewayInboundQueues.size === 0);

      expect(done).not.toHaveBeenCalled();
      expect(internal.inboundPacketPermits.size).toBe(0);
    }
  );

  it("releases the consumed permit once when the asynchronous handler rejects", async () => {
    const topic = `sites/${scope.siteId}/gateways/${scope.gatewayId}/events/automation/execution`;
    const service = new MqttService(
      {} as never,
      { attachProvisionedNode: jest.fn() } as never,
      undefined,
      { handleMessage: jest.fn().mockRejectedValue(new Error("injected handler failure")) } as never
    );
    const client = mqttClientHarness(service);
    const internal = mqttInternals(service);
    const packet = { qos: 1, messageId: 35 };
    const done = jest.fn((reasonCode: number) => {
      client.emit("message", topic, Buffer.from("{}"), packet);
      expect(reasonCode).toBe(0);
    });

    internal.createCustomHandleAcks()(topic, Buffer.from("{}"), packet, done);
    await waitFor(() => done.mock.calls.length === 1);
    await service.stopInboundAndDrain();

    expect(done).toHaveBeenCalledTimes(1);
    expect(internal.gatewayInboundQueues.size).toBe(0);
    expect(internal.inboundPacketPermits.size).toBe(0);
  });

  it("releases the inbound PUBACK after commit without waiting for the application ACK publish callback", async () => {
    let releaseApplicationAck!: () => void;
    const applicationAckPending = new Promise<void>((resolve) => {
      releaseApplicationAck = resolve;
    });
    const ingestion = {
      ingest: jest.fn().mockResolvedValue({
        eventId: fixtureEvent(9).eventId,
        sequence: 9,
        fixtureId: fixtureEvent(9).fixtureId,
        status: "ingested"
      })
    };
    const service = new MqttService({} as never, { attachProvisionedNode: jest.fn() } as never, ingestion as never);
    jest.spyOn(service, "publishTopic").mockReturnValue(applicationAckPending);
    let markPuback!: () => void;
    const puback = new Promise<void>((resolve) => { markPuback = resolve; });
    const done = jest.fn(() => markPuback());

    const customHandleAcks = (service as unknown as {
      createCustomHandleAcks: () => (topic: string, payload: Buffer, packet: { qos: number }, done: (reasonCode: number) => void) => void;
    }).createCustomHandleAcks();
    customHandleAcks(
      `sites/${scope.siteId}/gateways/${scope.gatewayId}/state/fixtures`,
      Buffer.from(JSON.stringify(fixtureEvent(9))),
      { qos: 1 },
      done
    );

    await puback;
    expect(done).toHaveBeenCalledWith(0);
    releaseApplicationAck();
    await service.stopInboundAndDrain();
  });

  it("rejects new fixture state intake after shutdown drain starts", async () => {
    const ingestion = { ingest: jest.fn() };
    const destroy = jest.fn();
    const service = new MqttService({} as never, { attachProvisionedNode: jest.fn() } as never, ingestion as never);
    (service as unknown as { client: { stream: { destroy: () => void } } }).client = { stream: { destroy } };
    const done = jest.fn();

    await service.stopInboundAndDrain();
    const customHandleAcks = (service as unknown as {
      createCustomHandleAcks: () => (topic: string, payload: Buffer, packet: { qos: number }, done: (reasonCode: number) => void) => void;
    }).createCustomHandleAcks();
    customHandleAcks(
      `sites/${scope.siteId}/gateways/${scope.gatewayId}/state/fixtures`,
      Buffer.from(JSON.stringify(fixtureEvent(9))),
      { qos: 1 },
      done
    );

    expect(ingestion.ingest).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("publishes the exact application ACK only after state transaction commit", async () => {
    const markers: string[] = [];
    const ingestion = {
      ingest: jest.fn(async () => {
        markers.push("committed");
        return {
          eventId: fixtureEvent(9).eventId,
          sequence: 9,
          fixtureId: fixtureEvent(9).fixtureId,
          status: "ingested" as const
        };
      })
    };
    const service = new MqttService({} as never, { attachProvisionedNode: jest.fn() } as never, ingestion as never);
    jest.spyOn(service, "publishTopic").mockImplementation(async (topic, payload) => {
      markers.push("application_ack");
      expect(topic).toBe(`sites/${scope.siteId}/gateways/${scope.gatewayId}/acks/state-ingested`);
      expect(payload).toMatchObject({
        eventId: fixtureEvent(9).eventId,
        sequence: 9,
        fixtureId: fixtureEvent(9).fixtureId,
        status: "ingested"
      });
    });

    await service.handleFixtureStatePacket(
      `sites/${scope.siteId}/gateways/${scope.gatewayId}/state/fixtures`,
      Buffer.from(JSON.stringify(fixtureEvent(9)))
    );

    expect(markers).toEqual(["committed", "application_ack"]);
  });

  it("publishes an explicit stale checkpoint ACK so the gateway can delete the exact record", async () => {
    const ingestion = {
      ingest: jest.fn().mockResolvedValue({
        eventId: fixtureEvent(9).eventId,
        sequence: 9,
        fixtureId: fixtureEvent(9).fixtureId,
        status: "stale_checkpoint"
      })
    };
    const service = new MqttService({} as never, { attachProvisionedNode: jest.fn() } as never, ingestion as never);
    const publish = jest.spyOn(service, "publishTopic").mockResolvedValue();

    await service.handleFixtureStatePacket(
      `sites/${scope.siteId}/gateways/${scope.gatewayId}/state/fixtures`,
      Buffer.from(JSON.stringify(fixtureEvent(9)))
    );

    expect(publish).toHaveBeenCalledWith(
      `sites/${scope.siteId}/gateways/${scope.gatewayId}/acks/state-ingested`,
      expect.objectContaining({ status: "stale_checkpoint" }),
      expect.objectContaining({ timeoutMs: 10_000 })
    );
  });

  it("does not ingest or acknowledge a forged topic scope", async () => {
    const ingestion = { ingest: jest.fn() };
    const service = new MqttService({} as never, { attachProvisionedNode: jest.fn() } as never, ingestion as never);
    const publish = jest.spyOn(service, "publishTopic").mockResolvedValue();

    await expect(service.handleFixtureStatePacket(
      `sites/${scope.siteId}/gateways/${scope.gatewayId}/state/fixtures`,
      Buffer.from(JSON.stringify({ ...fixtureEvent(10), siteId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }))
    )).rejects.toThrow("fixture state topic scope rejected");
    expect(ingestion.ingest).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not publish an application ACK when the database transaction fails", async () => {
    const ingestion = { ingest: jest.fn().mockRejectedValue(new Error("database unavailable")) };
    const service = new MqttService({} as never, { attachProvisionedNode: jest.fn() } as never, ingestion as never);
    const publish = jest.spyOn(service, "publishTopic").mockResolvedValue();

    await expect(service.handleFixtureStatePacket(
      `sites/${scope.siteId}/gateways/${scope.gatewayId}/state/fixtures`,
      Buffer.from(JSON.stringify(fixtureEvent(9)))
    )).rejects.toThrow("database unavailable");
    expect(publish).not.toHaveBeenCalled();
  });
});

function fixtureEvent(sequence: number) {
  return {
    ...scope,
    eventId: "99999999-9999-4999-8999-999999999999",
    sequence,
    occurredAt: "2026-07-11T00:00:09.000Z",
    fixtureId: "66666666-6666-4666-8666-666666666666",
    brightness: 70,
    powerOn: true,
    status: "online",
    statusReason: "reported",
    health: { faultCodes: [4, 0, 1, 4], observedAt: "2026-07-11T00:00:08.000Z" },
    rssi: -60,
    hopCount: 1
  };
}

function mqttClientHarness(service: MqttService) {
  const client = Object.assign(new EventEmitter(), {
    subscribe: jest.fn(),
    connected: true,
    stream: { destroy: jest.fn() }
  });
  (service as unknown as { client: typeof client }).client = client;
  service.onModuleInit();
  return client;
}

function mqttInternals(service: MqttService) {
  return service as unknown as {
    createCustomHandleAcks(): (
      topic: string,
      payload: Buffer,
      packet: { qos: number; messageId: number },
      done: (reasonCode: number) => void
    ) => void;
    runInGatewayInboundQueue<T>(topic: string, operation: () => Promise<T>): Promise<T>;
    gatewayInboundQueues: Map<string, unknown>;
    inboundPacketPermits: Map<object, unknown>;
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for MQTT test condition");
}
