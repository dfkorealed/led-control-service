import type { Page, Request, TestInfo } from "@playwright/test";
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
  parseDfkDeviceUuid,
  provisionDeviceSchema,
  provisioningCompletedSchema,
  provisioningScanCompletedSchema,
  provisioningScanFoundSchema,
  provisioningScanStartSchema
} from "@led-control/shared";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID, scrypt as scryptCallback } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { connect, type IClientPublishOptions, type MqttClient } from "mqtt";

const scrypt = promisify(scryptCallback);
const LAB_SENTINEL = "LED_CONTROL_REAL_BACKEND_LAB_SUPPORT_ONLY";
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../../../");
const defaultPorts = {
  postgres: Number(process.env.E2E_LAB_POSTGRES_PORT ?? 15432),
  redis: Number(process.env.E2E_LAB_REDIS_PORT ?? 16379),
  mqtt: Number(process.env.E2E_LAB_MQTT_PORT ?? 18883),
  api: Number(process.env.E2E_LAB_API_PORT ?? 14000),
  web: Number(process.env.E2E_LAB_WEB_PORT ?? 15173)
};
const childStartupErrors = new WeakMap<ChildProcess, Error>();

type Installation = { siteId: string; floorId: string; timeZone: string };
type ScanCandidate = { serialNumber: string; deviceUuid: string };
type Actor = "operator" | "admin" | "viewer";
type LabPorts = typeof defaultPorts;
type NetworkEvidence = {
  id: number;
  actor: Actor;
  method: string;
  path: string;
  status: number | null;
  outcome: "pending" | "responded" | "failed";
};

export class RealBackendLab {
  readonly operator = { loginId: runtimeLoginId("operator"), password: runtimePassword() };
  readonly admin = { loginId: runtimeLoginId("admin"), name: "Task 9 현장 관리자", password: runtimePassword(), newPassword: runtimePassword() };
  readonly viewer = {
    loginId: runtimeLoginId("viewer"),
    email: `${runtimeLoginId("viewer-mail")}@example.invalid`,
    name: "Task 9 조회 사용자",
    password: runtimePassword()
  };
  readonly gateway = { id: "", serialNumber: `DFK-TASK9-${randomBytes(6).toString("hex").toUpperCase()}`, claimCode: runtimeSecret("claim") };
  readonly fixtures = [
    { serialNumber: `DFK-T9-${randomBytes(5).toString("hex").toUpperCase()}-01`, deviceUuid: runtimeDfkDeviceUuid() },
    { serialNumber: `DFK-T9-${randomBytes(5).toString("hex").toUpperCase()}-02`, deviceUuid: runtimeDfkDeviceUuid() }
  ];
  private readonly invalidScanCandidate = {
    serialNumber: `OTHER-T9-${randomBytes(5).toString("hex").toUpperCase()}`,
    deviceUuid: randomBytes(16).toString("hex")
  };

