import { randomUUID } from "node:crypto";
import { fixtureIdentifyTopics } from "@led-control/shared";
import { MqttService } from "./mqtt.service";

const siteId = randomUUID(), gatewayId = randomUUID();
const result = { version: 1, commandId: randomUUID(), sessionId: randomUUID(), fixtureId: randomUUID(), siteId, gatewayId,
  action: "start", requestedAt: "2026-09-09T00:00:00.000Z", expiresAt: "2026-09-09T00:00:10.000Z",
  status: "attention_confirmed", attentionSeconds: 10, reportedAt: "2026-09-09T00:00:01.000Z" };
function setup() {
  const gateway = { findFirst: jest.fn(async () => ({ id: gatewayId })) };
  const mqtt = new MqttService({ gateway } as never, {} as never);
  const listener = jest.fn(async () => {});
  const remove = mqtt.onFixtureIdentifyResult(listener);
  return { gateway, mqtt, listener, remove };
}
it("delivers typed results only after topic and active claim/certificate checks", async () => {
  const h = setup();
  await h.mqtt.handleMessage(fixtureIdentifyTopics.result(siteId, gatewayId), Buffer.from(JSON.stringify(result)));
  expect(h.listener).toHaveBeenCalledWith(result);
  expect(h.gateway.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
    id: gatewayId, siteId, inventory: expect.objectContaining({ certificates: { some: expect.objectContaining({ gatewayId, purpose: "mqtt", status: "active", revokedAt: null }) } })
  }) }));
  h.remove();
  await h.mqtt.handleMessage(fixtureIdentifyTopics.result(siteId, gatewayId), Buffer.from(JSON.stringify(result)));
  expect(h.listener).toHaveBeenCalledTimes(1);
});
it("rejects wrong gateway/site and revoked claims before listener delivery", async () => {
  const h = setup();
  for (const topic of [fixtureIdentifyTopics.result(randomUUID(), gatewayId), fixtureIdentifyTopics.result(siteId, randomUUID())]) {
    await expect(h.mqtt.handleMessage(topic, Buffer.from(JSON.stringify(result)))).rejects.toThrow("scope");
  }
  h.gateway.findFirst.mockResolvedValueOnce(null as never);
  await expect(h.mqtt.handleMessage(fixtureIdentifyTopics.result(siteId, gatewayId), Buffer.from(JSON.stringify(result)))).rejects.toThrow("unregistered");
  expect(h.listener).not.toHaveBeenCalled();
});
it("rejects malformed Attention success and clears registrations on shutdown", async () => {
  const h = setup();
  await expect(h.mqtt.handleMessage(fixtureIdentifyTopics.result(siteId, gatewayId), Buffer.from(JSON.stringify({ ...result, attentionSeconds: 0 })))).rejects.toThrow();
  await h.mqtt.stopInboundAndDrain();
  await h.mqtt.handleMessage(fixtureIdentifyTopics.result(siteId, gatewayId), Buffer.from(JSON.stringify(result)));
  expect(h.listener).not.toHaveBeenCalled();
});
