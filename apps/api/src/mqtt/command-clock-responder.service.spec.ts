import { mqttTopicsV2, type CommandClockRequest } from "@led-control/shared";
import type { Prisma } from "@prisma/client";
import { MqttService } from "./mqtt.service";
import { CommandClockResponderService } from "./command-clock-responder.service";

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
  const health = { assertHealthy: jest.fn(async () => { if (options.healthError) throw new Error("clock evidence unavailable"); }) };
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
});