  private readonly runId = `task9-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  private readonly labDir = join(ROOT, ".local", "e2e-real-backend", this.runId);
  private readonly pkiDir = join(this.labDir, "pki");
  private readonly postgresSocketDir = join("/tmp", `lcs-e2e-pg-${randomBytes(8).toString("hex")}`);
  private readonly ports: LabPorts;
  private readonly processes: ChildProcess[] = [];
  private readonly network: NetworkEvidence[] = [];
  private readonly networkByRequest = new WeakMap<Request, NetworkEvidence>();
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
  private stopping?: Promise<void>;
  private cleanupTimeoutMs: number;

  constructor(options: { ports?: Partial<LabPorts>; cleanupTimeoutMs?: number } = {}) {
    this.ports = { ...defaultPorts, ...options.ports };
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5_000;
  }

  async start() {
    if (this.started) return;
    try {
      await this.assertPortsAvailable();
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
        BOOTSTRAP_ORGANIZATION_NAME: "Task 9 서비스 운영사",
        BOOTSTRAP_OPERATOR_LOGIN_ID: this.operator.loginId,
        BOOTSTRAP_OPERATOR_NAME: "Task 9 운영자",
        BOOTSTRAP_OPERATOR_PASSWORD: this.operator.password
      });
      const api = this.spawnLogged("api", process.execPath, [join(ROOT, "apps/api/dist/src/main.js")], this.apiEnv());
      const web = this.spawnLogged("web", process.execPath, [join(ROOT, "apps/web/node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(this.ports.web), "--strictPort"], {
        WEB_PORT: String(this.ports.web), VITE_API_PROXY_TARGET: `http://127.0.0.1:${this.ports.api}`
      }, join(ROOT, "apps/web"));
      await Promise.all([
        waitForOwnedHttp(api, this.ports.api, `http://127.0.0.1:${this.ports.api}/auth/me`, [401]),
        waitForOwnedHttp(web, this.ports.web, `http://127.0.0.1:${this.ports.web}`, [200])
      ]);
      this.started = true;
    } catch (error) {
      try {
        await this.stop();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "real backend lab startup and cleanup failed");
      }
      throw error;
    }
  }

  stop() {
    this.stopping ??= this.stopStages().finally(() => {
      this.started = false;
    });
    return this.stopping;
  }

  captureNetwork(page: Page, actor: Actor) {
    const recordRequest = (request: Request) => {
      const existing = this.networkByRequest.get(request);
      if (existing) return existing;
      const url = new URL(request.url());
      if (!url.pathname.startsWith("/api/")) return undefined;
      const record: NetworkEvidence = {
        id: this.network.length + 1,
        actor,
        method: request.method(),
        path: url.pathname + url.search,
        status: null,
        outcome: "pending"
      };
      this.network.push(record);
      this.networkByRequest.set(request, record);
      return record;
    };
    page.on("request", recordRequest);
    page.on("response", (response) => {
      const record = recordRequest(response.request());
      if (!record) return;
      record.status = response.status();
      record.outcome = "responded";
    });
    page.on("requestfailed", (request) => {
      const record = recordRequest(request);
      if (record) record.outcome = "failed";
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

  async seedViewerAccount() {
    const installation = this.requireInstallation();
    const organizationId = await this.scalar(`SELECT "organizationId" FROM "Site" WHERE id=${sqlString(installation.siteId)}`);
    const userId = randomUUID();
    const passwordHash = await hashSecret(this.viewer.password);
    await this.sql(`
      INSERT INTO "User" (id,"organizationId","loginId",email,name,"passwordHash",role,status,"createdAt","updatedAt")
      VALUES (${sqlString(userId)},${sqlString(organizationId)},${sqlString(this.viewer.loginId)},${sqlString(this.viewer.email)},
              ${sqlString(this.viewer.name)},${sqlString(passwordHash)},'viewer','active',now(),now());
      INSERT INTO "SiteMembership" (id,"userId","siteId","createdAt")
      VALUES (${sqlString(randomUUID())},${sqlString(userId)},${sqlString(installation.siteId)},now());
    `);
  }

  assertOperatorNetworkIsolation() {
    const customerRequests = this.network.filter((item) => item.actor === "operator" && isCustomerDataPath(String(item.path ?? "")));
    if (customerRequests.length > 0) throw new Error("operator requested a customer site or dashboard endpoint");
  }

  async readFixturePlacement(name: string) {
    return this.queryJson<{ x: number; y: number }>(
      `SELECT json_build_object('x',x,'y',y) FROM "Fixture" WHERE name=${sqlString(name)}`
    );
  }

  dimmingCommandCount() {
    return this.mqttEvidence.filter((item) => String(item.topic ?? "").endsWith("/commands/dimming")).length;
  }

  async waitForDimmingCommandCount(expected: number) {
    await this.waitFor(() => this.dimmingCommandCount() >= expected, 15_000);
    await this.mqttHandlerChain;
  }

  async attachGatewayPublisher() {
    const installation = this.requireInstallation();
    const gatewayId = await this.scalar(`SELECT id FROM "Gateway" WHERE "serialNumber"='${this.gateway.serialNumber}'`);
    Object.assign(this.gateway, { id: gatewayId });
    await this.run(resolve(ROOT, "scripts/dev-pki/issue-gateway-cert.sh"), [gatewayId], { PKI_DIR: this.pkiDir });
    const certificateName = `gateway-${gatewayId.replaceAll(/[^a-zA-Z0-9._-]/g, "_")}`;
    this.mqtt = await connectMqtt({
      host: "127.0.0.1", port: this.ports.mqtt, clientId: `task9-publisher-${this.runId}`,
      ca: await readFile(join(this.pkiDir, "ca.crt")),
      cert: await readFile(join(this.pkiDir, `${certificateName}.crt`)),
      key: await readFile(join(this.pkiDir, `${certificateName}.key`))
    });
    await this.assertGatewayAcl(this.mqtt, installation.siteId, gatewayId);
    await subscribe(this.mqtt, [
      `sites/${installation.siteId}/gateways/${gatewayId}/commands/#`,
      `sites/${installation.siteId}/gateways/${gatewayId}/acks/#`
    ]);
    this.recordMqtt({ direction: "lab-principal", principal: gatewayId, scope: "own-gateway-topics" });
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

  private async assertGatewayAcl(client: MqttClient, siteId: string, gatewayId: string) {
    const deniedTopics = [
      `sites/${siteId}/gateways/${randomUUID()}/state/heartbeat`,
      `sites/${siteId}/gateways/${gatewayId}/commands/dimming`
    ];
    for (const topic of deniedTopics) {
      try {
        await publish(client, topic, "{}", { qos: 1 });
        throw new Error(`lab gateway ACL unexpectedly allowed ${topic}`);
      } catch (error) {
        if (!safeMessage(error).toLowerCase().includes("not authorized")) throw error;
      }
    }
    this.recordMqtt({ direction: "acl-negative", deniedPublishCount: deniedTopics.length });
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
    const requiredPaths = ["/api/setup/initial-site", "/api/gateways/claim", "/api/registration-sessions", "/api/energy/sites/"];
    for (const path of requiredPaths) {
      if (!this.network.some((item) => item.path?.toString().includes(path))) throw new Error(`network evidence missing: ${path}`);
    }
    const requiredMqtt = ["scan-completed", "provisioning-completed", "commands/mesh-group/subscription-sync", "acks/state-ingested"];
    for (const marker of requiredMqtt) {
      if (!this.mqttEvidence.some((item) => item.topic?.toString().includes(marker))) throw new Error(`MQTT evidence missing: ${marker}`);
    }
    if (this.dimmingCommandCount() < 4) throw new Error("MQTT evidence missing: four dimming target commands");
    this.assertOperatorNetworkIsolation();
  }

  async writeEvidence(testInfo: TestInfo) {
    await writeFile(testInfo.outputPath("network-evidence.json"), this.redact(JSON.stringify(this.network, null, 2)));
    await writeFile(testInfo.outputPath("mqtt-evidence.json"), this.redact(JSON.stringify(this.mqttEvidence, null, 2)));
    for (const name of ["api.log", "web.log"]) {
      const source = join(this.labDir, name);
      if (existsSync(source)) await writeFile(testInfo.outputPath(name), this.redact(await readFile(source, "utf8")));
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
      const candidates = selectDfkScanCandidates([...this.fixtures, this.invalidScanCandidate]);
      this.recordMqtt({
        direction: "scan-filter",
        offeredCandidateCount: this.fixtures.length + 1,
        acceptedCandidateCount: candidates.length,
        rejectedCandidateCount: 1
      });
      if (this.scanCount > 1) {
        for (const fixture of candidates) {
          await this.publish(mqttTopicsV2.provisioningScanFound(command.siteId, command.gatewayId), provisioningScanFoundSchema.parse({
            sessionId: command.sessionId, scanCorrelationId: command.scanCorrelationId, scanAttempt: command.scanAttempt,
            siteId: command.siteId, gatewayId: command.gatewayId,
            eventId: randomUUID(), sequence: this.nextSequence(), occurredAt: new Date().toISOString(),
            ...fixture, rssi: -45, oobCapability: "static-oob", firmwareVersion: "1.0.0"
          }));
        }
        await this.waitForDatabaseCount(
          `SELECT count(*) FROM "DiscoveredMeshNode" WHERE "sessionId"=${sqlString(command.sessionId)} AND "scanAttempt"=${command.scanAttempt}`,
          candidates.length
        );
      }
      await this.publish(mqttTopicsV2.provisioningScanCompleted(command.siteId, command.gatewayId), provisioningScanCompletedSchema.parse({
        siteId: command.siteId, gatewayId: command.gatewayId, sessionId: command.sessionId,
        scanCorrelationId: command.scanCorrelationId, scanAttempt: command.scanAttempt,
        eventId: randomUUID(), sequence: this.nextSequence(), occurredAt: new Date().toISOString(),
        acceptedNodeCount: this.scanCount > 1 ? candidates.length : 0
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
      occurredAt: new Date().toISOString(), gatewaySerial: this.gateway.serialNumber, firmwareVersion: "task9-software-simulator-1.0.0", configVersion: 1
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

  private redact(value: string) {
    return [
      this.operator.password,
      this.admin.password,
      this.admin.newPassword,
      this.viewer.password,
      this.gateway.claimCode
    ].reduce((masked, secret) => masked.replaceAll(secret, "[REDACTED]"), value);
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
    const postgresData = join(this.labDir, "postgres");
    await mkdir(this.postgresSocketDir, { recursive: true, mode: 0o700 });
    await this.run("initdb", ["-D", postgresData, "--username=led", "--auth=trust", "--no-locale"]);
    const postgres = this.spawnLogged("postgres", "postgres", [
      "-D", postgresData,
      "-h", "",
      "-k", this.postgresSocketDir,
      "-p", String(this.ports.postgres)
    ], {});
    await waitForPostgresIdentity(postgres, postgresData, this.postgresSocketDir, this.ports.postgres);
    await this.run("createdb", ["-h", this.postgresSocketDir, "-p", String(this.ports.postgres), "-U", "led", "led_control"]);

    const redis = this.spawnLogged("redis", "redis-server", [
      "--bind", "127.0.0.1",
      "--port", String(this.ports.redis),
      "--save", "",
      "--appendonly", "no",
      "--pidfile", join(this.labDir, "redis.pid"),
      "--dir", this.labDir
    ], {});
    const mqtt = this.spawnLogged("mqtt", "mosquitto", ["-c", join(this.labDir, "mosquitto.conf")], {});
    await Promise.all([
      waitForRedisIdentity(redis, this.ports.redis),
      waitForOwnedPort(mqtt, this.ports.mqtt)
    ]);
    const probe = await connectMqtt({
      host: "127.0.0.1",
      port: this.ports.mqtt,
      clientId: `task9-broker-probe-${this.runId}`,
      ca: await readFile(join(this.pkiDir, "ca.crt")),
      cert: await readFile(join(this.pkiDir, "api.crt")),
      key: await readFile(join(this.pkiDir, "api.key"))
    });
    await closeMqtt(probe, true);
  }

  private async assertPortsAvailable() {
    for (const port of Object.values(this.ports)) {
      if (await canConnect(port)) throw new Error(`Task 9 격리 포트 ${port}가 이미 사용 중입니다.`);
    }
  }

  private async writeMosquittoConfig() {
    await writeFile(join(this.labDir, "mosquitto.acl"), [
      "user api-service",
      "topic readwrite sites/#",
      "pattern read sites/+/gateways/%u/commands/#",
      "pattern read sites/+/gateways/%u/acks/#",
      "pattern write sites/+/gateways/%u/acks/acceptance",
      "pattern write sites/+/gateways/%u/acks/device-status",
      "pattern write sites/+/gateways/%u/events/#",
      "pattern write sites/+/gateways/%u/state/#",
      "pattern write sites/+/gateways/%u/heartbeat",
      ""
    ].join("\n"));
    chmodSync(join(this.labDir, "mosquitto.acl"), 0o600);
    await writeFile(join(this.labDir, "mosquitto.conf"), [
      `listener ${this.ports.mqtt} 127.0.0.1`, "allow_anonymous false", `cafile ${join(this.pkiDir, "ca.crt")}`,
      `certfile ${join(this.pkiDir, "broker.crt")}`, `keyfile ${join(this.pkiDir, "broker.key")}`, `crlfile ${join(this.pkiDir, "ca.crl")}`,
      "require_certificate true", "use_identity_as_username true", "tls_version tlsv1.2",
      `acl_file ${join(this.labDir, "mosquitto.acl")}`, "persistence false", "log_dest stdout", ""
    ].join("\n"));
  }

  private apiEnv() {
    const socket = encodeURIComponent(this.postgresSocketDir);
    return {
      DATABASE_URL: `postgresql://led:led@localhost:${this.ports.postgres}/led_control?host=${socket}&schema=public`,
      REDIS_URL: `redis://127.0.0.1:${this.ports.redis}`,
      MQTT_URL: `mqtts://localhost:${this.ports.mqtt}`,
      MQTT_PUBLIC_URL: `mqtts://localhost:${this.ports.mqtt}`,
      MQTT_CA_PATH: join(this.pkiDir, "ca.crt"), MQTT_CLIENT_CERT_PATH: join(this.pkiDir, "api.crt"),
      MQTT_CLIENT_KEY_PATH: join(this.pkiDir, "api.key"), MQTT_API_INSTANCE_ID: this.runId,
      API_PORT: String(this.ports.api), WEB_PUBLIC_URL: `http://127.0.0.1:${this.ports.web}`,
      PKI_PROVIDER: "unavailable", NODE_ENV: "test"
    };
  }

  private spawnLogged(name: string, command: string, args: string[], env: NodeJS.ProcessEnv, cwd = ROOT) {
    const log = openSync(join(this.labDir, `${name}.log`), "a");
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd,
        detached: true,
        env: { ...process.env, ...env },
        stdio: ["ignore", log, log]
      });
    } finally {
      closeSync(log);
    }
    child.once("error", (error) => childStartupErrors.set(child, error));
    this.processes.push(child);
    return child;
  }

  private async run(command: string, args: string[], env: NodeJS.ProcessEnv = {}) {
    const result = spawnSync(command, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }

  private async sql(statement: string) {
    const result = spawnSync("psql", ["-h", this.postgresSocketDir, "-p", String(this.ports.postgres), "-v", "ON_ERROR_STOP=1", "-U", "led", "-d", "led_control", "-c", statement], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`isolated DB statement failed: ${result.stderr}`);
  }

  private async scalar(statement: string) {
    const result = spawnSync("psql", ["-h", this.postgresSocketDir, "-p", String(this.ports.postgres), "-At", "-U", "led", "-d", "led_control", "-c", statement], { encoding: "utf8" });
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

  private async waitForDatabaseCount(statement: string, expected: number) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (Number(await this.scalar(statement)) >= expected) return;
      await delay(100);
    }
    throw new Error("timed out waiting for isolated database ingestion");
  }

  private async stopStages() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    const errors: unknown[] = [];

    try {
      try {
        const background = [...this.backgroundTasks, this.mqttHandlerChain];
        if (background.length > 0) {
          const settled = await settleWithin(background, this.cleanupTimeoutMs, "background task cleanup");
          errors.push(...rejectedReasons(settled));
        }
      } catch (error) {
        errors.push(error);
      }
      try {
        if (this.mqtt) {
          const graceful = await settleWithin([closeMqtt(this.mqtt, false)], this.cleanupTimeoutMs, "MQTT graceful close");
          if (graceful.some((result) => result.status === "rejected")) {
            const forced = await settleWithin([closeMqtt(this.mqtt, true)], this.cleanupTimeoutMs, "MQTT forced close");
            errors.push(...rejectedReasons(forced));
          }
        }
      } catch (error) {
        errors.push(error);
      }
    } finally {
      this.mqtt = undefined;
      try {
        const processResults = await Promise.allSettled(
          [...this.processes].reverse().map((child) => stopProcessGroup(child, this.cleanupTimeoutMs))
        );
        errors.push(...rejectedReasons(processResults));
      } finally {
        this.processes.length = 0;
        try {
          await rm(this.labDir, { recursive: true, force: true });
        } catch (error) {
          errors.push(error);
        }
        try {
          await rm(this.postgresSocketDir, { recursive: true, force: true });
        } catch (error) {
          errors.push(error);
        }
      }
    }

    if (errors.length > 0) throw new AggregateError(errors, "real backend lab cleanup failed");
  }
}

async function hashSecret(secret: string) {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(secret, salt, 64) as Buffer;
  return `scrypt$${salt}$${key.toString("hex")}`;
}

function sqlString(value: string) { return `'${value.replaceAll("'", "''")}'`; }

function runtimeLoginId(prefix: string) {
  return `task9_${prefix.replaceAll("-", "_")}_${randomBytes(6).toString("hex")}`;
}

function runtimePassword() {
  return `T9-${randomBytes(18).toString("base64url")}!`;
}

function runtimeSecret(prefix: string) {
  return `${prefix}-${randomBytes(18).toString("base64url")}`;
}

function runtimeDfkDeviceUuid() {
  return `44464b4c454401010101${randomBytes(6).toString("hex")}`;
}

export function selectDfkScanCandidates<T extends ScanCandidate>(candidates: T[]) {
  return candidates.filter((candidate) => parseDfkDeviceUuid(candidate.deviceUuid) !== null);
}

function isCustomerDataPath(path: string) {
  return path === "/api/sites"
    || path.startsWith("/api/sites?")
    || path.includes("/dashboard");
}

function parseJson(value: Buffer) {
  try { return JSON.parse(value.toString()); } catch { return value.toString(); }
}

async function waitForPostgresIdentity(
  child: ChildProcess,
  expectedDataDirectory: string,
  socketDirectory: string,
  port: number,
  timeoutMs = 60_000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertChildRunning(child, "postgres");
    const result = spawnSync("psql", [
      "-h", socketDirectory,
      "-p", String(port),
      "-U", "led",
      "-d", "postgres",
      "-At",
      "-v", "ON_ERROR_STOP=1",
      "-c", "SHOW data_directory"
    ], { encoding: "utf8" });
    if (result.status === 0) {
      const actualDataDirectory = resolve(result.stdout.trim());
      const postmasterPid = Number((await readFile(join(expectedDataDirectory, "postmaster.pid"), "utf8")).split("\n")[0]);
      assertChildRunning(child, "postgres");
      if (actualDataDirectory !== resolve(expectedDataDirectory)) {
        throw new Error(`PostgreSQL data_directory identity mismatch: ${actualDataDirectory}`);
      }
      if (postmasterPid !== child.pid) {
        throw new Error(`PostgreSQL postmaster identity mismatch: expected ${child.pid}, got ${postmasterPid}`);
      }
      return;
    }
    await delay(200);
  }
  throw new Error("spawned PostgreSQL did not pass the lab identity check");
}

async function waitForRedisIdentity(child: ChildProcess, port: number, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertChildRunning(child, "redis");
    if (ownsListeningPort(child, port)) {
      const result = spawnSync("redis-cli", ["-h", "127.0.0.1", "-p", String(port), "INFO", "server"], { encoding: "utf8" });
      const processId = /^process_id:(\d+)\r?$/m.exec(result.stdout)?.[1];
      assertChildRunning(child, "redis");
      if (result.status === 0 && Number(processId) === child.pid && ownsListeningPort(child, port)) return;
      if (result.status === 0 && processId) {
        throw new Error(`Redis process identity mismatch: expected ${child.pid}, got ${processId}`);
      }
    }
    await delay(100);
  }
  throw new Error("spawned Redis did not pass the lab identity check");
}

async function waitForOwnedPort(child: ChildProcess, port: number, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertChildRunning(child, `service on port ${port}`);
    if (ownsListeningPort(child, port)) return;
    await delay(100);
  }
  throw new Error(`spawned process did not own port ${port}`);
}

async function waitForOwnedHttp(child: ChildProcess, port: number, url: string, accepted: number[], timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertChildRunning(child, url);
    if (ownsListeningPort(child, port)) {
      try {
        const status = (await fetch(url)).status;
        assertChildRunning(child, url);
        if (accepted.includes(status) && ownsListeningPort(child, port)) return;
      } catch {
        assertChildRunning(child, url);
      }
    }
    await delay(200);
  }
  throw new Error(`spawned process did not serve ${url}`);
}

