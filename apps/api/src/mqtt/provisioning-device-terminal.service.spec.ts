import type { ProvisioningDeviceTerminalV2 } from "@led-control/shared";
import { createHash } from "node:crypto";
import { ProvisioningDeviceTerminalService } from "./provisioning-device-terminal.service";

const SITE_ID = "10000000-0000-4000-8000-000000000001";
const GATEWAY_ID = "10000000-0000-4000-8000-000000000002";
const SESSION_ID = "10000000-0000-4000-8000-000000000003";
const NODE_ID = "10000000-0000-4000-8000-000000000004";
const COMMAND_ID = "10000000-0000-4000-8000-000000000005";
const EVENT_ID = "10000000-0000-4000-8000-000000000006";
const RECEIVED_AT = new Date("2026-09-12T01:00:01.000Z");
const EVENT_TYPE = "provisioning_device_terminal";
const ACK_KEY = `provisioning-device-terminal:${GATEWAY_ID}:${COMMAND_ID}`;
type ProvisionTerminal = Extract<ProvisioningDeviceTerminalV2, { meshAddress: string; status: "completed" }>;

function completed(overrides: Partial<ProvisionTerminal> = {}): ProvisionTerminal {
  return {
    commandId: COMMAND_ID,
    sessionId: SESSION_ID,
    siteId: SITE_ID,
    gatewayId: GATEWAY_ID,
    nodeId: NODE_ID,
    deviceUuid: "44464b4c454401010101aabbccddeeff",
    meshAddress: "0x0100",
    eventId: EVENT_ID,
    sequence: 41,
    occurredAt: "2026-09-12T01:00:00.000Z",
    status: "completed",
    firmwareVersion: "bio-1.0.0",
    rssi: -47,
    hopCount: 1,
    ...overrides
  } as ProvisionTerminal;
}

function commandPayload() {
  const event = completed();
  return {
    commandId: event.commandId,
    sessionId: event.sessionId,
    siteId: event.siteId,
    gatewayId: event.gatewayId,
    nodeId: event.nodeId,
    deviceUuid: event.deviceUuid,
    meshAddress: event.meshAddress,
    requestedAt: "2026-09-12T00:59:00.000Z"
  };
}

function identifyTerminal(overrides: Record<string, unknown> = {}): ProvisioningDeviceTerminalV2 {
  const { meshAddress: _meshAddress, firmwareVersion: _firmwareVersion, rssi: _rssi, hopCount: _hopCount, ...common } = completed();
  return {
    ...common,
    operation: "identify",
    status: "completed",
    restoreConfirmed: true,
    ...overrides
  } as ProvisioningDeviceTerminalV2;
}

