import type { ProvisioningDeviceTerminalV2 } from "@led-control/shared";
import { PrismaService } from "../prisma/prisma.service";
import { ProvisioningDeviceTerminalService } from "./provisioning-device-terminal.service";

const databaseUrl = process.env.PROVISIONING_DEVICE_TERMINAL_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("provisioning device terminal PostgreSQL transaction", () => {
  const ids = {
    organizationId: "31000000-0000-4000-8000-000000000001",
    userId: "31000000-0000-4000-8000-000000000002",
    siteId: "31000000-0000-4000-8000-000000000003",
    floorId: "31000000-0000-4000-8000-000000000004",
    gatewayId: "31000000-0000-4000-8000-000000000005",
    sessionId: "31000000-0000-4000-8000-000000000006",
    nodeId: "31000000-0000-4000-8000-000000000007",
    commandId: "31000000-0000-4000-8000-000000000008",
    eventId: "31000000-0000-4000-8000-000000000009"
  };
  let prisma: PrismaService;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.organization.upsert({
      where: { id: ids.organizationId },
      create: { id: ids.organizationId, name: "Provisioning terminal integration", type: "customer" },
      update: {}
    });
    await prisma.user.upsert({
      where: { id: ids.userId },
      create: {
        id: ids.userId,
        organizationId: ids.organizationId,
        loginId: "provisioning-terminal-integration",
        name: "Provisioning terminal integration",
        passwordHash: "not-used",
        role: "admin"
      },
      update: {}
    });
    await prisma.site.upsert({
      where: { id: ids.siteId },
      create: { id: ids.siteId, organizationId: ids.organizationId, name: "Provisioning terminal site" },
      update: {}
    });
    await prisma.floor.upsert({
      where: { id: ids.floorId },
      create: { id: ids.floorId, siteId: ids.siteId, name: "B1", level: -1 },
      update: {}
    });
    await prisma.gateway.upsert({
      where: { id: ids.gatewayId },
      create: {
        id: ids.gatewayId,
        siteId: ids.siteId,
        name: "Provisioning terminal gateway",
        serialNumber: "PROVISIONING-TERMINAL-GW",
        firmwareVersion: "integration"
      },
      update: {}
    });
  });

  beforeEach(async () => {
    await prisma.mqttOutbox.deleteMany({ where: { gatewayId: ids.gatewayId } });
    await prisma.processedGatewayEvent.deleteMany({ where: { gatewayId: ids.gatewayId } });
    await prisma.fixture.deleteMany({ where: { id: ids.nodeId } });
    await prisma.meshNode.deleteMany({ where: { deviceUuid: "bio-integration-device" } });
    await prisma.provisioningDeviceOutbox.deleteMany({ where: { id: ids.commandId } });
    await prisma.discoveredMeshNode.deleteMany({ where: { id: ids.nodeId } });
    await prisma.provisioningSession.deleteMany({ where: { id: ids.sessionId } });
    await prisma.provisioningSession.create({
      data: {
        id: ids.sessionId,
        siteId: ids.siteId,
        floorId: ids.floorId,
        gatewayId: ids.gatewayId,
        requestedBy: ids.userId,
        scanStatus: "completed"
      }
    });
    await prisma.discoveredMeshNode.create({
      data: {
        id: ids.nodeId,
        sessionId: ids.sessionId,
        deviceUuid: "bio-integration-device",
        serialNumber: "BIO-INTEGRATION-001",
        rssi: -60,
        oobCapability: "none",
        firmwareVersion: "unknown",
        status: "provisioning",
        meshAddress: "0x0100",
        pendingFixtureName: "B1-L001",
        pendingFixtureX: 100,
        pendingFixtureY: 200,
        pendingFixtureSize: 20,
        pendingRatedWatt: "40.00"
      }
    });
    await prisma.provisioningDeviceOutbox.create({
      data: {
        id: ids.commandId,
        sessionId: ids.sessionId,
        nodeId: ids.nodeId,
        topic: `sites/${ids.siteId}/gateways/${ids.gatewayId}/commands/provisioning/provision-device`,
        payload: command()
      }
    });
  });

  afterAll(async () => {
    await prisma.site.deleteMany({ where: { id: ids.siteId } });
    await prisma.user.deleteMany({ where: { id: ids.userId } });
    await prisma.organization.deleteMany({ where: { id: ids.organizationId } });
    await prisma.$disconnect();
  });

  it("commits failure, ledger and ACK once, rejects alteration, and rolls back a failed completion", async () => {
    const service = new ProvisioningDeviceTerminalService(
      prisma,
      { attachProvisionedNode: jest.fn().mockResolvedValue(undefined) } as never
    );
    const event = failedTerminal();
    const scope = { siteId: ids.siteId, gatewayId: ids.gatewayId };
    const firstAck = await service.ingest(scope, event, new Date("2026-09-12T01:00:01.000Z"));
    await expect(service.ingest(scope, event, new Date("2026-09-12T01:00:02.000Z"))).resolves.toEqual(firstAck);

    expect(await prisma.discoveredMeshNode.findUniqueOrThrow({ where: { id: ids.nodeId } }))
      .toMatchObject({ status: "reconcile_required", errorMessage: "device did not answer" });
    expect(await prisma.processedGatewayEvent.count({ where: { gatewayId: ids.gatewayId } })).toBe(1);
    expect(await prisma.mqttOutbox.count({
      where: { applicationAckKey: `provisioning-device-terminal:${ids.gatewayId}:${ids.commandId}` }
    })).toBe(1);

    await expect(service.ingest(scope, { ...event, errorMessage: "altered failure" }, new Date()))
      .rejects.toThrow("conflict");
    expect(await prisma.processedGatewayEvent.count({ where: { gatewayId: ids.gatewayId } })).toBe(1);

    await prisma.mqttOutbox.deleteMany({ where: { gatewayId: ids.gatewayId } });
    await prisma.processedGatewayEvent.deleteMany({ where: { gatewayId: ids.gatewayId } });
    await prisma.discoveredMeshNode.update({
      where: { id: ids.nodeId },
      data: { status: "provisioning", errorMessage: null }
    });
    const rollbackService = new ProvisioningDeviceTerminalService(
      prisma,
      { attachProvisionedNode: jest.fn().mockRejectedValue(new Error("group attach failed")) } as never
    );
    await expect(rollbackService.ingest(scope, completedTerminal(), new Date("2026-09-12T01:00:03.000Z")))
      .rejects.toThrow("group attach failed");

    expect(await prisma.meshNode.count({ where: { deviceUuid: "bio-integration-device" } })).toBe(0);
    expect(await prisma.fixture.count({ where: { id: ids.nodeId } })).toBe(0);
    expect(await prisma.processedGatewayEvent.count({ where: { gatewayId: ids.gatewayId } })).toBe(0);
    expect(await prisma.mqttOutbox.count({ where: { gatewayId: ids.gatewayId } })).toBe(0);
    expect(await prisma.discoveredMeshNode.findUniqueOrThrow({ where: { id: ids.nodeId } }))
      .toMatchObject({ status: "provisioning", errorMessage: null });
  });

  function command() {
    return {
      commandId: ids.commandId,
      sessionId: ids.sessionId,
      siteId: ids.siteId,
      gatewayId: ids.gatewayId,
      nodeId: ids.nodeId,
      deviceUuid: "bio-integration-device",
      meshAddress: "0x0100",
      requestedAt: "2026-09-12T00:59:00.000Z"
    };
  }

  function failedTerminal(): Extract<ProvisioningDeviceTerminalV2, { status: "failed" }> {
    const { requestedAt: _requestedAt, ...identity } = command();
    return {
      ...identity,
      eventId: ids.eventId,
      sequence: 41,
      occurredAt: "2026-09-12T01:00:00.000Z",
      status: "failed",
      errorCode: "DEVICE_TIMEOUT",
      errorMessage: "device did not answer"
    };
  }

  function completedTerminal(): Extract<ProvisioningDeviceTerminalV2, { status: "completed" }> {
    const { requestedAt: _requestedAt, ...identity } = command();
    return {
      ...identity,
      eventId: ids.eventId,
      sequence: 41,
      occurredAt: "2026-09-12T01:00:00.000Z",
      status: "completed",
      firmwareVersion: "bio-1.0.0"
    };
  }
});
