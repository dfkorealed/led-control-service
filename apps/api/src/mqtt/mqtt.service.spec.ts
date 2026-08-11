import { createMqttConnectionOptions, MqttService } from "./mqtt.service";

jest.mock("node:fs", () => ({ readFileSync: jest.fn(() => Buffer.from("test-certificate")) }));

describe("MqttService", () => {
  it("rejects insecure production broker configuration", () => {
    expect(() => createMqttConnectionOptions({ NODE_ENV: "production", MQTT_URL: "mqtt://broker:1883" })).toThrow(
      "mqtts://"
    );
  });

  it("rejects plaintext MQTT even when a legacy local override is set", () => {
    expect(() =>
      createMqttConnectionOptions({ MQTT_URL: "mqtt://localhost:1883", MQTT_ALLOW_INSECURE_LOCAL: "true" })
    ).toThrow("mqtts://");
  });

  it("uses a deployment-specific clean MQTT 5 API session", () => {
    const { options } = createMqttConnectionOptions({
      MQTT_URL: "mqtts://broker:8883",
      MQTT_CA_PATH: "/certs/ca.crt",
      MQTT_CLIENT_CERT_PATH: "/certs/api.crt",
      MQTT_CLIENT_KEY_PATH: "/certs/api.key",
      MQTT_API_INSTANCE_ID: "api-blue-2"
    });

    expect(options).toMatchObject({
      clientId: "api-service-api-blue-2",
      clean: true,
      protocolVersion: 5
    });
    expect(options.properties).toBeUndefined();
  });

  it("publishes a QoS 1 JSON payload that expires at the acceptance deadline", async () => {
    const prisma: any = {};
    const publish = jest.fn((_topic, _payload, _options, callback) => callback());
    const service = new MqttService(prisma);
    (service as any).client = { publish };

    await service.publishTopic("sites/s/gateways/g/commands/dimming", { ok: true });

    expect(publish).toHaveBeenCalledWith(
      "sites/s/gateways/g/commands/dimming",
      JSON.stringify({ ok: true }),
      { qos: 1, properties: { messageExpiryInterval: 10 } },
      expect.any(Function)
    );
  });

  it("marks a gateway dispatch accepted from a scoped acceptance ACK", async () => {
    const prisma: any = {
      commandDispatch: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    };
    const service = new MqttService(prisma);
    await service.handleMessage(
      "sites/22222222-2222-4222-8222-222222222222/gateways/55555555-5555-4555-8555-555555555555/acks/acceptance",
      Buffer.from(
        JSON.stringify({
          commandId: "11111111-1111-4111-8111-111111111111",
          dispatchId: "66666666-6666-4666-8666-666666666666",
          idempotencyKey: "33333333-3333-4333-8333-333333333333",
          sequence: 1,
          siteId: "22222222-2222-4222-8222-222222222222",
          gatewayId: "55555555-5555-4555-8555-555555555555",
          eventId: "77777777-7777-4777-8777-777777777777",
          status: "accepted",
          acceptedAt: "2026-07-11T00:00:01.000Z"
        })
      )
    );
    expect(prisma.commandDispatch.updateMany).toHaveBeenCalledWith({
      where: {
        id: "66666666-6666-4666-8666-666666666666",
        commandId: "11111111-1111-4111-8111-111111111111",
        gatewayId: "55555555-5555-4555-8555-555555555555",
        idempotencyKey: "33333333-3333-4333-8333-333333333333",
        sequence: 1n,
        status: { in: ["pending", "published"] },
        command: { siteId: "22222222-2222-4222-8222-222222222222" }
      },
      data: { status: "accepted", acceptedAt: new Date("2026-07-11T00:00:01.000Z"), errorCode: null, errorMessage: null }
    });
  });

  it("atomically fails a rejected dispatch, its pending fixture results, and its parent command", async () => {
    const prisma: any = {
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandFixtureResult: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      command: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const service = new MqttService(prisma);

    await service.handleMessage(
      "sites/22222222-2222-4222-8222-222222222222/gateways/55555555-5555-4555-8555-555555555555/acks/acceptance",
      Buffer.from(JSON.stringify({
        ...acceptanceAckPayload(),
        status: "rejected",
        errorCode: "COMMAND_EXPIRED",
        errorMessage: "gateway command expired before execution"
      }))
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.commandDispatch.updateMany).toHaveBeenCalledWith({
      where: {
        id: "66666666-6666-4666-8666-666666666666",
        commandId: "11111111-1111-4111-8111-111111111111",
        gatewayId: "55555555-5555-4555-8555-555555555555",
        idempotencyKey: "33333333-3333-4333-8333-333333333333",
        sequence: 1n,
        status: { in: ["pending", "published", "accepted"] },
        command: { siteId: "22222222-2222-4222-8222-222222222222" }
      },
      data: {
        status: "failed",
        acceptedAt: new Date("2026-07-11T00:00:01.000Z"),
        errorCode: "COMMAND_EXPIRED",
        errorMessage: "gateway command expired before execution"
      }
    });
    expect(prisma.commandFixtureResult.updateMany).toHaveBeenCalledWith({
      where: { dispatchId: "66666666-6666-4666-8666-666666666666", status: "pending" },
      data: {
        status: "failed",
        occurredAt: new Date("2026-07-11T00:00:01.000Z"),
        errorMessage: "gateway command expired before execution"
      }
    });
    expect(prisma.command.updateMany).toHaveBeenCalledWith({
      where: { id: "11111111-1111-4111-8111-111111111111", status: "pending" },
      data: { status: "failed", errorMessage: "gateway command expired before execution" }
    });
  });

  it("closes an accepted dispatch when a delayed expiry rejection follows its acceptance", async () => {
    const prisma: any = {
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandFixtureResult: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      command: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const service = new MqttService(prisma);
    const topic = "sites/22222222-2222-4222-8222-222222222222/gateways/55555555-5555-4555-8555-555555555555/acks/acceptance";

    await service.handleMessage(topic, Buffer.from(JSON.stringify(acceptanceAckPayload())));
    await service.handleMessage(topic, Buffer.from(JSON.stringify({
      ...acceptanceAckPayload(),
      status: "rejected",
      errorCode: "COMMAND_EXPIRED",
      errorMessage: "gateway command expired before execution"
    })));

    expect(prisma.commandDispatch.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ status: { in: ["pending", "published", "accepted"] } }),
      data: expect.objectContaining({ status: "failed", errorCode: "COMMAND_EXPIRED" })
    }));
    expect(prisma.commandFixtureResult.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.command.updateMany).toHaveBeenCalledTimes(1);
  });

  it("does not process a device-status ACK for an already terminal dispatch", async () => {
    const prisma: any = {
      commandDispatch: { findFirst: jest.fn().mockResolvedValue(null) },
      commandFixtureResult: { updateMany: jest.fn() }
    };
    const service = new MqttService(prisma);

    await service.handleMessage(
      "sites/22222222-2222-4222-8222-222222222222/gateways/55555555-5555-4555-8555-555555555555/acks/device-status",
      Buffer.from(JSON.stringify(deviceStatusAckPayload()))
    );

    expect(prisma.commandDispatch.findFirst).toHaveBeenCalledWith({
      where: {
        id: "66666666-6666-4666-8666-666666666666",
        commandId: "11111111-1111-4111-8111-111111111111",
        gatewayId: "55555555-5555-4555-8555-555555555555",
        idempotencyKey: "33333333-3333-4333-8333-333333333333",
        sequence: 1n,
        status: { in: ["pending", "published", "accepted"] },
        command: { siteId: "22222222-2222-4222-8222-222222222222" }
      },
      select: { id: true, commandId: true }
    });
    expect(prisma.commandFixtureResult.updateMany).not.toHaveBeenCalled();
  });

  it("stores fixture results from a device status ACK", async () => {
    const prisma: any = {
      commandDispatch: {
        findFirst: jest.fn().mockResolvedValue({ id: "66666666-6666-4666-8666-666666666666", commandId: "11111111-1111-4111-8111-111111111111" }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn()
      },
      commandFixtureResult: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      command: { updateMany: jest.fn() },
      $transaction: jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma))
    };
    const service = new MqttService(prisma);
    await service.handleMessage(
      "sites/22222222-2222-4222-8222-222222222222/gateways/55555555-5555-4555-8555-555555555555/acks/device-status",
      Buffer.from(
        JSON.stringify({
          commandId: "11111111-1111-4111-8111-111111111111",
          dispatchId: "66666666-6666-4666-8666-666666666666",
          idempotencyKey: "33333333-3333-4333-8333-333333333333",
          sequence: 1,
          siteId: "22222222-2222-4222-8222-222222222222",
          gatewayId: "55555555-5555-4555-8555-555555555555",
          eventId: "88888888-8888-4888-8888-888888888888",
          status: "succeeded",
          occurredAt: "2026-07-11T00:00:02.000Z",
          results: [
            { fixtureId: "99999999-9999-4999-8999-999999999999", status: "succeeded", brightness: 70, rssi: -60, hopCount: 1 }
          ]
        })
      )
    );
    expect(prisma.commandFixtureResult.updateMany).toHaveBeenCalledWith({
      where: {
        dispatchId: "66666666-6666-4666-8666-666666666666",
        fixtureId: "99999999-9999-4999-8999-999999999999"
      },
      data: {
        status: "succeeded",
        brightness: 70,
        faultCode: null,
        errorMessage: null,
        rssi: -60,
        hopCount: 1,
        occurredAt: new Date("2026-07-11T00:00:02.000Z")
      }
    });
  });

  it("ignores legacy unscoped MQTT fixture-state events", async () => {
    const prisma = {
      fixture: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      command: { update: jest.fn() }
    };
    const service = new MqttService(prisma as never);

    await service.handleMessage(
      "sites/00000000-0000-4000-8000-000000000003/events/fixture-state",
      Buffer.from(
        JSON.stringify({
          fixtureId: "00000000-0000-4000-8000-000000002001",
          brightness: 25,
          powerOn: true,
          status: "online",
          rssi: -61,
          hopCount: 1,
          commandSuccessRate: 0.97,
          lastSeenAt: "2026-07-01T00:00:00.000Z"
        })
      )
    );

    expect(prisma.fixture.updateMany).not.toHaveBeenCalled();
  });

  it("stores unprovisioned device discovery events", async () => {
    const prisma = {
      fixture: { update: jest.fn() },
      command: { update: jest.fn() },
      provisioningSession: {
        findFirst: jest.fn().mockResolvedValue({
          id: "11111111-1111-4111-8111-111111111111",
          siteId: "00000000-0000-4000-8000-000000000003",
          gatewayId: "00000000-0000-4000-8000-000000000004"
        })
      },
      discoveredMeshNode: {
        upsert: jest.fn().mockResolvedValue(undefined)
      }
    };
    const service = new MqttService(prisma as never);

    await service.handleMessage(
      "sites/00000000-0000-4000-8000-000000000003/gateways/00000000-0000-4000-8000-000000000004/events/unprovisioned-device-found",
      Buffer.from(
        JSON.stringify({
          sessionId: "11111111-1111-4111-8111-111111111111",
          deviceUuid: "esp32h2-b2-001",
          serialNumber: "LC-B2-001",
          rssi: -54,
          oobCapability: "static-oob",
          firmwareVersion: "mock-node-0.1.0",
          discoveredAt: "2026-07-01T00:00:01.000Z"
        })
      )
    );

    expect(prisma.discoveredMeshNode.upsert).toHaveBeenCalledWith({
      where: {
        sessionId_deviceUuid: {
          sessionId: "11111111-1111-4111-8111-111111111111",
          deviceUuid: "esp32h2-b2-001"
        }
      },
      create: {
        sessionId: "11111111-1111-4111-8111-111111111111",
        deviceUuid: "esp32h2-b2-001",
        serialNumber: "LC-B2-001",
        rssi: -54,
        oobCapability: "static-oob",
        firmwareVersion: "mock-node-0.1.0",
        discoveredAt: new Date("2026-07-01T00:00:01.000Z")
      },
      update: {
        rssi: -54,
        oobCapability: "static-oob",
        firmwareVersion: "mock-node-0.1.0",
        discoveredAt: new Date("2026-07-01T00:00:01.000Z"),
        errorMessage: null
      }
    });
  });

  it("creates mesh node and fixture mappings from provisioning completed events", async () => {
    const node = {
      id: "22222222-2222-4222-8222-222222222222",
      sessionId: "11111111-1111-4111-8111-111111111111",
      deviceUuid: "esp32h2-b2-001",
      serialNumber: "LC-B2-001",
      rssi: -54,
      oobCapability: "static-oob",
      firmwareVersion: "mock-node-0.1.0",
      status: "provisioning",
      identifyState: "blinking",
      meshAddress: "0x0101",
      pendingFixtureName: "B2-L13",
      pendingFixtureX: 420,
      pendingFixtureY: 260,
      pendingRatedWatt: "45.00",
      session: {
        id: "11111111-1111-4111-8111-111111111111",
        siteId: "00000000-0000-4000-8000-000000000003",
        floorId: "00000000-0000-4000-8000-000000000005",
        gatewayId: "00000000-0000-4000-8000-000000000004"
      }
    };
    const prisma: any = {
      fixture: {
        update: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: "44444444-4444-4444-8444-444444444444" })
      },
      command: { update: jest.fn() },
      discoveredMeshNode: {
        findFirst: jest.fn().mockResolvedValue(node),
        update: jest.fn().mockResolvedValue({ ...node, status: "provisioned" })
      },
      meshNode: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: "33333333-3333-4333-8333-333333333333" })
      }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma));
    const service = new MqttService(prisma as never);

    await service.handleMessage(
      "sites/00000000-0000-4000-8000-000000000003/gateways/00000000-0000-4000-8000-000000000004/events/provisioning-completed",
      Buffer.from(
        JSON.stringify({
          sessionId: "11111111-1111-4111-8111-111111111111",
          nodeId: "22222222-2222-4222-8222-222222222222",
          deviceUuid: "esp32h2-b2-001",
          meshAddress: "0x0101",
          firmwareVersion: "esp32h2-0.1.0",
          rssi: -61,
          hopCount: 1,
          completedAt: "2026-07-01T00:00:05.000Z"
        })
      )
    );

    expect(prisma.meshNode.create).toHaveBeenCalledWith({
      data: {
        gatewayId: "00000000-0000-4000-8000-000000000004",
        deviceUuid: "esp32h2-b2-001",
        serialNumber: "LC-B2-001",
        meshAddress: "0x0101",
        firmwareVersion: "esp32h2-0.1.0"
      }
    });
    expect(prisma.fixture.create).toHaveBeenCalledWith({
      data: {
        id: "22222222-2222-4222-8222-222222222222",
        floorId: "00000000-0000-4000-8000-000000000005",
        meshNodeId: "33333333-3333-4333-8333-333333333333",
        name: "B2-L13",
        ratedWatt: "45.00",
        x: 420,
        y: 260,
        status: "offline",
        brightness: 0,
        rssi: null,
        hopCount: null,
        commandSuccessRate: null,
        lastSeenAt: null,
        statusReason: "provisioning_waiting_state"
      }
    });
    expect(prisma.discoveredMeshNode.update).toHaveBeenCalledWith({
      where: { id: "22222222-2222-4222-8222-222222222222" },
      data: {
        status: "provisioned",
        identifyState: "confirmed",
        meshAddress: "0x0101",
        firmwareVersion: "esp32h2-0.1.0",
        rssi: -61,
        errorMessage: null
      }
    });
  });

  it("marks a completed node failed when its device UUID already belongs to another site", async () => {
    const node = {
      id: "22222222-2222-4222-8222-222222222222",
      sessionId: "11111111-1111-4111-8111-111111111111",
      deviceUuid: "esp32h2-b2-001",
      serialNumber: "LC-B2-001",
      rssi: -61,
      firmwareVersion: "mock-node-0.1.0",
      pendingFixtureName: "B2-L13",
      pendingFixtureX: 420,
      pendingFixtureY: 260,
      pendingRatedWatt: "45.00",
      session: {
        siteId: "00000000-0000-4000-8000-000000000003",
        floorId: "00000000-0000-4000-8000-000000000005",
        gatewayId: "00000000-0000-4000-8000-000000000004"
      }
    };
    const prisma: any = {
      fixture: { update: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
      command: { update: jest.fn() },
      discoveredMeshNode: {
        findFirst: jest.fn().mockResolvedValue(node),
        update: jest.fn()
      },
      meshNode: {
        findUnique: jest.fn().mockResolvedValue({
          id: "33333333-3333-4333-8333-333333333333",
          gatewayId: "99999999-9999-4999-8999-999999999999"
        }),
        create: jest.fn()
      }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma));
    const service = new MqttService(prisma);

    await service.handleMessage(
      "sites/00000000-0000-4000-8000-000000000003/gateways/00000000-0000-4000-8000-000000000004/events/provisioning-completed",
      Buffer.from(JSON.stringify({
        sessionId: node.sessionId,
        nodeId: node.id,
        deviceUuid: node.deviceUuid,
        meshAddress: "0x0101",
        completedAt: "2026-07-01T00:00:05.000Z"
      }))
    );

    expect(prisma.fixture.create).not.toHaveBeenCalled();
    expect(prisma.discoveredMeshNode.update).toHaveBeenCalledWith({
      where: { id: node.id },
      data: { status: "failed", errorMessage: "device UUID is already registered by another site" }
    });
  });

  it("marks only the competing registration attempt failed when the device UUID unique index wins a race", async () => {
    const node = {
      id: "22222222-2222-4222-8222-222222222222",
      sessionId: "11111111-1111-4111-8111-111111111111",
      deviceUuid: "esp32h2-b2-001",
      serialNumber: "LC-B2-001",
      rssi: -61,
      firmwareVersion: "mock-node-0.1.0",
      pendingFixtureName: "B2-L13",
      pendingFixtureX: 420,
      pendingFixtureY: 260,
      pendingRatedWatt: "45.00",
      session: {
        siteId: "00000000-0000-4000-8000-000000000003",
        floorId: "00000000-0000-4000-8000-000000000005",
        gatewayId: "00000000-0000-4000-8000-000000000004"
      }
    };
    const prisma: any = {
      fixture: { update: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
      command: { update: jest.fn() },
      discoveredMeshNode: {
        findFirst: jest.fn().mockResolvedValue(node),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      meshNode: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockRejectedValue({ code: "P2002", meta: { target: ["deviceUuid"] } })
      }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma));
    const service = new MqttService(prisma);

    await service.handleMessage(
      "sites/00000000-0000-4000-8000-000000000003/gateways/00000000-0000-4000-8000-000000000004/events/provisioning-completed",
      Buffer.from(JSON.stringify({
        sessionId: node.sessionId,
        nodeId: node.id,
        deviceUuid: node.deviceUuid,
        meshAddress: "0x0101",
        completedAt: "2026-07-01T00:00:05.000Z"
      }))
    );

    expect(prisma.fixture.create).not.toHaveBeenCalled();
    expect(prisma.discoveredMeshNode.updateMany).toHaveBeenCalledWith({
      where: {
        id: node.id,
        sessionId: node.sessionId,
        deviceUuid: node.deviceUuid,
        status: { in: ["discovered", "identifying", "provisioning"] },
        session: {
          siteId: node.session.siteId,
          gatewayId: node.session.gatewayId,
          status: "active"
        }
      },
      data: { status: "failed", errorMessage: "device UUID is already registered by another site" }
    });
  });

  async function expectProvisioningErrorToRethrow(error: unknown) {
    const prisma: any = {
      $transaction: jest.fn().mockRejectedValue(error),
      discoveredMeshNode: { updateMany: jest.fn() }
    };
    const service = new MqttService(prisma);

    await expect((service as any).completeProvisioning(
      { siteId: "site-1", gatewayId: "gateway-1" },
      { sessionId: "session-1", nodeId: "node-1", deviceUuid: "device-1", meshAddress: "0x0101", completedAt: "2026-07-01T00:00:05.000Z" }
    )).rejects.toBe(error);
    expect(prisma.discoveredMeshNode.updateMany).not.toHaveBeenCalled();
  }

  it("rethrows a P2002 for a different unique constraint", async () => {
    await expectProvisioningErrorToRethrow({ code: "P2002", meta: { target: ["gatewayId", "meshAddress"] } });
  });

  it("rethrows a transaction failure", async () => {
    await expectProvisioningErrorToRethrow(new Error("transaction serialization failure"));
  });

  it("marks discovered nodes failed from provisioning failed events", async () => {
    const prisma = {
      fixture: { update: jest.fn() },
      command: { update: jest.fn() },
      discoveredMeshNode: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    };
    const service = new MqttService(prisma as never);

    await service.handleMessage(
      "sites/00000000-0000-4000-8000-000000000003/gateways/00000000-0000-4000-8000-000000000004/events/provisioning-failed",
      Buffer.from(
        JSON.stringify({
          sessionId: "11111111-1111-4111-8111-111111111111",
          nodeId: "22222222-2222-4222-8222-222222222222",
          deviceUuid: "esp32h2-b2-001",
          errorMessage: "provisioning timeout",
          failedAt: "2026-07-01T00:00:05.000Z"
        })
      )
    );

    expect(prisma.discoveredMeshNode.updateMany).toHaveBeenCalledWith({
      where: {
        id: "22222222-2222-4222-8222-222222222222",
        sessionId: "11111111-1111-4111-8111-111111111111",
        deviceUuid: "esp32h2-b2-001",
        session: {
          siteId: "00000000-0000-4000-8000-000000000003",
          gatewayId: "00000000-0000-4000-8000-000000000004",
          status: "active"
        }
      },
      data: {
        status: "failed",
        errorMessage: "provisioning timeout"
      }
    });
  });

  it("ignores discovery events when the topic does not match the registration session", async () => {
    const prisma = {
      fixture: { update: jest.fn() },
      command: { update: jest.fn() },
      provisioningSession: {
        findFirst: jest.fn().mockResolvedValue(null)
      },
      discoveredMeshNode: {
        upsert: jest.fn()
      }
    };
    const service = new MqttService(prisma as never);

    await service.handleMessage(
      "sites/99999999-9999-4999-8999-999999999999/gateways/00000000-0000-4000-8000-000000000004/events/unprovisioned-device-found",
      Buffer.from(
        JSON.stringify({
          sessionId: "11111111-1111-4111-8111-111111111111",
          deviceUuid: "esp32h2-b2-001",
          serialNumber: "LC-B2-001",
          rssi: -54,
          oobCapability: "static-oob",
          firmwareVersion: "mock-node-0.1.0",
          discoveredAt: "2026-07-01T00:00:01.000Z"
        })
      )
    );

    expect(prisma.discoveredMeshNode.upsert).not.toHaveBeenCalled();
  });
});

