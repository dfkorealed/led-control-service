import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from "@nestjs/common";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, IClientOptions, MqttClient } from "mqtt";
import { PrismaService } from "../prisma/prisma.service";

type Options = { env?: NodeJS.ProcessEnv; timeoutMs?: number };

/** Local closure is deliberately not a broker drain or antirollback attestation. */
@Injectable()
export class CommandSetMqttService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CommandSetMqttService.name);
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private registration: { generation: number; workerId: string; brokerIdentity: string } | null = null;
  private connection: { url: string; options: IClientOptions } | null = null;
  private client: MqttClient | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService, @Optional() options: Options = {}) {
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async onModuleInit() {
    if (this.env.COMMAND_SET_EGRESS_ENABLED !== "1") return;
    try {
      const config = createCommandSetConnection(this.env);
      await this.prisma.commandPublishMember.createMany({ data: config.registration, skipDuplicates: true });
      if (this.closed) return;
      this.registration = config.registration;
      this.connection = config.connection;
    } catch {
      // A broken Set credential/DB registration must not take down Get and
      // monitoring. Set remains unavailable, with no shared-client fallback.
      this.logger.error("Command Set egress unavailable: credential or DB registration rejected");
    }
  }

  async publish(generation: number, topic: string, payload: unknown, expirySeconds: number): Promise<void> {
    if (this.closed) throw new Error("command Set egress closed");
    if (!this.registration || !this.connection) throw new Error("command Set registration unavailable");
    const body = payload as { siteId?: unknown; gatewayId?: unknown; publishEpoch?: unknown } | null;
    if (generation !== this.registration.generation || !body || body.publishEpoch !== generation ||
      !/^sites\/[^/+#\u0000]+\/gateways\/[^/+#\u0000]+\/commands\/dimming$/.test(topic) ||
      topic !== `sites/${body.siteId}/gateways/${body.gatewayId}/commands/dimming` ||
      !Number.isInteger(expirySeconds) || expirySeconds <= 0 || expirySeconds > 10) {
      throw new Error("command Set generation, topic scope or expiry rejected");
    }
    await this.assertRegistered();
    if (this.closed) throw new Error("command Set egress closed");
    const client = this.client ??= connect(this.connection.url, this.connection.options);
    // MQTT.js emits errors separately from publish callbacks. Consume them;
    // failures still reject the connect/publish operation below.
    const onError = () => {};
    client.on("error", onError);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        (async () => {
          if (!client.connected) await new Promise<void>((resolve, reject) => {
            const cleanup = () => { client.removeListener("connect", ready); client.removeListener("error", failed); client.removeListener("close", disconnected); };
            const ready = () => { cleanup(); resolve(); };
            const failed = (error: Error) => { cleanup(); reject(error); };
            const disconnected = () => failed(new Error("command Set connection closed"));
            client.once("connect", ready); client.once("error", failed); client.once("close", disconnected);
          });
          await this.assertRegistered();
          if (this.closed) throw new Error("command Set egress closed");
          await new Promise<void>((resolve, reject) => client.publish(topic, JSON.stringify(payload), {
            qos: 1, retain: false, properties: { messageExpiryInterval: expirySeconds }
          }, (error) => error ? reject(error) : resolve()));
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => {
          // Deferred QoS1 can survive an application timeout. Close locally and
          // latch refusal; only external broker retirement can prove rejection
          // of already handed-off work after DB permit loss.
          void this.close(); reject(new Error("command Set publish timed out"));
        }, this.timeoutMs); })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      // Keep one listener while the owned client closes asynchronously.
      if (client.listenerCount("error") > 1) client.removeListener("error", onError);
    }
  }

  private async assertRegistered() {
    const registration = this.registration!;
    const member = await this.prisma.commandPublishMember.findFirst({ where: {
      ...registration, quiesceAckAt: null, epoch: { status: "active" }
    }, select: { generation: true } });
    if (!member) throw new Error("command Set active registration unavailable");
  }

  close(): Promise<void> {
    this.closed = true;
    if (!this.closing) this.closing = new Promise<void>((resolve) => {
      if (!this.client) { resolve(); return; }
      const timer = setTimeout(resolve, 1000);
      this.client.end(true, { properties: { sessionExpiryInterval: 0 } }, () => { clearTimeout(timer); resolve(); });
    });
    return this.closing;
  }

  onModuleDestroy() { return this.close(); }
}

function createCommandSetConnection(env: NodeJS.ProcessEnv) {
  const generation = Number(env.MQTT_SET_GENERATION);
  const workerId = env.MQTT_API_INSTANCE_ID?.trim();
  if (!Number.isSafeInteger(generation) || generation <= 0 || generation > 2147483647 ||
    !workerId || !/^[a-zA-Z0-9_-]{1,128}$/.test(workerId)) throw new Error("invalid command Set generation/instance");
  const brokerIdentity = `command-set-${generation}`;
  const read = (name: string) => {
    if (!env[name]) throw new Error(`missing ${name}`);
    return readFileSync(env[name]!);
  };
  if (!env.MQTT_URL?.startsWith("mqtts://")) throw new Error("command Set requires mqtts://");
  const cert = read("MQTT_SET_CLIENT_CERT_PATH"), key = read("MQTT_SET_CLIENT_KEY_PATH");
  const certificate = new X509Certificate(cert);
  if (certificate.subject !== `CN=${brokerIdentity}` || !certificate.checkPrivateKey(createPrivateKey(key))) {
    throw new Error("command Set certificate identity/key mismatch");
  }
  return {
    registration: { generation, workerId, brokerIdentity },
    connection: { url: env.MQTT_URL, options: {
      ca: read("MQTT_CA_PATH"), cert, key, rejectUnauthorized: true,
      clientId: `${brokerIdentity}-${workerId}`, clean: true, protocolVersion: 5 as const,
      reconnectPeriod: 0, queueQoSZero: false, properties: { sessionExpiryInterval: 0 }
    } }
  };
}
