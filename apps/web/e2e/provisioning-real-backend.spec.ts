import { expect, test } from "@playwright/test";
import { countCompletedProvisioningDeviceExchanges } from "./support/real-backend-lab";

const command = {
  commandId: "10000000-0000-4000-8000-000000000005",
  sessionId: "10000000-0000-4000-8000-000000000003",
  siteId: "10000000-0000-4000-8000-000000000001",
  gatewayId: "10000000-0000-4000-8000-000000000002",
  nodeId: "10000000-0000-4000-8000-000000000004",
  deviceUuid: "44464b4c454401010101aabbccddeeff",
  meshAddress: "0x0100",
  requestedAt: "2026-09-12T00:59:00.000Z"
};
const terminal = {
  commandId: command.commandId,
  sessionId: command.sessionId,
  siteId: command.siteId,
  gatewayId: command.gatewayId,
  nodeId: command.nodeId,
  deviceUuid: command.deviceUuid,
  meshAddress: command.meshAddress,
  eventId: "10000000-0000-4000-8000-000000000006",
  sequence: 41,
  occurredAt: "2026-09-12T01:00:00.000Z",
  status: "completed" as const,
  firmwareVersion: "bio-1.0.0"
};
const acknowledgement = {
  commandId: terminal.commandId,
  sessionId: terminal.sessionId,
  siteId: terminal.siteId,
  gatewayId: terminal.gatewayId,
  nodeId: terminal.nodeId,
  deviceUuid: terminal.deviceUuid,
  meshAddress: terminal.meshAddress,
  eventId: terminal.eventId,
  sequence: terminal.sequence,
  ingestedAt: "2026-09-12T01:00:01.000Z"
};

const commandEvidence = {
  direction: "command",
  topic: `sites/${command.siteId}/gateways/${command.gatewayId}/commands/provisioning/provision-device`,
  payload: command
};

test("real-backend provisioning evidence requires an exact V2 terminal and application ACK", () => {
  const v2Terminal = {
    direction: "gateway-event",
    topic: `sites/${command.siteId}/gateways/${command.gatewayId}/events/provisioning/device-terminal`,
    payload: terminal
  };
  const applicationAck = {
    direction: "application-ack",
    topic: `sites/${command.siteId}/gateways/${command.gatewayId}/acks/provisioning/device-terminal-ingested`,
    payload: acknowledgement
  };

  expect(countCompletedProvisioningDeviceExchanges([commandEvidence, v2Terminal])).toBe(0);
  expect(countCompletedProvisioningDeviceExchanges([commandEvidence, v2Terminal, applicationAck])).toBe(1);
  expect(countCompletedProvisioningDeviceExchanges([
    commandEvidence,
    v2Terminal,
    { ...applicationAck, payload: { ...acknowledgement, sequence: 42 } }
  ])).toBe(0);
});

test("a legacy provisioning-completed event cannot establish real-backend completion", () => {
  const legacyTerminal = {
    direction: "gateway-event",
    topic: `sites/${command.siteId}/gateways/${command.gatewayId}/events/provisioning-completed`,
    payload: {
      sessionId: command.sessionId,
      nodeId: command.nodeId,
      deviceUuid: command.deviceUuid,
      meshAddress: command.meshAddress,
      completedAt: terminal.occurredAt
    }
  };

  expect(countCompletedProvisioningDeviceExchanges([
    commandEvidence,
    legacyTerminal,
    {
      direction: "application-ack",
      topic: `sites/${command.siteId}/gateways/${command.gatewayId}/acks/provisioning/device-terminal-ingested`,
      payload: acknowledgement
    }
  ])).toBe(0);
});
