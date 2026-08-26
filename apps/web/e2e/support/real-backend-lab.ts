import type { Page, TestInfo } from "@playwright/test";
import {
  acceptanceAckV2Schema,
  applicationStateIngestedAckV2Schema,
  deviceStatusAckV2Schema,
  fixtureStateV2Schema,
  gatewayHeartbeatV2Schema,
  meshGroupSubscriptionResultSchema,
  meshGroupSubscriptionSyncSchema,
  mqttTopics,
  mqttTopicsV2,
  provisionDeviceSchema,
  provisioningCompletedSchema,
  provisioningScanCompletedSchema,
  provisioningScanFoundSchema,
  provisioningScanStartSchema
} from "@led-control/shared";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { connect, type IClientPublishOptions, type MqttClient } from "mqtt";

const scrypt = promisify(scryptCallback);
const LAB_SENTINEL = "LED_CONTROL_REAL_BACKEND_LAB_SUPPORT_ONLY";
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../../../");
const ports = {
  postgres: Number(process.env.E2E_LAB_POSTGRES_PORT ?? 15432),
  redis: Number(process.env.E2E_LAB_REDIS_PORT ?? 16379),
  mqtt: Number(process.env.E2E_LAB_MQTT_PORT ?? 18883),
  api: Number(process.env.E2E_LAB_API_PORT ?? 14000),
  web: Number(process.env.E2E_LAB_WEB_PORT ?? 15173)
};

type Installation = { siteId: string; floorId: string; timeZone: string };

export class RealBackendLab {
  readonly operator = { email: "task11-operator@example.com", password: "Task11-operator-password!" };
  readonly admin = {
    email: "task11-admin@example.com",
    name: "Task 11 고객 관리자",
    password: "Task11-admin-password!",
    invitationToken: "task11-customer-admin-invitation"
  };
  readonly viewer = {
    email: "task11-viewer@example.com",
    name: "Task 11 조회 사용자",
    password: "Task11-viewer-password!",
    invitationToken: "task11-customer-viewer-invitation"
  };
  readonly gateway = { id: "", serialNumber: "DFK-TASK11-GW-001", claimCode: "task11-one-time-claim-code" };
  readonly fixtures = [
    { serialNumber: "DFK-T11-LIGHT-001", deviceUuid: "44464b4c454401010101aabbccddeeff" },
    { serialNumber: "DFK-T11-LIGHT-002", deviceUuid: "44464b4c454401010101aabbccddee00" }
  ];

  private readonly runId = `task11-${process.pid}-${Date.now()}`;
  private readonly labDir = join(ROOT, ".local", "e2e-real-backend", this.runId);
  private readonly pkiDir = join(this.labDir, "pki");
  private readonly processes: ChildProcess[] = [];
  private readonly network: Array<Record<string, unknown>> = [];
  private readonly mqttEvidence: Array<Record<string, unknown>> = [];
  private readonly stateIngestedEventIds = new Set<string>();
  private mqtt?: MqttClient;
  private heartbeat?: NodeJS.Timeout;
  private installation?: Installation;
  private scanCount = 0;
  private eventSequence = 100;
  private mqttHandlerChain = Promise.resolve();
  private initialStatesPublished = false;
  private initialStatePublishPromise?: Promise<void>;
  private readonly backgroundTasks = new Set<Promise<void>>();
  private backgroundError: unknown;
  private started = false;

