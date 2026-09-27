import { describe, expect, it } from "vitest";
import { mqttTopicsV2 } from "./gateway-contracts";
import {
  commandClockRequestSchema,
  commandClockResponseSchema,
  commandDrainRequestSchema,
  commandDrainResponseSchema,
  matchesCommandSafetyTopicScope
} from "./command-clock-contracts";

const siteId = "00000000-0000-4000-8000-000000000003";
const gatewayId = "00000000-0000-4000-8000-000000000004";
const otherGatewayId = "00000000-0000-4000-8000-000000000005";
const nonce = "11111111-1111-4111-8111-111111111111";

describe("command DB clock and drain wire", () => {
  const request = { siteId, gatewayId, nonce };
  const response = { ...request, publishEpoch: 3, dbNow: "2026-09-26T04:05:06.123Z" };
  const drainRequest = { ...request, publishEpoch: 3 };
  const drainResponse = {
    ...drainRequest, gatewayVersion: "2.1.0", bootId: "22222222-2222-4222-8222-222222222222",
    queuedCount: 1, submittedCount: 2, unconfirmedCount: 2
  };

  it("round-trips strict scoped clock messages on separate request and response topics", () => {
    expect(mqttTopicsV2.commandClockRequest(siteId, gatewayId)).toBe(
      `sites/${siteId}/gateways/${gatewayId}/commands/clock/request`
    );
    expect(mqttTopicsV2.commandClockResponse(siteId, gatewayId)).toBe(
      `sites/${siteId}/gateways/${gatewayId}/events/clock/response`
    );
    expect(commandClockRequestSchema.parse(JSON.parse(JSON.stringify(request)))).toEqual(request);
    expect(commandClockResponseSchema.parse(JSON.parse(JSON.stringify(response)))).toEqual(response);
    expect(matchesCommandSafetyTopicScope(mqttTopicsV2.commandClockRequest(siteId, gatewayId), "clock-request", request)).toBe(true);
    expect(matchesCommandSafetyTopicScope(mqttTopicsV2.commandClockResponse(siteId, gatewayId), "clock-response", response)).toBe(true);
  });

  it("rejects a wrong topic scope even when the payload itself is valid", () => {
    expect(commandClockRequestSchema.parse(request)).toEqual(request);
    expect(matchesCommandSafetyTopicScope(mqttTopicsV2.commandClockRequest(siteId, otherGatewayId), "clock-request", request)).toBe(false);
    expect(matchesCommandSafetyTopicScope(mqttTopicsV2.commandClockResponse(siteId, otherGatewayId), "clock-response", response)).toBe(false);
    expect(matchesCommandSafetyTopicScope(mqttTopicsV2.commandClockResponse(siteId, gatewayId), "clock-request", request)).toBe(false);
  });

  it("rejects malformed clock identity, epoch, timestamp, and extra fields", () => {
    for (const invalid of [
      { ...request, nonce: "not-a-uuid" }, { ...request, siteId: "other-site" }, { ...request, extra: true }
    ]) expect(commandClockRequestSchema.safeParse(invalid).success).toBe(false);
    for (const invalid of [
      { ...response, publishEpoch: 0 }, { ...response, publishEpoch: -1 },
      { ...response, publishEpoch: Number.MAX_SAFE_INTEGER + 1 },
      { ...response, dbNow: "2026-09-26T13:05:06.123+09:00" },
      { ...response, nonce: "bad" }, { ...response, extra: true }
    ]) expect(commandClockResponseSchema.safeParse(invalid).success).toBe(false);
  });

  it("round-trips scoped drain evidence with nonce, epoch, version, boot, and conservative counters", () => {
    expect(mqttTopicsV2.commandDrainRequest(siteId, gatewayId)).toBe(
      `sites/${siteId}/gateways/${gatewayId}/commands/drain/request`
    );
    expect(mqttTopicsV2.commandDrainResponse(siteId, gatewayId)).toBe(
      `sites/${siteId}/gateways/${gatewayId}/events/drain/response`
    );
    expect(commandDrainRequestSchema.parse(JSON.parse(JSON.stringify(drainRequest)))).toEqual(drainRequest);
    expect(commandDrainResponseSchema.parse(JSON.parse(JSON.stringify(drainResponse)))).toEqual(drainResponse);
    expect(matchesCommandSafetyTopicScope(mqttTopicsV2.commandDrainRequest(siteId, gatewayId), "drain-request", drainRequest)).toBe(true);
    expect(matchesCommandSafetyTopicScope(mqttTopicsV2.commandDrainResponse(siteId, gatewayId), "drain-response", drainResponse)).toBe(true);
    expect(matchesCommandSafetyTopicScope(mqttTopicsV2.commandDrainResponse(siteId, otherGatewayId), "drain-response", drainResponse)).toBe(false);
  });

  it("rejects malformed drain nonce, epoch, version, boot ID, counters, and extra fields", () => {
    for (const invalid of [
      { ...drainRequest, nonce: "bad" }, { ...drainRequest, publishEpoch: 0 },
      { ...drainRequest, publishEpoch: Number.MAX_SAFE_INTEGER + 1 }, { ...drainRequest, extra: true }
    ]) expect(commandDrainRequestSchema.safeParse(invalid).success).toBe(false);
    for (const invalid of [
      { ...drainResponse, gatewayVersion: "" }, { ...drainResponse, bootId: "" },
      { ...drainResponse, queuedCount: -1 }, { ...drainResponse, submittedCount: 1.5 },
      { ...drainResponse, unconfirmedCount: Number.MAX_SAFE_INTEGER + 1 },
      { ...drainResponse, nonce: "bad" }, { ...drainResponse, extra: true }
    ]) expect(commandDrainResponseSchema.safeParse(invalid).success).toBe(false);
  });
});
