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
const fixtureId2 = "33333333-3333-4333-8333-333333333334";
const meshControlGroupId = "88888888-8888-4888-8888-888888888888";
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
      deliveryMode: "unicast",
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
      deliveryMode: "unicast" as const,
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

  it("requires a destination address only for mesh group delivery", () => {
    const base = {
      commandId,
      dispatchId,
      siteId,
      gatewayId,
      idempotencyKey: `${commandId}:${gatewayId}`,
      sequence: 7,
      targetType: "floor" as const,
      targetId: "77777777-7777-4777-8777-777777777777",
      targetFixtureIds: [fixtureId],
      brightness: 70,
      requestedBy: "55555555-5555-4555-8555-555555555555",
      requestedAt: occurredAt
    };

    expect(gatewayDimmingCommandDraftV2Schema.parse({
      ...base,
      deliveryMode: "mesh_group",
      destinationAddress: "0xc000",
      meshControlGroupId,
      meshControlGroupVersion: 2
    })).toMatchObject({
      deliveryMode: "mesh_group",
      destinationAddress: "0xc000",
      meshControlGroupId,
      meshControlGroupVersion: 2
    });
    expect(() => gatewayDimmingCommandDraftV2Schema.parse({
      ...base,
      deliveryMode: "mesh_group"
    })).toThrow("destinationAddress is required");
    expect(() => gatewayDimmingCommandDraftV2Schema.parse({
      ...base,
      deliveryMode: "parallel_unicast",
      destinationAddress: "0xc000"
    })).toThrow("destinationAddress is only allowed");
  });

  it("rejects duplicate, oversized, and out-of-range physical fixture/group targets", () => {
    const fixtureCommand = {
      commandId,
      dispatchId,
      siteId,
      gatewayId,
      idempotencyKey: `${commandId}:${gatewayId}`,
      sequence: 7,
      targetType: "fixture" as const,
      targetId: fixtureId,
      targetFixtureIds: [fixtureId],
      deliveryMode: "unicast" as const,
      brightness: 70,
      requestedBy: "55555555-5555-4555-8555-555555555555",
      requestedAt: occurredAt
    };

    expect(() => gatewayDimmingCommandDraftV2Schema.parse({
      ...fixtureCommand,
      targetType: "fixtures",
      targetId: null,
      targetFixtureIds: [fixtureId, fixtureId],
      deliveryMode: "parallel_unicast"
    })).toThrow("targetFixtureIds must be unique");
    expect(() => gatewayDimmingCommandDraftV2Schema.parse({
      ...fixtureCommand,
      targetType: "fixtures",
      targetId: null,
      targetFixtureIds: Array.from({ length: 1_001 }, (_, index) =>
        `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`
      ),
      deliveryMode: "parallel_unicast"
    })).toThrow();
    expect(() => gatewayDimmingCommandDraftV2Schema.parse({
      ...fixtureCommand,
      targetType: "floor",
      targetId: "77777777-7777-4777-8777-777777777777",
      deliveryMode: "mesh_group",
      destinationAddress: "0xbfff",
      meshControlGroupId,
      meshControlGroupVersion: 1
    })).toThrow("destinationAddress must be a BLE Mesh group address");
  });

  it.each([
    ["fixture requires targetId", { targetType: "fixture", targetId: null }],
    ["fixture target matches its only fixture", { targetType: "fixture", targetId: fixtureId2 }],
    ["fixture only allows one fixture", { targetType: "fixture", targetFixtureIds: [fixtureId, fixtureId2] }],
    ["fixture only allows unicast", {
      targetType: "fixture", deliveryMode: "mesh_group", destinationAddress: "0xc000",
      meshControlGroupId, meshControlGroupVersion: 1
    }],
    ["fixtures requires null targetId", { targetType: "fixtures", targetId: fixtureId }],
    ["one fixtures target requires unicast", {
      targetType: "fixtures", targetId: null, deliveryMode: "parallel_unicast"
    }],
    ["multiple fixtures reject unicast", {
      targetType: "fixtures", targetId: null, targetFixtureIds: [fixtureId, fixtureId2]
    }],
    ["floor only allows mesh group", {
      targetType: "floor", targetId: "77777777-7777-4777-8777-777777777777"
    }],
    ["group requires targetId", { targetType: "group", targetId: null }]
  ])("enforces target invariant: %s", (_name, patch) => {
    const base = {
      commandId,
      dispatchId,
      siteId,
      gatewayId,
      idempotencyKey: `${commandId}:${gatewayId}`,
      sequence: 7,
      targetType: "fixture" as const,
      targetId: fixtureId,
      targetFixtureIds: [fixtureId],
      deliveryMode: "unicast" as const,
      brightness: 70,
      requestedBy: "55555555-5555-4555-8555-555555555555",
      requestedAt: occurredAt
    };

    expect(() => gatewayDimmingCommandDraftV2Schema.parse({ ...base, ...patch })).toThrow();
  });

  it("requires complete mesh metadata and forbids it for non-mesh delivery", () => {
    const mesh = {
      commandId,
      dispatchId,
      siteId,
      gatewayId,
      idempotencyKey: `${commandId}:${gatewayId}`,
      sequence: 7,
      targetType: "floor" as const,
      targetId: "77777777-7777-4777-8777-777777777777",
      targetFixtureIds: [fixtureId],
      deliveryMode: "mesh_group" as const,
      destinationAddress: "0xc000",
      meshControlGroupId,
      meshControlGroupVersion: 2,
      brightness: 70,
      requestedBy: "55555555-5555-4555-8555-555555555555",
      requestedAt: occurredAt
    };

    for (const field of ["destinationAddress", "meshControlGroupId", "meshControlGroupVersion"] as const) {
      const invalid = { ...mesh };
      delete invalid[field];
      expect(() => gatewayDimmingCommandDraftV2Schema.parse(invalid)).toThrow(`${field} is required`);
    }
    expect(() => gatewayDimmingCommandDraftV2Schema.parse({ ...mesh, meshControlGroupVersion: 0 })).toThrow();
    expect(() => gatewayDimmingCommandDraftV2Schema.parse({
      ...mesh,
      targetType: "fixture",
      targetId: fixtureId,
      deliveryMode: "unicast"
    })).toThrow("group metadata is only allowed");
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