  async start() {
    if (this.started) return;
    await mkdir(this.labDir, { recursive: true });
    await this.run("pnpm", ["--filter", "@led-control/shared", "build"]);
    await this.run("pnpm", ["--filter", "@led-control/api", "build"]);
    await this.run("pnpm", ["--filter", "@led-control/web", "build"]);
    await this.run(resolve(ROOT, "scripts/dev-pki/create-ca.sh"), [], { PKI_DIR: this.pkiDir });
    await this.writeMosquittoConfig();
    await this.startInfrastructure();
    await this.run("pnpm", ["--filter", "@led-control/api", "exec", "prisma", "migrate", "deploy"], this.apiEnv());
    await this.run("pnpm", ["--filter", "@led-control/api", "auth:bootstrap-operator"], {
      ...this.apiEnv(),
      BOOTSTRAP_ORGANIZATION_NAME: "Task 11 서비스 운영사",
      BOOTSTRAP_OPERATOR_EMAIL: this.operator.email,
      BOOTSTRAP_OPERATOR_NAME: "Task 11 운영자",
      BOOTSTRAP_OPERATOR_PASSWORD: this.operator.password
    });
    this.spawnLogged("api", "node", [join(ROOT, "apps/api/dist/src/main.js")], this.apiEnv());
    this.spawnLogged("web", "pnpm", ["--filter", "@led-control/web", "dev"], {
      WEB_PORT: String(ports.web), VITE_API_PROXY_TARGET: `http://127.0.0.1:${ports.api}`
    });
    await Promise.all([
      waitForHttp(`http://127.0.0.1:${ports.api}/auth/me`, [401]),
      waitForHttp(`http://127.0.0.1:${ports.web}`, [200])
    ]);
    this.started = true;
  }

  async stop() {
    clearInterval(this.heartbeat);
    await Promise.allSettled([...this.backgroundTasks]);
    await this.mqttHandlerChain;
    await closeMqtt(this.mqtt);
    for (const child of this.processes.reverse()) await stopProcess(child);
    this.started = false;
  }

