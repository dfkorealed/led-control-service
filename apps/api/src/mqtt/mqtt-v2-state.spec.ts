import { MqttService } from "./mqtt.service";

const scope = {
  siteId: "22222222-2222-4222-8222-222222222222",
  gatewayId: "55555555-5555-4555-8555-555555555555"
};

describe("MqttService v2 ordered state", () => {
  it("publishes the exact application ACK only after state transaction commit", async () => {
    const markers: string[] = [];
    const ingestion = {
      ingest: jest.fn(async () => {
        markers.push("committed");
        return {
          eventId: fixtureEvent(9).eventId,
          sequence: 9,
          fixtureId: fixtureEvent(9).fixtureId,
          status: "ingested" as const
        };
      })
    };
    const service = new MqttService({} as never, { attachProvisionedNode: jest.fn() } as never, ingestion as never);
    jest.spyOn(service, "publishTopic").mockImplementation(async (topic, payload) => {
      markers.push("application_ack");
      expect(topic).toBe(`sites/${scope.siteId}/gateways/${scope.gatewayId}/acks/state-ingested`);
      expect(payload).toMatchObject({
        eventId: fixtureEvent(9).eventId,
        sequence: 9,
        fixtureId: fixtureEvent(9).fixtureId,
        status: "ingested"
      });
    });

    await service.handleFixtureStatePacket(
      `sites/${scope.siteId}/gateways/${scope.gatewayId}/state/fixtures`,
      Buffer.from(JSON.stringify(fixtureEvent(9)))
    );

    expect(markers).toEqual(["committed", "application_ack"]);
  });

  it("publishes an explicit stale checkpoint ACK so the gateway can delete the exact record", async () => {
    const ingestion = {
      ingest: jest.fn().mockResolvedValue({
        eventId: fixtureEvent(9).eventId,
        sequence: 9,
        fixtureId: fixtureEvent(9).fixtureId,
        status: "stale_checkpoint"
      })
    };
    const service = new MqttService({} as never, { attachProvisionedNode: jest.fn() } as never, ingestion as never);
    const publish = jest.spyOn(service, "publishTopic").mockResolvedValue();

    await service.handleFixtureStatePacket(
      `sites/${scope.siteId}/gateways/${scope.gatewayId}/state/fixtures`,
      Buffer.from(JSON.stringify(fixtureEvent(9)))
    );

    expect(publish).toHaveBeenCalledWith(
      `sites/${scope.siteId}/gateways/${scope.gatewayId}/acks/state-ingested`,
      expect.objectContaining({ status: "stale_checkpoint" }),
      expect.objectContaining({ timeoutMs: 10_000 })
    );
  });

  it("does not ingest or acknowledge a forged topic scope", async () => {
    const ingestion = { ingest: jest.fn() };
    const service = new MqttService({} as never, { attachProvisionedNode: jest.fn() } as never, ingestion as never);
    const publish = jest.spyOn(service, "publishTopic").mockResolvedValue();

    await expect(service.handleFixtureStatePacket(
      `sites/${scope.siteId}/gateways/${scope.gatewayId}/state/fixtures`,
      Buffer.from(JSON.stringify({ ...fixtureEvent(10), siteId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }))
    )).rejects.toThrow("fixture state topic scope rejected");
    expect(ingestion.ingest).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not publish an application ACK when the database transaction fails", async () => {
    const ingestion = { ingest: jest.fn().mockRejectedValue(new Error("database unavailable")) };
    const service = new MqttService({} as never, { attachProvisionedNode: jest.fn() } as never, ingestion as never);
    const publish = jest.spyOn(service, "publishTopic").mockResolvedValue();

    await expect(service.handleFixtureStatePacket(
      `sites/${scope.siteId}/gateways/${scope.gatewayId}/state/fixtures`,
      Buffer.from(JSON.stringify(fixtureEvent(9)))
    )).rejects.toThrow("database unavailable");
    expect(publish).not.toHaveBeenCalled();
  });
});

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
