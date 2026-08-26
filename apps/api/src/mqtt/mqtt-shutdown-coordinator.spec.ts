import { Test } from "@nestjs/testing";
import { MqttService } from "./mqtt.service";
import { MqttShutdownCoordinator } from "./mqtt-shutdown-coordinator.service";
import { OutboxPublisherService } from "./outbox-publisher.service";
import { ProvisioningScanOutboxPublisherService } from "./provisioning-scan-outbox-publisher.service";

describe("MqttShutdownCoordinator", () => {
  it("drains both active outbox publishes before closing the MQTT client during Nest module close", async () => {
    const commandPublish = deferred<void>();
    const scanPublish = deferred<void>();
    const order: string[] = [];
    const mqtt = new MqttService({} as never, {} as never);
    const client: any = {
      on: jest.fn(),
      subscribe: jest.fn(),
      end: jest.fn((_force: boolean, callback?: (error?: Error) => void) => {
        order.push("client-end");
        callback?.();
        return client;
      })
    };
    (mqtt as any).client = client;

    const commandWorker = new OutboxPublisherService({} as never, mqtt, {
      workerId: "command-worker", pollMs: 60_000
    });
    jest.spyOn(commandWorker, "claimBatch").mockResolvedValue([
      commandRecord("command-outbox-1"),
      commandRecord("command-outbox-2")
    ] as never);
    const commandPublishClaimed = jest.spyOn(commandWorker, "publishClaimed")
      .mockImplementationOnce(async () => {
        await commandPublish.promise;
        order.push("command-drained");
      })
      .mockResolvedValue(undefined);

    const scanWorker = new ProvisioningScanOutboxPublisherService({} as never, mqtt, {
      workerId: "scan-worker", pollMs: 60_000
    });
    jest.spyOn(scanWorker, "claimBatch").mockResolvedValue([
      scanRecord("scan-outbox-1"),
      scanRecord("scan-outbox-2")
    ] as never);
    const scanPublishClaimed = jest.spyOn(scanWorker, "publishClaimed")
      .mockImplementationOnce(async () => {
        await scanPublish.promise;
        order.push("scan-drained");
      })
      .mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        MqttShutdownCoordinator,
        { provide: MqttService, useValue: mqtt },
        { provide: OutboxPublisherService, useValue: commandWorker },
        { provide: ProvisioningScanOutboxPublisherService, useValue: scanWorker }
      ]
    }).compile();
    await moduleRef.init();
    await waitForTurn();
    expect(commandPublishClaimed).toHaveBeenCalledTimes(1);
    expect(scanPublishClaimed).toHaveBeenCalledTimes(1);

    let closing: Promise<void> | undefined;
    try {
      closing = moduleRef.close();
      await waitForTurn();
      expect(client.end).not.toHaveBeenCalled();

      commandPublish.resolve();
      await waitForTurn();
      expect(client.end).not.toHaveBeenCalled();

      scanPublish.resolve();
      await closing;

      expect(order).toEqual(["command-drained", "scan-drained", "client-end"]);
      expect(commandPublishClaimed).toHaveBeenCalledTimes(1);
      expect(scanPublishClaimed).toHaveBeenCalledTimes(1);
    } finally {
      commandPublish.resolve();
      scanPublish.resolve();
      await closing?.catch(() => undefined);
    }
  });
});

function commandRecord(id: string) {
  return {
    id,
    dispatchId: "22222222-2222-4222-8222-222222222222",
    topic: "sites/44444444-4444-4444-8444-444444444444/gateways/55555555-5555-4555-8555-555555555555/commands/dimming",
    payload: {},
    attempts: 0,
    createdAt: new Date("2026-08-26T00:00:00.000Z"),
    dispatch: {
      commandId: "11111111-1111-4111-8111-111111111111",
      gatewayId: "55555555-5555-4555-8555-555555555555",
      deliveryMode: "unicast",
      destinationAddress: null,
      meshControlGroupId: null,
      meshControlGroupVersion: null
    }
  };
}

function scanRecord(id: string) {
  return {
    id,
    sessionId: "11111111-1111-4111-8111-111111111111",
    scanAttempt: 1,
    topic: "sites/33333333-3333-4333-8333-333333333333/gateways/44444444-4444-4444-8444-444444444444/commands/provisioning/scan-start",
    payload: {},
    attempts: 0,
    createdAt: new Date("2026-08-26T00:00:00.000Z")
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((value) => { resolve = value; });
  return { promise, resolve };
}

function waitForTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
