import { mqttTopicsV2, type CommandClockRequest } from "@led-control/shared";
import type { Prisma } from "@prisma/client";
import { EventEmitter } from "node:events";
import { MqttService } from "./mqtt.service";
import { CommandClockResponderService } from "./command-clock-responder.service";
import { CommandDbClockHealth, type CommandDbClockEvidence } from "./command-db-clock-health.service";

const request: CommandClockRequest = {
  siteId: "11111111-1111-4111-8111-111111111111",
  gatewayId: "22222222-2222-4222-8222-222222222222",
  nonce: "33333333-3333-4333-8333-333333333333"
};
const scope = { siteId: request.siteId, gatewayId: request.gatewayId };
const dbNow = new Date("2026-09-26T12:00:00.123Z");

function responder(options: { epoch?: number | null; dbError?: boolean; healthError?: boolean } = {}) {
  const tx = { $queryRaw: jest.fn(async (sql: TemplateStringsArray) => {
    if (options.dbError) throw new Error("database unavailable");
    const text = sql.join("");
    if (text.includes("clock_timestamp")) return [{ dbNow }];
    return options.epoch === null ? [] : [{ generation: options.epoch ?? 7 }];
  }) };
  const db = { $transaction: jest.fn(async (run: (tx: Prisma.TransactionClient) => Promise<unknown>) => run(tx as never)) };
  const health = { assertHealthy: jest.fn(async () => { if (options.healthError) throw new Error("clock evidence unavailable"); return dbNow; }) };
  return { service: new CommandClockResponderService(db as never, health as never), db, tx, health };
}

