import { MqttService } from "./mqtt.service";

const scope = {
  siteId: "22222222-2222-4222-8222-222222222222",
  gatewayId: "55555555-5555-4555-8555-555555555555"
};

describe("MqttService v2 ordered state", () => {
  it("stores a fixture event only inside the topic and DB scope", async () => {
    const prisma: any = fixturePrisma({ lastStateSequence: 8n });
    const service = new MqttService(prisma, { attachProvisionedNode: jest.fn() } as never);
    await service.handleMessage(
      `sites/${scope.siteId}/gateways/${scope.gatewayId}/state/fixtures`,
      Buffer.from(JSON.stringify(fixtureEvent(9)))
    );

    expect(prisma.processedGatewayEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventId: "99999999-9999-4999-8999-999999999999", gatewayId: scope.gatewayId, sequence: 9n })
    });
    expect(prisma.fixture.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "66666666-6666-4666-8666-666666666666" }),
      data: expect.objectContaining({
        brightness: 70,
        healthFaultCodes: [1, 4],
        healthLastSeenAt: new Date("2026-07-11T00:00:08.000Z"),
        lastStateSequence: 9n,
        status: "fault",
        statusReason: "reported"
      })
    });
  });

  it("drops a lower sequence and a forged payload scope", async () => {
    const prisma: any = fixturePrisma({ lastStateSequence: 9n });
    const service = new MqttService(prisma, { attachProvisionedNode: jest.fn() } as never);
    await service.handleMessage(
      `sites/${scope.siteId}/gateways/${scope.gatewayId}/state/fixtures`,
      Buffer.from(JSON.stringify(fixtureEvent(8)))
    );
    await service.handleMessage(
      `sites/${scope.siteId}/gateways/${scope.gatewayId}/state/fixtures`,
      Buffer.from(JSON.stringify({ ...fixtureEvent(10), siteId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }))
    );
    expect(prisma.fixture.updateMany).not.toHaveBeenCalled();
  });
});

function fixturePrisma(fixture: { lastStateSequence: bigint }) {
  const prisma: any = {
    fixture: {
      findFirst: jest.fn().mockResolvedValue(fixture),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    },
    processedGatewayEvent: { create: jest.fn().mockResolvedValue(undefined) }
  };
  prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
  return prisma;
}

function fixtureEvent(sequence: number) {
  return {
    ...scope,
    eventId: "99999999-9999-4999-8999-999999999999",
    sequence,
    occurredAt: "2026-07-11T00:00:09.000Z",
    fixtureId: "66666666-6666-4666-8666-666666666666",
    brightness: 70,
    powerOn: true,
    status: "online",
    statusReason: "reported",
    health: { faultCodes: [4, 0, 1, 4], observedAt: "2026-07-11T00:00:08.000Z" },
    rssi: -60,
    hopCount: 1
  };
}