function testContext(options: {
  eventById?: Record<string, unknown> | null;
  eventBySequence?: Record<string, unknown> | null;
  storedAck?: Record<string, unknown> | null;
  failDomainWrite?: boolean;
  identify?: boolean;
  latestIdentifyCommandId?: string;
  sessionStatus?: string;
} = {}) {
  const event = completed();
  const node = {
    id: NODE_ID,
    sessionId: SESSION_ID,
    deviceUuid: event.deviceUuid,
    serialNumber: "BIO-001",
    firmwareVersion: "unknown",
    rssi: -70,
    status: options.identify ? "identifying" : "provisioning",
    identifyState: options.identify ? "running" : "blinking",
    meshAddress: options.identify ? null : event.meshAddress,
    pendingFixtureName: "B1-L001",
    pendingFixtureX: 100,
    pendingFixtureY: 200,
    pendingFixtureSize: 20,
    pendingRatedWatt: "40.00"
  };
  const session = {
    id: SESSION_ID,
    siteId: SITE_ID,
    floorId: "10000000-0000-4000-8000-000000000009",
    gatewayId: GATEWAY_ID,
    status: options.sessionStatus ?? "active"
  };
  const outbox = {
    id: COMMAND_ID,
    sessionId: SESSION_ID,
    nodeId: NODE_ID,
    topic: `sites/${SITE_ID}/gateways/${GATEWAY_ID}/commands/provisioning/${options.identify ? "identify-device" : "provision-device"}`,
    payload: options.identify ? {
      operation: "identify", commandId: COMMAND_ID, sessionId: SESSION_ID, siteId: SITE_ID,
      gatewayId: GATEWAY_ID, nodeId: NODE_ID, deviceUuid: event.deviceUuid,
      requestedAt: "2026-09-12T00:59:00.000Z"
    } : commandPayload(),
    createdAt: new Date("2026-09-12T00:59:00.000Z"),
    session,
    node
  };
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: COMMAND_ID }]),
    provisioningDeviceOutbox: {
      findUnique: jest.fn().mockResolvedValue(outbox),
      findFirst: jest.fn().mockResolvedValue({ id: options.latestIdentifyCommandId ?? COMMAND_ID })
    },
    processedGatewayEvent: {
      findUnique: jest.fn().mockResolvedValue(options.eventById ?? null),
      findFirst: jest.fn().mockResolvedValue(options.eventBySequence ?? null),
      create: jest.fn().mockResolvedValue({})
    },
    mqttOutbox: {
      findUnique: jest.fn().mockResolvedValue(options.storedAck ?? null),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "ack-1", ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    },
    meshNode: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "10000000-0000-4000-8000-000000000007" })
    },
    fixture: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async () => {
        if (options.failDomainWrite) throw new Error("fixture write failed");
        return {
          id: NODE_ID,
          createdAt: RECEIVED_AT,
          energyTrackingStartedAt: RECEIVED_AT
        };
      })
    },
    floor: { findUniqueOrThrow: jest.fn().mockResolvedValue({ name: "B1" }) },
    groupFixture: { findMany: jest.fn().mockResolvedValue([]) },
    discoveredMeshNode: {
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(node, data)),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    }
  };
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
  };
  const meshControlGroups = { attachProvisionedNode: jest.fn().mockResolvedValue(undefined) };
  const energyDimensions = { recordFixtureDimensions: jest.fn().mockResolvedValue(undefined) };
  const service = new ProvisioningDeviceTerminalService(
    prisma as never,
    meshControlGroups as never,
    energyDimensions as never
  );
  return { service, prisma, tx, node, event, meshControlGroups };
}