describe("CommandClockResponderService", () => {
  it("returns DB UTC time, active generation, original scope and nonce", async () => {
    const { service } = responder();
    await expect(service.respond(scope, request)).resolves.toEqual({ ...request, dbNow: "2026-09-26T12:00:00.123Z", publishEpoch: 7 });
  });

  it("rejects a payload with another topic scope before DB access", async () => {
    const { service, db } = responder();
    await expect(service.respond({ ...scope, gatewayId: "44444444-4444-4444-8444-444444444444" }, request)).resolves.toBeNull();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("uses only the DB timestamp validated by the clock-health gate", async () => {
    const validated = new Date("2026-09-26T12:00:00.000Z");
    const stepped = new Date("2026-09-26T12:00:02.000Z");
    const tx = { $queryRaw: jest.fn(async (sql: TemplateStringsArray) =>
      sql.join("").includes("CommandPublishEpoch") ? [{ generation: 7 }] : [{ dbNow: stepped }]) };
    const db = { $transaction: async (run: (tx: Prisma.TransactionClient) => Promise<unknown>) => run(tx as never) };
    const health = { assertHealthy: async () => validated };
    const service = new CommandClockResponderService(db as never, health as never);
    await expect(service.respond(scope, request)).resolves.toEqual({ ...request,
      dbNow: "2026-09-26T12:00:00.000Z", publishEpoch: 7 });
  });

  it("rejects stale evidence when the active-epoch lock delayed the DB sample", async () => {
    let dbTime = new Date("2026-09-26T12:00:00.000Z");
    const primaryStartedAt = new Date("2026-09-25T01:00:00.000Z");
    const evidence: CommandDbClockEvidence = {
      issuedAt: new Date("2026-09-26T11:59:59.500Z"), offsetMs: 0,
      stepGeneration: 1, clearedStepGeneration: 1,
      failoverGeneration: 1, clearedFailoverGeneration: 1,
      primary: { startedAt: primaryStartedAt, address: "127.0.0.1", port: 5432 }
    };
    const tx = { $queryRaw: jest.fn(async (sql: TemplateStringsArray) => {
      if (sql.join("").includes("CommandPublishEpoch")) {
        dbTime = new Date("2026-09-26T12:00:02.000Z");
        return [{ generation: 7 }];
      }
      return [{ dbNow: dbTime, isReplica: false, primaryStartedAt, serverAddress: "127.0.0.1", serverPort: 5432 }];
    }) };
    const db = { $transaction: async (run: (tx: Prisma.TransactionClient) => Promise<unknown>) => run(tx as never) };
    const service = new CommandClockResponderService(db as never, new CommandDbClockHealth({ read: async () => evidence }));
    await expect(service.respond(scope, request)).resolves.toBeNull();
  });

  it.each([
    ["DB outage", { dbError: true }],
    ["missing clock evidence", { healthError: true }],
    ["quiescing or absent epoch", { epoch: null }]
  ])("returns no time response on %s", async (_name, options) => {
    const { service } = responder(options);
    await expect(service.respond(scope, request)).resolves.toBeNull();
  });

  it("subscribes and routes a scoped request to a non-retained response", async () => {
    const { service: clock } = responder();
    const mqtt = new MqttService({} as never, {} as never);
    (mqtt as never as { commandClockResponder: CommandClockResponderService }).commandClockResponder = clock;
    const client = {
      on: jest.fn(), subscribe: jest.fn(), getLastMessageId: jest.fn().mockReturnValue(1),
      publish: jest.fn((_topic, _payload, _options, done: (error?: Error) => void) => done())
    };
    (mqtt as never as { client: unknown }).client = client;
    mqtt.onModuleInit();
    client.on.mock.calls.find(([name]) => name === "connect")?.[1]();
    expect(client.subscribe).toHaveBeenCalledWith(
      expect.arrayContaining([mqttTopicsV2.commandClockRequest("+", "+")]), { qos: 1 }
    );
    await mqtt.handleMessage(mqttTopicsV2.commandClockRequest(request.siteId, request.gatewayId), Buffer.from(JSON.stringify(request)));
    expect(client.publish).toHaveBeenCalledWith(mqttTopicsV2.commandClockResponse(request.siteId, request.gatewayId),
      expect.any(String), { qos: 1, retain: false, properties: { messageExpiryInterval: 10 } }, expect.any(Function));
    expect(JSON.parse(client.publish.mock.calls[0][1])).toEqual({ ...request, dbNow: dbNow.toISOString(), publishEpoch: 7 });

    await mqtt.handleMessage(`${mqttTopicsV2.commandClockRequest(request.siteId, request.gatewayId)}/forged`, Buffer.from(JSON.stringify(request)));
    await mqtt.handleMessage(mqttTopicsV2.commandClockRequest(request.siteId, request.gatewayId), Buffer.from(JSON.stringify({
      ...request, gatewayId: "44444444-4444-4444-8444-444444444444"
    })));
    expect(client.publish).toHaveBeenCalledTimes(1);
  });

  it("PUBACKs one scoped QoS1 request before publishing one response", async () => {
    const { service: clock } = responder();
    const mqtt = new MqttService({} as never, {} as never);
    (mqtt as never as { commandClockResponder: CommandClockResponderService }).commandClockResponder = clock;
    const order: string[] = [];
    let outboundDone!: (error?: Error) => void;
    const client: EventEmitter & { subscribe?: jest.Mock; stream?: { destroy: jest.Mock }; publish?: jest.Mock; getLastMessageId?: jest.Mock } = new EventEmitter();
    client.subscribe = jest.fn();
    client.stream = { destroy: jest.fn() };
    client.getLastMessageId = jest.fn().mockReturnValue(1);
    client.publish = jest.fn((_topic, _payload, _options, callback) => {
      order.push("outbound publish");
      outboundDone = callback;
    });
    (mqtt as never as { client: unknown }).client = client;
    mqtt.onModuleInit();
    const topic = mqttTopicsV2.commandClockRequest(request.siteId, request.gatewayId);
    const payload = Buffer.from(JSON.stringify(request));
    const packet = { qos: 1, topic, payload };
    const done = jest.fn((reason: number) => {
      order.push("inbound PUBACK");
      client.emit("message", topic, payload, packet);
    });
    (mqtt as never as { createCustomHandleAcks: () => Function }).createCustomHandleAcks()(topic, payload, packet, done);
    await new Promise((resolve) => setImmediate(resolve));
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(0);
    expect(order).toEqual(["inbound PUBACK", "outbound publish"]);
    expect(client.publish).toHaveBeenCalledTimes(1);
    outboundDone();
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.publish).toHaveBeenCalledTimes(1);
    expect(client.stream.destroy).not.toHaveBeenCalled();
  });
});