  captureNetwork(page: Page) {
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname.startsWith("/api/")) {
        this.network.push({ method: response.request().method(), path: url.pathname + url.search, status: response.status() });
      }
    });
  }

  async screenshot(page: Page, testInfo: TestInfo, name: string) {
    await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
  }

  async readInstallation(): Promise<Installation> {
    const row = await this.queryJson<{ siteId: string; floorId: string; timeZone: string }>(
      `SELECT json_build_object('siteId', s.id, 'floorId', f.id, 'timeZone', s."timeZone") FROM "Site" s JOIN "Floor" f ON f."siteId"=s.id ORDER BY s."createdAt" DESC LIMIT 1`
    );
    this.installation = row;
    return row;
  }

  async seedGatewayInventory() {
    const hash = await hashSecret(this.gateway.claimCode);
    await this.sql(`INSERT INTO "GatewayInventory" (id,"serialNumber","claimCodeHash","createdAt","updatedAt") VALUES ('${randomUUID()}','${this.gateway.serialNumber}','${hash}',now(),now())`);
  }

  async seedCustomerAdminInvitation() {
    const installation = this.requireInstallation();
    await this.sql(`
      INSERT INTO "Invitation" (id,"organizationId",email,role,"tokenHash","expiresAt","createdAt","updatedAt")
      SELECT '${randomUUID()}',"organizationId",'${this.admin.email}','admin',
             '${createHash("sha256").update(this.admin.invitationToken).digest("hex")}',
             now() + interval '1 day',now(),now()
      FROM "Site" WHERE id='${installation.siteId}';
    `);
  }

  async seedCustomerViewerInvitation() {
    const installation = this.requireInstallation();
    await this.sql(`
      INSERT INTO "Invitation" (id,"organizationId","siteId",email,role,"tokenHash","expiresAt","createdAt","updatedAt")
      SELECT '${randomUUID()}',"organizationId",id,'${this.viewer.email}','viewer',
             '${createHash("sha256").update(this.viewer.invitationToken).digest("hex")}',
             now() + interval '1 day',now(),now()
      FROM "Site" WHERE id='${installation.siteId}';
    `);
  }

  async attachGatewayPublisher() {
    const installation = this.requireInstallation();
    const gatewayId = await this.scalar(`SELECT id FROM "Gateway" WHERE "serialNumber"='${this.gateway.serialNumber}'`);
    Object.assign(this.gateway, { id: gatewayId });
    this.mqtt = await connectMqtt({
      host: "127.0.0.1", port: ports.mqtt, clientId: `task11-publisher-${this.runId}`,
      ca: await readFile(join(this.pkiDir, "ca.crt")),
      cert: await readFile(join(this.pkiDir, "api.crt")),
      key: await readFile(join(this.pkiDir, "api.key"))
    });
    await subscribe(this.mqtt, [
      `sites/${installation.siteId}/gateways/${gatewayId}/commands/#`,
      `sites/${installation.siteId}/gateways/${gatewayId}/acks/#`
    ]);
    this.mqtt.on("message", (topic, payload) => {
      if (topic.endsWith("/acks/state-ingested")) {
        const acknowledgement = applicationStateIngestedAckV2Schema.parse(JSON.parse(payload.toString()));
        this.stateIngestedEventIds.add(acknowledgement.eventId);
      }
      this.mqttHandlerChain = this.mqttHandlerChain.then(() => this.handleMqtt(topic, payload)).catch((error) => {
        this.recordMqtt({ direction: "handler-error", topic, error: safeMessage(error) });
      });
    });
    await this.publishHeartbeat();
    this.heartbeat = setInterval(() => void this.publishHeartbeat(), 5_000);
  }

  async publishEnergyHistory(mode: "partial" | "available") {
    const installation = this.requireInstallation();
    const fixtureIds = await this.fixtureIds();
    await this.waitFor(() => this.stateIngestedAckCount() >= fixtureIds.length, 10_000);
    await this.mqttHandlerChain;
    const now = Date.now();
    const start = new Date(now - 3_720_000);
    const fixtureIdList = fixtureIds.map(sqlString).join(",");
    // 격리 랩에서만 수집 시작 시계를 되돌려 실제 MQTT 적산 경로에 과거 상태를 순서대로 통과시킨다.
    await this.sql(`
      DELETE FROM "FixtureEnergyDailyAggregate" WHERE "fixtureId" IN (${fixtureIdList});
      DELETE FROM "FixtureEnergyStateCursor" WHERE "fixtureId" IN (${fixtureIdList});
      UPDATE "Fixture"
      SET "energyTrackingStartedAt"='${start.toISOString()}',
          "firstStateOccurredAt"=NULL,
          "lastStateEventId"=NULL,
          "lastStateSequence"=NULL,
          "lastStateOccurredAt"=NULL
      WHERE id IN (${fixtureIdList});
    `);
    const count = mode === "partial" ? 2 : 32;
    for (let index = 0; index < count; index += 1) {
      const occurredAt = new Date(start.getTime() + index * 120_000).toISOString();
      for (const fixtureId of fixtureIds) {
        const ackCount = this.stateIngestedAckCount();
        await this.publish(mqttTopicsV2.fixtureState(installation.siteId, this.gateway.id), fixtureStateV2Schema.parse({
          siteId: installation.siteId, gatewayId: this.gateway.id, fixtureId,
          eventId: randomUUID(), sequence: this.nextSequence(), occurredAt,
          brightness: 60, powerOn: true, status: "online", statusReason: "mesh_publication",
          health: { faultCodes: [], observedAt: occurredAt }, rssi: -48, hopCount: 1
        }));
        await this.waitFor(() => this.stateIngestedAckCount() > ackCount, 10_000);
      }
    }
  }

  async assertEvidence() {
    if (this.backgroundError) throw this.backgroundError;
    const requiredPaths = ["/api/setup/initial-site", "/api/gateways/claim", "/api/registration-sessions", "/api/commands/dimming", "/api/energy/sites/"];
    for (const path of requiredPaths) {
      if (!this.network.some((item) => item.path?.toString().includes(path))) throw new Error(`network evidence missing: ${path}`);
    }
    const requiredMqtt = ["scan-completed", "provisioning-completed", "subscription-result", "acks/acceptance", "acks/device-status", "acks/state-ingested"];
    for (const marker of requiredMqtt) {
      if (!this.mqttEvidence.some((item) => item.topic?.toString().includes(marker))) throw new Error(`MQTT evidence missing: ${marker}`);
    }
  }

  async writeEvidence(testInfo: TestInfo) {
    await writeFile(testInfo.outputPath("network-evidence.json"), JSON.stringify(this.network, null, 2));
    await writeFile(testInfo.outputPath("mqtt-evidence.json"), JSON.stringify(this.mqttEvidence, null, 2));
    for (const name of ["api.log", "web.log"]) {
      const source = join(this.labDir, name);
      if (existsSync(source)) await writeFile(testInfo.outputPath(name), await readFile(source));
    }
  }

  async assertProductionBundleIsolation() {
    const files = await listFiles(join(ROOT, "apps/web/dist"));
    for (const file of files) {
      if ((await readFile(file, "utf8")).includes(LAB_SENTINEL) || (await readFile(file, "utf8")).includes("real-backend-lab")) {
        throw new Error(`test-only lab support leaked into production bundle: ${file}`);
      }
    }
  }

  private async handleMqtt(topic: string, payload: Buffer) {
    this.recordMqtt({
      direction: topic.includes("/acks/") ? "application-ack" : "command",
      topic,
      payload: parseJson(payload)
    });
    if (topic.endsWith("/commands/provisioning/scan-start")) {
      const command = provisioningScanStartSchema.parse(JSON.parse(payload.toString()));
      this.scanCount += 1;
      if (this.scanCount > 1) {
        for (const fixture of this.fixtures) {
          await this.publish(mqttTopicsV2.provisioningScanFound(command.siteId, command.gatewayId), provisioningScanFoundSchema.parse({
            sessionId: command.sessionId, scanCorrelationId: command.scanCorrelationId, scanAttempt: command.scanAttempt,
            siteId: command.siteId, gatewayId: command.gatewayId,
            eventId: randomUUID(), sequence: this.nextSequence(), occurredAt: new Date().toISOString(),
            ...fixture, rssi: -45, oobCapability: "static-oob", firmwareVersion: "1.0.0"
          }));
        }
      }
      await this.publish(mqttTopicsV2.provisioningScanCompleted(command.siteId, command.gatewayId), provisioningScanCompletedSchema.parse({
        siteId: command.siteId, gatewayId: command.gatewayId, sessionId: command.sessionId,
        scanCorrelationId: command.scanCorrelationId, scanAttempt: command.scanAttempt,
        eventId: randomUUID(), sequence: this.nextSequence(), occurredAt: new Date().toISOString(),
        acceptedNodeCount: this.scanCount > 1 ? this.fixtures.length : 0
      }));
      return;
    }
    if (topic.endsWith("/commands/provisioning/provision-device")) {
      const command = provisionDeviceSchema.parse(JSON.parse(payload.toString()));
      await this.publish(mqttTopics.provisioningCompleted(command.siteId, command.gatewayId), provisioningCompletedSchema.parse({
        sessionId: command.sessionId, nodeId: command.nodeId, deviceUuid: command.deviceUuid,
        meshAddress: command.meshAddress, firmwareVersion: "1.0.0", rssi: -45, hopCount: 1,
        completedAt: new Date().toISOString()
      }));
      await delay(250);
      this.scheduleInitialFixtureStates();
      return;
    }
    if (topic.endsWith("/commands/mesh-group/subscription-sync")) {
      const command = meshGroupSubscriptionSyncSchema.parse(JSON.parse(payload.toString()));
      await this.publish(mqttTopics.meshGroupSubscriptionResult(command.siteId, command.gatewayId), meshGroupSubscriptionResultSchema.parse({
        siteId: command.siteId, gatewayId: command.gatewayId, groupId: command.groupId,
        version: command.version, groupAddress: command.groupAddress, occurredAt: new Date().toISOString(),
        operations: command.expectedOperations.map((operation) => ({ ...operation, status: "ready" }))
      }));
      return;
    }
    if (topic.endsWith("/commands/dimming")) {
      const command = JSON.parse(payload.toString());
      const identity = {
        siteId: command.siteId, gatewayId: command.gatewayId, commandId: command.commandId,
        dispatchId: command.dispatchId, idempotencyKey: command.idempotencyKey, sequence: command.sequence
      };
      await this.publish(mqttTopicsV2.acceptanceAck(command.siteId, command.gatewayId), acceptanceAckV2Schema.parse({
        ...identity, eventId: randomUUID(), status: "accepted", acceptedAt: new Date().toISOString()
      }));
      await this.publish(mqttTopicsV2.deviceStatusAck(command.siteId, command.gatewayId), deviceStatusAckV2Schema.parse({
        ...identity, eventId: randomUUID(), status: "succeeded", occurredAt: new Date().toISOString(),
        results: command.targetFixtureIds.map((fixtureId: string) => ({ fixtureId, status: "succeeded", brightness: command.brightness, rssi: -46, hopCount: 1 }))
      }));
      for (const fixtureId of command.targetFixtureIds) await this.publishFixtureState(fixtureId, command.brightness);
    }
  }

  private async publishCurrentFixtureStates() {
    for (const fixtureId of await this.fixtureIds()) await this.publishFixtureState(fixtureId, 60);
  }

  private publishInitialFixtureStatesWhenReady() {
    if (this.initialStatesPublished) return Promise.resolve();
    this.initialStatePublishPromise ??= this.publishInitialFixtureStates().finally(() => {
      this.initialStatePublishPromise = undefined;
    });
    return this.initialStatePublishPromise;
  }

  private async publishInitialFixtureStates() {
    const fixtureIds = await this.fixtureIds();
    if (fixtureIds.length !== this.fixtures.length) return;
    for (const fixtureId of fixtureIds) await this.publishFixtureState(fixtureId, 60);
    this.initialStatesPublished = true;
  }

  private scheduleInitialFixtureStates() {
    let task!: Promise<void>;
    task = delay(800)
      .then(() => this.publishInitialFixtureStatesWhenReady())
      .catch((error) => {
        this.backgroundError ??= error;
      })
      .finally(() => this.backgroundTasks.delete(task));
    this.backgroundTasks.add(task);
  }

  private async publishFixtureState(fixtureId: string, brightness: number) {
    const installation = this.requireInstallation();
    const occurredAt = new Date().toISOString();
    const state = fixtureStateV2Schema.parse({
      siteId: installation.siteId, gatewayId: this.gateway.id, fixtureId,
      eventId: randomUUID(), sequence: this.nextSequence(), occurredAt,
      brightness, powerOn: brightness > 0, status: "online", statusReason: "mesh_publication",
      health: { faultCodes: [], observedAt: occurredAt }, rssi: -46, hopCount: 1
    });
    await this.publish(mqttTopicsV2.fixtureState(installation.siteId, this.gateway.id), state);
    await this.waitFor(() => this.stateIngestedEventIds.has(state.eventId), 10_000);
  }

  private async publishHeartbeat() {
    if (!this.mqtt || !this.gateway.id || !this.installation) return;
    await this.publish(mqttTopicsV2.heartbeat(this.installation.siteId, this.gateway.id), gatewayHeartbeatV2Schema.parse({
      siteId: this.installation.siteId, gatewayId: this.gateway.id, eventId: randomUUID(), sequence: this.nextSequence(),
      occurredAt: new Date().toISOString(), gatewaySerial: this.gateway.serialNumber, firmwareVersion: "task11-lab-1.0.0", configVersion: 1
    }));
  }

  private async publish(topic: string, payload: unknown, options: IClientPublishOptions = { qos: 1 }) {
    if (!this.mqtt) throw new Error("test-only MQTT publisher is not connected");
    await publish(this.mqtt, topic, JSON.stringify(payload), options);
    this.recordMqtt({ direction: "gateway-event", topic, eventId: (payload as { eventId?: string }).eventId ?? null });
  }

  private nextSequence() { return this.eventSequence += 1; }

  private stateIngestedAckCount() {
    return this.stateIngestedEventIds.size;
  }

  private recordMqtt(entry: Record<string, unknown>) {
    this.mqttEvidence.push(entry);
    appendFileSync(join(this.labDir, "mqtt-evidence.ndjson"), `${JSON.stringify(entry)}\n`);
  }

  private requireInstallation() {
    if (!this.installation) throw new Error("initial site must be created before this operation");
    return this.installation;
  }

  private async fixtureIds() {
    const raw = await this.scalar(`SELECT coalesce(string_agg(id,',' ORDER BY name),'') FROM "Fixture" WHERE "floorId"='${this.requireInstallation().floorId}'`);
    return raw ? raw.split(",") : [];
  }

  private async startInfrastructure() {
    for (const port of [ports.postgres, ports.redis, ports.mqtt, ports.api, ports.web]) {
      if (await canConnect(port)) throw new Error(`Task 11 격리 포트 ${port}가 이미 사용 중입니다.`);
    }
    const postgresData = join(this.labDir, "postgres");
    await this.run("initdb", ["-D", postgresData, "--username=led", "--auth=trust", "--no-locale"]);
    this.spawnLogged("postgres", "postgres", ["-D", postgresData, "-h", "127.0.0.1", "-p", String(ports.postgres)], {});
    await waitForPort(ports.postgres);
    await this.run("createdb", ["-h", "127.0.0.1", "-p", String(ports.postgres), "-U", "led", "led_control"]);

    this.spawnLogged("redis", "redis-server", ["--bind", "127.0.0.1", "--port", String(ports.redis), "--save", "", "--appendonly", "no", "--dir", this.labDir], {});
    this.spawnLogged("mqtt", "mosquitto", ["-c", join(this.labDir, "mosquitto.conf")], {});
    await Promise.all([waitForPort(ports.redis), waitForPort(ports.mqtt)]);
  }

  private async writeMosquittoConfig() {
    await writeFile(join(this.labDir, "mosquitto.acl"), [
      "user api-service", "topic readwrite sites/#", ""
    ].join("\n"));
    chmodSync(join(this.labDir, "mosquitto.acl"), 0o600);
    await writeFile(join(this.labDir, "mosquitto.conf"), [
      `listener ${ports.mqtt} 127.0.0.1`, "allow_anonymous false", `cafile ${join(this.pkiDir, "ca.crt")}`,
      `certfile ${join(this.pkiDir, "broker.crt")}`, `keyfile ${join(this.pkiDir, "broker.key")}`, `crlfile ${join(this.pkiDir, "ca.crl")}`,
      "require_certificate true", "use_identity_as_username true", "tls_version tlsv1.2",
      `acl_file ${join(this.labDir, "mosquitto.acl")}`, "persistence false", "log_dest stdout", ""
    ].join("\n"));
  }

  private apiEnv() {
    return {
      DATABASE_URL: `postgresql://led:led@127.0.0.1:${ports.postgres}/led_control?schema=public`,
      REDIS_URL: `redis://127.0.0.1:${ports.redis}`,
      MQTT_URL: `mqtts://localhost:${ports.mqtt}`,
      MQTT_PUBLIC_URL: `mqtts://localhost:${ports.mqtt}`,
      MQTT_CA_PATH: join(this.pkiDir, "ca.crt"), MQTT_CLIENT_CERT_PATH: join(this.pkiDir, "api.crt"),
      MQTT_CLIENT_KEY_PATH: join(this.pkiDir, "api.key"), MQTT_API_INSTANCE_ID: this.runId,
      API_PORT: String(ports.api), WEB_PUBLIC_URL: `http://127.0.0.1:${ports.web}`,
      PKI_PROVIDER: "unavailable", NODE_ENV: "test"
    };
  }

  private spawnLogged(name: string, command: string, args: string[], env: NodeJS.ProcessEnv) {
    const log = openSync(join(this.labDir, `${name}.log`), "a");
    const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", log, log] });
    this.processes.push(child);
  }

  private async run(command: string, args: string[], env: NodeJS.ProcessEnv = {}) {
    const result = spawnSync(command, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }

  private async sql(statement: string) {
    const result = spawnSync("psql", ["-h", "127.0.0.1", "-p", String(ports.postgres), "-v", "ON_ERROR_STOP=1", "-U", "led", "-d", "led_control", "-c", statement], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`isolated DB statement failed: ${result.stderr}`);
  }

  private async scalar(statement: string) {
    const result = spawnSync("psql", ["-h", "127.0.0.1", "-p", String(ports.postgres), "-At", "-U", "led", "-d", "led_control", "-c", statement], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`isolated DB query failed: ${result.stderr}`);
    return result.stdout.trim();
  }

  private async queryJson<T>(statement: string): Promise<T> {
    return JSON.parse(await this.scalar(statement)) as T;
  }

  private async waitFor(predicate: () => boolean, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await delay(100);
    }
    throw new Error("timed out waiting for real-backend evidence");
  }
}

