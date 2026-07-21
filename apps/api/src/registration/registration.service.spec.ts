import { Test } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
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
  const operator: AuthenticatedUser = {
    id: "00000000-0000-4000-8000-000000000002", organizationId: "provider-org", organizationType: "service_provider",
    email: "operator@example.com", name: "Operator", role: "operator", status: "active"
  };
  const admin: AuthenticatedUser = { ...operator, organizationId: ids.organizationId, organizationType: "customer", role: "admin" };

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
      publishIdentifyDevice: jest.fn().mockResolvedValue(undefined),
      publishProvisionDevice: jest.fn().mockResolvedValue(undefined)
    };
    const siteAccess = { assert: jest.fn().mockResolvedValue({ id: ids.siteId }) };

    return Test.createTestingModule({
      providers: [
        RegistrationService,
        { provide: PrismaService, useValue: prisma },
        { provide: MqttService, useValue: mqtt },
        { provide: SiteAccessService, useValue: siteAccess }
      ]
    }).compile().then((moduleRef) => ({
      service: moduleRef.get(RegistrationService),
      prisma,
      mqtt,
      siteAccess
    }));
  }

  it("rejects a customer admin from starting provisioning", async () => {
    const { service } = await createModule();

    await expect((service as any).createSession(admin, { siteId: ids.siteId, floorId: ids.floorId })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("creates an active registration session and publishes a scan command", async () => {
    const { service, prisma, mqtt } = await createModule();

    const session = await service.createSession(operator, {
      siteId: ids.siteId,
      floorId: ids.floorId
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

    const result = await service.identifyNode(operator, ids.sessionId, ids.nodeId);

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

  it("starts provisioning for a discovered node and publishes a provision command", async () => {
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
    const provisioningNode = { ...node, status: "provisioning", meshAddress: "0x0101" };
    const { service, prisma, mqtt } = await createModule({
      discoveredMeshNode: {
        findUnique: jest.fn().mockResolvedValue(node),
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue(provisioningNode)
      },
      meshNode: {
        count: jest.fn().mockResolvedValue(256),
        create: jest.fn()
      },
      fixture: {
        create: jest.fn()
      }
    });

    const result = await service.registerNode(
      operator,
      ids.sessionId,
      ids.nodeId,
      {
        fixtureName: "B2-L13",
        x: 420,
        y: 260
      }
    );

    expect(result).toEqual({ fixture: null, discoveredNode: provisioningNode });
    expect(prisma.discoveredMeshNode.update).toHaveBeenCalledWith({
      where: { id: ids.nodeId },
      data: {
        status: "provisioning",
        meshAddress: "0x0101",
        pendingFixtureName: "B2-L13",
        pendingFixtureX: 420,
        pendingFixtureY: 260,
        pendingRatedWatt: "40.00",
        errorMessage: null
      }
    });
    expect(prisma.meshNode.create).not.toHaveBeenCalled();
    expect(prisma.fixture.create).not.toHaveBeenCalled();
    expect(mqtt.publishProvisionDevice).toHaveBeenCalledWith({
      sessionId: ids.sessionId,
      siteId: ids.siteId,
      gatewayId: ids.gatewayId,
      nodeId: ids.nodeId,
      deviceUuid: "esp32h2-demo-001",
      meshAddress: "0x0101",
      requestedAt: expect.any(String)
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

    const result = await service.completeSession(operator, ids.sessionId);

    expect(result.status).toBe("completed");
    expect(prisma.provisioningSession.update).toHaveBeenCalledWith({
      where: { id: ids.sessionId },
      data: { status: "completed", completedAt: expect.any(Date) },
      include: { discoveredNodes: true }
    });
  });

  it("does not expose registration sessions across organizations", async () => {
    const { service, siteAccess } = await createModule({
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
    siteAccess.assert.mockRejectedValue(new NotFoundException("site not found"));

    await expect(service.getSession(operator, ids.sessionId)).rejects.toBeInstanceOf(NotFoundException);
  });
});