describe("ProvisioningDeviceTerminalService", () => {
  it("confirms pre-provision identify only from a restore-confirmed terminal without mapping writes", async () => {
    const { service, tx, node } = testContext({ identify: true });
    const event = identifyTerminal();

    await service.ingest({ siteId: SITE_ID, gatewayId: GATEWAY_ID }, event, RECEIVED_AT);

    expect(node).toMatchObject({ status: "discovered", identifyState: "confirmed", errorMessage: null });
    expect(tx.meshNode.create).not.toHaveBeenCalled();
    expect(tx.fixture.create).not.toHaveBeenCalled();
    expect(tx.processedGatewayEvent.create).toHaveBeenCalledTimes(1);
    expect(tx.mqttOutbox.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      payload: expect.objectContaining({ operation: "identify", commandId: COMMAND_ID })
    }) });
  });

  it("records an explicit identify failure without mapping or address side effects", async () => {
    const { service, tx, node } = testContext({ identify: true });
    const completedIdentify = identifyTerminal();
    const { restoreConfirmed: _restoreConfirmed, ...identifyEnvelope } = completedIdentify as Extract<
      ProvisioningDeviceTerminalV2,
      { operation: "identify"; status: "completed" }
    >;
    const event: ProvisioningDeviceTerminalV2 = {
      ...identifyEnvelope,
      status: "failed",
      errorCode: "RESTORE_UNCONFIRMED",
      errorMessage: "sensor mode restore was not confirmed"
    };

    await service.ingest({ siteId: SITE_ID, gatewayId: GATEWAY_ID }, event, RECEIVED_AT);

    expect(node).toMatchObject({
      status: "discovered",
      identifyState: "failed",
      errorMessage: "sensor mode restore was not confirmed",
      meshAddress: null
    });
    expect(tx.meshNode.create).not.toHaveBeenCalled();
    expect(tx.fixture.create).not.toHaveBeenCalled();
  });

  it("acknowledges an exact identify terminal replay without applying it twice", async () => {
    const event = identifyTerminal();
    const acknowledgement = {
      operation: "identify",
      commandId: COMMAND_ID,
      sessionId: SESSION_ID,
      siteId: SITE_ID,
      gatewayId: GATEWAY_ID,
      nodeId: NODE_ID,
      deviceUuid: event.deviceUuid,
      eventId: EVENT_ID,
      sequence: 41,
      ingestedAt: "2026-09-12T01:00:00.500Z"
    };
    const ledger = {
      eventId: EVENT_ID,
      gatewayId: GATEWAY_ID,
      sequence: 41n,
      eventType: EVENT_TYPE,
      payloadHash: independentCanonicalHash(event),
      occurredAt: new Date(event.occurredAt)
    };
    const { service, tx } = testContext({
      identify: true,
      eventById: ledger,
      eventBySequence: ledger,
      storedAck: {
        id: "ack-1",
        gatewayId: GATEWAY_ID,
        applicationAckKey: ACK_KEY,
        topic: `sites/${SITE_ID}/gateways/${GATEWAY_ID}/acks/provisioning/device-terminal-ingested`,
        payload: acknowledgement
      }
    });

    await expect(service.ingest({ siteId: SITE_ID, gatewayId: GATEWAY_ID }, event, RECEIVED_AT))
      .resolves.toEqual(acknowledgement);
    expect(tx.discoveredMeshNode.update).not.toHaveBeenCalled();
    expect(tx.processedGatewayEvent.create).not.toHaveBeenCalled();
    expect(tx.mqttOutbox.create).not.toHaveBeenCalled();
    expect(tx.mqttOutbox.updateMany).toHaveBeenCalledTimes(1);
  });

  it("does not let a late older identify terminal complete a newer identify operation", async () => {
    const { service, tx, node } = testContext({
      identify: true,
      latestIdentifyCommandId: "10000000-0000-4000-8000-000000000099"
    });

    await service.ingest(
      { siteId: SITE_ID, gatewayId: GATEWAY_ID },
      identifyTerminal(),
      RECEIVED_AT
    );

    expect(node).toMatchObject({ status: "identifying", identifyState: "running" });
    expect(tx.discoveredMeshNode.update).not.toHaveBeenCalled();
    expect(tx.processedGatewayEvent.create).toHaveBeenCalledTimes(1);
    expect(tx.mqttOutbox.create).toHaveBeenCalledTimes(1);
  });
  it("atomically completes the stored command and records the fixed ledger identity and durable ACK", async () => {
    const { service, tx, node, event, meshControlGroups } = testContext();

    await expect(service.ingest({ siteId: SITE_ID, gatewayId: GATEWAY_ID }, event, RECEIVED_AT))
      .resolves.toEqual({
        commandId: COMMAND_ID,
        sessionId: SESSION_ID,
        siteId: SITE_ID,
        gatewayId: GATEWAY_ID,
        nodeId: NODE_ID,
        deviceUuid: event.deviceUuid,
        meshAddress: "0x0100",
        eventId: EVENT_ID,
        sequence: 41,
        ingestedAt: RECEIVED_AT.toISOString()
      });

    const lockSql = tx.$queryRaw.mock.calls.map(([sql]: any[]) => (
      Array.isArray(sql) ? sql.join(" ") : sql.strings.join(" ")
    ));
    expect(lockSql).toEqual([
      expect.stringContaining('FROM "Floor"'),
      expect.stringContaining('FROM "Gateway"'),
      expect.stringContaining('FROM "ProvisioningSession"'),
      expect.stringContaining('FROM "DiscoveredMeshNode"'),
      expect.stringContaining('FROM "ProvisioningDeviceOutbox"')
    ]);
    expect(lockSql.every((sql: string) => sql.includes("FOR UPDATE"))).toBe(true);
    expect(node.status).toBe("provisioned");
    expect(meshControlGroups.attachProvisionedNode).toHaveBeenCalledTimes(1);
    expect(tx.processedGatewayEvent.create).toHaveBeenCalledWith({ data: {
      eventId: EVENT_ID,
      gatewayId: GATEWAY_ID,
      sequence: 41n,
      eventType: EVENT_TYPE,
      payloadHash: independentCanonicalHash(event),
      occurredAt: new Date(event.occurredAt),
      receivedAt: RECEIVED_AT
    } });
    expect(tx.mqttOutbox.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      gatewayId: GATEWAY_ID,
      applicationAckKey: ACK_KEY,
      revision: null,
      topic: `sites/${SITE_ID}/gateways/${GATEWAY_ID}/acks/provisioning/device-terminal-ingested`,
      payload: expect.objectContaining({ eventId: EVENT_ID, sequence: 41 })
    }) });
  });

  it("converges a failed terminal to reconcile_required and still commits its ledger and ACK", async () => {
    const { service, tx, node } = testContext();
    const base = completed();
    const event: ProvisioningDeviceTerminalV2 = {
      commandId: base.commandId,
      sessionId: base.sessionId,
      siteId: base.siteId,
      gatewayId: base.gatewayId,
      nodeId: base.nodeId,
      deviceUuid: base.deviceUuid,
      meshAddress: base.meshAddress,
      eventId: base.eventId,
      sequence: base.sequence,
      occurredAt: base.occurredAt,
      status: "failed",
      errorCode: "DEVICE_TIMEOUT",
      errorMessage: "device did not answer"
    };

    await service.ingest({ siteId: SITE_ID, gatewayId: GATEWAY_ID }, event, RECEIVED_AT);

    expect(node).toMatchObject({ status: "reconcile_required", errorMessage: "device did not answer" });
    expect(tx.meshNode.create).not.toHaveBeenCalled();
    expect(tx.processedGatewayEvent.create).toHaveBeenCalledTimes(1);
    expect(tx.mqttOutbox.create).toHaveBeenCalledTimes(1);
  });

  it("revives the immutable ACK for an exact duplicate without applying the domain transition twice", async () => {
    const event = completed();
    const acknowledgement = {
      commandId: COMMAND_ID,
      sessionId: SESSION_ID,
      siteId: SITE_ID,
      gatewayId: GATEWAY_ID,
      nodeId: NODE_ID,
      deviceUuid: event.deviceUuid,
      meshAddress: event.meshAddress,
      eventId: EVENT_ID,
      sequence: 41,
      ingestedAt: "2026-09-12T01:00:00.500Z"
    };
    const ledger = {
      eventId: EVENT_ID,
      gatewayId: GATEWAY_ID,
      sequence: 41n,
      eventType: EVENT_TYPE,
      payloadHash: independentCanonicalHash(event),
      occurredAt: new Date(event.occurredAt)
    };
    const { service, tx } = testContext({
      eventById: ledger,
      eventBySequence: ledger,
      storedAck: {
        id: "ack-1",
        gatewayId: GATEWAY_ID,
        applicationAckKey: ACK_KEY,
        topic: `sites/${SITE_ID}/gateways/${GATEWAY_ID}/acks/provisioning/device-terminal-ingested`,
        payload: acknowledgement
      }
    });

    await expect(service.ingest({ siteId: SITE_ID, gatewayId: GATEWAY_ID }, event, RECEIVED_AT))
      .resolves.toEqual(acknowledgement);
    expect(tx.meshNode.create).not.toHaveBeenCalled();
    expect(tx.fixture.create).not.toHaveBeenCalled();
    expect(tx.processedGatewayEvent.create).not.toHaveBeenCalled();
    expect(tx.mqttOutbox.create).not.toHaveBeenCalled();
    expect(tx.mqttOutbox.updateMany).toHaveBeenCalledTimes(1);
  });

  it("replays the durable provision ACK after the node was registered and its mutable address changed", async () => {
    const event = completed();
    const acknowledgement = {
      commandId: COMMAND_ID,
      sessionId: SESSION_ID,
      siteId: SITE_ID,
      gatewayId: GATEWAY_ID,
      nodeId: NODE_ID,
      deviceUuid: event.deviceUuid,
      meshAddress: event.meshAddress,
      eventId: EVENT_ID,
      sequence: 41,
      ingestedAt: "2026-09-12T01:00:00.500Z"
    };
    const ledger = {
      eventId: EVENT_ID,
      gatewayId: GATEWAY_ID,
      sequence: 41n,
      eventType: EVENT_TYPE,
      payloadHash: independentCanonicalHash(event),
      occurredAt: new Date(event.occurredAt)
    };
    const { service, tx, node } = testContext({
      eventById: ledger,
      eventBySequence: ledger,
      storedAck: {
        id: "ack-1",
        gatewayId: GATEWAY_ID,
        applicationAckKey: ACK_KEY,
        topic: `sites/${SITE_ID}/gateways/${GATEWAY_ID}/acks/provisioning/device-terminal-ingested`,
        payload: acknowledgement
      }
    });
    Object.assign(node, { status: "provisioned", meshAddress: "0x0200" });

    await expect(service.ingest({ siteId: SITE_ID, gatewayId: GATEWAY_ID }, event, RECEIVED_AT))
      .resolves.toEqual(acknowledgement);
    expect(tx.discoveredMeshNode.update).not.toHaveBeenCalled();
    expect(tx.meshNode.create).not.toHaveBeenCalled();
    expect(tx.fixture.create).not.toHaveBeenCalled();
    expect(tx.mqttOutbox.updateMany).toHaveBeenCalledTimes(1);
  });

  it("records and acknowledges a late first-seen terminal for a retired session without reviving domain state", async () => {
    const { service, tx, node, event } = testContext({ sessionStatus: "cancelled" });

    await expect(service.ingest({ siteId: SITE_ID, gatewayId: GATEWAY_ID }, event, RECEIVED_AT))
      .resolves.toEqual(expect.objectContaining({ commandId: COMMAND_ID, eventId: EVENT_ID }));

    expect(node.status).toBe("provisioning");
    expect(tx.discoveredMeshNode.update).not.toHaveBeenCalled();
    expect(tx.meshNode.create).not.toHaveBeenCalled();
    expect(tx.fixture.create).not.toHaveBeenCalled();
    expect(tx.processedGatewayEvent.create).toHaveBeenCalledTimes(1);
    expect(tx.mqttOutbox.create).toHaveBeenCalledTimes(1);
  });

  it("rejects a first-time terminal whose operation does not match the stored command on a registered node", async () => {
    const { service, tx, node } = testContext();
    Object.assign(node, { status: "provisioned", meshAddress: "0x0200" });

    await expect(service.ingest(
      { siteId: SITE_ID, gatewayId: GATEWAY_ID },
      identifyTerminal(),
      RECEIVED_AT
    )).rejects.toThrow("stored command identity conflict");
    expect(tx.processedGatewayEvent.create).not.toHaveBeenCalled();
    expect(tx.mqttOutbox.create).not.toHaveBeenCalled();
  });

  it.each([
    ["topic tenant", { scope: { siteId: "10000000-0000-4000-8000-000000000099", gatewayId: GATEWAY_ID } }],
    ["stored command identity", { event: { meshAddress: "0x0101" } }],
    ["event hash", { eventById: { eventId: EVENT_ID, gatewayId: GATEWAY_ID, sequence: 41n, eventType: EVENT_TYPE,
      payloadHash: `sha256:${"f".repeat(64)}`, occurredAt: new Date("2026-09-12T01:00:00.000Z") } }],
    ["fixed event type", { eventBySequence: { eventId: EVENT_ID, gatewayId: GATEWAY_ID, sequence: 41n,
      eventType: "provisioning_completed", payloadHash: independentCanonicalHash(completed()),
      occurredAt: new Date("2026-09-12T01:00:00.000Z") } }],
    ["sequence", { eventBySequence: { eventId: "10000000-0000-4000-8000-000000000099", gatewayId: GATEWAY_ID,
      sequence: 41n, eventType: EVENT_TYPE, payloadHash: independentCanonicalHash(completed()),
      occurredAt: new Date("2026-09-12T01:00:00.000Z") } }]
  ])("rejects a %s conflict without domain, ledger, or ACK writes", async (_case, setup: any) => {
    const { service, tx } = testContext({ eventById: setup.eventById, eventBySequence: setup.eventBySequence });
    const event = completed(setup.event);
    const scope = setup.scope ?? { siteId: SITE_ID, gatewayId: GATEWAY_ID };

    await expect(service.ingest(scope, event, RECEIVED_AT)).rejects.toThrow(/rejected|conflict/);
    expect(tx.meshNode.create).not.toHaveBeenCalled();
    expect(tx.fixture.create).not.toHaveBeenCalled();
    expect(tx.discoveredMeshNode.update).not.toHaveBeenCalled();
    expect(tx.processedGatewayEvent.create).not.toHaveBeenCalled();
    expect(tx.mqttOutbox.create).not.toHaveBeenCalled();
  });

  it("rolls back ledger and ACK when the completed domain transition fails", async () => {
    const { service, prisma, tx, event } = testContext({ failDomainWrite: true });

    await expect(service.ingest({ siteId: SITE_ID, gatewayId: GATEWAY_ID }, event, RECEIVED_AT))
      .rejects.toThrow("fixture write failed");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.processedGatewayEvent.create).not.toHaveBeenCalled();
    expect(tx.mqttOutbox.create).not.toHaveBeenCalled();
  });
});

function independentCanonicalHash(value: unknown) {
  return `sha256:${createHash("sha256").update(JSON.stringify(sortObject(value))).digest("hex")}`;
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, sortObject(child)]));
}
