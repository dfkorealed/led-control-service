import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException, HttpException, NotFoundException } from "@nestjs/common";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { MqttService } from "../mqtt/mqtt.service";
import { MeshControlGroupService } from "../mesh-control-groups/mesh-control-group.service";
import { RegistrationAllocationService } from "./registration-allocation.service";
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
    loginId: "operator_01", name: "Operator", role: "operator", status: "active"
  };
  const admin: AuthenticatedUser = { ...operator, organizationId: ids.organizationId, organizationType: "customer", loginId: "fixture_user", role: "admin" };

  function createModule(prismaOverrides = {}, mqttOverrides = {}, meshGroupOverrides = {}) {
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
          scanStatus: "pending",
          scanCorrelationId: "99999999-9999-4999-8999-999999999999",
          scanAttempt: 1,
          scanStartedAt: null,
          startedAt: new Date("2026-07-01T00:00:00.000Z"),
          completedAt: null,
          discoveredNodes: []
        }),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      provisioningScanOutbox: { create: jest.fn() },
      discoveredMeshNode: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      meshNode: {
        count: jest.fn().mockResolvedValue(256),
        create: jest.fn()
      },
      fixture: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn()
      },
      ...prismaOverrides
    };
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    prisma.$transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma));
    const mqtt = {
      publishProvisioningScanStart: jest.fn().mockResolvedValue(undefined),
      publishIdentifyDevice: jest.fn().mockResolvedValue(undefined),
      publishProvisionDevice: jest.fn().mockResolvedValue(undefined),
      ...mqttOverrides
    };
    const meshGroups = {
      ensureFloorGroup: jest.fn().mockResolvedValue({
        id: "mesh-group-1",
        gatewayId: ids.gatewayId,
        targetType: "floor",
        targetId: ids.floorId,
        groupAddress: "0xc000",
        status: "configuring",
        configurationVersion: 1
      }),
      ...meshGroupOverrides
    };
    const siteAccess = { assert: jest.fn().mockResolvedValue({ id: ids.siteId }) };
    const allocation = {
      reserveFixtureNumbers: jest.fn().mockResolvedValue([1]),
      reserveMeshAddresses: jest.fn().mockResolvedValue(["0x0100"])
    };

    return Test.createTestingModule({
      providers: [
        RegistrationService,
        { provide: PrismaService, useValue: prisma },
        { provide: MqttService, useValue: mqtt },
        { provide: MeshControlGroupService, useValue: meshGroups },
        { provide: SiteAccessService, useValue: siteAccess },
        { provide: RegistrationAllocationService, useValue: allocation }
      ]
    }).compile().then((moduleRef) => ({
      service: moduleRef.get(RegistrationService),
      prisma,
      mqtt,
      meshGroups,
      siteAccess,
      allocation
    }));
  }

  it("atomically reserves valid batch nodes and returns node-level validation failures", async () => {
    const secondNodeId = "55555555-5555-4555-8555-555555555555";
    const session = {
      id: ids.sessionId,
      siteId: ids.siteId,
      floorId: ids.floorId,
      gatewayId: ids.gatewayId,
      status: "active",
      floor: { id: ids.floorId, name: "B2", floorPlan: { width: 1200, height: 800 } }
    };
    const node = {
      id: ids.nodeId,
      sessionId: ids.sessionId,
      deviceUuid: "esp32h2-demo-001",
      status: "discovered",
      meshAddress: null
    };
    const { service, prisma, mqtt, allocation } = await createModule({
      provisioningSession: {
        create: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(session),
        update: jest.fn()
      },
      discoveredMeshNode: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([node]),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...node, ...data }))
      },
      fixture: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn() }
    });

    const result = await service.registerBatch(admin, ids.sessionId, {
      mode: "batch",
      defaults: { namePrefix: "B2-L", startNumber: 1, digits: 3, ratedWatt: "40.00", size: 20 },
      nodes: [
        { nodeId: ids.nodeId, placement: { mode: "auto" } },
        { nodeId: secondNodeId, placement: { mode: "auto" } }
      ]
    });

    expect(result.items).toEqual([
      expect.objectContaining({ nodeId: ids.nodeId, fixtureName: "B2-L001", status: "accepted" }),
      { nodeId: secondNodeId, status: "validation_failed", error: "discovered node not found" }
    ]);
    expect(allocation.reserveFixtureNumbers).toHaveBeenCalledWith(prisma, ids.floorId, 1, 1);
    expect(allocation.reserveMeshAddresses).toHaveBeenCalledWith(prisma, ids.gatewayId, 1);
    expect(prisma.discoveredMeshNode.update).toHaveBeenCalledWith({
      where: { id: ids.nodeId },
      data: expect.objectContaining({
        status: "provisioning",
        meshAddress: "0x0100",
        pendingFixtureName: "B2-L001",
        pendingRatedWatt: "40.00",
        pendingFixtureSize: 20,
        errorMessage: null
      })
    });
    expect(mqtt.publishProvisionDevice).toHaveBeenCalledTimes(1);
  });

  it("ensures the floor mesh group before publishing provisioning commands", async () => {
    const session = {
      id: ids.sessionId,
      siteId: ids.siteId,
      floorId: ids.floorId,
      gatewayId: ids.gatewayId,
      status: "active",
      floor: { id: ids.floorId, name: "B2", floorPlan: { width: 1200, height: 800 } }
    };
    const node = {
      id: ids.nodeId,
      sessionId: ids.sessionId,
      deviceUuid: "esp32h2-demo-001",
      status: "discovered",
      meshAddress: null
    };
    const { service, prisma, mqtt, meshGroups } = await createModule({
      provisioningSession: {
        create: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(session),
        update: jest.fn()
      },
      discoveredMeshNode: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([node]),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...node, ...data }))
      },
      fixture: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn() }
    });

    await service.registerBatch(admin, ids.sessionId, {
      mode: "batch",
      defaults: { namePrefix: "B2-L", startNumber: 1, digits: 3, ratedWatt: "40.00", size: 20 },
      nodes: [{ nodeId: ids.nodeId, placement: { mode: "auto" } }]
    });

    expect(meshGroups.ensureFloorGroup).toHaveBeenCalledWith(prisma, ids.gatewayId, ids.floorId);
    expect(meshGroups.ensureFloorGroup.mock.invocationCallOrder[0]).toBeLessThan(
      mqtt.publishProvisionDevice.mock.invocationCallOrder[0]
    );
  });

  it("does not publish provisioning when floor mesh group allocation fails", async () => {
    const session = {
      id: ids.sessionId,
      siteId: ids.siteId,
      floorId: ids.floorId,
      gatewayId: ids.gatewayId,
      status: "active",
      floor: { id: ids.floorId, name: "B2", floorPlan: { width: 1200, height: 800 } }
    };
    const node = {
      id: ids.nodeId,
      sessionId: ids.sessionId,
      deviceUuid: "esp32h2-demo-001",
      status: "discovered",
      meshAddress: null
    };
    const { service, prisma, mqtt, meshGroups } = await createModule({
      provisioningSession: {
        create: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(session),
        update: jest.fn()
      },
      discoveredMeshNode: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([node]),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...node, ...data }))
      },
      fixture: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn() }
    }, {}, {
      ensureFloorGroup: jest.fn().mockRejectedValue(new BadRequestException("mesh group address range exhausted"))
    });

    await expect(service.registerBatch(admin, ids.sessionId, {
      mode: "batch",
      defaults: { namePrefix: "B2-L", startNumber: 1, digits: 3, ratedWatt: "40.00", size: 20 },
      nodes: [{ nodeId: ids.nodeId, placement: { mode: "auto" } }]
    })).rejects.toThrow("mesh group address range exhausted");

    expect(meshGroups.ensureFloorGroup).toHaveBeenCalledWith(prisma, ids.gatewayId, ids.floorId);
    expect(prisma.discoveredMeshNode.update).not.toHaveBeenCalled();
    expect(mqtt.publishProvisionDevice).not.toHaveBeenCalled();
  });

  it("keeps an accepted node in reconciliation when MQTT publish outcome is unknown", async () => {
    const session = {
      id: ids.sessionId,
      siteId: ids.siteId,
      floorId: ids.floorId,
      gatewayId: ids.gatewayId,
      status: "active",
      floor: { id: ids.floorId, name: "B2", floorPlan: null }
    };
    const node = {
      id: ids.nodeId,
      sessionId: ids.sessionId,
      deviceUuid: "esp32h2-demo-001",
      status: "discovered",
      meshAddress: null
    };
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const { service } = await createModule({
      provisioningSession: {
        create: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(session),
        update: jest.fn()
      },
      discoveredMeshNode: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([node]),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...node, ...data })),
        updateMany
      },
      fixture: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn() }
    }, {
      publishProvisionDevice: jest.fn().mockRejectedValue(new Error("MQTT connection closed"))
    });

    await expect(service.registerBatch(admin, ids.sessionId, {
      mode: "batch",
      defaults: { namePrefix: "B2-L", startNumber: 1, digits: 3, ratedWatt: "40.00", size: 20 },
      nodes: [{ nodeId: ids.nodeId, placement: { mode: "auto" } }]
    })).resolves.toEqual({
      items: [{ nodeId: ids.nodeId, fixtureName: "B2-L001", status: "accepted" }]
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: ids.nodeId, sessionId: ids.sessionId, status: "provisioning" },
      data: { status: "reconcile_required", errorMessage: "MQTT connection closed" }
    });
  });

  it("rejects a customer admin from starting provisioning", async () => {
    const { service } = await createModule();

    await expect((service as any).createSession(admin, {
      siteId: ids.siteId,
      floorId: ids.floorId,
      gatewayId: ids.gatewayId
    })).resolves.toMatchObject({ id: ids.sessionId });
    await expect((service as any).createSession(operator, {
      siteId: ids.siteId,
      floorId: ids.floorId,
      gatewayId: ids.gatewayId
    })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects a gateway selected from another site instead of auto-selecting a local gateway", async () => {
    const { service, prisma } = await createModule({
      gateway: { findFirst: jest.fn().mockResolvedValue(null) }
    });

    await expect(service.createSession(admin, {
      siteId: ids.siteId,
      floorId: ids.floorId,
      gatewayId: "99999999-9999-4999-8999-999999999999"
    })).rejects.toEqual(new BadRequestException("gatewayId must reference an online gateway in the selected site"));

    expect(prisma.provisioningSession.create).not.toHaveBeenCalled();
    expect(prisma.gateway.findFirst).toHaveBeenCalledWith({
      where: {
        id: "99999999-9999-4999-8999-999999999999",
        siteId: ids.siteId,
        lastHeartbeatAt: { gte: expect.any(Date) }
      }
    });
  });

  it("rejects a selected gateway without a heartbeat in the last 90 seconds", async () => {
    const { service, prisma } = await createModule({
      gateway: { findFirst: jest.fn().mockResolvedValue(null) }
    });

    await expect(service.createSession(admin, {
      siteId: ids.siteId,
      floorId: ids.floorId,
      gatewayId: ids.gatewayId
    })).rejects.toEqual(new BadRequestException("gatewayId must reference an online gateway in the selected site"));

    expect(prisma.provisioningSession.create).not.toHaveBeenCalled();
  });

  it("accepts a gateway heartbeat exactly 90 seconds old", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-07-11T00:05:00.000Z"));
    const { service, prisma } = await createModule();

    await service.createSession(admin, {
      siteId: ids.siteId,
      floorId: ids.floorId,
      gatewayId: ids.gatewayId
    });

    expect(prisma.gateway.findFirst).toHaveBeenCalledWith({
      where: {
        id: ids.gatewayId,
        siteId: ids.siteId,
        lastHeartbeatAt: { gte: new Date("2026-07-11T00:03:30.000Z") }
      }
    });
    jest.useRealTimers();
  });

  it("creates a pending scan and its durable scan-start outbox in one transaction", async () => {
    const { service, prisma, mqtt } = await createModule();

    const session = await service.createSession(admin, {
      siteId: ids.siteId,
      floorId: ids.floorId,
      gatewayId: ids.gatewayId
    });

    expect(session.id).toBe(ids.sessionId);
    expect(prisma.provisioningSession.create).toHaveBeenCalledWith({
      data: {
        siteId: ids.siteId,
        floorId: ids.floorId,
        gatewayId: ids.gatewayId,
        requestedBy: ids.userId,
        status: "active",
        scanStatus: "pending",
        scanCorrelationId: expect.any(String),
        scanAttempt: 1,
        scanStartedAt: null
      },
      include: { discoveredNodes: true }
    });
    expect(prisma.provisioningScanOutbox.create).toHaveBeenCalledWith({ data: {
      sessionId: ids.sessionId,
      scanAttempt: 1,
      topic: `sites/${ids.siteId}/gateways/${ids.gatewayId}/commands/provisioning/scan-start`,
      payload: expect.objectContaining({ sessionId: ids.sessionId, scanCorrelationId: expect.any(String), scanAttempt: 1 })
    } });
    expect(mqtt.publishProvisioningScanStart).not.toHaveBeenCalled();
  });

  it("does not publish directly when creating a scan", async () => {
    const { service, mqtt } = await createModule({}, {
      publishProvisioningScanStart: jest.fn().mockRejectedValue(new Error("broker unavailable"))
    });

    await expect(service.createSession(admin, {
      siteId: ids.siteId,
      floorId: ids.floorId,
      gatewayId: ids.gatewayId
    })).resolves.toEqual(expect.objectContaining({ id: ids.sessionId, scanStatus: "pending" }));

    expect(mqtt.publishProvisioningScanStart).not.toHaveBeenCalled();
  });

  it("retries a terminal scan by creating its next pending outbox attempt under the session lock", async () => {
    const correlation = "88888888-8888-4888-8888-888888888888";
    const terminalSession = {
      id: ids.sessionId,
      siteId: ids.siteId,
      floorId: ids.floorId,
      gatewayId: ids.gatewayId,
      status: "active",
      scanStatus: "failed",
      scanAttempt: 1,
      scanCorrelationId: "77777777-7777-4777-8777-777777777777",
      startedAt: new Date("2026-07-01T00:00:00.000Z")
    };
    const update = jest.fn().mockResolvedValue({ ...terminalSession, scanStatus: "pending", scanAttempt: 2, scanCorrelationId: correlation });
    const { service, prisma, mqtt } = await createModule({
      provisioningSession: {
        create: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(terminalSession),
        update,
        updateMany: jest.fn()
      }
    });
    jest.spyOn(require("node:crypto"), "randomUUID").mockReturnValue(correlation);

    await service.retryScan(admin, ids.sessionId);

    expect((prisma.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join("")).toContain("FOR UPDATE");
    expect(update).toHaveBeenCalledWith({
      where: { id: ids.sessionId },
      data: expect.objectContaining({
        scanStatus: "pending",
        scanCorrelationId: correlation,
        scanAttempt: 2,
        scanStartedAt: null,
        scanCompletedAt: null,
        scanFailureCode: null,
        scanFailureMessage: null
      })
    });
    expect(prisma.provisioningScanOutbox.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      sessionId: ids.sessionId, scanAttempt: 2, payload: expect.objectContaining({ scanCorrelationId: correlation })
    }) });
    expect(mqtt.publishProvisioningScanStart).not.toHaveBeenCalled();
  });

  it("maps a new session partial unique conflict to gateway_scan_in_progress", async () => {
    const { service } = await createModule({
      provisioningSession: {
        create: jest.fn().mockRejectedValue({ code: "P2002", meta: { target: ["ProvisioningSession_single_scanning_gateway_key"] } }),
        findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn()
      }
    });

    await expect(service.createSession(admin, {
      siteId: ids.siteId, floorId: ids.floorId, gatewayId: ids.gatewayId
    })).rejects.toEqual(new ConflictException({ code: "gateway_scan_in_progress" }));
  });

  it("returns gateway_scan_in_progress when retry conflicts with the gateway scanning unique index", async () => {
    const terminalSession = {
      id: ids.sessionId,
      siteId: ids.siteId,
      floorId: ids.floorId,
      gatewayId: ids.gatewayId,
      status: "active",
      scanStatus: "completed",
      scanAttempt: 1,
      startedAt: new Date("2026-07-01T00:00:00.000Z")
    };
    const { service } = await createModule({
      provisioningSession: {
        create: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(terminalSession),
        update: jest.fn().mockRejectedValue({ code: "P2002", meta: { target: ["ProvisioningSession_single_scanning_gateway_key"] } }),
        updateMany: jest.fn()
      }
    });

    await expect(service.retryScan(admin, ids.sessionId)).rejects.toEqual(
      new ConflictException({ code: "gateway_scan_in_progress" })
    );
  });

  it("checks session site commission access before returning stateless identify unsupported", async () => {
    const { service, prisma, mqtt, siteAccess } = await createModule({
      provisioningSession: { create: jest.fn(), findUnique: jest.fn().mockResolvedValue({ id: ids.sessionId, siteId: ids.siteId }), update: jest.fn() }
    });

    await expect(service.identifyNode(admin, ids.sessionId, ids.nodeId)).rejects.toEqual(
      new HttpException({ code: "pre_provision_identify_unsupported" }, 501)
    );

    expect(prisma.provisioningSession.findUnique).toHaveBeenCalledWith({ where: { id: ids.sessionId }, select: { siteId: true } });
    expect(siteAccess.assert).toHaveBeenCalledWith(admin, ids.siteId, "commission");
    expect(prisma.discoveredMeshNode.findUnique).not.toHaveBeenCalled();
    expect(prisma.discoveredMeshNode.update).not.toHaveBeenCalled();
    expect(mqtt.publishIdentifyDevice).not.toHaveBeenCalled();
  });

  it("keeps the not-found boundary before identify unsupported", async () => {
    const { service, siteAccess } = await createModule({
      provisioningSession: { create: jest.fn(), findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() }
    });

    await expect(service.identifyNode(admin, ids.sessionId, ids.nodeId)).rejects.toBeInstanceOf(NotFoundException);
    expect(siteAccess.assert).not.toHaveBeenCalled();
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
    const provisioningNode = { ...node, status: "provisioning", meshAddress: "0x0100" };
    const { service, prisma, mqtt } = await createModule({
      provisioningSession: {
        create: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({
          id: ids.sessionId,
          siteId: ids.siteId,
          floorId: ids.floorId,
          gatewayId: ids.gatewayId,
          status: "active",
          floor: { id: ids.floorId, name: "B2", floorPlan: { width: 1200, height: 800 } }
        }),
        update: jest.fn()
      },
      discoveredMeshNode: {
        findUnique: jest.fn().mockResolvedValue(provisioningNode),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([node]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue(provisioningNode)
      },
      meshNode: {
        count: jest.fn().mockResolvedValue(256),
        create: jest.fn()
      },
      fixture: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn()
      }
    });

    const result = await service.registerNode(
      admin,
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
        meshAddress: "0x0100",
        pendingFixtureName: "B2-L13",
        pendingFixtureX: 420,
        pendingFixtureY: 260,
        pendingFixtureSize: 20,
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
      meshAddress: "0x0100",
      requestedAt: expect.any(String)
    });
  });

  it("completes a registration session only after terminal scan state", async () => {
    const { service, prisma } = await createModule({
      provisioningSession: {
        create: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({
          id: ids.sessionId,
          status: "active", scanStatus: "completed", siteId: ids.siteId,
          site: { organizationId: ids.organizationId }
        }),
        update: jest.fn().mockResolvedValue({ id: ids.sessionId, status: "completed" })
      }
    });

    const result = await service.completeSession(admin, ids.sessionId);

    expect(result.status).toBe("completed");
    expect((prisma.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join("")).toContain("FOR UPDATE");
    expect(prisma.provisioningSession.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: ids.sessionId }, data: { status: "completed", completedAt: expect.any(Date) }, include: { discoveredNodes: true }
    }));
  });

  it("rejects completion while a scan is pending or scanning", async () => {
    const { service, prisma } = await createModule({
      provisioningSession: {
        create: jest.fn(),
        findUnique: jest.fn().mockResolvedValue({ id: ids.sessionId, siteId: ids.siteId, status: "active", scanStatus: "scanning" }),
        update: jest.fn()
      }
    });

    await expect(service.completeSession(admin, ids.sessionId)).rejects.toEqual(
      new ConflictException({ code: "scan_session_not_terminal" })
    );
    expect(prisma.provisioningSession.update).not.toHaveBeenCalled();
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

    await expect(service.getSession(admin, ids.sessionId)).rejects.toBeInstanceOf(NotFoundException);
  });
});