async function hashSecret(secret: string) {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(secret, salt, 64) as Buffer;
  return `scrypt$${salt}$${key.toString("hex")}`;
}

function sqlString(value: string) { return `'${value.replaceAll("'", "''")}'`; }

function parseJson(value: Buffer) {
  try { return JSON.parse(value.toString()); } catch { return value.toString(); }
}

async function waitForPort(port: number, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(port)) return;
    await delay(200);
  }
  throw new Error(`port ${port} did not become ready`);
}

function canConnect(port: number) {
  return new Promise<boolean>((resolvePromise) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(300);
    socket.once("connect", () => { socket.destroy(); resolvePromise(true); });
    const fail = () => { socket.destroy(); resolvePromise(false); };
    socket.once("error", fail); socket.once("timeout", fail);
  });
}

async function waitForHttp(url: string, accepted: number[], timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (accepted.includes((await fetch(url)).status)) return; } catch { /* startup */ }
    await delay(250);
  }
  throw new Error(`${url} did not become ready`);
}

function connectMqtt(options: Parameters<typeof connect>[1]) {
  return new Promise<MqttClient>((resolvePromise, reject) => {
    const client = connect(`mqtts://${options?.host}:${options?.port}`, { ...options, protocolVersion: 5, rejectUnauthorized: true });
    client.once("connect", () => resolvePromise(client));
    client.once("error", reject);
  });
}

function subscribe(client: MqttClient, topics: string[]) {
  return new Promise<void>((resolvePromise, reject) => client.subscribe(topics, { qos: 1 }, (error) => error ? reject(error) : resolvePromise()));
}

function publish(client: MqttClient, topic: string, payload: string, options: IClientPublishOptions) {
  return new Promise<void>((resolvePromise, reject) => client.publish(topic, payload, options, (error) => error ? reject(error) : resolvePromise()));
}

function closeMqtt(client?: MqttClient) {
  if (!client) return Promise.resolve();
  return new Promise<void>((resolvePromise) => client.end(false, {}, () => resolvePromise()));
}

async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())), delay(5_000)]);
  if (child.exitCode === null && !child.signalCode) {
    const killed = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
    child.kill("SIGKILL");
    await Promise.race([killed, delay(1_000)]);
  }
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? listFiles(join(directory, entry.name)) : [join(directory, entry.name)]));
  return nested.flat();
}

function delay(ms: number) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
function safeMessage(error: unknown) { return error instanceof Error ? error.message : "unknown error"; }

void LAB_SENTINEL;
