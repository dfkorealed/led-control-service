import { MqttService } from "./mqtt.service";

const scope = {
  siteId: "22222222-2222-4222-8222-222222222222",
  gatewayId: "55555555-5555-4555-8555-555555555555"
};

describe("MqttService v2 ordered state", () => {
  it("serializes automation and fixture-state ingestion for the same Gateway", async () => {
    let releaseAutomation!: () => void;
    let markAutomationStarted!: () => void;
    const automationStarted = new Promise<void>((resolve) => { markAutomationStarted = resolve; });
    const automationBlocked = new Promise<void>((resolve) => { releaseAutomation = resolve; });
    const ingestion = {
      ingest: jest.fn().mockResolvedValue({
        eventId: fixtureEvent(9).eventId,
        sequence: 9,
        fixtureId: fixtureEvent(9).fixtureId,
        status: "ingested"
      })
    };
    const automation = {
      handleMessage: jest.fn(async () => {
        markAutomationStarted();
        await automationBlocked;
      })
    };
    const service = new MqttService(
      {} as never,
      { attachProvisionedNode: jest.fn() } as never,
      ingestion as never,
      automation as never
    );
    jest.spyOn(service, "publishTopic").mockResolvedValue();
    const internal = service as unknown as {
      startInboundHandler(topic: string, payload: Buffer): void;
      createCustomHandleAcks(): (
        topic: string,
        payload: Buffer,
        packet: { qos: number },
        done: (reasonCode: number) => void
      ) => void;
    };

    internal.startInboundHandler(
      `sites/${scope.siteId}/gateways/${scope.gatewayId}/events/automation/execution`,
      Buffer.from("{}")
    );
    await automationStarted;
    const done = jest.fn();
    internal.createCustomHandleAcks()(
      `sites/${scope.siteId}/gateways/${scope.gatewayId}/state/fixtures`,
      Buffer.from(JSON.stringify(fixtureEvent(9))),
      { qos: 1 },
      done
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(ingestion.ingest).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();

    releaseAutomation();
    await service.stopInboundAndDrain();
    expect(ingestion.ingest).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(0);
  });

  it("bounds the pending inbound work for one Gateway", async () => {
    const service = new MqttService({} as never, { attachProvisionedNode: jest.fn() } as never);
    const internal = service as unknown as {
      runInGatewayInboundQueue<T>(topic: string, operation: () => Promise<T>): Promise<T>;
    };
    const topic = `sites/${scope.siteId}/gateways/${scope.gatewayId}/events/automation/execution`;
    const blocked = new Promise<void>(() => undefined);

    for (let index = 0; index < 256; index += 1) {
      void internal.runInGatewayInboundQueue(topic, () => blocked);
    }

    await expect(internal.runInGatewayInboundQueue(topic, async () => undefined)).rejects.toThrow(
      "MQTT inbound Gateway queue capacity exceeded"
    );
  });

  it("releases the inbound PUBACK after commit without waiting for the application ACK publish callback", async () => {
    let releaseApplicationAck!: () => void;
    const applicationAckPending = new Promise<void>((resolve) => {
      releaseApplicationAck = resolve;
    });
    const ingestion = {
      ingest: jest.fn().mockResolvedValue({
        eventId: fixtureEvent(9).eventId,
        sequence: 9,
        fixtureId: fixtureEvent(9).fixtureId,
        status: "ingested"
      })
    };
    const service = new MqttService({} as never, { attachProvisionedNode: jest.fn() } as never, ingestion as never);
    jest.spyOn(service, "publishTopic").mockReturnValue(applicationAckPending);
    let markPuback!: () => void;
    const puback = new Promise<void>((resolve) => { markPuback = resolve; });
    const done = jest.fn(() => markPuback());

    const customHandleAcks = (service as unknown as {
      createCustomHandleAcks: () => (topic: string, payload: Buffer, packet: { qos: number }, done: (reasonCode: number) => void) => void;
    }).createCustomHandleAcks();
    customHandleAcks(
      `sites/${scope.siteId}/gateways/${scope.gatewayId}/state/fixtures`,
      Buffer.from(JSON.stringify(fixtureEvent(9))),
      { qos: 1 },
      done
    );

    await puback;
    expect(done).toHaveBeenCalledWith(0);
    releaseApplicationAck();
    await service.stopInboundAndDrain();
  });

  it("rejects new fixture state intake after shutdown drain starts", async () => {
    const ingestion = { ingest: jest.fn() };
    const destroy = jest.fn();
    const service = new MqttService({} as never, { attachProvisionedNode: jest.fn() } as never, ingestion as never);
    (service as unknown as { client: { stream: { destroy: () => void } } }).client = { stream: { destroy } };
    const done = jest.fn();

    await service.stopInboundAndDrain();
    const customHandleAcks = (service as unknown as {
      createCustomHandleAcks: () => (topic: string, payload: Buffer, packet: { qos: number }, done: (reasonCode: number) => void) => void;
    }).createCustomHandleAcks();
    customHandleAcks(
      `sites/${scope.siteId}/gateways/${scope.gatewayId}/state/fixtures`,
      Buffer.from(JSON.stringify(fixtureEvent(9))),
      { qos: 1 },
      done
    );

    expect(ingestion.ingest).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

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
