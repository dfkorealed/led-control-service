import { describe, expect, it } from "vitest";
import {
  acceptanceAckV2Schema,
  deviceStatusAckV2Schema,
  fixtureStateV2Schema,
  gatewayDimmingCommandDraftV2Schema,
  gatewayDimmingCommandV2Schema,
  gatewayHeartbeatV2Schema,
  mapHealthFaults,
  mqttTopicsV2,
  statusFromHealth
} from "./gateway-contracts";
import { mqttTopics } from "./mqtt";

const siteId = "00000000-0000-4000-8000-000000000003";
const gatewayId = "00000000-0000-4000-8000-000000000004";
const commandId = "11111111-1111-4111-8111-111111111111";
const dispatchId = "22222222-2222-4222-8222-222222222222";
const fixtureId = "33333333-3333-4333-8333-333333333333";
const eventId = "44444444-4444-4444-8444-444444444444";
const occurredAt = "2026-07-11T00:00:00.000Z";

describe("gateway-scoped MQTT v2 contracts", () => {
  it("builds gateway-scoped command, ack, state, and heartbeat topics", () => {
    expect(mqttTopicsV2.gatewayCommand(siteId, gatewayId, "dimming")).toBe(
      `sites/${siteId}/gateways/${gatewayId}/commands/dimming`
    );
    expect(mqttTopicsV2.acceptanceAck(siteId, gatewayId)).toBe(`sites/${siteId}/gateways/${gatewayId}/acks/acceptance`);
    expect(mqttTopicsV2.deviceStatusAck(siteId, gatewayId)).toBe(`sites/${siteId}/gateways/${gatewayId}/acks/device-status`);
    expect(mqttTopicsV2.fixtureState(siteId, gatewayId)).toBe(`sites/${siteId}/gateways/${gatewayId}/state/fixtures`);
    expect(mqttTopicsV2.heartbeat(siteId, gatewayId)).toBe(`sites/${siteId}/gateways/${gatewayId}/state/heartbeat`);
  });

  it("keeps legacy topics unchanged during migration", () => {
    expect(mqttTopics.dimmingCommand(siteId)).toBe(`sites/${siteId}/commands/dimming`);
    expect(mqttTopics.fixtureState(siteId)).toBe(`sites/${siteId}/events/fixture-state`);
  });

  it("validates a gateway dimming command and its two acknowledgement stages", () => {
    const command = gatewayDimmingCommandV2Schema.parse({
      commandId,
      dispatchId,
      siteId,
      gatewayId,
      idempotencyKey: `${commandId}:${gatewayId}`,
      sequence: 7,
      targetType: "fixture",
      targetId: fixtureId,
      targetFixtureIds: [fixtureId],
      brightness: 70,
      requestedBy: "55555555-5555-4555-8555-555555555555",
      requestedAt: occurredAt,
      expiresAt: "2026-07-11T00:00:10.000Z"
    });
    const acceptance = acceptanceAckV2Schema.parse({
      eventId,
      siteId,
      gatewayId,
      commandId,
      dispatchId,
      idempotencyKey: command.idempotencyKey,
      sequence: command.sequence,
      status: "accepted",
      acceptedAt: occurredAt
    });
    const deviceStatus = deviceStatusAckV2Schema.parse({
      eventId: "66666666-6666-4666-8666-666666666666",
      siteId,
      gatewayId,
      commandId,
      dispatchId,
      idempotencyKey: command.idempotencyKey,
      sequence: command.sequence,
      status: "succeeded",
      occurredAt,
      results: [{ fixtureId, status: "succeeded", brightness: 70, rssi: -58, hopCount: 1 }]
    });

    expect(acceptance.status).toBe("accepted");
    expect(deviceStatus.results[0]).toMatchObject({ fixtureId, brightness: 70 });
  });

  it("requires the publish-relative command expiry used by the gateway", () => {
    const draft = {
      commandId,
      dispatchId,
      siteId,
      gatewayId,
      idempotencyKey: `${commandId}:${gatewayId}`,
      sequence: 7,
      targetType: "fixture" as const,
      targetId: fixtureId,
      targetFixtureIds: [fixtureId],
      brightness: 70,
      requestedBy: "55555555-5555-4555-8555-555555555555",
      requestedAt: occurredAt
    };

    expect(gatewayDimmingCommandDraftV2Schema.parse(draft)).toMatchObject(draft);
    expect(() => gatewayDimmingCommandV2Schema.parse(draft)).toThrow();
    expect(gatewayDimmingCommandV2Schema.parse({ ...draft, expiresAt: "2026-07-11T00:00:10.000Z" }).expiresAt).toBe(
      "2026-07-11T00:00:10.000Z"
    );
  });

  it("requires ordered identity fields for fixture state and heartbeat", () => {
    const state = {
      eventId,
      siteId,
      gatewayId,
      fixtureId,
      sequence: 9,
      occurredAt,
      brightness: 40,
      powerOn: true,
      status: "online",
      rssi: -60,
      hopCount: 2
    };
    const heartbeat = {
      eventId: "77777777-7777-4777-8777-777777777777",
      siteId,
      gatewayId,
      gatewaySerial: "GW-001",
      firmwareVersion: "gateway-0.2.0",
      sequence: 10,
      occurredAt
    };

    expect(fixtureStateV2Schema.parse({ ...state, statusReason: "mesh_publication" }).statusReason).toBe("mesh_publication");
    expect(fixtureStateV2Schema.parse(state).sequence).toBe(9);
    expect(gatewayHeartbeatV2Schema.parse(heartbeat).gatewaySerial).toBe("GW-001");
    expect(() => fixtureStateV2Schema.parse({ ...state, eventId: "", sequence: -1 })).toThrow();
    expect(() => gatewayHeartbeatV2Schema.parse({ ...heartbeat, gatewayId: "other" })).toThrow();
  });

  it("parses and normalizes a current Health snapshot", () => {
    const state = {
      eventId,
      siteId,
      gatewayId,
      fixtureId,
      sequence: 9,
      occurredAt,
      brightness: 40,
      powerOn: true,
      status: "fault",
      health: { faultCodes: [4, 0, 1, 4], observedAt: occurredAt },
      rssi: -60,
      hopCount: 2
    };

    expect(fixtureStateV2Schema.parse(state).health?.faultCodes).toEqual([4, 0, 1, 4]);
    expect(mapHealthFaults([4, 0, 1, 4])).toEqual([1, 4]);
    expect(statusFromHealth(mapHealthFaults([0]))).toBe("online");
    expect(statusFromHealth([1])).toBe("fault");
  });
});
