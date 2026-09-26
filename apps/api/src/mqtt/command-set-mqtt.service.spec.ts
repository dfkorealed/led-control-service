import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "mqtt";
import { CommandSetMqttService } from "./command-set-mqtt.service";
import { MqttService } from "./mqtt.service";
import { Logger } from "@nestjs/common";

jest.mock("mqtt", () => ({ connect: jest.fn() }));

describe("generation-scoped Set egress", () => {
  let directory: string;
  let env: NodeJS.ProcessEnv;
  const topic = "sites/site/gateways/gateway/commands/dimming";
  const payload = { siteId: "site", gatewayId: "gateway", publishEpoch: 7 };
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "set-egress-unit-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=command-set-7", "-keyout", join(directory, "key"), "-out", join(directory, "cert")], { stdio: "ignore" });
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  beforeEach(() => {
    jest.clearAllMocks();
    env = { COMMAND_SET_EGRESS_ENABLED: "1", MQTT_SET_GENERATION: "7", MQTT_API_INSTANCE_ID: "api-1",
      MQTT_URL: "mqtts://localhost:8883", MQTT_CA_PATH: join(directory, "cert"),
      MQTT_SET_CLIENT_CERT_PATH: join(directory, "cert"), MQTT_SET_CLIENT_KEY_PATH: join(directory, "key") };
  });
  afterEach(() => jest.restoreAllMocks());
  function fixture() {
    const client = Object.assign(new EventEmitter(), {
      connected: true, publish: jest.fn((_topic, _payload, _options, callback) => callback()),
      end: jest.fn((_force, _options, callback) => callback())
    });
    (connect as jest.Mock).mockReturnValue(client);
    const prisma = { commandPublishMember: { createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue({ generation: 7 }) } };
    const service = new CommandSetMqttService(prisma as never, { env, timeoutMs: 10 });
    return { service, prisma, client };
  }
  it("registers the certificate identity and uses a clean, zero-expiry Set-only client", async () => {
    const { service, prisma, client } = fixture();
    await service.onModuleInit();
    await service.publish(7, topic, payload, 8);
    expect(prisma.commandPublishMember.createMany).toHaveBeenCalledWith({ data: {
      generation: 7, workerId: "api-1", brokerIdentity: "command-set-7"
    }, skipDuplicates: true });
    expect(prisma.commandPublishMember.findFirst).toHaveBeenCalledWith({ where: {
      generation: 7, workerId: "api-1", brokerIdentity: "command-set-7", quiesceAckAt: null,
      epoch: { status: "active" }
    }, select: { generation: true } });
    expect(connect).toHaveBeenCalledWith(env.MQTT_URL, expect.objectContaining({
      clientId: "command-set-7-api-1", clean: true, protocolVersion: 5, reconnectPeriod: 0,
      queueQoSZero: false, rejectUnauthorized: true, properties: { sessionExpiryInterval: 0 }
    }));
    expect(client.publish).toHaveBeenCalledWith(topic, JSON.stringify(payload), {
      qos: 1, retain: false, properties: { messageExpiryInterval: 8 }
    }, expect.any(Function));
    await service.onModuleDestroy();
  });
  it("never connects without DB registration, even when credentials are valid", async () => {
    const { service, prisma } = fixture();
    await expect(service.publish(7, topic, payload, 8)).rejects.toThrow(/registration/);
    prisma.commandPublishMember.findFirst.mockResolvedValue(null);
    await service.onModuleInit();
    await expect(service.publish(7, topic, payload, 8)).rejects.toThrow(/registration/);
    expect(connect).not.toHaveBeenCalled();
  });
  it("binds an outbox publisher to the same registered worker and epoch", async () => {
    const { service } = fixture();
    await service.onModuleInit();
    expect(() => (service as any).assertPublisherIdentity("api-1", 7)).not.toThrow();
    expect(() => (service as any).assertPublisherIdentity("other-worker", 7)).toThrow(/identity/);
    expect(() => (service as any).assertPublisherIdentity("api-1", 8)).toThrow(/identity/);
  });
  it("retirement or DB loss stops a previously active client's next handoff", async () => {
    const { service, prisma, client } = fixture();
    await service.onModuleInit();
    await service.publish(7, topic, payload, 8);
    prisma.commandPublishMember.findFirst.mockResolvedValueOnce(null);
    await expect(service.publish(7, topic, payload, 8)).rejects.toThrow(/registration/);
    prisma.commandPublishMember.findFirst.mockRejectedValueOnce(new Error("DB lost"));
    await expect(service.publish(7, topic, payload, 8)).rejects.toThrow("DB lost");
    expect(client.publish).toHaveBeenCalledTimes(1);
    await service.close();
  });
  it.each([
    [6, topic, payload, 8], [7, topic.replace("dimming", "status-check"), payload, 8],
    [7, topic, { ...payload, publishEpoch: undefined }, 8], [7, topic, { ...payload, gatewayId: "other" }, 8],
    [7, topic, payload, 0], [7, topic, payload, 11]
  ])("rejects wrong generation, scope, kind or expiry before MQTT (%s %s)", async (generation, target, body, expiry) => {
    const { service, client } = fixture();
    await service.onModuleInit();
    await expect(service.publish(generation as number, target as string, body, expiry as number)).rejects.toThrow();
    expect(client.publish).not.toHaveBeenCalled();
  });
  it("does not fallback to the API credential when the Set credential is missing or has wrong CN", async () => {
    jest.spyOn(Logger.prototype, "error").mockImplementation();
    const { service } = fixture();
    delete env.MQTT_SET_CLIENT_CERT_PATH;
    await service.onModuleInit();
    await expect(service.publish(7, topic, payload, 8)).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
    env.MQTT_SET_CLIENT_CERT_PATH = join(directory, "cert"); env.MQTT_SET_GENERATION = "8";
    const other = new CommandSetMqttService({} as never, { env });
    await other.onModuleInit();
    await expect(other.publish(8, topic, { ...payload, publishEpoch: 8 }, 8)).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
  it("closes and latches local refusal after timeout without treating close as broker proof", async () => {
    const { service, client } = fixture();
    client.publish.mockImplementation(() => undefined);
    await service.onModuleInit();
    await expect(service.publish(7, topic, payload, 8)).rejects.toThrow(/timed out/);
    expect(client.end).toHaveBeenCalledWith(true, { properties: { sessionExpiryInterval: 0 } }, expect.any(Function));
    await expect(service.publish(7, topic, payload, 8)).rejects.toThrow(/closed/);
  });
  it("keeps the default OFF path available while ON rejects old API dimming but preserves Get", async () => {
    const previous = process.env.COMMAND_SET_EGRESS_ENABLED;
    const { client } = fixture();
    const shared = new MqttService({} as never, {} as never);
    (shared as any).client = client;
    try {
      delete process.env.COMMAND_SET_EGRESS_ENABLED;
      await shared.publishTopic(topic, payload);
      process.env.COMMAND_SET_EGRESS_ENABLED = "1";
      await expect(shared.publishTopic(topic, payload)).rejects.toThrow(/Set/);
      await shared.publishTopic(topic.replace("dimming", "status-check"), {});
      expect(client.publish).toHaveBeenCalledTimes(2);
    } finally {
      if (previous === undefined) delete process.env.COMMAND_SET_EGRESS_ENABLED;
      else process.env.COMMAND_SET_EGRESS_ENABLED = previous;
    }
  });
});
