import { MqttService } from "./mqtt.service";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";
import { Prisma } from "@prisma/client";
import { FixtureStateIngestionService } from "../energy/fixture-state-ingestion.service";
import { fixtureStateV2Schema } from "@led-control/shared";

const mqttHandlePublish = require(
  join(dirname(require.resolve("mqtt")), "lib/handlers/publish.js")
).default as (client: Record<string, unknown>, packet: Record<string, unknown>, done: () => void) => void;

const scope = {
  siteId: "22222222-2222-4222-8222-222222222222",
  gatewayId: "55555555-5555-4555-8555-555555555555"
};

describe("MqttService v2 ordered state", () => {
  it("reconciles a legacy heartbeat only after the owning gateway lock without refreshing the gateway", async () => {
    const { service, gateway, tx, ledger } = heartbeatHarness();
    const event = heartbeatEvent();
    const legacy = legacyHeartbeatEvent(event);
    ledger.set(event.eventId, legacy);
    gateway.lastHeartbeatSequence = 10n;
    const before = { ...gateway };
    const lock = deferred<void>();
    tx.$queryRaw.mockImplementationOnce(async () => { await lock.promise; return [{ ...gateway }]; });
    const replay = receiveHeartbeat(service, event);
    await flushPromises();
    expect(legacy.payloadHash).toBeNull();
    expect(tx.processedGatewayEvent.updateMany).not.toHaveBeenCalled();
    lock.resolve();
    await expect(replay).resolves.toBeUndefined();
    expect(legacy.payloadHash).toBe(canonicalPayloadHash(event));
    expect(tx.processedGatewayEvent.updateMany).toHaveBeenCalledWith({
      where: { eventId: event.eventId, payloadHash: null }, data: { payloadHash: legacy.payloadHash }
    });
    expect(gateway).toEqual(before);
    expect(ledger.size).toBe(1);
    await expect(receiveHeartbeat(service, { ...event, firmwareVersion: "mutated" })).rejects.toThrow("conflict");
    expect(gateway).toEqual(before);
  });

  it.each([false, true])("requires the winning legacy heartbeat CAS hash after a race (different=%s)", async (different) => {
    const { service, gateway, tx, ledger } = heartbeatHarness();
    const event = heartbeatEvent();
    const legacy = legacyHeartbeatEvent(event);
    ledger.set(event.eventId, legacy);
    const before = { ...gateway };
    const winnerHash = canonicalPayloadHash({ ...event, firmwareVersion: different ? "other" : "v2" });
    tx.processedGatewayEvent.updateMany.mockImplementationOnce(async () => {
      legacy.payloadHash = winnerHash;
      return { count: 0 };
    });
    const replay = receiveHeartbeat(service, event);
    if (different) await expect(replay).rejects.toThrow("conflict");
    else await expect(replay).resolves.toBeUndefined();
    expect(tx.processedGatewayEvent.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.processedGatewayEvent.findUnique).toHaveBeenCalledTimes(2);
    expect(legacy.payloadHash).toBe(winnerHash);
    expect(gateway).toEqual(before);
  });

  it.each([
    { gatewayId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    { fixtureId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    { sequence: 8n }, { eventType: "fixture_state" },
    { occurredAt: new Date("2026-09-11T23:59:59.000Z") }
  ])("rejects a legacy heartbeat identity mismatch without binding its null hash: %o", async (mismatch) => {
    const { service, gateway, tx, ledger } = heartbeatHarness();
    const event = heartbeatEvent();
    ledger.set(event.eventId, { ...legacyHeartbeatEvent(event), ...mismatch });
    const before = { ...gateway };
    await expect(receiveHeartbeat(service, event)).rejects.toThrow("conflict");
    expect(tx.processedGatewayEvent.updateMany).not.toHaveBeenCalled();
    expect(ledger.get(event.eventId).payloadHash).toBeNull();
    expect(gateway).toEqual(before);
  });

  it.each(["topic", "serial", "site"])("rejects legacy heartbeat %s scope before binding its hash", async (kind) => {
    const { service, ledger, tx } = heartbeatHarness();
    const original = heartbeatEvent();
    ledger.set(original.eventId, legacyHeartbeatEvent(original));
    const event = { ...original, ...(kind === "serial" ? { gatewaySerial: "forged" } : {}),
      ...(kind === "site" ? { siteId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } : {}) };
    await expect(receiveHeartbeat(service, event, kind === "topic" ? `${heartbeatTopic}/state/heartbeat` : heartbeatTopic))
      .rejects.toThrow("scope");
    expect(tx.processedGatewayEvent.updateMany).not.toHaveBeenCalled();
    expect(ledger.get(original.eventId).payloadHash).toBeNull();
  });

  it("PUBACKs and emits duplicate after real API legacy reconciliation so the next queued state proceeds", async () => {
    const event = fixtureStateV2Schema.parse(fixtureEvent(9));
    const legacy = { eventId: event.eventId, gatewayId: event.gatewayId, fixtureId: event.fixtureId,
      sequence: 9n, eventType: "fixture_state", occurredAt: new Date(event.occurredAt),
      payloadHash: null as string | null, ingestionStatus: "accepted" };
    const prisma = fixtureReceiptPrisma(new Date("2026-07-11T00:00:00.000Z"), event.fixtureId);
    prisma.processedGatewayEvent.findUnique.mockImplementation(async ({ where }) => where.eventId === event.eventId ? legacy : null);
    prisma.processedGatewayEvent.updateMany.mockImplementation(async ({ where, data }) => {
      if (where.eventId !== legacy.eventId || legacy.payloadHash !== where.payloadHash) return { count: 0 };
      Object.assign(legacy, data);
      return { count: 1 };
    });
    const service = new MqttService(prisma as never, {} as never, new FixtureStateIngestionService(prisma as never));
    const client = mqttClientHarness(service);
    jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);
    const publish = jest.spyOn(service, "publishTopic").mockResolvedValue();
    const replayDone = jest.fn();
    const nextDone = jest.fn();
    const handle = mqttInternals(service).createCustomHandleAcks();
    handle(fixtureTopic, Buffer.from(JSON.stringify(event)), { qos: 1, messageId: 96 }, replayDone);
    handle(fixtureTopic, Buffer.from(JSON.stringify({ ...event,
      eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sequence: 10 })), { qos: 1, messageId: 97 }, nextDone);
    await service.stopInboundAndDrain();
    expect(replayDone).toHaveBeenCalledWith(0);
    expect(nextDone).toHaveBeenCalledWith(0);
    expect(publish.mock.calls.map(([, ack]) => ack)).toEqual([
      expect.objectContaining({ eventId: event.eventId, sequence: 9, status: "duplicate" }),
      expect.objectContaining({ sequence: 10, status: "ingested" })
    ]);
    expect(legacy.payloadHash).toBe(canonicalPayloadHash(event));
    expect(prisma.fixture.update).toHaveBeenCalledTimes(1);
    expect(client.stream.destroy).not.toHaveBeenCalled();
  });

  it("persists a future heartbeat rejection without changing gateway freshness, sequence, or firmware", async () => {
    const { service, gateway, ledger } = heartbeatHarness();
    const before = { ...gateway };
    const event = heartbeatEvent({ occurredAt: "9999-01-01T00:00:00.000Z" });

    await receiveHeartbeat(service, event);

    expect(gateway).toEqual(before);
    expect(ledger.get(event.eventId)).toMatchObject({
      gatewayId: scope.gatewayId, sequence: 9n, eventType: "gateway_heartbeat",
      occurredAt: new Date(event.occurredAt), receivedAt: heartbeatReceivedAt,
      ingestionStatus: "rejected_future_timestamp", payloadHash: canonicalPayloadHash(event)
    });
  });

  it("stores server receipt for heartbeat freshness and device time separately at the inclusive boundary", async () => {
    const { service, gateway, ledger } = heartbeatHarness();
    const event = heartbeatEvent({ occurredAt: "2026-09-12T00:05:00.000Z" });
    await receiveHeartbeat(service, event);
    expect(gateway).toMatchObject({ lastHeartbeatAt: heartbeatReceivedAt,
      lastHeartbeatOccurredAt: new Date(event.occurredAt), lastHeartbeatSequence: 9n, firmwareVersion: "v2" });
    expect(ledger.get(event.eventId)).toMatchObject({
      receivedAt: heartbeatReceivedAt, ingestionStatus: "accepted", payloadHash: canonicalPayloadHash(event)
    });
  });

  it.each(["2026-09-12T00:00:00.000Z", "2026-09-12T00:05:00.001Z"])(
    "verifies heartbeat replay hash even when its sequence is already terminal: %s", async (occurredAt) => {
      const { service, gateway, ledger } = heartbeatHarness();
      const event = heartbeatEvent({ occurredAt });
      await receiveHeartbeat(service, event);
      const before = { ...gateway };
      await receiveHeartbeat(service, Object.fromEntries(Object.entries(event).reverse()) as typeof event);
      expect(ledger.size).toBe(1);
      expect(gateway).toEqual(before);
      await expect(receiveHeartbeat(service, { ...event, firmwareVersion: "mutated" })).rejects.toThrow("conflict");
      expect(gateway).toEqual(before);
    }
  );

  it.each(["topic", "serial", "site"])("rejects forged heartbeat %s scope before writing the ledger", async (kind) => {
    const { service, gateway, ledger } = heartbeatHarness();
    const before = { ...gateway };
    const event = heartbeatEvent({ occurredAt: "9999-01-01T00:00:00.000Z",
      ...(kind === "serial" ? { gatewaySerial: "forged" } : {}),
      ...(kind === "site" ? { siteId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } : {}) });
    await expect(receiveHeartbeat(service, event, kind === "topic" ? `${heartbeatTopic}/state/heartbeat` : heartbeatTopic))
      .rejects.toThrow("scope");
    expect(ledger.size).toBe(0);
    expect(gateway).toEqual(before);
  });

  it("keeps old and equal heartbeat sequences harmless while processing the next heartbeat", async () => {
    const { service, gateway, ledger } = heartbeatHarness();
    gateway.lastHeartbeatSequence = 9n;
    const before = { ...gateway };
    await receiveHeartbeat(service, heartbeatEvent({ sequence: 8 }));
    await receiveHeartbeat(service, heartbeatEvent());
    expect(gateway).toEqual(before);
    expect(ledger.size).toBe(0);
    await receiveHeartbeat(service, heartbeatEvent({ sequence: 10 }));
    expect(gateway.lastHeartbeatSequence).toBe(10n);
  });

  it("does not swallow a partial unique sequence collision with no exact heartbeat replay", async () => {
    const { service, tx } = heartbeatHarness();
    tx.processedGatewayEvent.create.mockRejectedValueOnce({ code: "P2002" });
    await expect(receiveHeartbeat(service, heartbeatEvent())).rejects.toThrow("conflict");
  });

  it.each([false, true])("checks the winning heartbeat payload after a unique race (mutated=%s)", async (mutated) => {
    const { service, gateway, tx, ledger } = heartbeatHarness();
    const before = { ...gateway };
    const event = heartbeatEvent({ occurredAt: "9999-01-01T00:00:00.000Z" });
    tx.processedGatewayEvent.create.mockImplementationOnce(async ({ data }) => {
      ledger.set(event.eventId, { fixtureId: null, ...data, payloadHash: mutated ? "sha256:conflicting" : canonicalPayloadHash(event) });
      throw { code: "P2002" };
    });
    if (mutated) await expect(receiveHeartbeat(service, event)).rejects.toThrow("conflict");
    else await expect(receiveHeartbeat(service, event)).resolves.toBeUndefined();
    expect(gateway).toEqual(before);
  });

  it("freezes heartbeat receipt before waiting in the gateway queue", async () => {
    jest.useFakeTimers().setSystemTime(heartbeatReceivedAt);
    const { service, ledger } = heartbeatHarness();
    const client = mqttClientHarness(service);
    const release = deferred<void>();
    const event = heartbeatEvent({ occurredAt: "2026-09-12T00:05:00.001Z" });
    const payload = Buffer.from(JSON.stringify(event));
    const packet = { qos: 1, messageId: 94 };
    const done = jest.fn(() => client.emit("message", heartbeatTopic, payload, packet));
    try {
      void mqttInternals(service).runInGatewayInboundQueue(heartbeatTopic, () => release.promise);
      mqttInternals(service).createCustomHandleAcks()(heartbeatTopic, payload, packet, done);
      jest.setSystemTime(new Date("2026-09-12T00:10:00.000Z"));
      release.resolve();
      // Drain active handlers without stopping intake; shutdown intentionally suppresses pending generic PUBACKs.
      await Promise.all((service as any).activeInboundHandlers);
      expect(done).toHaveBeenCalledWith(0);
      expect(ledger.get(event.eventId)).toMatchObject({
        receivedAt: heartbeatReceivedAt, ingestionStatus: "rejected_future_timestamp"
      });
    } finally {
      release.resolve();
      await service.stopInboundAndDrain();
      jest.useRealTimers();
    }
  });

  it("fails closed on invalid heartbeat skew configuration", async () => {
    const original = process.env.GATEWAY_EVENT_MAX_FUTURE_SKEW_MS;
    process.env.GATEWAY_EVENT_MAX_FUTURE_SKEW_MS = "invalid";
    try {
      const { service, ledger } = heartbeatHarness();
      await expect(receiveHeartbeat(service)).rejects.toThrow("invalid GATEWAY_EVENT_MAX_FUTURE_SKEW_MS");
      expect(ledger.size).toBe(0);
    } finally {
      if (original === undefined) delete process.env.GATEWAY_EVENT_MAX_FUTURE_SKEW_MS;
      else process.env.GATEWAY_EVENT_MAX_FUTURE_SKEW_MS = original;
    }
  });

  it("PUBACKs a durably rejected future heartbeat and then processes the same gateway's state packet", async () => {
    const { service, ledger } = heartbeatHarness();
    const client = mqttClientHarness(service);
    const future = heartbeatEvent({ occurredAt: "9999-01-01T00:00:00.000Z" });
    const payload = Buffer.from(JSON.stringify(future));
    const packet = { qos: 1, messageId: 90 };
    const done = jest.fn(() => {
      expect(ledger.get(future.eventId)?.ingestionStatus).toBe("rejected_future_timestamp");
      client.emit("message", heartbeatTopic, payload, packet);
    });
    const publish = jest.spyOn(service, "publishTopic").mockResolvedValue();
    mqttInternals(service).createCustomHandleAcks()(heartbeatTopic, payload, packet, done);
    await waitFor(() => done.mock.calls.length === 1);
    const nextDone = jest.fn();
    mqttInternals(service).createCustomHandleAcks()(fixtureTopic, Buffer.from(JSON.stringify(fixtureEvent(10))),
      { qos: 1, messageId: 91 }, nextDone);
    await waitFor(() => nextDone.mock.calls.length === 1);
    await service.stopInboundAndDrain();
    expect(publish).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ sequence: 10, status: "ingested" }), expect.any(Object));
    expect(client.stream.destroy).not.toHaveBeenCalled();
  });

  it("PUBACKs future fixture rejection and publishes its terminal ACK before processing the next same-gateway state", async () => {
    const commit = deferred<void>();
    const ingestion = { ingest: jest.fn(async (_gateway, event) => {
      if (event.sequence === 9) await commit.promise;
      return { eventId: event.eventId, sequence: event.sequence, fixtureId: event.fixtureId,
        status: event.sequence === 9 ? "rejected_future_timestamp" : "ingested" };
    }) };
    const service = new MqttService({} as never, {} as never, ingestion as never);
    const publish = jest.spyOn(service, "publishTopic").mockResolvedValue();
    const firstDone = jest.fn();
    const secondDone = jest.fn();
    const handle = mqttInternals(service).createCustomHandleAcks();
    handle(fixtureTopic, Buffer.from(JSON.stringify({ ...fixtureEvent(9), occurredAt: "9999-01-01T00:00:00.000Z" })),
      { qos: 1, messageId: 92 }, firstDone);
    handle(fixtureTopic, Buffer.from(JSON.stringify({ ...fixtureEvent(10), eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })),
      { qos: 1, messageId: 93 }, secondDone);
    await flushPromises();
    expect(firstDone).not.toHaveBeenCalled();
    expect(secondDone).not.toHaveBeenCalled();
    commit.resolve();
    await service.stopInboundAndDrain();
    expect(firstDone).toHaveBeenCalledWith(0);
    expect(secondDone).toHaveBeenCalledWith(0);
    expect(publish.mock.calls.map(([, ack]) => ack)).toEqual([
      expect.objectContaining({ sequence: 9, status: "rejected_future_timestamp" }),
      expect.objectContaining({ sequence: 10, status: "ingested" })
    ]);
  });

  it.each([
    ["2026-09-12T00:05:00.001Z", "rejected_future_timestamp"],
    ["2026-09-12T00:05:00.000Z", "ingested"]
  ])("uses fixture packet arrival before queue waiting for %s (%s)", async (occurredAt, status) => {
    const arrival = new Date("2026-09-12T00:00:00.000Z");
    jest.useFakeTimers().setSystemTime(arrival);
    const event = { ...fixtureEvent(9), occurredAt };
    const prisma = fixtureReceiptPrisma(arrival, event.fixtureId);
    const ingestion = new FixtureStateIngestionService(prisma as never);
    const ingest = jest.spyOn(ingestion, "ingest");
    const service = new MqttService(prisma as never, {} as never, ingestion);
    const publish = jest.spyOn(service, "publishTopic").mockResolvedValue();
    const release = deferred<void>();
    const done = jest.fn();
    try {
      void mqttInternals(service).runInGatewayInboundQueue(fixtureTopic, () => release.promise);
      mqttInternals(service).createCustomHandleAcks()(fixtureTopic, Buffer.from(JSON.stringify(event)),
        { qos: 1, messageId: 95 }, done);
      jest.setSystemTime(new Date("2026-09-12T00:10:00.000Z"));
      expect(ingest).not.toHaveBeenCalled();
      release.resolve();
      await service.stopInboundAndDrain();

      expect(done).toHaveBeenCalledWith(0);
      expect(publish).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status }), expect.any(Object));
      expect(ingest).toHaveBeenCalledWith(scope.gatewayId, expect.objectContaining({ eventId: event.eventId }), arrival);
      expect(prisma.processedGatewayEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ receivedAt: arrival }) });
      if (status === "ingested") {
        expect(prisma.fixture.update).toHaveBeenCalledWith(expect.objectContaining({
          data: expect.objectContaining({ lastSeenAt: arrival, lastStateOccurredAt: new Date(occurredAt) })
        }));
      } else {
        expect(prisma.fixture.update).not.toHaveBeenCalled();
        expect(prisma.fixtureEnergyStateCursor.findUnique).not.toHaveBeenCalled();
      }
    } finally {
      release.resolve();
      await service.stopInboundAndDrain();
      jest.useRealTimers();
    }
  });

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
    await waitFor(() => client.stream.destroy.mock.calls.length === 1);

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
    await waitFor(() => client.stream.destroy.mock.calls.length === 1);

    expect(order).toEqual([]);
    expect(client.stream.destroy).toHaveBeenCalledTimes(1);
    expect(internal.gatewayInboundQueues.size).toBe(0);
    expect(internal.inboundPacketPermits.size).toBe(0);
  });

  it("processes a packet exactly once when MQTT invokes the custom ACK handler twice", async () => {
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

  it("does not PUBACK and closes the transport when durable handling rejects", async () => {
    const topic = `sites/${scope.siteId}/gateways/${scope.gatewayId}/events/automation/execution`;
    const service = new MqttService(
      {} as never,
      { attachProvisionedNode: jest.fn() } as never,
      undefined,
      { handleMessage: jest.fn().mockRejectedValue(new Error("injected handler failure")) } as never
    );
    const client = mqttClientHarness(service);
    const internal = mqttInternals(service);
    jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);
    const packet = { qos: 1, messageId: 35 };
    const done = jest.fn((reasonCode: number) => {
      client.emit("message", topic, Buffer.from("{}"), packet);
      expect(reasonCode).toBe(0);
    });

    internal.createCustomHandleAcks()(topic, Buffer.from("{}"), packet, done);
    await waitFor(() => client.stream.destroy.mock.calls.length === 1);
    await service.stopInboundAndDrain();

    expect(done).not.toHaveBeenCalled();
    expect(client.stream.destroy).toHaveBeenCalledTimes(1);
    expect(internal.gatewayInboundQueues.size).toBe(0);
    expect(internal.inboundPacketPermits.size).toBe(0);
  });

  it("PUBACKs a command acceptance only after its database write completes", async () => {
    const stored = deferred<{ count: number }>();
    const prisma = {
      commandDispatch: { updateMany: jest.fn(() => stored.promise) }
    };
    const service = new MqttService(prisma as never, { attachProvisionedNode: jest.fn() } as never);
    const client = mqttClientHarness(service);
    const internal = mqttInternals(service);
    const topic = `sites/${scope.siteId}/gateways/${scope.gatewayId}/acks/acceptance`;
    const packet = { qos: 1, messageId: 37 };
    const payload = Buffer.from(JSON.stringify({
      commandId: "11111111-1111-4111-8111-111111111111",
      dispatchId: "66666666-6666-4666-8666-666666666666",
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
      sequence: 1,
      ...scope,
      eventId: "77777777-7777-4777-8777-777777777777",
      status: "accepted",
      acceptedAt: "2026-07-11T00:00:01.000Z"
    }));
    const done = jest.fn((reasonCode: number) => {
      client.emit("message", topic, payload, packet);
      expect(reasonCode).toBe(0);
    });

    internal.createCustomHandleAcks()(topic, payload, packet, done);
    await flushPromises();

    expect(prisma.commandDispatch.updateMany).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();

    stored.resolve({ count: 1 });
    await waitFor(() => done.mock.calls.length === 1);
    await service.stopInboundAndDrain();

    expect(done).toHaveBeenCalledTimes(1);
    expect(client.stream.destroy).not.toHaveBeenCalled();
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

  it("PUBACKs a mesh resync request after commit without waiting for the outbound resync ACK callback", async () => {
    const outboundResyncAck = deferred<void>();
    const markers: string[] = [];
    const prisma = {
      $transaction: jest.fn(async (operation: (tx: object) => Promise<unknown>) => {
        const result = await operation({ transaction: true });
        markers.push("transaction-committed");
        return result;
      })
    };
    const meshGroups = {
      attachProvisionedNode: jest.fn(),
      resetGatewayGroupsForResync: jest.fn().mockResolvedValue({ groupCount: 1, memberCount: 0 })
    };
    const service = new MqttService(prisma as never, meshGroups as never);
    const client = mqttClientHarness(service);
    jest.spyOn(service, "publishTopic").mockImplementation(() => {
      markers.push("resync-ack-publish-started");
      return outboundResyncAck.promise;
    });
    const internal = mqttInternals(service);
    const topic = `sites/${scope.siteId}/gateways/${scope.gatewayId}/events/mesh-group/resync-request`;
    const payload = Buffer.from(JSON.stringify({
      ...scope,
      eventId: "77777777-7777-4777-8777-777777777777",
      occurredAt: "2026-08-26T00:00:00.000Z",
      reason: "state_missing"
    }));
    const packet = { qos: 1, messageId: 38 };
    const done = jest.fn((reasonCode: number) => {
      markers.push("inbound-puback");
      client.emit("message", topic, payload, packet);
      expect(reasonCode).toBe(0);
    });

    internal.createCustomHandleAcks()(topic, payload, packet, done);
    await waitFor(() => markers.includes("resync-ack-publish-started"));
    await flushPromises();
    const markersBeforeOutboundAckSettles = [...markers];

    outboundResyncAck.resolve();
    await service.stopInboundAndDrain();

    expect(markersBeforeOutboundAckSettles).toEqual([
      "transaction-committed",
      "inbound-puback",
      "resync-ack-publish-started"
    ]);
    expect(done).toHaveBeenCalledTimes(1);
    expect(client.stream.destroy).not.toHaveBeenCalled();
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

const heartbeatReceivedAt = new Date("2026-09-12T00:00:00.000Z");
const heartbeatTopic = `sites/${scope.siteId}/gateways/${scope.gatewayId}/state/heartbeat`;
const fixtureTopic = `sites/${scope.siteId}/gateways/${scope.gatewayId}/state/fixtures`;

function heartbeatEvent(overrides: Record<string, unknown> = {}) {
  return { ...scope, eventId: "77777777-7777-4777-8777-777777777777", sequence: 9,
    occurredAt: "2026-09-12T00:00:00.000Z", gatewaySerial: "GW-001", firmwareVersion: "v2", ...overrides };
}

function receiveHeartbeat(service: MqttService, event = heartbeatEvent(), topic = heartbeatTopic) {
  return service.handleMessage(topic, Buffer.from(JSON.stringify(event)), heartbeatReceivedAt);
}

function heartbeatHarness() {
  const gateway = { id: scope.gatewayId, siteId: scope.siteId, serialNumber: "GW-001",
    lastHeartbeatAt: new Date("2026-09-11T00:00:00.000Z"), lastHeartbeatOccurredAt: new Date("2026-09-11T00:00:00.000Z"),
    lastHeartbeatSequence: null as bigint | null, firmwareVersion: "v1" };
  const ledger = new Map<string, any>();
  const tx = {
    $queryRaw: jest.fn(async (_sql, id, siteId, serialNumber) =>
      id === gateway.id && siteId === gateway.siteId && serialNumber === gateway.serialNumber ? [{ ...gateway }] : []),
    gateway: {
      findFirst: jest.fn(async ({ where }) => where.id === gateway.id && where.siteId === gateway.siteId && where.serialNumber === gateway.serialNumber ? { ...gateway } : null),
      updateMany: jest.fn(async ({ data }) => { Object.assign(gateway, data); return { count: 1 }; })
    },
    processedGatewayEvent: {
      findUnique: jest.fn(async ({ where }) => ledger.get(where.eventId) ?? null),
      updateMany: jest.fn(async ({ where, data }) => {
        const existing = ledger.get(where.eventId);
        if (!existing || existing.payloadHash !== where.payloadHash) return { count: 0 };
        Object.assign(existing, data);
        return { count: 1 };
      }),
      create: jest.fn(async ({ data }) => { const row = { fixtureId: null, ...data }; ledger.set(data.eventId, row); return row; })
    }
  };
  const prisma = { ...tx, $transaction: jest.fn(async (operation) => operation(tx)) };
  const ingestion = { ingest: jest.fn(async (_id, event) => ({ eventId: event.eventId, sequence: event.sequence,
    fixtureId: event.fixtureId, status: "ingested" })) };
  return { service: new MqttService(prisma as never, {} as never, ingestion as never), gateway, ledger, tx, prisma };
}

function fixtureReceiptPrisma(trackingStartedAt: Date, fixtureId: string) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{
      ...scope, id: fixtureId, energyFixtureId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ratedWatt: new Prisma.Decimal("40.00"), brightness: 0, powerOn: null,
      energyTrackingStartedAt: trackingStartedAt, firstStateOccurredAt: null,
      lastStateEventId: null, lastStateSequence: null, lastStateOccurredAt: null,
      timeZone: "Asia/Seoul", tariffKwhRate: new Prisma.Decimal("120.00")
    }]),
    processedGatewayEvent: {
      findUnique: jest.fn().mockResolvedValue(null), findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue(undefined)
    },
    fixtureEnergyStateCursor: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue(undefined) },
    fixtureEnergyDailyAggregate: { upsert: jest.fn().mockResolvedValue(undefined) },
    fixtureEnergyHourlyAggregate: { upsert: jest.fn().mockResolvedValue(undefined) },
    fixture: { update: jest.fn().mockResolvedValue(undefined) }
  };
  return { ...tx, $transaction: jest.fn(async (operation) => operation(tx)) };
}

function legacyHeartbeatEvent(event: ReturnType<typeof heartbeatEvent>) {
  return { eventId: event.eventId, gatewayId: event.gatewayId, fixtureId: null,
    sequence: BigInt(event.sequence), eventType: "gateway_heartbeat", occurredAt: new Date(event.occurredAt),
    payloadHash: null as string | null, ingestionStatus: "accepted" };
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