function ownsListeningPort(child: ChildProcess, port: number) {
  if (!child.pid) return false;
  const result = spawnSync("lsof", [
    "-nP", "-a",
    "-p", String(child.pid),
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-t"
  ], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim().split(/\s+/).includes(String(child.pid));
}

function assertChildRunning(child: ChildProcess, name: string) {
  const startupError = childStartupErrors.get(child);
  if (startupError) throw new Error(`${name} failed to spawn: ${startupError.message}`);
  if (!child.pid || child.exitCode !== null || child.signalCode || !isPidAlive(child.pid)) {
    throw new Error(`${name} exited before its identity was verified`);
  }
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

function closeMqtt(client: MqttClient, force: boolean) {
  if (!client) return Promise.resolve();
  return new Promise<void>((resolvePromise) => client.end(force, {}, () => resolvePromise()));
}

async function stopProcessGroup(child: ChildProcess, timeoutMs: number) {
  if (!child.pid) return;
  signalProcessGroup(child.pid, "SIGTERM");
  if (await waitForProcessGroupExit(child.pid, timeoutMs)) return;
  signalProcessGroup(child.pid, "SIGKILL");
  if (!await waitForProcessGroupExit(child.pid, timeoutMs)) {
    throw new Error(`process group ${child.pid} did not exit after SIGKILL`);
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(pid)) return true;
    await delay(20);
  }
  return !isProcessGroupAlive(pid);
}

function isProcessGroupAlive(pid: number) {
  const result = spawnSync("ps", ["-axo", "pgid="], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`failed to inspect process groups: ${result.stderr}`);
  return result.stdout.split("\n").some((value) => Number(value.trim()) === pid);
}

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function settleWithin<T>(promises: Promise<T>[], timeoutMs: number, label: string): Promise<PromiseSettledResult<T>[]> {
  return Promise.race([
    Promise.allSettled(promises),
    delay(timeoutMs).then(() => promises.map(() => ({ status: "rejected", reason: new Error(`${label} timed out`) }) as PromiseRejectedResult))
  ]);
}

function rejectedReasons(results: PromiseSettledResult<unknown>[]) {
  return results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory() ? listFiles(join(directory, entry.name)) : [join(directory, entry.name)]));
  return nested.flat();
}

function delay(ms: number) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
function safeMessage(error: unknown) { return error instanceof Error ? error.message : "unknown error"; }

void LAB_SENTINEL;