function deviceStatusAckPayload() {
  return {
    commandId: "11111111-1111-4111-8111-111111111111",
    dispatchId: "66666666-6666-4666-8666-666666666666",
    idempotencyKey: "33333333-3333-4333-8333-333333333333",
    sequence: 1,
    siteId: "22222222-2222-4222-8222-222222222222",
    gatewayId: "55555555-5555-4555-8555-555555555555",
    eventId: "88888888-8888-4888-8888-888888888888",
    status: "succeeded",
    occurredAt: "2026-07-11T00:00:02.000Z",
    results: [
      { fixtureId: "99999999-9999-4999-8999-999999999999", status: "succeeded", brightness: 70, rssi: -60, hopCount: 1 }
    ]
  };
}

function acceptanceAckPayload() {
  return {
    commandId: "11111111-1111-4111-8111-111111111111",
    dispatchId: "66666666-6666-4666-8666-666666666666",
    idempotencyKey: "33333333-3333-4333-8333-333333333333",
    sequence: 1,
    siteId: "22222222-2222-4222-8222-222222222222",
    gatewayId: "55555555-5555-4555-8555-555555555555",
    eventId: "77777777-7777-4777-8777-777777777777",
    status: "accepted",
    acceptedAt: "2026-07-11T00:00:01.000Z"
  };
}
