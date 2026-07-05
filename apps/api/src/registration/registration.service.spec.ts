import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { MqttService } from "../mqtt/mqtt.service";
import { RegistrationService } from "./registration.service";

describe("RegistrationService", () => {
  const ids = {
    siteId: "00000000-0000-4000-8000-000000000003",
    gatewayId: "00000000-0000-4000-8000-000000000004",
    floorId: "00000000-0000-4000-8000-000000000005",
    userId: "00000000-0000-4000-8000-000000000002",
    organizationId: "00000000-0000-4000-8000-000000000001",
    sessionId: "11111111-1111-4111-8111-111111111111",
    nodeId: "22222222-2222-4222-8222-222222222222",
    meshNodeId: "33333333-3333-4333-8333-333333333333",
    fixtureId: "44444444-4444-4444-8444-444444444444"
  };

  function createModule(prismaOverrides = {}) {
    const prisma: any = {
      site: { findUnique: jest.fn().mockResolvedValue({ id: ids.siteId }) },
      floor: { findFirst: jest.fn().mockResolvedValue({ id: ids.floorId, siteId: ids.siteId }) },
      gateway: { findFirst: jest.fn().mockResolvedValue({ id: ids.gatewayId, siteId: ids.siteId }) },
      provisioningSession: {
        create: jest.fn().mockResolvedValue({
          id: ids.sessionId,
          siteId: ids.siteId,
          floorId: ids.floorId,
          gatewayId: ids.gatewayId,
          requestedBy: ids.userId,
          status: "active",
          startedAt: new Date("2026-07-01T00:00:00.000Z"),
          completedAt: null,
          discoveredNodes: []
        }),
        findUnique: jest.fn(),
        update: jest.fn()
      },
      discoveredMeshNode: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn()
      },
      meshNode: {
        count: jest.fn().mockResolvedValue(256),
        create: jest.fn()
      },
      fixture: {
        create: jest.fn()
      },
      ...prismaOverrides
    };
    prisma.$transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma));
    const mqtt = {
      publishProvisioningScanStart: jest.fn().mockResolvedValue(undefined),
      publishIdentifyDevice: jest.fn().mockResolvedValue(undefined)
    };

    return Test.createTestingModule({
      providers: [
        RegistrationService,
        { provide: PrismaService, useValue: prisma },
        { provide: MqttService, useValue: mqtt }
      ]
    }).compile().then((moduleRef) => ({
      service: moduleRef.get(RegistrationService),
      prisma,
      mqtt
    }));
  }

  it("creates an active registration session and publishes a scan command", async () => {
    const { service, prisma, mqtt } = await createModule();

    const session = await service.createSession({
      siteId: ids.siteId,
      floorId: ids.floorId,
      requestedBy: ids.userId,
      organizationId: ids.organizationId
    });

    expect(session.id).toBe(ids.sessionId);
    expect(prisma.provisioningSession.create).toHaveBeenCalledWith({
      data: {
        siteId: ids.siteId,
        floorId: ids.floorId,
        gatewayId: ids.gatewayId,
        requestedBy: ids.userId,
        status: "active"
      },
      include: { discoveredNodes: true }
    });
    expect(mqtt.publishProvisioningScanStart).toHaveBeenCalledWith({
      sessionId: ids.sessionId,
      siteId: ids.siteId,
      gatewayId: ids.gatewayId,
      floorId: ids.floorId,
      requestedBy: ids.userId,
      requestedAt: "2026-07-01T00:00:00.000Z"
    });
  });

  it("marks a discovered node as identifying and publishes identify command", async () => {
    const node = {
      id: ids.nodeId,
      sessionId: ids.sessionId,
      deviceUuid: "esp32h2-demo-001",
      serialNumber: "LC-B2-001",
      rssi: -54,
      oobCapability: "static-oob",
      firmwareVersion: "mock-node-0.1.0",
      status: "discovered",
      identifyState: "idle",
      session: {
        id: ids.sessionId,
        siteId: ids.siteId,
        floorId: ids.floorId,
        gatewayId: ids.gatewayId,
        requestedBy: ids.userId,
        status: "active",
        site: { organizationId: ids.organizationId }
      }
    };
    const { service, prisma, mqtt } = await createModule({
      discoveredMeshNode: {
        findUnique: jest.fn().mockResolvedValue(node),
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({ ...node, status: "identifying", identifyState: "blinking" })
      }
    });

    const result = await service.identifyNode(ids.sessionId, ids.nodeId, ids.organizationId);

    expect(result.identifyState).toBe("blinking");
    expect(prisma.discoveredMeshNode.update).toHaveBeenCalledWith({
      where: { id: ids.nodeId },
      data: { status: "identifying", identifyState: "blinking" }
    });
    expect(mqtt.publishIdentifyDevice).toHaveBeenCalledWith({
      sessionId: ids.sessionId,
      siteId: ids.siteId,
      gatewayId: ids.gatewayId,
      nodeId: ids.nodeId,
      deviceUuid: "esp32h2-demo-001",
      requestedAt: expect.any(String)
    });
  });

  it("registers a discovered node by creating a mesh node and fixture mapping", async () => {
    const node = {
      id: ids.nodeId,
      sessionId: ids.sessionId,
      deviceUuid: "esp32h2-demo-001",
      serialNumber: "LC-B2-001",
      rssi: -54,
      oobCapability: "static-oob",
      firmwareVersion: "mock-node-0.1.0",
      status: "identifying",
      identifyState: "blinking",
      meshAddress: null,
      session: {
        id: ids.sessionId,
        siteId: ids.siteId,
        floorId: ids.floorId,
        gatewayId: ids.gatewayId,
        requestedBy: ids.userId,
        status: "active",
        site: { organizationId: ids.organizationId }
      }
    };
    const meshNode = { id: ids.meshNodeId, meshAddress: "0x0101", firmwareVersion: "mock-node-0.1.0" };
    const fixture = { id: ids.fixtureId, name: "B2-L13", meshNodeId: ids.meshNodeId };
    const { service, prisma } = await createModule({
      discoveredMeshNode: {
        findUnique: jest.fn().mockResolvedValue(node),
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({ ...node, status: "provisioned", meshAddress: "0x0101" })
      },
      meshNode: {
        count: jest.fn().mockResolvedValue(256),
        create: jest.fn().mockResolvedValue(meshNode)
      },
      fixture: {
        create: jest.fn().mockResolvedValue(fixture)
      }
    });

    const result = await service.registerNode(
      ids.sessionId,
      ids.nodeId,
      {
        fixtureName: "B2-L13",
        x: 420,
        y: 260
      },
      ids.organizationId
    );

    expect(result.fixture.id).toBe(ids.fixtureId);
    expect(prisma.meshNode.create).toHaveBeenCalledWith({
      data: {
        gatewayId: ids.gatewayId,
        deviceUuid: "esp32h2-demo-001",
        serialNumber: "LC-B2-001",
        meshAddress: "0x0101",
        firmwareVersion: "mock-node-0.1.0"
      }
    });
    expect(prisma.fixture.create).toHaveBeenCalledWith({
      data: {
        floorId: ids.floorId,
        meshNodeId: ids.meshNodeId,
        name: "B2-L13",
        ratedWatt: "40.00",
        x: 420,
        y: 260,
        status: "online",
        brightness: 60,
        lastSeenAt: expect.any(Date)
      }
    });
  });

  it("completes an active registration session", async () => {
    const { service, prisma } = await createModule({
      provisioningSession: {
        create: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({
          id: ids.sessionId,
          status: "active",
          site: { organizationId: ids.organizationId }
        }),
        update: jest.fn().mockResolvedValue({ id: ids.sessionId, status: "completed" })
      }
    });

    const result = await service.completeSession(ids.sessionId, ids.organizationId);

    expect(result.status).toBe("completed");
    expect(prisma.provisioningSession.update).toHaveBeenCalledWith({
      where: { id: ids.sessionId },
      data: { status: "completed", completedAt: expect.any(Date) },
      include: { discoveredNodes: true }
    });
  });

  it("does not expose registration sessions across organizations", async () => {
    const { service } = await createModule({
      provisioningSession: {
        create: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({
          id: ids.sessionId,
          status: "active",
          site: { organizationId: "99999999-9999-4999-8999-999999999999" }
        }),
        update: jest.fn()
      }
    });

    await expect(service.getSession(ids.sessionId, ids.organizationId)).rejects.toThrow("registration session not found");
  });
});
