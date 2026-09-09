import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { FixtureIdentifyResult } from "@led-control/shared";
import { publishFixtureIdentifyResult } from "./fixture-identify-publisher";

afterEach(() => vi.useRealTimers());
const id = randomUUID();
const result: FixtureIdentifyResult = { version: 1, commandId: id, sessionId: id, fixtureId: id, siteId: id, gatewayId: id,
  action: "start", requestedAt: "2026-09-09T00:00:00.000Z", expiresAt: "2026-09-09T00:00:10.000Z",
  status: "rejected", reason: "command_expired", reportedAt: "2026-09-09T00:00:11.000Z" };
function client() {
  return { connected: true, publish: vi.fn(), getLastMessageId: () => 7, removeOutgoingMessage: vi.fn() };
}
it("bounds an unacknowledged result publish and removes its MQTT outgoing entry", async () => {
  vi.useFakeTimers();
  const mqtt = client();
  const sent = publishFixtureIdentifyResult(mqtt as never, result);
  const assertion = expect(sent).rejects.toThrow("identify_result_publish_timeout");
  await vi.advanceTimersByTimeAsync(1000);
  await assertion;
  expect(mqtt.removeOutgoingMessage).toHaveBeenCalledWith(7);
});
it("never offline-queues a result and cancels the outgoing entry on shutdown", async () => {
  const mqtt = client();
  mqtt.connected = false;
  await expect(publishFixtureIdentifyResult(mqtt as never, result)).rejects.toThrow("identify_result_offline");
  expect(mqtt.publish).not.toHaveBeenCalled();
  mqtt.connected = true;
  const abort = new AbortController();
  const sent = publishFixtureIdentifyResult(mqtt as never, result, abort.signal);
  abort.abort();
  await expect(sent).rejects.toThrow("identify_result_aborted");
  expect(mqtt.removeOutgoingMessage).toHaveBeenCalledWith(7);
});
it("publishes the exact scoped result with a short broker expiry and releases its deadline", async () => {
  vi.useFakeTimers();
  const mqtt = client();
  mqtt.publish.mockImplementation((_topic, _payload, _options, callback) => callback());
  await publishFixtureIdentifyResult(mqtt as never, result);
  expect(mqtt.publish).toHaveBeenCalledWith(`sites/${id}/gateways/${id}/events/identify-result`, expect.any(String),
    { qos: 1, properties: { messageExpiryInterval: 5 } }, expect.any(Function));
  expect(JSON.parse(mqtt.publish.mock.calls[0]![1])).toEqual(result);
  expect(vi.getTimerCount()).toBe(0);
  expect(mqtt.removeOutgoingMessage).not.toHaveBeenCalled();
});
