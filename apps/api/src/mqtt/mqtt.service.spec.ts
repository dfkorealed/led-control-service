import { MqttService } from "./mqtt.service";

describe("MqttService", () => {
  it("updates fixture state from MQTT fixture-state events", async () => {
    const prisma = {
      fixture: { update: jest.fn().mockResolvedValue(undefined) },
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

    expect(prisma.fixture.update).toHaveBeenCalledWith({
      where: { id: "00000000-0000-4000-8000-000000002001" },
      data: {
        brightness: 25,
        status: "online",
        lastSeenAt: new Date("2026-07-01T00:00:00.000Z")
      }
    });
  });

  it("updates command status from MQTT command-ack events", async () => {
    const prisma = {
      fixture: { update: jest.fn() },
      command: { update: jest.fn().mockResolvedValue(undefined) }
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

    expect(prisma.command.update).toHaveBeenCalledWith({
      where: { id: "11111111-1111-4111-8111-111111111111" },
      data: { status: "acknowledged", errorMessage: null }
    });
  });
});
