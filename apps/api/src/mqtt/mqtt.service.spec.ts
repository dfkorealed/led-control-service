import { MqttService } from "./mqtt.service";

describe("MqttService", () => {
  it("updates fixture state from MQTT fixture-state events", async () => {
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

    expect(prisma.fixture.updateMany).toHaveBeenCalledWith({
      where: { id: "00000000-0000-4000-8000-000000002001" },
      data: {
        brightness: 25,
        status: "online",
        rssi: -61,
        hopCount: 1,
        commandSuccessRate: 0.97,
        lastSeenAt: new Date("2026-07-01T00:00:00.000Z")
      }
    });
  });

  it("ignores fixture-state events for fixtures that no longer exist", async () => {
    const prisma = {
      fixture: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      command: { updateMany: jest.fn() }
    };
    const service = new MqttService(prisma as never);

    await expect(
      service.handleMessage(
        "sites/00000000-0000-4000-8000-000000000003/events/fixture-state",
        Buffer.from(
          JSON.stringify({
            fixtureId: "99999999-9999-4999-8999-999999999999",
            brightness: 25,
            powerOn: true,
            status: "online",
            rssi: -61,
            hopCount: 1,
            commandSuccessRate: 0.97,
            lastSeenAt: "2026-07-01T00:00:00.000Z"
          })
        )
      )
    ).resolves.toBeUndefined();
  });

  it("updates gateway heartbeat timestamps from MQTT heartbeat events", async () => {
    const prisma = {
      fixture: { update: jest.fn() },
      command: { update: jest.fn() },
      gateway: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    const service = new MqttService(prisma as never);

    await service.handleMessage(
      "sites/00000000-0000-4000-8000-000000000003/events/gateway-heartbeat",
      Buffer.from(
        JSON.stringify({
          siteId: "00000000-0000-4000-8000-000000000003",
          gatewaySerial: "GW-DEMO-001",
          sentAt: "2026-07-01T00:00:02.000Z"
        })
      )
    );

    expect(prisma.gateway.updateMany).toHaveBeenCalledWith({
      where: { serialNumber: "GW-DEMO-001" },
      data: { lastHeartbeatAt: new Date("2026-07-01T00:00:02.000Z") }
    });
  });

  it("updates command status from MQTT command-ack events", async () => {
    const prisma = {
      fixture: { update: jest.fn() },
      command: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    const service = new MqttService(prisma as never);

    await service.handleMessage(
      "sites/00000000-0000-4000-8000-000000000003/events/command-ack",
      Buffer.from(
        JSON.stringify({
          commandId: "11111111-1111-4111-8111-111111111111",
          status: "acknowledged",
          acknowledgedAt: "2026-07-01T00:00:00.000Z"
        })
      )
    );

    expect(prisma.command.updateMany).toHaveBeenCalledWith({
      where: { id: "11111111-1111-4111-8111-111111111111" },
      data: { status: "acknowledged", errorMessage: null }
    });
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
