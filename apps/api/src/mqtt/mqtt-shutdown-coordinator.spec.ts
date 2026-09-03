import { Test } from "@nestjs/testing";
import { EventEmitter } from "node:events";
import { AutomationOutboxPublisherService } from "../automation/automation-outbox-publisher.service";
import { CommandTimeoutService } from "../commands/command-timeout.service";
import { MeshControlGroupService } from "../mesh-control-groups/mesh-control-group.service";
import { MeshGroupSyncWorker } from "../mesh-control-groups/mesh-group-sync.worker";
import { PrismaService } from "../prisma/prisma.service";
import { MqttModule } from "./mqtt.module";
import { MqttService } from "./mqtt.service";
import { MqttShutdownCoordinator } from "./mqtt-shutdown-coordinator.service";
import { OutboxPublisherService } from "./outbox-publisher.service";
import { ProvisioningDeviceOutboxPublisherService } from "./provisioning-device-outbox-publisher.service";
import { ProvisioningScanOutboxPublisherService } from "./provisioning-scan-outbox-publisher.service";

describe("MqttShutdownCoordinator", () => {
  it("drains command, scan, device, and automation outbox publishes before closing MQTT during Nest module close", async () => {
    const commandPublish = deferred<void>();
    const scanPublish = deferred<void>();
    const devicePublish = deferred<void>();
    const automationPublish = deferred<void>();
    const order: string[] = [];
    const mqtt = new MqttService({} as never, {} as never);
    const client: any = {
      on: jest.fn(),
      removeListener: jest.fn(),
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
        { provide: ProvisioningScanOutboxPublisherService, useValue: scanWorker },
        {
          provide: ProvisioningDeviceOutboxPublisherService,
          useValue: { stopAndDrain: jest.fn(() => devicePublish.promise) }
        },
        {
          provide: AutomationOutboxPublisherService,
          useValue: { stopAndDrain: jest.fn(() => automationPublish.promise) }
        },
        { provide: MeshGroupSyncWorker, useValue: { stopAndDrain: jest.fn().mockResolvedValue(undefined) } }
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
      await waitForTurn();
      expect(client.end).not.toHaveBeenCalled();

      devicePublish.resolve();
      await waitForTurn();
      expect(client.end).not.toHaveBeenCalled();

      automationPublish.resolve();
      await closing;

      expect(order).toEqual(["command-drained", "scan-drained", "client-end"]);
      expect(commandPublishClaimed).toHaveBeenCalledTimes(1);
      expect(scanPublishClaimed).toHaveBeenCalledTimes(1);
    } finally {
      commandPublish.resolve();
      scanPublish.resolve();
      devicePublish.resolve();
      automationPublish.resolve();
      await closing?.catch(() => undefined);
    }
  });

  it.each([
    ["when PUBACK callbacks complete", true],
    ["when PUBACK callbacks never arrive", false]
  ])("drains active mesh sync and inbound ACK handling before client.end in the production MQTT module %s", async (_case, completeCallbacks) => {
    jest.useFakeTimers({ doNotFake: ["setImmediate"] });
    const meshPublish = deferred<void>();
    const inboundReset = deferred<void>();
    const order: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);

    let meshPublishCallback: ((error?: Error) => void) | undefined;
    let ackPublishCallback: ((error?: Error) => void) | undefined;
    let lastMessageId = 0;
    let client: any;
    client = Object.assign(new EventEmitter(), {
      subscribe: jest.fn(),
      publish: jest.fn((topic: string, _payload: string, _options: object, callback: (error?: Error) => void) => {
        lastMessageId += 1;
        if (topic.endsWith("/commands/mesh-group/subscription-sync")) {
          order.push("mesh-publish-started");
          meshPublishCallback = (error?: Error) => {
            if (error) meshPublish.reject(error);
            else meshPublish.resolve();
            callback(error);
          };
        } else if (topic.endsWith("/commands/mesh-group/resync-ack")) {
          order.push("ack-publish-started");
          ackPublishCallback = callback;
        }
        return client;
      }),
      getLastMessageId: jest.fn(() => lastMessageId),
      removeOutgoingMessage: jest.fn(),
      end: jest.fn((_force: boolean, callback?: (error?: Error) => void) => {
        order.push("client-end");
        callback?.();
        return client;
      })
    });
    const prisma: any = {
      meshControlGroup: {
        findMany: jest.fn().mockResolvedValue([{
          id: "11111111-1111-4111-8111-111111111111",
          gatewayId: "55555555-5555-4555-8555-555555555555",
          configurationVersion: 2
        }])
      },
      $transaction: jest.fn(async (callback: (tx: object) => Promise<unknown>) => callback({ transaction: true }))
    };
    const meshGroups = {
      prepareSubscriptionSync: jest.fn().mockResolvedValue({
        siteId: "22222222-2222-4222-8222-222222222222",
        gatewayId: "55555555-5555-4555-8555-555555555555",
        groupId: "11111111-1111-4111-8111-111111111111",
        version: 2,
        groupAddress: "0xc000",
        desiredMembers: [],
        expectedOperations: [],
        requestedAt: "2026-08-26T00:00:00.000Z"
      }),
      resetGatewayGroupsForResync: jest.fn(async () => {
        await inboundReset.promise;
        return { groupCount: 1, memberCount: 0 };
      })
    };
    const moduleRef = await Test.createTestingModule({ imports: [MqttModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(MeshControlGroupService)
      .useValue(meshGroups)
      .compile();
    const mqtt = moduleRef.get(MqttService);
    const meshWorker = moduleRef.get(MeshGroupSyncWorker);
    const commandWorker = moduleRef.get(OutboxPublisherService);
    const scanWorker = moduleRef.get(ProvisioningScanOutboxPublisherService);
    const deviceWorker = moduleRef.get(ProvisioningDeviceOutboxPublisherService);
    const automationWorker = moduleRef.get(AutomationOutboxPublisherService);
    const commandTimeout = moduleRef.get(CommandTimeoutService);
    (mqtt as any).client = client;
    jest.spyOn(commandWorker, "claimBatch").mockResolvedValue([]);
    jest.spyOn(scanWorker, "claimBatch").mockResolvedValue([]);
    jest.spyOn(deviceWorker, "claimBatch").mockResolvedValue([]);
    jest.spyOn(automationWorker, "claimConfigBatch").mockResolvedValue([]);
    jest.spyOn(automationWorker, "claimApplicationAckBatch").mockResolvedValue([]);
    jest.spyOn(commandTimeout, "closeExpired").mockResolvedValue({ timedOut: 0 });
    const loggerError = jest.spyOn((mqtt as any).logger, "error").mockImplementation(() => undefined);
    const meshLoggerError = jest.spyOn((meshWorker as any).logger, "error").mockImplementation(() => undefined);
    let closing: Promise<void> | undefined;

    try {
      await moduleRef.init();
      await jest.advanceTimersByTimeAsync(10_000);
      expect(meshPublishCallback).toBeDefined();

      client.emit(
        "message",
        "sites/22222222-2222-4222-8222-222222222222/gateways/55555555-5555-4555-8555-555555555555/events/mesh-group/resync-request",
        Buffer.from(JSON.stringify({
          siteId: "22222222-2222-4222-8222-222222222222",
          gatewayId: "55555555-5555-4555-8555-555555555555",
          eventId: "77777777-7777-4777-8777-777777777777",
          occurredAt: "2026-08-26T00:00:00.000Z",
          reason: "state_missing"
        }))
      );
      await waitForTurn();
      expect(meshGroups.resetGatewayGroupsForResync).toHaveBeenCalledTimes(1);

      closing = moduleRef.close();
      await waitForTurn();
      expect(client.end).not.toHaveBeenCalled();
      expect(client.listenerCount("message")).toBe(0);

      client.emit(
        "message",
        "sites/22222222-2222-4222-8222-222222222222/gateways/55555555-5555-4555-8555-555555555555/events/mesh-group/resync-request",
        Buffer.from("later-message")
      );
      expect(meshGroups.resetGatewayGroupsForResync).toHaveBeenCalledTimes(1);

      inboundReset.resolve();
      await waitForTurn();
      expect(ackPublishCallback).toBeDefined();
      expect(client.end).not.toHaveBeenCalled();

      if (completeCallbacks) {
        ackPublishCallback?.(Object.assign(new Error("payload=private-ack"), { code: "PRIVATE_ACK" }));
        await waitForTurn();
        expect(client.end).not.toHaveBeenCalled();

        meshPublishCallback?.();
        await meshPublish.promise;
      } else {
        await jest.advanceTimersByTimeAsync(9_999);
        expect(client.end).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        expect(client.end).toHaveBeenCalledTimes(1);
      }
      await closing;
      await waitForTurn();

      expect(unhandled).toEqual([]);
      expect(loggerError).toHaveBeenCalledWith("mqtt inbound message handling failed (error=UNEXPECTED_ERROR)");
      expect(JSON.stringify(loggerError.mock.calls)).not.toContain(completeCallbacks ? "private-ack" : "timed out");
      expect(order).toEqual(["mesh-publish-started", "ack-publish-started", "client-end"]);
      if (completeCallbacks) {
        expect(client.removeOutgoingMessage).not.toHaveBeenCalled();
      } else {
        expect(client.removeOutgoingMessage).toHaveBeenNthCalledWith(1, 1);
        expect(client.removeOutgoingMessage).toHaveBeenNthCalledWith(2, 2);
        expect(meshLoggerError).toHaveBeenCalledWith(
          "mesh control group sync publish failed",
          expect.objectContaining({ error: "UNEXPECTED_ERROR" })
        );
        expect(JSON.stringify(meshLoggerError.mock.calls)).not.toContain("timed out");
      }
      await expect(meshWorker.stopAndDrain()).resolves.toBeUndefined();
    } finally {
      if (client.end.mock.calls.length > 0 && !ackPublishCallback) {
        jest.spyOn(mqtt, "publishTopic").mockResolvedValue(undefined);
      }
      inboundReset.resolve();
      ackPublishCallback?.();
      meshPublishCallback?.();
      meshPublish.resolve();
      await closing?.catch(() => undefined);
      await moduleRef.close().catch(() => undefined);
      process.off("unhandledRejection", onUnhandled);
      jest.useRealTimers();
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
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function waitForTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
