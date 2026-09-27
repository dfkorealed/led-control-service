import { EventEmitter } from "node:events";
import { Logger } from "@nestjs/common";
import { MqttService } from "../mqtt/mqtt.service";

describe("redacted manual replay ACK transport", () => {
  it.each([false, true])("commits, PUBACKs, then publishes an expiring one-shot ACK (first publish fails=%s)", async failFirst => {
    const order: string[] = [];
    const topic = "sites/11111111-1111-4111-8111-111111111111/gateways/22222222-2222-4222-8222-222222222222/events/automation/execution";
    const ackTopic = topic.replace("events/automation/execution", "acks/automation-execution-ingested");
    let commit!: () => void;
    const consumer = { handleMessage: jest.fn(() => new Promise(resolve => {
      commit = () => { order.push("commit"); resolve({ publishAfterAck: { topic: ackTopic, payload: { eventId: "event" } } }); };
    })) };
    const service = new MqttService({} as never, {} as never, undefined, consumer as never);
    const client: any = new EventEmitter();
    client.subscribe = jest.fn(); client.getLastMessageId = () => 0;
    client.stream = { destroy: jest.fn() };
    let attempt = 0;
    client.publish = jest.fn((_topic, _payload, _options, callback) => {
      order.push("publish"); callback(failFirst && attempt++ === 0 ? new Error("broker disconnected") : undefined);
    });
    (service as any).client = client;
    service.onModuleInit();
    const logging = jest.spyOn(Logger.prototype, "error").mockImplementation();
    try {
      for (let delivery = 0; delivery < (failFirst ? 2 : 1); delivery++) {
        const payload = Buffer.from("{}"), packet = { qos: 1, topic, payload };
        const done = () => { order.push("puback"); client.emit("message", topic, payload, packet); };
        (service as any).createCustomHandleAcks()(topic, payload, packet, done);
        await new Promise(resolve => setImmediate(resolve));
        expect(order).toEqual(Array.from({ length: delivery }, () => ["commit", "puback", "publish"]).flat());
        commit();
        await new Promise(resolve => setImmediate(resolve));
      }
      expect(order).toEqual(Array.from({ length: failFirst ? 2 : 1 }, () => ["commit", "puback", "publish"]).flat());
      for (const call of client.publish.mock.calls) {
        expect(call[0]).toBe(ackTopic);
        expect(call[2]).toMatchObject({ qos: 1, properties: { messageExpiryInterval: 10 } });
      }
      expect(client.stream.destroy).not.toHaveBeenCalled();
      expect(consumer.handleMessage).toHaveBeenCalledTimes(failFirst ? 2 : 1);
    } finally { logging.mockRestore(); }
  });
});
