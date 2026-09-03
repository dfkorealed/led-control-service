import { Logger } from "@nestjs/common";
import { EventEmitter } from "node:events";
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

  it("uses a deployment-specific persistent MQTT 5 API session", () => {
    const { options } = createMqttConnectionOptions({
      MQTT_URL: "mqtts://broker:8883",
      MQTT_CA_PATH: "/certs/ca.crt",
      MQTT_CLIENT_CERT_PATH: "/certs/api.crt",
      MQTT_CLIENT_KEY_PATH: "/certs/api.key",
      MQTT_API_INSTANCE_ID: "api-blue-2"
    });

    expect(options).toMatchObject({
      clientId: "api-service-api-blue-2",
      clean: false,
      protocolVersion: 5
    });
    expect(options.properties).toEqual({ sessionExpiryInterval: 86_400 });
  });

  it("awaits the MQTT end callback and reuses one close promise", async () => {
    let finishClose: ((error?: Error) => void) | undefined;
    const client: any = {
      end: jest.fn((_force: boolean, callback?: (error?: Error) => void) => {
        finishClose = callback;
        return client;
      })
    };
    const service = new MqttService({} as never, createMeshGroupsMock() as never);
    (service as any).client = client;

    const closing = service.close();
    expect(service.close()).toBe(closing);
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();

    expect(client.end).toHaveBeenCalledWith(false, expect.any(Function));
    expect(closed).toBe(false);

    finishClose?.();
    await closing;
    expect(closed).toBe(true);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("forces MQTT close after the graceful timeout and awaits the force-close callback", async () => {
    jest.useFakeTimers();
    const loggerWarn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    let finishForceClose: ((error?: Error) => void) | undefined;
    const client: any = {
      end: jest.fn((force: boolean, callback?: (error?: Error) => void) => {
        if (force) finishForceClose = callback;
        return client;
      })
    };
    const service = new MqttService({} as never, createMeshGroupsMock() as never);
    (service as any).client = client;

    try {
      const closing = service.close();
      let closed = false;
      void closing.then(() => { closed = true; });
      expect(client.end).toHaveBeenNthCalledWith(1, false, expect.any(Function));

      await jest.advanceTimersByTimeAsync(4_999);
      expect(client.end).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);

      expect(client.end).toHaveBeenNthCalledWith(2, true, expect.any(Function));
      expect(loggerWarn).toHaveBeenCalledWith("MQTT client graceful close timed out; forcing close");
      expect(closed).toBe(false);

      finishForceClose?.();
      await closing;
      expect(closed).toBe(true);
    } finally {
      loggerWarn.mockRestore();
      jest.useRealTimers();
    }
  });

  it("finishes shutdown when the forced MQTT end callback also stalls", async () => {
    jest.useFakeTimers();
    const loggerWarn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    const client: any = { end: jest.fn(() => client) };
    const service = new MqttService({} as never, createMeshGroupsMock() as never);
    (service as any).client = client;

    try {
      const closing = service.close();
      await jest.advanceTimersByTimeAsync(5_999);
      let closed = false;
      void closing.then(() => { closed = true; });
      await Promise.resolve();
      expect(closed).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      await closing;

      expect(client.end).toHaveBeenNthCalledWith(2, true, expect.any(Function));
      expect(loggerWarn).toHaveBeenCalledWith("MQTT client forced close callback timed out; continuing shutdown");
    } finally {
      loggerWarn.mockRestore();
      jest.useRealTimers();
    }
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

  it("publishes durable automation payloads without command message expiry", async () => {
    const publish = jest.fn((_topic, _payload, _options, callback) => callback());
    const service = new MqttService({} as never, createMeshGroupsMock() as never);
    (service as any).client = { publish };

    await service.publishTopic(
      "sites/s/gateways/g/acks/automation/execution-ingested",
      { stored: true },
      { messageExpiryInterval: null, timeoutMs: 10_000 }
    );

    expect(publish).toHaveBeenCalledWith(
      "sites/s/gateways/g/acks/automation/execution-ingested",
      JSON.stringify({ stored: true }),
      { qos: 1 },
      expect.any(Function)
    );
  });

  it("publishes every provisioning command on the v2 provisioning command namespace", async () => {
    const service = new MqttService({} as never, createMeshGroupsMock() as never);
    const publishTopic = jest.spyOn(service, "publishTopic").mockResolvedValue(undefined);
    const base = {
      sessionId: "11111111-1111-4111-8111-111111111111",
      siteId: "22222222-2222-4222-8222-222222222222",
      gatewayId: "33333333-3333-4333-8333-333333333333",
      nodeId: "44444444-4444-4444-8444-444444444444",
      requestedAt: "2026-08-26T00:00:00.000Z"
    };
    await service.publishIdentifyDevice({ ...base, deviceUuid: "device-1" });
    await service.publishProvisionDevice({ ...base, deviceUuid: "device-1", meshAddress: "0x0100" });

    expect(publishTopic).toHaveBeenNthCalledWith(1, "sites/22222222-2222-4222-8222-222222222222/gateways/33333333-3333-4333-8333-333333333333/commands/provisioning/identify-device", expect.any(Object));
    expect(publishTopic).toHaveBeenNthCalledWith(2, "sites/22222222-2222-4222-8222-222222222222/gateways/33333333-3333-4333-8333-333333333333/commands/provisioning/provision-device", expect.any(Object));
  });

  it("records zero-node scan completion as completed under a session row lock", async () => {
    const siteId = "22222222-2222-4222-8222-222222222222";
    const gatewayId = "33333333-3333-4333-8333-333333333333";
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const scanCorrelationId = "44444444-4444-4444-8444-444444444444";
    const prisma: any = {
      provisioningSession: {
        findUnique: jest.fn().mockResolvedValue({ id: sessionId, siteId, gatewayId, status: "active", scanStatus: "scanning", scanCorrelationId, scanAttempt: 1 }),
        update: jest.fn()
      },
      processedGatewayEvent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      discoveredMeshNode: { upsert: jest.fn().mockResolvedValue(undefined) },
      mqttOutbox: createScanAckOutboxMock()
    };
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    const order: string[] = [];
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => {
      const result = await callback(prisma);
      order.push("transaction-committed");
      return result;
    });
    const service = new MqttService(prisma, createMeshGroupsMock() as never);
    const publishTopic = jest.spyOn(service, "publishTopic").mockResolvedValue(undefined);
    const base = {
      sessionId, scanCorrelationId, scanAttempt: 1, siteId, gatewayId,
      eventId: "55555555-5555-4555-8555-555555555555", sequence: 1, occurredAt: "2026-08-26T00:00:01.000Z"
    };

    await service.handleMessage(`sites/${siteId}/gateways/${gatewayId}/events/provisioning/scan-completed`, Buffer.from(JSON.stringify({
      ...base, eventId: "66666666-6666-4666-8666-666666666666", sequence: 2, acceptedNodeCount: 0
    })));

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect((prisma.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join("")).toContain("FOR UPDATE");
    expect(prisma.provisioningSession.update).toHaveBeenCalledWith({
      where: { id: sessionId },
      data: { scanStatus: "completed", scanCompletedAt: new Date(base.occurredAt), scanFailureCode: null, scanFailureMessage: null }
    });
    expect(prisma.processedGatewayEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      eventId: "66666666-6666-4666-8666-666666666666", gatewayId, sequence: 2n, eventType: "provisioning_scan_completed"
    }) });
    expect(prisma.mqttOutbox.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      applicationAckKey: `provisioning-scan-terminal:${gatewayId}:66666666-6666-4666-8666-666666666666:2`,
      topic: `sites/${siteId}/gateways/${gatewayId}/acks/provisioning/scan-terminal-ingested`
    }) });
    expect(publishTopic).not.toHaveBeenCalled();
    expect(order).toEqual(["transaction-committed"]);
  });

  it("requeues the durable application ACK for an already committed duplicate terminal", async () => {
    const siteId = "22222222-2222-4222-8222-222222222222";
    const gatewayId = "33333333-3333-4333-8333-333333333333";
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const scanCorrelationId = "44444444-4444-4444-8444-444444444444";
    const event = {
      sessionId, siteId, gatewayId, scanCorrelationId, scanAttempt: 1,
      eventId: "66666666-6666-4666-8666-666666666666", sequence: 2,
      occurredAt: "2026-08-26T00:00:01.000Z", acceptedNodeCount: 0
    };
    const session: any = {
      id: sessionId, siteId, gatewayId, status: "active", scanStatus: "scanning",
      scanCorrelationId, scanAttempt: 1, scanCompletedAt: null,
      scanFailureCode: null, scanFailureMessage: null
    };
    const markers: any[] = [];
    const mqttOutbox = createScanAckOutboxMock();
    const prisma: any = {
      provisioningSession: {
        findUnique: jest.fn(async () => session),
        update: jest.fn(async ({ data }) => Object.assign(session, data))
      },
      processedGatewayEvent: {
        findFirst: jest.fn(async ({ where }) => where.eventId
          ? markers.find((marker) => marker.eventId === where.eventId) ?? null
          : null),
        create: jest.fn(async ({ data }) => { markers.push(data); })
      },
      mqttOutbox
    };
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const service = new MqttService(prisma, createMeshGroupsMock() as never);
    const publishTopic = jest.spyOn(service, "publishTopic").mockResolvedValue(undefined);
    const topic = `sites/${siteId}/gateways/${gatewayId}/events/provisioning/scan-completed`;
    const payload = Buffer.from(JSON.stringify(event));

    await service.handleMessage(topic, payload);
    session.status = "completed";
    await service.handleMessage(topic, payload);

    expect(prisma.provisioningSession.update).toHaveBeenCalledTimes(1);
    expect(prisma.processedGatewayEvent.create).toHaveBeenCalledTimes(1);
    expect(mqttOutbox.create).toHaveBeenCalledTimes(1);
    expect(mqttOutbox.updateMany).toHaveBeenCalledTimes(1);
    expect(publishTopic).not.toHaveBeenCalled();
  });

  it("stores the durable ACK when the same terminal is redelivered after a transaction failure", async () => {
    const siteId = "22222222-2222-4222-8222-222222222222";
    const gatewayId = "33333333-3333-4333-8333-333333333333";
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const scanCorrelationId = "44444444-4444-4444-8444-444444444444";
    const prisma: any = {
      provisioningSession: {
        findUnique: jest.fn().mockResolvedValue({
          id: sessionId, siteId, gatewayId, status: "active", scanStatus: "scanning", scanCorrelationId, scanAttempt: 1
        }),
        update: jest.fn().mockRejectedValueOnce(new Error("transaction failed")).mockResolvedValueOnce(undefined)
      },
      processedGatewayEvent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      mqttOutbox: createScanAckOutboxMock(),
      $queryRaw: jest.fn().mockResolvedValue([])
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const service = new MqttService(prisma, createMeshGroupsMock() as never);
    const publishTopic = jest.spyOn(service, "publishTopic").mockResolvedValue(undefined);

    const topic = `sites/${siteId}/gateways/${gatewayId}/events/provisioning/scan-failed`;
    const payload = Buffer.from(JSON.stringify({
      sessionId, siteId, gatewayId, scanCorrelationId, scanAttempt: 1,
      eventId: "66666666-6666-4666-8666-666666666666", sequence: 2,
      occurredAt: "2026-08-26T00:00:01.000Z", code: "scan_timeout",
      message: "조명 검색 시간이 초과되었습니다."
    }));

    await expect(service.handleMessage(topic, payload)).rejects.toThrow("transaction failed");

    expect(publishTopic).not.toHaveBeenCalled();
    await expect(service.handleMessage(topic, payload)).resolves.toBeUndefined();
    expect(prisma.mqttOutbox.create).toHaveBeenCalledTimes(1);
    expect(publishTopic).not.toHaveBeenCalled();
  });

  it("stores the scan terminal ACK durably without coupling broker PUBACK to an MQTT publish", async () => {
    const siteId = "22222222-2222-4222-8222-222222222222";
    const gatewayId = "33333333-3333-4333-8333-333333333333";
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const scanCorrelationId = "44444444-4444-4444-8444-444444444444";
    const prisma: any = {
      provisioningSession: {
        findUnique: jest.fn().mockResolvedValue({
          id: sessionId, siteId, gatewayId, status: "active", scanStatus: "scanning",
          scanCorrelationId, scanAttempt: 1
        }),
        update: jest.fn().mockResolvedValue(undefined)
      },
      processedGatewayEvent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      mqttOutbox: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }) => ({ ...data, id: "scan-ack-outbox" })),
        updateMany: jest.fn()
      },
      $queryRaw: jest.fn().mockResolvedValue([])
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const service = new MqttService(prisma, createMeshGroupsMock() as never);
    const publishTopic = jest.spyOn(service, "publishTopic").mockRejectedValue(new Error("Connection closed"));

    await expect(service.handleMessage(
      `sites/${siteId}/gateways/${gatewayId}/events/provisioning/scan-completed`,
      Buffer.from(JSON.stringify({
        sessionId, siteId, gatewayId, scanCorrelationId, scanAttempt: 1,
        eventId: "66666666-6666-4666-8666-666666666666", sequence: 2,
        occurredAt: "2026-08-26T00:00:01.000Z", acceptedNodeCount: 1
      }))
    )).resolves.toBeUndefined();

    expect(publishTopic).not.toHaveBeenCalled();
    expect(prisma.mqttOutbox.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      gatewayId,
      applicationAckKey: `provisioning-scan-terminal:${gatewayId}:66666666-6666-4666-8666-666666666666:2`,
      topic: `sites/${siteId}/gateways/${gatewayId}/acks/provisioning/scan-terminal-ingested`,
      payloadHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
    }) });
  });

  it("revives a durable terminal ACK when the same committed event is redelivered", async () => {
    const siteId = "22222222-2222-4222-8222-222222222222";
    const gatewayId = "33333333-3333-4333-8333-333333333333";
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const scanCorrelationId = "44444444-4444-4444-8444-444444444444";
    const event = {
      sessionId, siteId, gatewayId, scanCorrelationId, scanAttempt: 1,
      eventId: "66666666-6666-4666-8666-666666666666", sequence: 2,
      occurredAt: "2026-08-26T00:00:01.000Z", acceptedNodeCount: 0
    };
    const session: any = {
      id: sessionId, siteId, gatewayId, status: "active", scanStatus: "scanning",
      scanCorrelationId, scanAttempt: 1, scanCompletedAt: null,
      scanFailureCode: null, scanFailureMessage: null
    };
    const markers: any[] = [];
    const mqttOutbox = createScanAckOutboxMock();
    const prisma: any = {
      provisioningSession: {
        findUnique: jest.fn(async () => session),
        update: jest.fn(async ({ data }) => Object.assign(session, data))
      },
      processedGatewayEvent: {
        findFirst: jest.fn(async ({ where }) => where.eventId
          ? markers.find((marker) => marker.eventId === where.eventId) ?? null
          : null),
        create: jest.fn(async ({ data }) => { markers.push(data); })
      },
      mqttOutbox,
      $queryRaw: jest.fn().mockResolvedValue([])
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const service = new MqttService(prisma, createMeshGroupsMock() as never);
    const publishTopic = jest.spyOn(service, "publishTopic").mockResolvedValue(undefined);
    const topic = `sites/${siteId}/gateways/${gatewayId}/events/provisioning/scan-completed`;
    const payload = Buffer.from(JSON.stringify(event));

    await expect(service.handleMessage(topic, payload)).resolves.toBeUndefined();
    session.status = "completed";
    await expect(service.handleMessage(topic, payload)).resolves.toBeUndefined();

    expect(prisma.provisioningSession.update).toHaveBeenCalledTimes(1);
    expect(prisma.processedGatewayEvent.create).toHaveBeenCalledTimes(1);
    expect(mqttOutbox.create).toHaveBeenCalledTimes(1);
    expect(mqttOutbox.updateMany).toHaveBeenCalledTimes(1);
    expect(publishTopic).not.toHaveBeenCalled();
  });

  it("stores a correlated scan failure and ignores wrong correlation, attempt, scope, duplicate, and lower sequence events", async () => {
    const siteId = "22222222-2222-4222-8222-222222222222";
    const gatewayId = "33333333-3333-4333-8333-333333333333";
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const scanCorrelationId = "44444444-4444-4444-8444-444444444444";
    const session = { id: sessionId, siteId, gatewayId, status: "active", scanStatus: "scanning", scanCorrelationId, scanAttempt: 2 };
    const prisma: any = {
      provisioningSession: { findUnique: jest.fn().mockResolvedValue(session), update: jest.fn() },
      processedGatewayEvent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      discoveredMeshNode: { upsert: jest.fn() },
      mqttOutbox: createScanAckOutboxMock()
    };
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const service = new MqttService(prisma, createMeshGroupsMock() as never);
    jest.spyOn(service, "publishTopic").mockResolvedValue(undefined);
    const topic = `sites/${siteId}/gateways/${gatewayId}/events/provisioning/scan-failed`;
    const base = {
      sessionId, siteId, gatewayId, scanCorrelationId, scanAttempt: 2,
      eventId: "55555555-5555-4555-8555-555555555555", sequence: 8, occurredAt: "2026-08-26T00:00:08.000Z",
      code: "scan_timeout", message: "조명 검색 시간이 초과되었습니다."
    };

    await service.handleMessage(topic, Buffer.from(JSON.stringify(base)));
    expect(prisma.provisioningSession.update).toHaveBeenCalledWith({
      where: { id: sessionId },
      data: { scanStatus: "failed", scanCompletedAt: new Date(base.occurredAt), scanFailureCode: "scan_timeout", scanFailureMessage: "조명 검색 시간이 초과되었습니다." }
    });
    expect(prisma.processedGatewayEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: "provisioning_scan_failed", sequence: 8n }) });

    prisma.provisioningSession.update.mockClear();
    await service.handleMessage(topic, Buffer.from(JSON.stringify({ ...base, eventId: "66666666-6666-4666-8666-666666666666", scanCorrelationId: "77777777-7777-4777-8777-777777777777" })));
    await service.handleMessage(topic, Buffer.from(JSON.stringify({ ...base, eventId: "77777777-7777-4777-8777-777777777777", scanAttempt: 1 })));
    await service.handleMessage(`sites/${siteId}/gateways/88888888-8888-4888-8888-888888888888/events/provisioning/scan-failed`, Buffer.from(JSON.stringify({ ...base, eventId: "88888888-8888-4888-8888-888888888888" })));
    prisma.processedGatewayEvent.findFirst.mockResolvedValueOnce({ eventId: "older-or-duplicate" });
    await service.handleMessage(topic, Buffer.from(JSON.stringify({ ...base, eventId: "99999999-9999-4999-8999-999999999999", sequence: 7 })));

    expect(prisma.provisioningSession.update).not.toHaveBeenCalled();
  });

  it("rolls back the scan event marker when its state mutation fails", async () => {
    const siteId = "22222222-2222-4222-8222-222222222222";
    const gatewayId = "33333333-3333-4333-8333-333333333333";
    const markers: string[] = [];
    const prisma: any = {
      provisioningSession: { findUnique: jest.fn().mockResolvedValue({
        id: "11111111-1111-4111-8111-111111111111", siteId, gatewayId, status: "active", scanStatus: "scanning",
        scanCorrelationId: "44444444-4444-4444-8444-444444444444", scanAttempt: 1
      }) },
      processedGatewayEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }) => { markers.push(data.eventId); })
      },
      discoveredMeshNode: { upsert: jest.fn().mockRejectedValue(new Error("database write failed")) }
    };
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => {
      const checkpoint = [...markers];
      try {
        return await callback(prisma);
      } catch (error) {
        markers.splice(0, markers.length, ...checkpoint);
        throw error;
      }
    });
    const service = new MqttService(prisma, createMeshGroupsMock() as never);

    await expect(service.handleMessage(`sites/${siteId}/gateways/${gatewayId}/events/provisioning/scan-found`, Buffer.from(JSON.stringify({
      sessionId: "11111111-1111-4111-8111-111111111111", siteId, gatewayId,
      scanCorrelationId: "44444444-4444-4444-8444-444444444444", scanAttempt: 1,
      eventId: "55555555-5555-4555-8555-555555555555", sequence: 1, occurredAt: "2026-08-26T00:00:01.000Z",
      deviceUuid: "device-1", serialNumber: "serial-1", rssi: -50, oobCapability: "none", firmwareVersion: "1.0.0"
    })))).rejects.toThrow("database write failed");

    expect(markers).toEqual([]);
  });

  it("ignores a delayed found event after its scan is terminal", async () => {
    const siteId = "22222222-2222-4222-8222-222222222222";
    const gatewayId = "33333333-3333-4333-8333-333333333333";
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const scanCorrelationId = "44444444-4444-4444-8444-444444444444";
    const prisma: any = {
      provisioningSession: {
        findUnique: jest.fn().mockResolvedValue({ id: sessionId, siteId, gatewayId, status: "active", scanStatus: "completed", scanCorrelationId, scanAttempt: 1 })
      },
      processedGatewayEvent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      discoveredMeshNode: { upsert: jest.fn() }
    };
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const service = new MqttService(prisma, createMeshGroupsMock() as never);

    await service.handleMessage(`sites/${siteId}/gateways/${gatewayId}/events/provisioning/scan-found`, Buffer.from(JSON.stringify({
      sessionId, scanCorrelationId, scanAttempt: 1, siteId, gatewayId,
      eventId: "55555555-5555-4555-8555-555555555555", sequence: 3, occurredAt: "2026-08-26T00:00:03.000Z",
      deviceUuid: "device-1", serialNumber: "serial-1", rssi: -50, oobCapability: "none", firmwareVersion: "1.0.0"
    })));

    expect(prisma.discoveredMeshNode.upsert).not.toHaveBeenCalled();
  });

  it("subscribes to gateway mesh group and automation inbound topics at startup", () => {
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
    expect(subscribe).toHaveBeenCalledWith(
      [
        "sites/+/gateways/+/events/automation/config-applied",
        "sites/+/gateways/+/events/automation/current-config-request",
        "sites/+/gateways/+/events/automation/execution",
        "sites/+/gateways/+/events/automation/vehicle-sensor-capability"
      ],
      { qos: 1 }
    );
  });

  it("delegates exact automation channels without accepting suffix-spoofed topics", async () => {
    const automation = { handleMessage: jest.fn().mockResolvedValue(undefined) };
    const service = new MqttService(
      {} as never,
      createMeshGroupsMock() as never,
      undefined,
      automation as never
    );
    const payload = Buffer.from("{}");

    await service.handleMessage(
      "prefix/sites/site/gateways/gateway/events/automation/execution",
      payload
    );
    await service.handleMessage(
      "sites/site/gateways/gateway/events/automation/execution/forged-suffix",
      payload
    );
    expect(automation.handleMessage).not.toHaveBeenCalled();

    await service.handleMessage(
      "sites/site/gateways/gateway/events/automation/execution",
      payload
    );
    expect(automation.handleMessage).toHaveBeenCalledWith(
      "sites/site/gateways/gateway/events/automation/execution",
      payload
    );
  });

  it("detaches inbound messages, drains the active handler, and contains a redacted rejection", async () => {
    const activeHandler = deferred<void>();
    const handlerStarted = deferred<void>();
    const client = Object.assign(new EventEmitter(), {
      subscribe: jest.fn()
    });
    const service = new MqttService({} as never, createMeshGroupsMock() as never);
    (service as any).client = client;
    const sensitiveError = Object.assign(new Error("payload=private-token"), {
      name: "PrivateHandlerFailure",
      code: "PRIVATE_CODE"
    });
    const handleMessage = jest.spyOn(service, "handleMessage").mockImplementation(async () => {
      handlerStarted.resolve();
      await activeHandler.promise;
      throw sensitiveError;
    });
    const loggerError = jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);

    service.onModuleInit();
    client.emit("message", "sites/private/topic", Buffer.from("private-payload"));
    await handlerStarted.promise;
    expect(handleMessage).toHaveBeenCalledTimes(1);

    const stopping = service.stopInboundAndDrain();
    expect(service.stopInboundAndDrain()).toBe(stopping);
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(client.listenerCount("message")).toBe(0);

    client.emit("message", "sites/private/topic", Buffer.from("later-private-payload"));
    activeHandler.resolve();
    await stopping;

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(loggerError).toHaveBeenCalledWith("mqtt inbound message handling failed (error=UNEXPECTED_ERROR)");
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain("private-token");
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain("PRIVATE_CODE");
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain("PrivateHandlerFailure");
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain("private-payload");
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
      commandDispatch: { updateMany: jest.fn() },
      commandFixtureResult: { updateMany: jest.fn() }
    };
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const service = new MqttService(prisma, createMeshGroupsMock() as never);

    await service.handleMessage(
      "sites/22222222-2222-4222-8222-222222222222/gateways/55555555-5555-4555-8555-555555555555/acks/device-status",
      Buffer.from(JSON.stringify(deviceStatusAckPayload()))
    );

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect((prisma.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join("")).toContain("FOR UPDATE OF d");
    expect(prisma.commandDispatch.updateMany).not.toHaveBeenCalled();
    expect(prisma.commandFixtureResult.updateMany).not.toHaveBeenCalled();
  });

  it("stores fixture results from a device status ACK", async () => {
    const prisma = deviceAckPrisma(["99999999-9999-4999-8999-999999999999"]);
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

  it.each([
    ["missing", [fixtureResult("99999999-9999-4999-8999-999999999999", "succeeded")]],
    ["duplicate", [
      fixtureResult("99999999-9999-4999-8999-999999999999", "succeeded"),
      fixtureResult("99999999-9999-4999-8999-999999999999", "succeeded")
    ]],
    ["outside", [
      fixtureResult("99999999-9999-4999-8999-999999999999", "succeeded"),
      fixtureResult("aaaaaaaa-9999-4999-8999-999999999999", "succeeded")
    ]]
  ])("fails the entire dispatch for a %s fixture result set", async (_case, results) => {
    const expectedFixtureIds = [
      "99999999-9999-4999-8999-999999999999",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    ];
    const prisma = deviceAckPrisma(expectedFixtureIds);
    const service = new MqttService(prisma as never, createMeshGroupsMock() as never);

    await service.handleMessage(deviceStatusTopic(), Buffer.from(JSON.stringify({
      ...deviceStatusAckPayload(),
      status: results.every((result) => result.status === "succeeded") ? "succeeded" : "failed",
      results
    })));

    expect(prisma.commandDispatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "failed",
        errorCode: "ack_fixture_set_mismatch"
      })
    }));
    expect(prisma.commandFixtureResult.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.commandFixtureResult.updateMany).toHaveBeenCalledWith({
      where: { dispatchId: deviceStatusAckPayload().dispatchId },
      data: expect.objectContaining({
        status: "failed",
        errorMessage: "device status ACK fixture set mismatch"
      })
    });
  });

  it.each([
    ["succeeded", [fixtureResult("99999999-9999-4999-8999-999999999999", "succeeded"), fixtureResult("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "failed")]],
    ["partially_succeeded", [fixtureResult("99999999-9999-4999-8999-999999999999", "failed"), fixtureResult("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "timed_out")]],
    ["timed_out", [fixtureResult("99999999-9999-4999-8999-999999999999", "timed_out"), fixtureResult("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "failed")]]
  ])("fails the entire dispatch when aggregate status %s disagrees with fixture results", async (status, results) => {
    const prisma = deviceAckPrisma(results.map((result) => result.fixtureId));
    const service = new MqttService(prisma as never, createMeshGroupsMock() as never);

    await service.handleMessage(deviceStatusTopic(), Buffer.from(JSON.stringify({
      ...deviceStatusAckPayload(),
      status,
      results
    })));

    expect(prisma.commandDispatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "failed",
        errorCode: "ack_status_mismatch"
      })
    }));
    expect(prisma.commandFixtureResult.updateMany).toHaveBeenCalledTimes(1);
  });

  it("accepts a complete fixture set when its aggregate status is derived from the individual results", async () => {
    const results = [
      fixtureResult("99999999-9999-4999-8999-999999999999", "succeeded"),
      fixtureResult("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "timed_out")
    ];
    const prisma = deviceAckPrisma(results.map((result) => result.fixtureId));
    const service = new MqttService(prisma as never, createMeshGroupsMock() as never);

    await service.handleMessage(deviceStatusTopic(), Buffer.from(JSON.stringify({
      ...deviceStatusAckPayload(),
      status: "partially_succeeded",
      results
    })));

    expect(prisma.commandDispatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "failed", errorCode: null, errorMessage: null })
    }));
    expect(prisma.commandFixtureResult.updateMany).toHaveBeenCalledTimes(2);
  });

  it("accepts failed precedence when failed and timed-out fixture results are mixed", async () => {
    const results = [
      fixtureResult("99999999-9999-4999-8999-999999999999", "failed"),
      fixtureResult("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "timed_out")
    ];
    const prisma = deviceAckPrisma(results.map((result) => result.fixtureId));
    const service = new MqttService(prisma as never, createMeshGroupsMock() as never);

    await service.handleMessage(deviceStatusTopic(), Buffer.from(JSON.stringify({
      ...deviceStatusAckPayload(),
      status: "failed",
      results
    })));

    expect(prisma.commandDispatch.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "failed", errorCode: null, errorMessage: null })
    }));
    expect(prisma.commandFixtureResult.updateMany).toHaveBeenCalledTimes(2);
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
      occurredAt: resyncRequest.occurredAt,
      reason: resyncRequest.reason
    });
    expect(service.publishTopic).toHaveBeenCalledWith(
      `sites/${resyncRequest.siteId}/gateways/${resyncRequest.gatewayId}/commands/mesh-group/resync-ack`,
      {
        siteId: resyncRequest.siteId,
        gatewayId: resyncRequest.gatewayId,
        eventId: expect.any(String),
        requestEventId: resyncRequest.eventId,
        occurredAt: expect.any(String)
      },
      { timeoutMs: 10_000 }
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

  it("fails a post-resync group when any reported operation fails", async () => {
    const groupId = "11111111-1111-4111-8111-111111111111";
    const nodeId1 = "22222222-2222-4222-8222-222222222222";
    const nodeId2 = "33333333-3333-4333-8333-333333333333";
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
            { groupId, gatewayId: "55555555-5555-4555-8555-555555555555", meshNodeId: nodeId1, desired: true, subscriptionStatus: "pending", appliedVersion: 0, statusVersion: 0, operationId: null, operation: null, meshNode: { meshAddress: "0x0100" } },
            { groupId, gatewayId: "55555555-5555-4555-8555-555555555555", meshNodeId: nodeId2, desired: true, subscriptionStatus: "pending", appliedVersion: 0, statusVersion: 0, operationId: null, operation: null, meshNode: { meshAddress: "0x0101" } }
          ])
          .mockResolvedValueOnce([
            { meshNodeId: nodeId1, desired: true, subscriptionStatus: "applied", appliedVersion: 2, lastError: null, statusVersion: 2 },
            { meshNodeId: nodeId2, desired: true, subscriptionStatus: "failed", appliedVersion: 0, lastError: "ignore me", statusVersion: 2 }
          ]),
      }
    };
    installMeshAckState(tx, [
      subscriptionOperation(nodeId1, "0x0100", "add", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"),
      subscriptionOperation(nodeId2, "0x0101", "add", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2")
    ], [{ meshNodeId: nodeId1, meshAddress: "0x0100" }]);
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
        operations: [
          { operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", action: "add", meshNodeId: nodeId1, meshAddress: "0x0100", status: "ready" },
          { operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", action: "add", meshNodeId: nodeId2, meshAddress: "0x0101", status: "failed", error: "ignore me" }
        ],
        occurredAt: "2026-08-20T09:00:01.000Z"
      }))
    );

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.meshControlGroupMember.updateMany).toHaveBeenCalledTimes(2);
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
        operationId: null,
        operation: null,
        lastError: null
      }
    });
    expect(tx.meshControlGroup.updateMany).toHaveBeenCalledWith({
      where: { id: groupId, gatewayId: "55555555-5555-4555-8555-555555555555", configurationVersion: 2 },
      data: {
        status: "failed",
        lastError: "ignore me"
      }
    });
  });

  it("fails closed when a result reports an operation set not represented by the expected member state", async () => {
    const groupId = "11111111-1111-4111-8111-111111111111";
    const memberId = "22222222-2222-4222-8222-222222222222";
    const gatewayId = "55555555-5555-4555-8555-555555555555";
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: groupId, gatewayId, configurationVersion: 2 }]),
      meshControlGroup: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      meshControlGroupMember: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn()
          .mockResolvedValueOnce([
            { groupId, gatewayId, meshNodeId: memberId, subscriptionStatus: "pending", appliedVersion: 0, statusVersion: 0 }
          ])
          .mockResolvedValueOnce([
            { meshNodeId: memberId, subscriptionStatus: "applied", appliedVersion: 2, statusVersion: 2, lastError: null }
          ])
      }
    };
    installMeshAckState(tx, [
      subscriptionOperation(memberId, "0x0100", "add", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5")
    ]);
    const prisma: any = { $transaction: jest.fn(async (callback: (client: any) => Promise<unknown>) => callback(tx)) };
    const service = new MqttService(prisma, createMeshGroupsMock() as never);

    await service.handleMessage(
      `sites/22222222-2222-4222-8222-222222222222/gateways/${gatewayId}/events/mesh-group/subscription-result`,
      Buffer.from(JSON.stringify({
        siteId: "22222222-2222-4222-8222-222222222222",
        gatewayId,
        groupId,
        version: 2,
        groupAddress: "0xc000",
        operations: [
          { operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", action: "delete", meshNodeId: memberId, meshAddress: "0x0100", status: "failed", error: "old address delete failed" },
          { operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7", action: "add", meshNodeId: memberId, meshAddress: "0x0101", status: "ready" }
        ],
        occurredAt: "2026-08-20T09:00:01.000Z"
      }))
    );

    expect(tx.meshControlGroupMember.updateMany).not.toHaveBeenCalled();
    expect(tx.meshControlGroup.updateMany).toHaveBeenCalledWith({
      where: { id: groupId, gatewayId, configurationVersion: 2 },
      data: { status: "failed", lastError: "mesh group subscription operation set mismatch" }
    });
  });

  it("accepts the persisted delete-old and add-new exact operation set for one node", async () => {
    const groupId = "11111111-1111-4111-8111-111111111111";
    const nodeId = "22222222-2222-4222-8222-222222222222";
    const gatewayId = "55555555-5555-4555-8555-555555555555";
    const expectedOperations = [
      { operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", action: "delete", meshNodeId: nodeId, meshAddress: "0x0100" },
      { operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7", action: "add", meshNodeId: nodeId, meshAddress: "0x0101" }
    ];
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{
        id: groupId,
        gatewayId,
        groupAddress: "0xc000",
        configurationVersion: 2,
        targetType: "fixture_group",
        targetId: "33333333-3333-4333-8333-333333333333",
        fullReconciliationRequired: true,
        status: "configuring"
      }]),
      meshControlGroupExpectedOperation: {
        findMany: jest.fn().mockResolvedValue(expectedOperations),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      meshControlGroupAppliedMember: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([{ meshNodeId: nodeId, meshAddress: "0x0101" }])
      },
      meshControlGroupMember: {
        findMany: jest.fn().mockResolvedValue([{
          meshNodeId: nodeId,
          desired: true,
          meshNode: { meshAddress: "0x0101" }
        }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      meshControlGroup: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      fixtureGroup: { updateMany: jest.fn() }
    };
    const prisma: any = { $transaction: jest.fn(async (callback: (client: any) => Promise<unknown>) => callback(tx)) };
    const service = new MqttService(prisma, createMeshGroupsMock() as never);

    await (service as any).storeMeshGroupSubscriptionResult({
      siteId: "44444444-4444-4444-8444-444444444444",
      gatewayId,
      groupId,
      version: 2,
      groupAddress: "0xc000",
      operations: expectedOperations.map((operation) => ({ ...operation, status: "ready" as const })),
      occurredAt: "2026-08-20T09:00:01.000Z"
    });

    expect(tx.meshControlGroupExpectedOperation.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.meshControlGroupAppliedMember.deleteMany).toHaveBeenCalledWith({
      where: { groupId, gatewayId, meshNodeId: nodeId, meshAddress: "0x0100" }
    });
    expect(tx.meshControlGroupAppliedMember.createMany).toHaveBeenCalledWith({
      data: [{ groupId, gatewayId, meshNodeId: nodeId, meshAddress: "0x0101" }],
      skipDuplicates: true
    });
    expect(tx.meshControlGroup.updateMany).toHaveBeenCalledWith({
      where: { id: groupId, gatewayId, configurationVersion: 2 },
      data: { status: "ready", lastError: null, fullReconciliationRequired: false }
    });
  });

  it("retires a fixture group only after the retiring version acknowledges its empty desired set", async () => {
    const groupId = "11111111-1111-4111-8111-111111111111";
    const fixtureGroupId = "22222222-2222-4222-8222-222222222222";
    const nodeId = "33333333-3333-4333-8333-333333333333";
    const gatewayId = "55555555-5555-4555-8555-555555555555";
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{
        id: groupId,
        gatewayId,
        configurationVersion: 2,
        targetType: "fixture_group",
        targetId: fixtureGroupId,
        status: "retiring"
      }]),
      meshControlGroupMember: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn()
          .mockResolvedValueOnce([{
            groupId,
            gatewayId,
            meshNodeId: nodeId,
            desired: false,
            subscriptionStatus: "pending",
            appliedVersion: 1,
            statusVersion: 0,
            operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8",
            operation: "delete",
            meshNode: { meshAddress: "0x0100" }
          }])
          .mockResolvedValueOnce([{
            meshNodeId: nodeId,
            desired: false,
            subscriptionStatus: "applied",
            appliedVersion: 2,
            statusVersion: 2,
            lastError: null
          }])
      },
      meshControlGroup: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      fixtureGroup: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    installMeshAckState(tx, [
      subscriptionOperation(nodeId, "0x0100", "delete", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8")
    ]);
    const prisma: any = { $transaction: jest.fn(async (callback: (client: any) => Promise<unknown>) => callback(tx)) };
    const service = new MqttService(prisma, createMeshGroupsMock() as never);

    await (service as any).storeMeshGroupSubscriptionResult({
      siteId: "44444444-4444-4444-8444-444444444444",
      gatewayId,
      groupId,
      version: 2,
      groupAddress: "0xc000",
      operations: [{
        operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8",
        action: "delete",
        meshNodeId: nodeId,
        meshAddress: "0x0100",
        status: "ready"
      }],
      occurredAt: "2026-08-20T09:00:01.000Z"
    });

    expect(tx.meshControlGroup.updateMany).toHaveBeenCalledWith({
      where: { id: groupId, gatewayId, configurationVersion: 2 },
      data: { status: "retired", lastError: null }
    });
    expect(tx.fixtureGroup.updateMany).toHaveBeenCalledWith({
      where: { id: fixtureGroupId, gatewayId, lifecycleStatus: "retiring" },
      data: { lifecycleStatus: "retired" }
    });
  });

  it("does not let delayed gateway A cleanup retire a group now owned and deleting on gateway B", async () => {
    const groupId = "11111111-1111-4111-8111-111111111111";
    const fixtureGroupId = "22222222-2222-4222-8222-222222222222";
    const oldGatewayId = "55555555-5555-4555-8555-555555555555";
    const currentGatewayId = "66666666-6666-4666-8666-666666666666";
    let lifecycleStatus = "retiring";
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{
        id: groupId,
        gatewayId: oldGatewayId,
        groupAddress: "0xc000",
        configurationVersion: 5,
        targetType: "fixture_group",
        targetId: fixtureGroupId,
        status: "retiring"
      }]),
      meshControlGroupMember: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn()
      },
      meshControlGroup: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      fixtureGroup: {
        updateMany: jest.fn(async ({ where }: { where: { gatewayId: string } }) => {
          if (where.gatewayId !== currentGatewayId) return { count: 0 };
          lifecycleStatus = "retired";
          return { count: 1 };
        })
      }
    };
    installMeshAckState(tx, []);
    const prisma: any = { $transaction: jest.fn(async (callback: (client: any) => Promise<unknown>) => callback(tx)) };
    const service = new MqttService(prisma, createMeshGroupsMock() as never);

    await (service as any).storeMeshGroupSubscriptionResult({
      siteId: "44444444-4444-4444-8444-444444444444",
      gatewayId: oldGatewayId,
      groupId,
      version: 5,
      groupAddress: "0xc000",
      operations: [],
      occurredAt: "2026-08-20T09:00:01.000Z"
    });

    expect(lifecycleStatus).toBe("retiring");
    expect(tx.fixtureGroup.updateMany).toHaveBeenCalledWith({
      where: { id: fixtureGroupId, gatewayId: oldGatewayId, lifecycleStatus: "retiring" },
      data: { lifecycleStatus: "retired" }
    });
  });

  it.each([
    ["empty", []],
    ["partial", [subscriptionOperation("node-a", "0x0100", "delete", "operation-a")]],
    ["duplicate", [
      subscriptionOperation("node-a", "0x0100", "delete", "operation-a"),
      subscriptionOperation("node-a", "0x0100", "delete", "operation-b")
    ]],
    ["outside", [
      subscriptionOperation("node-a", "0x0100", "delete", "operation-a"),
      subscriptionOperation("node-outside", "0x0101", "delete", "operation-b")
    ]],
    ["wrong action", [
      subscriptionOperation("node-a", "0x0100", "add", "operation-a"),
      subscriptionOperation("node-b", "0x0101", "delete", "operation-b")
    ]],
    ["wrong address", [
      subscriptionOperation("node-a", "0x0199", "delete", "operation-a"),
      subscriptionOperation("node-b", "0x0101", "delete", "operation-b")
    ]],
    ["wrong operation id", [
      subscriptionOperation("node-a", "0x0100", "delete", "operation-other"),
      subscriptionOperation("node-b", "0x0101", "delete", "operation-b")
    ]]
  ])("fails closed on a %s subscription operation set", async (_case, operations) => {
    const groupId = "11111111-1111-4111-8111-111111111111";
    const fixtureGroupId = "22222222-2222-4222-8222-222222222222";
    const gatewayId = "55555555-5555-4555-8555-555555555555";
    const expectedMembers = [
      expectedSubscriptionMember(groupId, gatewayId, "node-a", "0x0100", "operation-a"),
      expectedSubscriptionMember(groupId, gatewayId, "node-b", "0x0101", "operation-b")
    ];
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{
        id: groupId,
        gatewayId,
        groupAddress: "0xc000",
        configurationVersion: 2,
        targetType: "fixture_group",
        targetId: fixtureGroupId,
        status: "retiring"
      }]),
      meshControlGroupMember: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue(expectedMembers)
      },
      meshControlGroup: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      fixtureGroup: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    installMeshAckState(tx, expectedMembers.map((member) => ({
      operationId: member.operationId,
      action: member.operation,
      meshNodeId: member.meshNodeId,
      meshAddress: member.meshNode.meshAddress,
      status: "ready" as const
    })));
    const prisma: any = { $transaction: jest.fn(async (callback: (client: any) => Promise<unknown>) => callback(tx)) };
    const service = new MqttService(prisma, createMeshGroupsMock() as never);

    await (service as any).storeMeshGroupSubscriptionResult({
      siteId: "44444444-4444-4444-8444-444444444444",
      gatewayId,
      groupId,
      version: 2,
      groupAddress: "0xc000",
      operations,
      occurredAt: "2026-08-20T09:00:01.000Z"
    });

    expect(tx.meshControlGroupMember.updateMany).not.toHaveBeenCalled();
    expect(tx.meshControlGroup.updateMany).toHaveBeenCalledWith({
      where: { id: groupId, gatewayId, configurationVersion: 2 },
      data: { status: "retiring", lastError: "mesh group subscription operation set mismatch" }
    });
    expect(tx.fixtureGroup.updateMany).not.toHaveBeenCalled();
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
              desired: true,
              subscriptionStatus: "pending",
              appliedVersion: 0,
              statusVersion: 0,
              operationId: null,
              operation: null,
              meshNode: { meshAddress: "0x0100" }
            },
            {
              groupId,
              gatewayId: "55555555-5555-4555-8555-555555555555",
              meshNodeId: nodeId2,
              desired: false,
              subscriptionStatus: "failed",
              appliedVersion: 0,
              statusVersion: 1,
              operationId: null,
              operation: null,
              meshNode: { meshAddress: "0x0101" }
            }
          ])
          .mockResolvedValueOnce([
            { meshNodeId: nodeId1, desired: true, subscriptionStatus: "applied", appliedVersion: 2, statusVersion: 2, lastError: null },
            { meshNodeId: nodeId2, desired: false, subscriptionStatus: "applied", appliedVersion: 2, statusVersion: 2, lastError: null }
          ])
      }
    };
    installMeshAckState(tx, [
      subscriptionOperation(nodeId1, "0x0100", "add", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3")
    ], [{ meshNodeId: nodeId1, meshAddress: "0x0100" }]);
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
        operations: [
          { operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", action: "add", meshNodeId: nodeId1, meshAddress: "0x0100", status: "ready" }
        ],
        occurredAt: "2026-08-20T09:00:01.000Z"
      }))
    );

    expect(tx.meshControlGroup.updateMany).toHaveBeenCalledWith({
      where: { id: groupId, gatewayId: "55555555-5555-4555-8555-555555555555", configurationVersion: 2 },
      data: {
        status: "ready",
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
        findMany: jest.fn()
          .mockResolvedValueOnce([{
            meshNodeId: memberId,
            desired: true,
            subscriptionStatus: "pending",
            appliedVersion: 0,
            statusVersion: 0,
            operationId: null,
            operation: null,
            meshNode: { meshAddress: "0x0100" }
          }])
          .mockResolvedValueOnce([{
            meshNodeId: memberId,
            desired: true,
            subscriptionStatus: "applied",
            appliedVersion: 2,
            statusVersion: 2,
            lastError: null
          }])
      },
      meshControlGroup: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      }
    };
    installMeshAckState(tx, [
      subscriptionOperation(memberId, "0x0100", "add", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4")
    ], [{ meshNodeId: memberId, meshAddress: "0x0100" }]);
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
        operations: [{ operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", action: "add", meshNodeId: memberId, meshAddress: "0x0100", status: "ready" }],
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

  it("ignores a delayed pre-resync subscription result before touching current-version members", async () => {
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
        operations: [{ operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5", action: "add", meshNodeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", meshAddress: "0x0100", status: "ready" }],
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

  it("stores current scan identity for create and same-device update despite gateway clock skew", async () => {
    const prisma = {
      fixture: { update: jest.fn() },
      command: { update: jest.fn() },
      provisioningSession: {
        findUnique: jest.fn().mockResolvedValue({
          id: "11111111-1111-4111-8111-111111111111",
          siteId: "00000000-0000-4000-8000-000000000003",
          gatewayId: "00000000-0000-4000-8000-000000000004",
          status: "active",
          scanStatus: "scanning",
          scanCorrelationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          scanAttempt: 2
        })
      },
      processedGatewayEvent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      discoveredMeshNode: {
        upsert: jest.fn().mockResolvedValue(undefined)
      }
    };
    (prisma as any).$queryRaw = jest.fn().mockResolvedValue([]);
    (prisma as any).$transaction = jest.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma));
    const service = new MqttService(prisma as never, createMeshGroupsMock() as never);

    await service.handleMessage(
      "sites/00000000-0000-4000-8000-000000000003/gateways/00000000-0000-4000-8000-000000000004/events/provisioning/scan-found",
      Buffer.from(
        JSON.stringify({
          sessionId: "11111111-1111-4111-8111-111111111111",
          scanCorrelationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          scanAttempt: 2,
          siteId: "00000000-0000-4000-8000-000000000003",
          gatewayId: "00000000-0000-4000-8000-000000000004",
          eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          sequence: 1,
          occurredAt: "2026-06-30T23:59:01.000Z",
          deviceUuid: "esp32h2-b2-001",
          serialNumber: "LC-B2-001",
          rssi: -54,
          oobCapability: "static-oob",
          firmwareVersion: "mock-node-0.1.0"
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
        scanCorrelationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        scanAttempt: 2,
        discoveredAt: new Date("2026-06-30T23:59:01.000Z")
      },
      update: {
        status: "discovered",
        rssi: -54,
        oobCapability: "static-oob",
        firmwareVersion: "mock-node-0.1.0",
        scanCorrelationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        scanAttempt: 2,
        discoveredAt: new Date("2026-06-30T23:59:01.000Z"),
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
      provisioningSession: {
        findUnique: jest.fn().mockResolvedValue({ ...node.session, status: "active" })
      },
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
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
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
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect((prisma.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join(" ").replace(/\s+/g, " ")).toContain(
      'FROM "ProvisioningSession" WHERE "id" = FOR UPDATE'
    );
    expect((prisma.$queryRaw.mock.calls[1][0] as TemplateStringsArray).join(" ").replace(/\s+/g, " ")).toContain(
      'FROM "DiscoveredMeshNode" WHERE "id" = AND "sessionId" = FOR UPDATE'
    );
    expect(prisma.$queryRaw.mock.calls[1].slice(1)).toEqual([node.id, node.sessionId]);
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
      provisioningSession: {
        findUnique: jest.fn().mockResolvedValue({ ...node.session, status: "active" })
      },
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
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
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
      provisioningSession: {
        findUnique: jest.fn().mockResolvedValue({ ...node.session, status: "active" })
      },
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
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
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
      status: "provisioning",
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
      provisioningSession: {
        findUnique: jest.fn().mockResolvedValue({ ...node.session, status: "active" })
      },
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
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
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
      status: "provisioning",
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
      provisioningSession: {
        findUnique: jest.fn().mockResolvedValue({ ...node.session, status: "active" })
      },
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
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
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
        status: { in: ["discovered", "identifying", "provisioning", "reconcile_required"] },
        session: {
          siteId: node.session.siteId,
          gatewayId: node.session.gatewayId,
          status: "active"
        }
      },
      data: { status: "failed", errorMessage: "device UUID is already registered by another site" }
    });
  });

  it.each([
    ["failed", "active"],
    ["provisioned", "active"],
    ["provisioning", "cancelled"],
    ["reconcile_required", "completed"]
  ])("ignores late provisioning completion for node %s in session %s", async (nodeStatus, sessionStatus) => {
    const session = {
      id: "11111111-1111-4111-8111-111111111111",
      siteId: "00000000-0000-4000-8000-000000000003",
      floorId: "00000000-0000-4000-8000-000000000005",
      gatewayId: "00000000-0000-4000-8000-000000000004",
      status: sessionStatus
    };
    const prisma: any = {
      provisioningSession: { findUnique: jest.fn().mockResolvedValue(session) },
      discoveredMeshNode: {
        findFirst: jest.fn().mockResolvedValue({
          id: "22222222-2222-4222-8222-222222222222",
          sessionId: session.id,
          deviceUuid: "esp32h2-b2-001",
          serialNumber: "LC-B2-001",
          status: nodeStatus,
          pendingFixtureName: "B2-L001",
          pendingFixtureX: 100,
          pendingFixtureY: 200,
          session
        }),
        update: jest.fn()
      },
      meshNode: { findUnique: jest.fn(), create: jest.fn() },
      fixture: { findFirst: jest.fn(), create: jest.fn() }
    };
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    prisma.$transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma));
    const service = new MqttService(prisma, createMeshGroupsMock() as never);

    await (service as any).completeProvisioning(
      { siteId: session.siteId, gatewayId: session.gatewayId },
      {
        sessionId: session.id,
        nodeId: "22222222-2222-4222-8222-222222222222",
        deviceUuid: "esp32h2-b2-001",
        meshAddress: "0x0101",
        completedAt: "2026-07-01T00:00:05.000Z"
      }
    );

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.meshNode.findUnique).not.toHaveBeenCalled();
    expect(prisma.meshNode.create).not.toHaveBeenCalled();
    expect(prisma.fixture.create).not.toHaveBeenCalled();
    expect(prisma.discoveredMeshNode.update).not.toHaveBeenCalled();
    if (sessionStatus === "active") {
      expect(prisma.discoveredMeshNode.findFirst).toHaveBeenCalledWith({
        where: {
          id: "22222222-2222-4222-8222-222222222222",
          sessionId: session.id,
          deviceUuid: "esp32h2-b2-001",
          status: { in: ["provisioning", "reconcile_required"] }
        }
      });
    } else {
      expect(prisma.discoveredMeshNode.findFirst).not.toHaveBeenCalled();
    }
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
      provisioningSession: { findUnique: jest.fn().mockResolvedValue(null) },
      discoveredMeshNode: {
        upsert: jest.fn()
      }
    };
    (prisma as any).$queryRaw = jest.fn().mockResolvedValue([]);
    (prisma as any).$transaction = jest.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma));
    const service = new MqttService(prisma as never, createMeshGroupsMock() as never);

    await service.handleMessage(
      "sites/99999999-9999-4999-8999-999999999999/gateways/00000000-0000-4000-8000-000000000004/events/provisioning/scan-found",
      Buffer.from(
        JSON.stringify({
          sessionId: "11111111-1111-4111-8111-111111111111",
          scanCorrelationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          scanAttempt: 1,
          siteId: "99999999-9999-4999-8999-999999999999",
          gatewayId: "00000000-0000-4000-8000-000000000004",
          eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          sequence: 1,
          occurredAt: "2026-07-01T00:00:01.000Z",
          deviceUuid: "esp32h2-b2-001",
          serialNumber: "LC-B2-001",
          rssi: -54,
          oobCapability: "static-oob",
          firmwareVersion: "mock-node-0.1.0"
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

function createScanAckOutboxMock() {
  let stored: any = null;
  return {
    findUnique: jest.fn(async () => stored),
    create: jest.fn(async ({ data }) => {
      stored = {
        id: "scan-terminal-ack-outbox",
        ...data,
        attempts: 0,
        nextAttemptAt: new Date(),
        publishedAt: null,
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null,
        deadLetteredAt: null,
        lastError: null
      };
      return stored;
    }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 })
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((value) => { resolve = value; });
  return { promise, resolve };
}

function subscriptionOperation(
  meshNodeId: string,
  meshAddress: string,
  action: "add" | "delete",
  operationId: string
) {
  return { operationId, action, meshNodeId, meshAddress, status: "ready" as const };
}

function installMeshAckState(
  tx: any,
  expectedOperations: Array<{
    operationId: string;
    action: string;
    meshNodeId: string;
    meshAddress: string;
  }>,
  appliedMembers: Array<{ meshNodeId: string; meshAddress: string }> = []
) {
  tx.meshControlGroupExpectedOperation = {
    findMany: jest.fn().mockResolvedValue(expectedOperations),
    updateMany: jest.fn().mockResolvedValue({ count: 1 })
  };
  tx.meshControlGroupAppliedMember = {
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    createMany: jest.fn().mockResolvedValue({ count: 1 }),
    findMany: jest.fn().mockResolvedValue(appliedMembers)
  };
}

function expectedSubscriptionMember(
  groupId: string,
  gatewayId: string,
  meshNodeId: string,
  meshAddress: string,
  operationId: string
) {
  return {
    groupId,
    gatewayId,
    meshNodeId,
    desired: false,
    subscriptionStatus: "pending",
    appliedVersion: 1,
    statusVersion: 0,
    operationId,
    operation: "delete",
    meshNode: { meshAddress }
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

function deviceStatusTopic() {
  return "sites/22222222-2222-4222-8222-222222222222/gateways/55555555-5555-4555-8555-555555555555/acks/device-status";
}

function fixtureResult(fixtureId: string, status: "succeeded" | "failed" | "timed_out") {
  return {
    fixtureId,
    status,
    ...(status === "succeeded" ? { brightness: 70 } : { errorMessage: `${status} result` })
  };
}

function deviceAckPrisma(expectedFixtureIds: string[]) {
  const prisma: any = {
    commandDispatch: {
      findFirst: jest.fn().mockResolvedValue({
        id: deviceStatusAckPayload().dispatchId,
        commandId: deviceStatusAckPayload().commandId
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([{ status: "failed" }])
    },
    commandFixtureResult: {
      findMany: jest.fn().mockResolvedValue(expectedFixtureIds.map((fixtureId) => ({ fixtureId }))),
      updateMany: jest.fn().mockResolvedValue({ count: 1 })
    },
    command: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) }
  };
  prisma.$queryRaw = jest.fn(async (query: TemplateStringsArray) => {
    const sql = query.join("");
    if (sql.includes('FROM "CommandDispatch"')) {
      return [{ id: deviceStatusAckPayload().dispatchId, commandId: deviceStatusAckPayload().commandId }];
    }
    if (sql.includes('FROM "CommandFixtureResult"')) {
      return expectedFixtureIds.map((fixtureId) => ({ fixtureId }));
    }
    throw new Error(`unexpected device ACK query: ${sql}`);
  });
  prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
  return prisma;
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
