import { createMqttConnectionOptions, MqttService } from "./mqtt.service";

jest.mock("node:fs", () => ({ readFileSync: jest.fn(() => Buffer.from("test-certificate")) }));

describe("MqttService", () => {
  const resyncRequest = {
    siteId: "22222222-2222-4222-8222-222222222222",
    gatewayId: "55555555-5555-4555-8555-555555555555",
    eventId: "77777777-7777-4777-8777-777777777777",
    occurredAt: "2026-08-23T09:00:00.000Z",
    reason: "state_missing"
  };
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
    const service = new MqttService(prisma, createMeshGroupsMock() as never);
    (service as any).client = { publish };

    await service.publishTopic("sites/s/gateways/g/commands/dimming", { ok: true });

    expect(publish).toHaveBeenCalledWith(
      "sites/s/gateways/g/commands/dimming",
      JSON.stringify({ ok: true }),
      { qos: 1, properties: { messageExpiryInterval: 10 } },
      expect.any(Function)
    );
  });

  it("subscribes to gateway mesh group resync requests at startup", () => {
    const subscribe = jest.fn();
    const on = jest.fn((event: string, listener: () => void) => {
      if (event === "connect") listener();
    });
    const service = new MqttService({} as never, createMeshGroupsMock() as never);
    (service as any).client = { on, subscribe };

    service.onModuleInit();

    expect(subscribe).toHaveBeenCalledWith(
      expect.arrayContaining(["sites/+/gateways/+/events/mesh-group/resync-request"]),
      { qos: 1 }
    );
  });

  it("does not resolve a QoS 1 publish until the MQTT callback confirms PUBACK", async () => {
    let callback: ((error?: Error) => void) | undefined;
    const client: any = {
      publish: jest.fn((_topic, _payload, _options, value) => {
        callback = value;
        return client;
      })
    };
    const service = new MqttService({} as never, createMeshGroupsMock() as never);
    (service as any).client = client;
    let settled = false;

    const publishing = service.publishTopic("sites/s/gateways/g/commands/dimming", { ok: true })
      .finally(() => { settled = true; });
    await Promise.resolve();

    expect(settled).toBe(false);
    callback?.();
    await expect(publishing).resolves.toBeUndefined();
  });

  it("cancels each concurrent QoS 1 packet by its own message ID on timeout", async () => {
    jest.useFakeTimers();
    try {
      let lastMessageId = 0;
      const callbacks = new Map<number, (error?: Error) => void>();
      const client: any = {
        publish: jest.fn((_topic, _payload, _options, callback) => {
          lastMessageId += 1;
          callbacks.set(lastMessageId, callback);
          return client;
        }),
        getLastMessageId: jest.fn(() => lastMessageId),
        removeOutgoingMessage: jest.fn((messageId: number) => {
          callbacks.get(messageId)?.(new Error("Message removed"));
          return client;
        })
      };
      const service = new MqttService({} as never, createMeshGroupsMock() as never);
      (service as any).client = client;

      const first = service.publishTopic("topic/first", { id: 1 }, { timeoutMs: 1_000 });
      const second = service.publishTopic("topic/second", { id: 2 }, { timeoutMs: 1_000 });
      const resultsPromise = Promise.allSettled([first, second]);
      await jest.advanceTimersByTimeAsync(1_000);

      const results = await resultsPromise;
      expect(results).toEqual([
        expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ message: "MQTT publish timed out after 1000ms" }) }),
        expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ message: "MQTT publish timed out after 1000ms" }) })
      ]);
      expect(client.removeOutgoingMessage).toHaveBeenNthCalledWith(1, 1);
      expect(client.removeOutgoingMessage).toHaveBeenNthCalledWith(2, 2);

      callbacks.get(1)?.();
      callbacks.get(2)?.();
      expect(client.removeOutgoingMessage).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("marks a gateway dispatch accepted from a scoped acceptance ACK", async () => {
    const prisma: any = {
      commandDispatch: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    };
    const service = new MqttService(prisma, createMeshGroupsMock() as never);
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
    const service = new MqttService(prisma, createMeshGroupsMock() as never);

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
    const service = new MqttService(prisma, createMeshGroupsMock() as never);
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
    const service = new MqttService(prisma, createMeshGroupsMock() as never);

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
    const service = new MqttService(prisma, createMeshGroupsMock() as never);
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

  it("handles a scoped mesh group resync request inside one database transaction", async () => {
    const tx = { transaction: true };
    const order: string[] = [];
    const prisma: any = {
      $transaction: jest.fn(async (callback: (client: any) => Promise<unknown>) => {
        const result = await callback(tx);
        order.push("transaction-committed");
        return result;
      })
    };
    const meshGroups = createMeshGroupsMock();
    meshGroups.resetGatewayGroupsForResync.mockImplementation(async () => {
      order.push("groups-reset");
      return { groupCount: 2, memberCount: 4 };
    });
    const service = new MqttService(prisma, meshGroups as never);
    jest.spyOn(service, "publishTopic").mockImplementation(async () => {
      order.push("ack-published");
    });

    await service.handleMessage(
      `sites/${resyncRequest.siteId}/gateways/${resyncRequest.gatewayId}/events/mesh-group/resync-request`,
      Buffer.from(JSON.stringify(resyncRequest))
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(meshGroups.resetGatewayGroupsForResync).toHaveBeenCalledWith(tx, {
      siteId: resyncRequest.siteId,
      gatewayId: resyncRequest.gatewayId,
      eventId: resyncRequest.eventId,
      occurredAt: resyncRequest.occurredAt
    });
    expect(service.publishTopic).toHaveBeenCalledWith(
      `sites/${resyncRequest.siteId}/gateways/${resyncRequest.gatewayId}/commands/mesh-group/resync-ack`,
      {
        siteId: resyncRequest.siteId,
        gatewayId: resyncRequest.gatewayId,
        eventId: expect.any(String),
        requestEventId: resyncRequest.eventId,
        occurredAt: expect.any(String)
      }
    );
    expect(order).toEqual(["groups-reset", "transaction-committed", "ack-published"]);
  });

  it("publishes the application ACK again when a resync event is redelivered", async () => {
    const tx = { transaction: true };
    const prisma: any = {
      $transaction: jest.fn(async (callback: (client: any) => Promise<unknown>) => callback(tx))
    };
    const service = new MqttService(prisma, createMeshGroupsMock() as never);
    jest.spyOn(service, "publishTopic").mockResolvedValue(undefined);
    const topic = `sites/${resyncRequest.siteId}/gateways/${resyncRequest.gatewayId}/events/mesh-group/resync-request`;
    const payload = Buffer.from(JSON.stringify(resyncRequest));

    await service.handleMessage(topic, payload);
    await service.handleMessage(topic, payload);

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(service.publishTopic).toHaveBeenCalledTimes(2);
  });

  it("does not publish a mesh group resync ACK when the database transaction fails", async () => {
    const databaseError = new Error("database unavailable");
    const prisma: any = {
      $transaction: jest.fn().mockRejectedValue(databaseError)
    };
    const service = new MqttService(prisma, createMeshGroupsMock() as never);
    jest.spyOn(service, "publishTopic").mockResolvedValue(undefined);

    await expect(service.handleMessage(
      `sites/${resyncRequest.siteId}/gateways/${resyncRequest.gatewayId}/events/mesh-group/resync-request`,
      Buffer.from(JSON.stringify(resyncRequest))
    )).rejects.toBe(databaseError);

    expect(service.publishTopic).not.toHaveBeenCalled();
  });

  it("surfaces mesh group resync ACK publish failures so the gateway can retry", async () => {
    const publishError = new Error("broker unavailable");
    const prisma: any = {
      $transaction: jest.fn(async (callback: (client: any) => Promise<unknown>) => callback({ transaction: true }))
    };
    const service = new MqttService(prisma, createMeshGroupsMock() as never);
    jest.spyOn(service, "publishTopic").mockRejectedValue(publishError);

    await expect(service.handleMessage(
      `sites/${resyncRequest.siteId}/gateways/${resyncRequest.gatewayId}/events/mesh-group/resync-request`,
      Buffer.from(JSON.stringify(resyncRequest))
    )).rejects.toBe(publishError);
  });

  it("ignores a mesh group resync request whose topic and payload scopes differ", async () => {
    const prisma: any = { $transaction: jest.fn() };
    const meshGroups = createMeshGroupsMock();
    const service = new MqttService(prisma, meshGroups as never);
    jest.spyOn(service, "publishTopic").mockResolvedValue(undefined);

    await service.handleMessage(
      `sites/${resyncRequest.siteId}/gateways/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/events/mesh-group/resync-request`,
      Buffer.from(JSON.stringify(resyncRequest))
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(meshGroups.resetGatewayGroupsForResync).not.toHaveBeenCalled();
    expect(service.publishTopic).not.toHaveBeenCalled();
  });

  it("persists only current-version mesh group subscription results from the same site and gateway", async () => {
    const groupId = "11111111-1111-4111-8111-111111111111";
    const nodeId1 = "22222222-2222-4222-8222-222222222222";
    const nodeId2 = "33333333-3333-4333-8333-333333333333";
    const outsideNodeId = "44444444-4444-4444-8444-444444444444";
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: groupId, gatewayId: "55555555-5555-4555-8555-555555555555", configurationVersion: 2 }]),
      meshControlGroup: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      meshControlGroupMember: {
        updateMany: jest.fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 1 }),
        findMany: jest.fn()
          .mockResolvedValueOnce([
            { groupId, gatewayId: "55555555-5555-4555-8555-555555555555", meshNodeId: nodeId1, subscriptionStatus: "pending", appliedVersion: 0, statusVersion: 0 },
            { groupId, gatewayId: "55555555-5555-4555-8555-555555555555", meshNodeId: nodeId2, subscriptionStatus: "pending", appliedVersion: 0, statusVersion: 0 }
          ])
          .mockResolvedValueOnce([
            { meshNodeId: nodeId1, subscriptionStatus: "applied", appliedVersion: 2, lastError: null, statusVersion: 2 },
            { meshNodeId: nodeId2, subscriptionStatus: "pending", appliedVersion: 0, lastError: null, statusVersion: 0 }
          ]),
      }
    };
    const prisma: any = { $transaction: jest.fn(async (callback: (client: any) => Promise<unknown>) => callback(tx)) };
    const service = new MqttService(prisma, createMeshGroupsMock() as never);

    await service.handleMessage(
      "sites/22222222-2222-4222-8222-222222222222/gateways/55555555-5555-4555-8555-555555555555/events/mesh-group/subscription-result",
      Buffer.from(JSON.stringify({
        siteId: "22222222-2222-4222-8222-222222222222",
        gatewayId: "55555555-5555-4555-8555-555555555555",
        groupId,
        version: 2,
        groupAddress: "0xc000",
        members: [
          { meshNodeId: nodeId1, status: "ready" },
          { meshNodeId: outsideNodeId, status: "failed", error: "ignore me" }
        ],
        occurredAt: "2026-08-20T09:00:01.000Z"
      }))
    );

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.meshControlGroupMember.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.meshControlGroupMember.updateMany).toHaveBeenCalledWith({
      where: {
        groupId,
        gatewayId: "55555555-5555-4555-8555-555555555555",
        meshNodeId: nodeId1
      },
      data: {
        subscriptionStatus: "applied",
        appliedVersion: 2,
        statusVersion: 2,
        lastError: null
      }
    });
    expect(tx.meshControlGroup.updateMany).toHaveBeenCalledWith({
      where: { id: groupId, gatewayId: "55555555-5555-4555-8555-555555555555", configurationVersion: 2 },
      data: {
        status: "configuring",
        lastError: null
      }
    });
  });

  it("does not fail the current version from an omitted member that only failed in an older version", async () => {
    const groupId = "11111111-1111-4111-8111-111111111111";
    const nodeId1 = "22222222-2222-4222-8222-222222222222";
    const nodeId2 = "33333333-3333-4333-8333-333333333333";
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: groupId, gatewayId: "55555555-5555-4555-8555-555555555555", configurationVersion: 2 }]),
      meshControlGroup: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      meshControlGroupMember: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn()
          .mockResolvedValueOnce([
            {
              groupId,
              gatewayId: "55555555-5555-4555-8555-555555555555",
              meshNodeId: nodeId1,
              subscriptionStatus: "pending",
              appliedVersion: 0,
              statusVersion: 0
            },
            {
              groupId,
              gatewayId: "55555555-5555-4555-8555-555555555555",
              meshNodeId: nodeId2,
              subscriptionStatus: "failed",
              appliedVersion: 0,
              statusVersion: 1
            }
          ])
          .mockResolvedValueOnce([
            { meshNodeId: nodeId1, subscriptionStatus: "applied", appliedVersion: 2, statusVersion: 2, lastError: null },
            { meshNodeId: nodeId2, subscriptionStatus: "failed", appliedVersion: 0, statusVersion: 1, lastError: "old failure" }
          ])
      }
    };
    const prisma: any = { $transaction: jest.fn(async (callback: (client: any) => Promise<unknown>) => callback(tx)) };
    const service = new MqttService(prisma, createMeshGroupsMock() as never);

    await service.handleMessage(
      "sites/22222222-2222-4222-8222-222222222222/gateways/55555555-5555-4555-8555-555555555555/events/mesh-group/subscription-result",
      Buffer.from(JSON.stringify({
        siteId: "22222222-2222-4222-8222-222222222222",
        gatewayId: "55555555-5555-4555-8555-555555555555",
        groupId,
        version: 2,
        groupAddress: "0xc000",
        members: [
          { meshNodeId: nodeId1, status: "ready" }
        ],
        occurredAt: "2026-08-20T09:00:01.000Z"
      }))
    );

    expect(tx.meshControlGroup.updateMany).toHaveBeenCalledWith({
      where: { id: groupId, gatewayId: "55555555-5555-4555-8555-555555555555", configurationVersion: 2 },
      data: {
        status: "configuring",
        lastError: null
      }
    });
  });

  it("locks the current group row before applying subscription results", async () => {
    const groupId = "11111111-1111-4111-8111-111111111111";
    const memberId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: groupId, gatewayId: "55555555-5555-4555-8555-555555555555", configurationVersion: 2 }]),
      meshControlGroupMember: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([
          { meshNodeId: memberId, subscriptionStatus: "applied", appliedVersion: 2, statusVersion: 2, lastError: null }
        ])
      },
      meshControlGroup: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    };
    const prisma: any = { $transaction: jest.fn(async (callback: (client: any) => Promise<unknown>) => callback(tx)) };
    const service = new MqttService(prisma, createMeshGroupsMock() as never);

    await service.handleMessage(
      "sites/22222222-2222-4222-8222-222222222222/gateways/55555555-5555-4555-8555-555555555555/events/mesh-group/subscription-result",
      Buffer.from(JSON.stringify({
        siteId: "22222222-2222-4222-8222-222222222222",
        gatewayId: "55555555-5555-4555-8555-555555555555",
        groupId,
        version: 2,
        groupAddress: "0xc000",
        members: [{ meshNodeId: memberId, status: "ready" }],
        occurredAt: "2026-08-20T09:00:01.000Z"
      }))
    );

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = String.raw({ raw: tx.$queryRaw.mock.calls[0][0] as readonly string[] }, ...tx.$queryRaw.mock.calls[0].slice(1));
    expect(sql).toContain('INNER JOIN "Gateway" gw ON gw."id" = g."gatewayId"');
    expect(sql).toContain("FOR UPDATE OF g");
    expect(sql).not.toMatch(/FOR UPDATE\s*$/);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.meshControlGroupMember.updateMany.mock.invocationCallOrder[0]
    );
  });

  it("ignores stale or foreign subscription results before touching members when no locked group row matches", async () => {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      meshControlGroupMember: {
        updateMany: jest.fn(),
        findMany: jest.fn()
      },
      meshControlGroup: {
        updateMany: jest.fn()
      }
    };
    const prisma: any = { $transaction: jest.fn(async (callback: (client: any) => Promise<unknown>) => callback(tx)) };
    const service = new MqttService(prisma, createMeshGroupsMock() as never);

    await service.handleMessage(
      "sites/22222222-2222-4222-8222-222222222222/gateways/55555555-5555-4555-8555-555555555555/events/mesh-group/subscription-result",
      Buffer.from(JSON.stringify({
        siteId: "22222222-2222-4222-8222-222222222222",
        gatewayId: "55555555-5555-4555-8555-555555555555",
        groupId: "11111111-1111-4111-8111-111111111111",
        version: 2,
        groupAddress: "0xc000",
        members: [{ meshNodeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "ready" }],
        occurredAt: "2026-08-20T09:00:01.000Z"
      }))
    );

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.meshControlGroupMember.updateMany).not.toHaveBeenCalled();
    expect(tx.meshControlGroup.updateMany).not.toHaveBeenCalled();
  });

  it("ignores legacy unscoped MQTT fixture-state events", async () => {
    const prisma = {
      fixture: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      command: { update: jest.fn() }
    };
    const service = new MqttService(prisma as never, createMeshGroupsMock() as never);

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
    const service = new MqttService(prisma as never, createMeshGroupsMock() as never);

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
    const meshGroups = createMeshGroupsMock();
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
        create: jest.fn().mockResolvedValue({ id: "22222222-2222-4222-8222-222222222222" })
      },
      groupFixture: {
        findMany: jest.fn().mockResolvedValue([
          { groupId: "55555555-5555-4555-8555-555555555555" },
          { groupId: "66666666-6666-4666-8666-666666666666" }
        ])
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
    const service = new MqttService(prisma as never, meshGroups as never);

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
        size: 20,
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
    expect(prisma.groupFixture.findMany).toHaveBeenCalledWith({
      where: { fixtureId: "22222222-2222-4222-8222-222222222222" },
      select: { groupId: true },
      orderBy: { groupId: "asc" }
    });
    expect(meshGroups.attachProvisionedNode).toHaveBeenCalledWith(prisma, {
      meshNodeId: "33333333-3333-4333-8333-333333333333",
      gatewayId: "00000000-0000-4000-8000-000000000004",
      floorId: "00000000-0000-4000-8000-000000000005",
      fixtureGroupIds: [
        "55555555-5555-4555-8555-555555555555",
        "66666666-6666-4666-8666-666666666666"
      ]
    });
  });

  it("reuses existing provisioning mappings for duplicate completion events and still attaches group memberships", async () => {
    const meshGroups = createMeshGroupsMock();
    const meshNodeId = "33333333-3333-4333-8333-333333333333";
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
        findFirst: jest.fn().mockResolvedValue({
          id: node.id,
          floorId: node.session.floorId,
          meshNodeId
        }),
        create: jest.fn()
      },
      groupFixture: {
        findMany: jest.fn().mockResolvedValue([{ groupId: "55555555-5555-4555-8555-555555555555" }])
      },
      command: { update: jest.fn() },
      discoveredMeshNode: {
        findFirst: jest.fn().mockResolvedValue(node),
        update: jest.fn().mockResolvedValue({ ...node, status: "provisioned" })
      },
      meshNode: {
        findUnique: jest.fn().mockResolvedValue({ id: meshNodeId, gatewayId: node.session.gatewayId }),
        create: jest.fn()
      }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma));
    const service = new MqttService(prisma as never, meshGroups as never);

    await service.handleMessage(
      "sites/00000000-0000-4000-8000-000000000003/gateways/00000000-0000-4000-8000-000000000004/events/provisioning-completed",
      Buffer.from(JSON.stringify({
        sessionId: node.sessionId,
        nodeId: node.id,
        deviceUuid: node.deviceUuid,
        meshAddress: "0x0101",
        firmwareVersion: "esp32h2-0.1.0",
        rssi: -61,
        hopCount: 1,
        completedAt: "2026-07-01T00:00:05.000Z"
      }))
    );

    expect(prisma.meshNode.create).not.toHaveBeenCalled();
    expect(prisma.fixture.create).not.toHaveBeenCalled();
    expect(meshGroups.attachProvisionedNode).toHaveBeenCalledWith(prisma, {
      meshNodeId,
      gatewayId: node.session.gatewayId,
      floorId: node.session.floorId,
      fixtureGroupIds: ["55555555-5555-4555-8555-555555555555"]
    });
  });

  it("fails provisioning completion when an existing fixture is assigned to another floor", async () => {
    const meshGroups = createMeshGroupsMock();
    const meshNodeId = "33333333-3333-4333-8333-333333333333";
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
        findFirst: jest.fn().mockResolvedValue({
          id: node.id,
          floorId: "99999999-9999-4999-8999-999999999999",
          meshNodeId
        }),
        create: jest.fn()
      },
      groupFixture: {
        findMany: jest.fn()
      },
      command: { update: jest.fn() },
      discoveredMeshNode: {
        findFirst: jest.fn().mockResolvedValue(node),
        update: jest.fn().mockResolvedValue({ ...node, status: "failed" })
      },
      meshNode: {
        findUnique: jest.fn().mockResolvedValue({ id: meshNodeId, gatewayId: node.session.gatewayId }),
        create: jest.fn()
      }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma));
    const service = new MqttService(prisma as never, meshGroups as never);

    await service.handleMessage(
      "sites/00000000-0000-4000-8000-000000000003/gateways/00000000-0000-4000-8000-000000000004/events/provisioning-completed",
      Buffer.from(JSON.stringify({
        sessionId: node.sessionId,
        nodeId: node.id,
        deviceUuid: node.deviceUuid,
        meshAddress: "0x0101",
        firmwareVersion: "esp32h2-0.1.0",
        rssi: -61,
        hopCount: 1,
        completedAt: "2026-07-01T00:00:05.000Z"
      }))
    );

    expect(prisma.fixture.findFirst).toHaveBeenCalledWith({
      where: { meshNodeId },
      select: { id: true, floorId: true }
    });
    expect(prisma.discoveredMeshNode.update).toHaveBeenCalledWith({
      where: { id: node.id },
      data: {
        status: "failed",
        errorMessage: "fixture is already assigned to another floor"
      }
    });
    expect(prisma.groupFixture.findMany).not.toHaveBeenCalled();
    expect(meshGroups.attachProvisionedNode).not.toHaveBeenCalled();
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
    const service = new MqttService(prisma, createMeshGroupsMock() as never);

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
    const service = new MqttService(prisma, createMeshGroupsMock() as never);

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
    const service = new MqttService(prisma, createMeshGroupsMock() as never);

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

  it("marks provisioning failures as requiring reconciliation before retry", async () => {
    const prisma = {
      fixture: { update: jest.fn() },
      command: { update: jest.fn() },
      discoveredMeshNode: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    };
    const service = new MqttService(prisma as never, createMeshGroupsMock() as never);

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
        },
        status: "provisioning"
      },
      data: {
        status: "reconcile_required",
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
    const service = new MqttService(prisma as never, createMeshGroupsMock() as never);

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

function createMeshGroupsMock() {
  return {
    attachProvisionedNode: jest.fn().mockResolvedValue(undefined),
    resetGatewayGroupsForResync: jest.fn().mockResolvedValue({ groupCount: 0, memberCount: 0 })
  };
}

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
