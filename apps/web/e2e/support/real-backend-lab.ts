import type { Page, Request, TestInfo } from "@playwright/test";
import {
  acceptanceAckV2Schema,
  applicationStateIngestedAckV2Schema,
  automationConfigAppliedDeliveryV1Schema,
  automationConfigAppliedReceiptV1Schema,
  automationCurrentConfigRequestV1Schema,
  automationExecutionActionResultPayloadV1Schema,
  automationExecutionEventV1Schema,
  automationExecutionIngestedAckV1Schema,
  automationSnapshotV1Schema,
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
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, X509Certificate } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
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
type AutomationFixture = { fixtureId: string; meshNodeId: string; name: string };
type NetworkEvidence = {
  id: number;
  actor: Actor;
  method: string;
  path: string;
  status: number | null;
  outcome: "pending" | "responded" | "failed";
};
type AutomationExecutionDatabaseRow = {
  eventId: string;
  sequence: string;
  revision: number;
  kind: string;
  ruleId: string | null;
  occurrenceKey: string | null;
  payload: unknown;
  payloadHash: string | null;
  lightingScheduleId: string | null;
  vehicleEventRuleId: string | null;
  manualOverrideId: string | null;
  manualCommandId: string | null;
};

export function correlateAutomationExecutionEvidence(input: {
  siteId: string;
  gatewayId: string;
  producerPid: number;
  targetFixtureId: string;
  mqttEvidence: Array<Record<string, unknown>>;
  databaseRows: AutomationExecutionDatabaseRow[];
}) {
  const eventTopic = mqttTopics.automationExecution(input.siteId, input.gatewayId);
  const ackTopic = mqttTopics.automationExecutionIngested(input.siteId, input.gatewayId);
  const events = new Map<string, ReturnType<typeof automationExecutionEventV1Schema.parse>>();
  const acknowledgements = new Map<string, ReturnType<typeof automationExecutionIngestedAckV1Schema.parse>>();

  for (const evidence of input.mqttEvidence) {
    if (
      evidence.direction === "automation-observer" &&
      evidence.producer === "production-gateway" &&
      evidence.producerPid === input.producerPid &&
      evidence.topic === eventTopic
    ) {
      const event = automationExecutionEventV1Schema.parse(evidence.payload);
      if (event.gatewayId !== input.gatewayId) throw new Error("production execution event scope mismatch");
      const key = automationExecutionKey(event.eventId, event.sequence);
      const existing = events.get(key);
      if (existing && !isDeepStrictEqual(existing, event)) {
        throw new Error(`conflicting production execution replay: ${key}`);
      }
      events.set(key, event);
      continue;
    }
    if (
      evidence.direction === "automation-observer" &&
      evidence.producer === "api" &&
      evidence.producerPid === null &&
      evidence.topic === ackTopic
    ) {
      const acknowledgement = automationExecutionIngestedAckV1Schema.parse(evidence.payload);
      if (acknowledgement.gatewayId !== input.gatewayId) throw new Error("execution ACK scope mismatch");
      const key = automationExecutionKey(acknowledgement.eventId, acknowledgement.sequence);
      const existing = acknowledgements.get(key);
      if (existing && existing.reportPayloadHash !== acknowledgement.reportPayloadHash) {
        throw new Error(`conflicting execution ACK replay: ${key}`);
      }
      acknowledgements.set(key, acknowledgement);
    }
  }

  if (events.size === 0) throw new Error("production automation execution evidence is missing");
  const pendingAckKeys = [...events.keys()].filter((key) => !acknowledgements.has(key));
  if (pendingAckKeys.length > 0) {
    throw new Error(`pending execution ACK: ${pendingAckKeys.join(",")}`);
  }
  const unexpectedAckKeys = [...acknowledgements.keys()].filter((key) => !events.has(key));
  if (unexpectedAckKeys.length > 0) {
    throw new Error(`unexpected execution ACK: ${unexpectedAckKeys.join(",")}`);
  }

  const rows = new Map(input.databaseRows.map((row) => [automationExecutionKey(row.eventId, Number(row.sequence)), row]));
  const pendingDatabaseKeys = [...events.keys()].filter((key) => !rows.has(key));
  if (pendingDatabaseKeys.length > 0) {
    throw new Error(`pending execution DB row: ${pendingDatabaseKeys.join(",")}`);
  }
  const unexpectedDatabaseKeys = [...rows.keys()].filter((key) => !events.has(key));
  if (unexpectedDatabaseKeys.length > 0) {
    throw new Error(`unexpected execution DB row: ${unexpectedDatabaseKeys.join(",")}`);
  }

  const actions: Array<Record<string, unknown>> = [];
  for (const [key, event] of events) {
    const row = rows.get(key)!;
    const acknowledgement = acknowledgements.get(key)!;
    const canonicalPayloadHash = canonicalAutomationExecutionPayloadHash(event);
    if (
      row.revision !== event.revision || row.kind !== event.kind || row.ruleId !== event.ruleId ||
      row.occurrenceKey !== event.occurrenceKey || !isDeepStrictEqual(row.payload, event.payload)
    ) throw new Error(`execution DB row mismatch: ${key}`);
    if (row.payloadHash !== canonicalPayloadHash) throw new Error(`execution DB canonical hash mismatch: ${key}`);
    if (acknowledgement.reportPayloadHash !== canonicalPayloadHash) {
      throw new Error(`execution ACK canonical hash mismatch: ${key}`);
    }
    if (event.kind !== "action_result") continue;
    const action = automationExecutionActionResultPayloadV1Schema.parse(event.payload);
    if (action.sourceType === "schedule" && row.lightingScheduleId !== action.sourceId) {
      throw new Error(`schedule execution source mismatch: ${key}`);
    }
    if (action.sourceType === "vehicle_event_rule" && row.vehicleEventRuleId !== action.sourceId) {
      throw new Error(`vehicle execution source mismatch: ${key}`);
    }
    if (action.sourceType === "manual_override" && (
      !row.manualOverrideId || row.manualCommandId !== action.sourceId
    )) throw new Error(`manual execution source mismatch: ${key}`);
    const targetResult = action.results.find(({ fixtureId }) => fixtureId === input.targetFixtureId);
    if (!targetResult || targetResult.status !== "succeeded" || targetResult.brightnessPercent === null) {
      throw new Error(`target execution result mismatch: ${key}`);
    }
    actions.push({
      eventId: event.eventId,
      sequence: event.sequence,
      sourceType: action.sourceType,
      sourceId: action.sourceId,
      brightness: targetResult.brightnessPercent,
      kind: event.kind,
      revision: event.revision,
      occurrenceKey: event.occurrenceKey,
      payloadHash: canonicalPayloadHash
    });
  }
  actions.sort((left, right) => Number(left.sequence) - Number(right.sequence));

  return {
    uniqueProductionEventCount: events.size,
    uniqueAckCount: acknowledgements.size,
    databaseRowCount: rows.size,
    actions
  };
}

export function inspectAutomationTelemetryOutbox(
  value: unknown,
  scope: { siteId: string; gatewayId: string }
) {
  if (!isJsonRecord(value) || value.version !== 2 || !isJsonRecord(value.scope) ||
    value.scope.siteId !== scope.siteId || value.scope.gatewayId !== scope.gatewayId ||
    !Number.isSafeInteger(value.nextSequence) || Number(value.nextSequence) < 0 ||
    !Array.isArray(value.records) || (value.gap !== null && !isJsonRecord(value.gap)) ||
    !isJsonRecord(value.acceptedHandoffs)) {
    throw new Error("automation telemetry outbox identity or shape mismatch");
  }
  return {
    version: 2,
    siteId: scope.siteId,
    gatewayId: scope.gatewayId,
    nextSequence: Number(value.nextSequence),
    pendingRecordCount: value.records.length,
    pendingGap: value.gap !== null,
    durableHandoffReceiptCount: Object.keys(value.acceptedHandoffs).length
  };
}

function canonicalAutomationExecutionPayloadHash(
  event: ReturnType<typeof automationExecutionEventV1Schema.parse>
) {
  const action = event.kind === "action_result"
    ? automationExecutionActionResultPayloadV1Schema.parse(event.payload)
    : null;
  const value = action ? {
    ...event,
    payload: {
      ...action,
      results: [...action.results]
        .sort((left, right) => left.fixtureId < right.fixtureId ? -1 : left.fixtureId > right.fixtureId ? 1 : 0)
    }
  } : event;
  return `sha256:${createHash("sha256").update(JSON.stringify(sortCanonicalJson(value))).digest("hex")}`;
}

function sortCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonicalJson);
  if (!isJsonRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, sortCanonicalJson(child)])
  );
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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
  private automationObserver?: MqttClient;
  private apiProcess?: ChildProcess;
  private mqttProcess?: ChildProcess;
  private automationGateway?: ChildProcess;
  private automationGatewayEnvironment?: NodeJS.ProcessEnv;
  private automationConfigAckOutboxPath?: string;
  private automationSnapshotPath?: string;
  private automationTelemetryOutboxPath?: string;
  private automationTarget?: AutomationFixture;
  private automationSensor?: AutomationFixture;
  private automationDatabaseEvidence?: Record<string, unknown>;
  private readonly automationPhaseEvidence: Array<Record<string, unknown>> = [];
  private readonly automationConvergenceEvidence: Array<Record<string, unknown>> = [];
  private automationClockMs?: number;
  private readonly automationIpcToken = runtimeSecret("automation-ipc");
  private readonly automationIpcRequests = new Map<string, {
    expectedType: "automation-e2e-sensor-edge-result" | "automation-e2e-clock-advance-result";
    resolve: (result: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
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
      await this.run("pnpm", ["--filter", "@led-control/api", "prisma:generate"]);
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
      this.apiProcess = api;
      const web = this.spawnLogged("web", process.execPath, [join(ROOT, "apps/web/node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(this.ports.web), "--strictPort"], {
        WEB_PORT: String(this.ports.web), VITE_API_PROXY_TARGET: `http://127.0.0.1:${this.ports.api}`
      }, join(ROOT, "apps/web"));
      await Promise.all([
        waitForOwnedHttp(api, this.ports.api, `http://127.0.0.1:${this.ports.api}/auth/me`, [401]),
        waitForOwnedHttp(web, this.ports.web, `http://127.0.0.1:${this.ports.web}`, [200])
      ]);
      this.started = true;
    } catch (error) {
      const diagnosedError = new Error(
        `${safeMessage(error)}${await this.readStartupDiagnostics()}`,
        { cause: error }
      );
      try {
        await this.stop();
      } catch (cleanupError) {
        throw new AggregateError([diagnosedError, cleanupError], "real backend lab startup and cleanup failed");
      }
      throw diagnosedError;
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
    const deniedRequests = this.network.filter((item) => (
      item.actor === "operator" && !isAllowedOperatorApiPath(String(item.path ?? ""))
    ));
    if (deniedRequests.length > 0) throw new Error("operator requested a non-allowlisted API");
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
    await this.seedGatewayMqttCertificateLedger(join(this.pkiDir, `${certificateName}.crt`));
    this.mqtt = await connectMqttForLab({
      host: "127.0.0.1", port: this.ports.mqtt, clientId: `task9-publisher-${this.runId}`,
      ca: await readFile(join(this.pkiDir, "ca.crt")),
      cert: await readFile(join(this.pkiDir, `${certificateName}.crt`)),
      key: await readFile(join(this.pkiDir, `${certificateName}.key`))
    });
    this.mqtt.on("error", (error) => this.recordMqtt({ direction: "client-error", error: safeMessage(error) }));
    await this.assertGatewayAcl(this.mqtt, installation.siteId, gatewayId);
    await subscribe(this.mqtt, [
      `sites/${installation.siteId}/gateways/${gatewayId}/commands/#`,
      `sites/${installation.siteId}/gateways/${gatewayId}/acks/state-ingested`,
      `sites/${installation.siteId}/gateways/${gatewayId}/acks/provisioning/scan-terminal-ingested`
    ]);
    this.recordMqtt({ direction: "lab-principal", principal: gatewayId, scope: "own-gateway-topics" });
    this.mqtt.on("message", (topic, payload) => {
      if (topic.endsWith("/acks/state-ingested")) {
        const acknowledgement = applicationStateIngestedAckV2Schema.parse(JSON.parse(payload.toString()));
        this.stateIngestedEventIds.add(acknowledgement.eventId);
      }
      this.mqttHandlerChain = this.mqttHandlerChain.then(() => this.handleMqtt(topic, payload)).catch((error) => {
        this.backgroundError ??= error;
        this.recordMqtt({ direction: "handler-error", topic, error: safeMessage(error) });
      });
    });
    await this.publishHeartbeat();
    this.heartbeat = setInterval(() => {
      this.trackBackgroundTask(this.publishHeartbeat(), "publisher heartbeat");
    }, 5_000);
  }

  async startAutomationGateway(input: { targetName: string; sensorName: string }) {
    const installation = this.requireInstallation();
    if (!this.gateway.id) throw new Error("claimed gateway is required before automation runtime startup");
    const registered = await this.queryJson<Array<{
      fixtureId: string;
      meshNodeId: string;
      serialNumber: string;
    }>>(`
      SELECT coalesce(json_agg(json_build_object(
        'fixtureId', f.id,
        'meshNodeId', m.id,
        'serialNumber', m."serialNumber"
      ) ORDER BY m."serialNumber"), '[]'::json)
      FROM "Fixture" f
      JOIN "MeshNode" m ON m.id=f."meshNodeId" AND m."gatewayId"=f."gatewayId"
      WHERE f."gatewayId"=${sqlString(this.gateway.id)}
    `);
    const target = registered.find(({ serialNumber }) => serialNumber === this.fixtures[0].serialNumber);
    const sensor = registered.find(({ serialNumber }) => serialNumber === this.fixtures[1].serialNumber);
    if (!target || !sensor) throw new Error("two registered automation fixtures are required");
    await this.sql(`
      UPDATE "Fixture" SET name=${sqlString(input.targetName)}, "updatedAt"=now()
      WHERE id=${sqlString(target.fixtureId)};
      UPDATE "Fixture" SET name=${sqlString(input.sensorName)}, "updatedAt"=now()
      WHERE id=${sqlString(sensor.fixtureId)};
    `);
    this.automationTarget = { ...target, name: input.targetName };
    this.automationSensor = { ...sensor, name: input.sensorName };

    await this.detachGatewayPublisher();
    await this.attachAutomationObserver();
    await this.run("pnpm", ["--filter", "@led-control/gateway", "build"]);

    const gatewayDir = join(this.labDir, "gateway");
    await mkdir(gatewayDir, { recursive: true, mode: 0o700 });
    const assignmentPath = join(gatewayDir, "assignment.json");
    const eventSequencePath = join(gatewayDir, "event-sequence.json");
    const automationTelemetryOutboxPath = join(gatewayDir, "automation-telemetry.json");
    const automationConfigAckOutboxPath = join(gatewayDir, "automation-config-acks.json");
    const automationSnapshotPath = join(gatewayDir, "automation-snapshot.json");
    this.automationTelemetryOutboxPath = automationTelemetryOutboxPath;
    this.automationConfigAckOutboxPath = automationConfigAckOutboxPath;
    this.automationSnapshotPath = automationSnapshotPath;
    await writeFile(assignmentPath, `${JSON.stringify({
      siteId: installation.siteId,
      gatewayId: this.gateway.id,
      serialNumber: this.gateway.serialNumber,
      mqttUrl: `mqtts://localhost:${this.ports.mqtt}`,
      configVersion: 1
    }, null, 2)}\n`, { mode: 0o600 });
    await writeFile(eventSequencePath, `${JSON.stringify({ sequence: this.eventSequence })}\n`, { mode: 0o600 });
    const certificateName = `gateway-${this.gateway.id.replaceAll(/[^a-zA-Z0-9._-]/g, "_")}`;
    const identity = await this.seedGatewayIdentityStores(gatewayDir, certificateName);
    this.automationGatewayEnvironment = {
      NODE_ENV: "test",
      AUTOMATION_E2E_SIMULATOR: "1",
      AUTOMATION_E2E_SIMULATOR_IPC_TOKEN: this.automationIpcToken,
      AUTOMATION_E2E_SIMULATOR_FIXTURES: JSON.stringify([
        { fixtureId: target.fixtureId },
        {
          fixtureId: sensor.fixtureId,
          vehicleSensor: { meshNodeId: sensor.meshNodeId, primaryUnicast: 0x1201 }
        }
      ]),
      GATEWAY_ASSIGNMENT_PATH: assignmentPath,
      GATEWAY_BLUETOOTH_COMPANY_ID: "0x1234",
      GATEWAY_HEARTBEAT_MS: "1000",
      GATEWAY_BLE_STATUS_TIMEOUT_MS: "1000",
      GATEWAY_FIRMWARE_VERSION: "task19-software-automation-simulator",
      GATEWAY_BOOTSTRAP_URL: `https://localhost:${this.ports.api}`,
      GATEWAY_BOOTSTRAP_CA_PATH: join(this.pkiDir, "ca.crt"),
      GATEWAY_DEVICE_CERT_PATH: identity.deviceCertificatePath,
      GATEWAY_DEVICE_KEY_PATH: identity.deviceKeyPath,
      GATEWAY_IDENTITY_ROOT: identity.deviceRoot,
      GATEWAY_MQTT_IDENTITY_ROOT: identity.mqttRoot,
      GATEWAY_MQTT_CA_SOURCE_PATH: join(this.pkiDir, "ca.crt"),
      MQTT_URL: `mqtts://localhost:${this.ports.mqtt}`,
      MQTT_CA_PATH: identity.mqttCaPath,
      MQTT_CLIENT_CERT_PATH: identity.mqttCertificatePath,
      MQTT_CLIENT_KEY_PATH: identity.mqttKeyPath,
      GATEWAY_HEALTH_PATH: join(gatewayDir, "health.json"),
      GATEWAY_COMMAND_JOURNAL_PATH: join(gatewayDir, "command-journal.json"),
      GATEWAY_EVENT_SEQUENCE_PATH: eventSequencePath,
      GATEWAY_PROVISIONING_SCAN_JOURNAL_PATH: join(gatewayDir, "provisioning-scan-journal.json"),
      GATEWAY_STATE_EVENT_OUTBOX_PATH: join(gatewayDir, "state-event-outbox.json"),
      GATEWAY_MESH_GROUP_STATE_PATH: join(gatewayDir, "mesh-groups.json"),
      GATEWAY_MESH_GROUP_RESYNC_PATH: join(gatewayDir, "mesh-group-resync.json"),
      GATEWAY_AUTOMATION_CONFIG_PATH: automationSnapshotPath,
      GATEWAY_AUTOMATION_STATE_PATH: join(gatewayDir, "automation-state.json"),
      GATEWAY_AUTOMATION_TELEMETRY_OUTBOX_PATH: automationTelemetryOutboxPath,
      GATEWAY_AUTOMATION_ACK_OUTBOX_PATH: automationConfigAckOutboxPath,
      GATEWAY_VEHICLE_SENSOR_CAPABILITY_JOURNAL_PATH: join(gatewayDir, "vehicle-sensor-capabilities.json")
    };
    await this.launchAutomationGateway();
  }

  async readRegisteredFixtureName(serialNumber: string) {
    const name = await this.scalar(`
      SELECT f.name
      FROM "Fixture" f
      JOIN "MeshNode" m ON m.id=f."meshNodeId"
      WHERE m."serialNumber"=${sqlString(serialNumber)}
    `);
    if (!name) throw new Error(`registered fixture name is missing: ${serialNumber}`);
    return name;
  }

  async readScheduleId(name: string) {
    const id = await this.scalar(`
      SELECT id FROM "LightingSchedule"
      WHERE "gatewayId"=${sqlString(this.gateway.id)} AND name=${sqlString(name)}
    `);
    if (!id) throw new Error(`schedule identity is missing: ${name}`);
    return id;
  }

  async waitForPublishedDesiredRevisionAhead(label: string, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    let state: Awaited<ReturnType<RealBackendLab["readAutomationSyncState"]>> | undefined;
    while (Date.now() < deadline) {
      state = await this.readAutomationSyncState();
      if (state.desiredRevision > state.appliedRevision && state.publishedAt) {
        const evidence = {
          scenario: label,
          stage: "snapshot-published-unapplied",
          ...state,
          evidenceCursor: this.mqttEvidence.length
        };
        this.automationConvergenceEvidence.push(evidence);
        return evidence;
      }
      await delay(100);
    }
    throw new Error(`desired automation snapshot was not published ahead of applied revision: ${label}`);
  }

  async assertDesiredConfigPublishedBeforeFirstGatewayConnect() {
    if (this.automationGateway || this.automationGatewayEnvironment) {
      throw new Error("production automation Gateway was prepared before the first-connect assertion");
    }
    const evidence = await this.waitForPublishedDesiredRevisionAhead("first-connect-published");
    const configTopic = mqttTopics.automationConfig(this.requireInstallation().siteId, this.gateway.id);
    if (!this.mqttEvidence.some((item) => item.direction === "command" && item.topic === configTopic)) {
      throw new Error("pre-connect config snapshot did not reach the broker-backed test Gateway");
    }
    return evidence;
  }

  async waitForAutomationProtocolConvergence(label: string, evidenceCursor: number, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const state = await this.readAutomationSyncState();
        const localSnapshot = await this.readLocalAutomationSnapshot();
        const pendingAcks = await this.readAutomationConfigAckRecords();
        if (
          state.syncStatus !== "APPLIED" || state.desiredRevision !== state.appliedRevision ||
          localSnapshot.revision !== state.desiredRevision || localSnapshot.payloadHash !== state.payloadHash ||
          pendingAcks.length !== 0
        ) {
          throw new Error("database, local snapshot, and durable ACK state are not converged");
        }
        const protocol = this.readAutomationProtocolEvidence(evidenceCursor);
        const evidence = {
          scenario: label,
          stage: "application-protocol-converged",
          ...state,
          localRevision: localSnapshot.revision,
          pendingAckCount: pendingAcks.length,
          ...protocol
        };
        this.automationConvergenceEvidence.push(evidence);
        return evidence;
      } catch (error) {
        lastError = error;
      }
      await delay(100);
    }
    throw new Error(`automation application protocol did not converge for ${label}: ${safeMessage(lastError)}`, {
      cause: lastError
    });
  }

  async restartAutomationGatewayAfterSessionExpiry(label: string) {
    await this.stopAutomationGateway();
    await this.resetMqttBrokerSessions();
    const evidenceCursor = this.mqttEvidence.length;
    await this.launchAutomationGateway();
    return this.waitForAutomationProtocolConvergence(label, evidenceCursor);
  }

  async stopAutomationGateway() {
    const gateway = this.automationGateway;
    if (!gateway) return;
    this.rejectAutomationIpcRequests("automation Gateway was stopped for a convergence scenario");
    await stopProcessGroup(gateway, this.cleanupTimeoutMs);
    if (this.automationGateway === gateway) this.automationGateway = undefined;
  }

  async restartAutomationGateway() {
    await this.stopAutomationGateway();
    return this.launchAutomationGateway();
  }

  async assertDeletedScheduleDoesNotExecute(scheduleId: string) {
    const snapshot = await this.readLocalAutomationSnapshot();
    if (snapshot.schedules.some(({ id }) => id === scheduleId)) {
      throw new Error("cloud-deleted schedule remains in the local full snapshot");
    }
    const before = Number(await this.scalar(`
      SELECT count(*) FROM "AutomationExecution"
      WHERE "gatewayId"=${sqlString(this.gateway.id)} AND "ruleId"=${sqlString(scheduleId)}
    `));
    await this.advanceAutomationClock(3 * 60 * 60 * 1_000);
    await delay(1_500);
    const after = Number(await this.scalar(`
      SELECT count(*) FROM "AutomationExecution"
      WHERE "gatewayId"=${sqlString(this.gateway.id)} AND "ruleId"=${sqlString(scheduleId)}
    `));
    if (after !== before) throw new Error("cloud-deleted schedule executed after empty-snapshot convergence");
    this.automationConvergenceEvidence.push({
      scenario: "deleted-rule",
      stage: "post-convergence-clock-advance",
      scheduleId,
      localRevision: snapshot.revision,
      executionCountBefore: before,
      executionCountAfter: after,
      advancedMs: 3 * 60 * 60 * 1_000
    });
  }

  async stopApi() {
    const api = this.apiProcess;
    if (!api) return;
    await stopProcessGroup(api, this.cleanupTimeoutMs);
    if (this.apiProcess === api) this.apiProcess = undefined;
  }

  async startApi() {
    if (this.apiProcess) return;
    const api = this.spawnLogged("api", process.execPath, [join(ROOT, "apps/api/dist/src/main.js")], this.apiEnv());
    this.apiProcess = api;
    await waitForOwnedHttp(api, this.ports.api, `http://127.0.0.1:${this.ports.api}/auth/me`, [401]);
  }

  async resetMqttBrokerSessions() {
    const broker = this.mqttProcess;
    if (!broker) throw new Error("lab MQTT broker process is unavailable");
    if (this.mqtt) throw new Error("test Gateway publisher must be detached before broker session reset");
    await stopProcessGroup(broker, this.cleanupTimeoutMs);
    const replacement = this.spawnLogged("mqtt", "mosquitto", ["-c", join(this.labDir, "mosquitto.conf")], {});
    this.mqttProcess = replacement;
    await waitForOwnedPort(replacement, this.ports.mqtt);
    if (this.automationObserver) {
      await this.waitFor(() => Boolean(this.automationObserver?.connected), 15_000);
    }
    this.automationConvergenceEvidence.push({
      scenario: "broker-session-reset",
      stage: "non-persistent-broker-restarted",
      previousPid: broker.pid ?? null,
      replacementPid: replacement.pid ?? null
    });
  }

  async publishLatestDesiredSnapshotAsApiPrincipal() {
    const installation = this.requireInstallation();
    const snapshot = automationSnapshotV1Schema.parse(await this.queryJson<unknown>(`
      SELECT outbox.payload
      FROM "GatewayAutomationConfiguration" configuration
      JOIN "MqttOutbox" outbox
        ON outbox."gatewayId"=configuration."gatewayId"
       AND outbox.revision=configuration."desiredRevision"
       AND outbox."payloadHash"=configuration."payloadHash"
      WHERE configuration."gatewayId"=${sqlString(this.gateway.id)}
        AND outbox."dispatchId" IS NULL
        AND outbox."applicationAckKey" IS NULL
    `));
    const client = await connectMqttForLab({
      host: "127.0.0.1",
      port: this.ports.mqtt,
      clientId: `task19-api-recovery-${randomUUID()}`,
      ca: await readFile(join(this.pkiDir, "ca.crt")),
      cert: await readFile(join(this.pkiDir, "api.crt")),
      key: await readFile(join(this.pkiDir, "api.key"))
    });
    client.on("error", () => undefined);
    const topic = mqttTopics.automationConfig(installation.siteId, this.gateway.id);
    try {
      await publish(client, topic, JSON.stringify(snapshot), { qos: 1 });
      this.recordMqtt({
        direction: "lab-api-recovery-publisher",
        topic,
        revision: snapshot.revision,
        payloadHash: snapshot.payloadHash
      });
    } finally {
      await closeMqttStrictWithin(client, false, this.cleanupTimeoutMs, "API recovery publisher close");
    }
    return snapshot;
  }

  async waitForDurableConfigAck(timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const records = await this.readAutomationConfigAckRecords();
      if (records.length > 0) {
        const record = records[0];
        this.automationConvergenceEvidence.push({
          scenario: "api-restart-ack",
          stage: "broker-puback-without-application-receipt",
          acknowledgementId: record.acknowledgementId,
          revision: record.acknowledgement.revision,
          pendingAckCount: records.length
        });
        return record;
      }
      await delay(100);
    }
    throw new Error("Gateway config-applied ACK did not remain durable after broker PUBACK");
  }

  async assertAutomationConvergenceEvidence() {
    const required = ["first-connect", "session-expired-reconnect", "deleted-rule", "api-restart-ack"];
    for (const scenario of required) {
      if (!this.automationConvergenceEvidence.some((evidence) => evidence.scenario === scenario)) {
        throw new Error(`automation convergence evidence is missing: ${scenario}`);
      }
    }
    const state = await this.readAutomationSyncState();
    const pendingAcks = await this.readAutomationConfigAckRecords();
    if (state.syncStatus !== "APPLIED" || state.desiredRevision !== state.appliedRevision || pendingAcks.length !== 0) {
      throw new Error("final automation convergence state is incomplete");
    }
    this.assertCleanAutomationIngestion();
  }

  async waitForVehicleSensorCapability(name: string, timeoutMs = 20_000) {
    await this.waitForDatabaseValue(
      `SELECT "vehicleSensorCapabilityStatus" FROM "Fixture" f JOIN "MeshNode" m ON m.id=f."meshNodeId" WHERE f.name=${sqlString(name)}`,
      "supported",
      timeoutMs
    );
  }

  injectSensorEdge(fixtureId: string, edge: "detected" | "cleared") {
    return this.sendAutomationIpcRequest(
      "automation-e2e-sensor-edge-result",
      {
        type: "automation-e2e-sensor-edge",
        fixtureId: this.resolveAutomationFixtureId(fixtureId),
        edge
      }
    ).then(() => undefined);
  }

  async advanceAutomationClock(advanceMs: number) {
    const result = await this.sendAutomationIpcRequest(
      "automation-e2e-clock-advance-result",
      { type: "automation-e2e-clock-advance", advanceMs }
    );
    if (typeof result.wallClockMs !== "number" || typeof result.monotonicMs !== "number") {
      throw new Error("automation Gateway returned a malformed clock result");
    }
    this.automationClockMs = result.wallClockMs;
    return { wallClockMs: result.wallClockMs, monotonicMs: result.monotonicMs };
  }

  async advanceAutomationClockTo(wallClockMs: number) {
    const current = await this.advanceAutomationClock(0);
    const advanceMs = Math.floor(wallClockMs - current.wallClockMs);
    if (advanceMs < 0) throw new Error("automation clock cannot move backwards");
    return this.advanceAutomationClock(advanceMs);
  }

  async waitForFixtureBrightness(name: string, brightness: number, timeoutMs = 20_000) {
    await this.waitForDatabaseValue(
      `SELECT brightness::text FROM "Fixture" WHERE name=${sqlString(name)}`,
      String(brightness),
      timeoutMs
    );
  }

  async assertAutomationBrightnessPhase(input: {
    phase: string;
    cause: string;
    fixtureName: string;
    brightness: number;
  }) {
    const actual = Number(await this.scalar(
      `SELECT brightness::text FROM "Fixture" WHERE name=${sqlString(input.fixtureName)}`
    ));
    if (actual !== input.brightness) {
      throw new Error(
        `automation phase ${input.phase} expected brightness ${input.brightness}, received ${actual}`
      );
    }
    this.automationPhaseEvidence.push({
      order: this.automationPhaseEvidence.length + 1,
      phase: input.phase,
      cause: input.cause,
      fixtureName: input.fixtureName,
      brightness: actual,
      clockMs: this.automationClockMs ?? null
    });
  }

  async waitForAutomationExecutionKind(kind: string, expected = 1, timeoutMs = 20_000) {
    await this.waitForDatabaseCount(
      `SELECT count(*) FROM "AutomationExecution" WHERE "gatewayId"=${sqlString(this.gateway.id)} AND kind=${sqlString(kind)}::"AutomationExecutionKind"`,
      expected,
      timeoutMs
    );
  }

  async latestVehicleHoldUntil() {
    const value = await this.scalar(`
      SELECT payload->>'holdUntil'
      FROM "AutomationExecution"
      WHERE "gatewayId"=${sqlString(this.gateway.id)} AND kind='event_extended'::"AutomationExecutionKind"
      ORDER BY sequence DESC
      LIMIT 1
    `);
    const holdUntilMs = Date.parse(value);
    if (!Number.isFinite(holdUntilMs)) throw new Error("vehicle hold deadline evidence is missing");
    return holdUntilMs;
  }

  async assertAutomationEvidence(input: { targetName: string; sensorName: string }) {
    const installation = this.requireInstallation();
    const evidence = await this.queryJson<Record<string, unknown>>(`
      SELECT json_build_object(
        'siteId', ${sqlString(installation.siteId)},
        'gatewayId', ${sqlString(this.gateway.id)},
        'scheduleCount', (SELECT count(*)::int FROM "LightingSchedule" WHERE "siteId"=${sqlString(installation.siteId)}),
        'vehicleEventRuleCount', (SELECT count(*)::int FROM "VehicleEventRule" WHERE "siteId"=${sqlString(installation.siteId)}),
        'manualOverrideCount', (SELECT count(*)::int FROM "ManualOverride" WHERE "siteId"=${sqlString(installation.siteId)}),
        'automationExecutionCount', (SELECT count(*)::int FROM "AutomationExecution" WHERE "siteId"=${sqlString(installation.siteId)}),
        'desiredRevision', (SELECT "desiredRevision" FROM "GatewayAutomationConfiguration" WHERE "gatewayId"=${sqlString(this.gateway.id)}),
        'appliedRevision', (SELECT "appliedRevision" FROM "GatewayAutomationConfiguration" WHERE "gatewayId"=${sqlString(this.gateway.id)}),
        'syncStatus', (SELECT "syncStatus" FROM "GatewayAutomationConfiguration" WHERE "gatewayId"=${sqlString(this.gateway.id)}),
        'targetFixtureId', (SELECT id FROM "Fixture" WHERE name=${sqlString(input.targetName)}),
        'targetBrightness', (SELECT brightness FROM "Fixture" WHERE name=${sqlString(input.targetName)}),
        'sensorCapability', (SELECT m."vehicleSensorCapabilityStatus" FROM "Fixture" f JOIN "MeshNode" m ON m.id=f."meshNodeId" WHERE f.name=${sqlString(input.sensorName)})
      )
    `);
    for (const [key, minimum] of [
      ["scheduleCount", 1],
      ["vehicleEventRuleCount", 1],
      ["manualOverrideCount", 1],
      ["automationExecutionCount", 4]
    ] as const) {
      if (Number(evidence[key]) < minimum) throw new Error(`database automation evidence missing: ${key}`);
    }
    if (evidence.syncStatus !== "APPLIED" || evidence.desiredRevision !== evidence.appliedRevision) {
      throw new Error("database automation snapshot was not applied");
    }
    for (const marker of [
      "/commands/automation/config-sync",
      "/events/automation/current-config-request",
      "/events/automation/config-applied",
      "/acks/automation/config-applied-ingested",
      "/events/automation/execution",
      "/events/automation/vehicle-sensor-capability",
      "/state/fixtures"
    ]) {
      if (!this.mqttEvidence.some(({ topic }) => String(topic).includes(marker))) {
        throw new Error(`MQTT automation evidence missing: ${marker}`);
      }
    }
    const gateway = this.automationGateway;
    if (!gateway?.pid) throw new Error("production automation Gateway child identity is unavailable");
    const targetFixtureId = String(evidence.targetFixtureId ?? "");
    if (!targetFixtureId) throw new Error("automation target fixture identity is unavailable");
    const executionOracle = await this.waitForAutomationExecutionOracle(gateway.pid, targetFixtureId, 30_000);
    this.assertCleanAutomationIngestion();
    if (this.backgroundError) throw this.backgroundError;
    this.automationDatabaseEvidence = { ...evidence, executionOracle };
  }

  private async waitForAutomationExecutionOracle(
    producerPid: number,
    targetFixtureId: string,
    timeoutMs: number
  ) {
    const installation = this.requireInstallation();
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    let stableSignature = "";
    let stableSince = 0;
    while (Date.now() < deadline) {
      try {
        const databaseRows = await this.queryAutomationExecutionRows();
        const correlated = correlateAutomationExecutionEvidence({
          siteId: installation.siteId,
          gatewayId: this.gateway.id,
          producerPid,
          targetFixtureId,
          mqttEvidence: this.mqttEvidence,
          databaseRows
        });
        const gatewayTelemetryOutbox = await this.readAutomationTelemetryOutbox();
        if (gatewayTelemetryOutbox.pendingRecordCount !== 0 || gatewayTelemetryOutbox.pendingGap) {
          throw new Error(
            `Gateway automation telemetry outbox is pending: records=${gatewayTelemetryOutbox.pendingRecordCount}, gap=${gatewayTelemetryOutbox.pendingGap}`
          );
        }
        const phases = expectedAutomationActionPhases(correlated.actions);
        const signature = JSON.stringify({
          eventCount: correlated.uniqueProductionEventCount,
          ackCount: correlated.uniqueAckCount,
          databaseRowCount: correlated.databaseRowCount,
          phases,
          gatewayTelemetryOutbox
        });
        if (signature !== stableSignature) {
          stableSignature = signature;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= 500) {
          return { ...correlated, phases, databaseRows, gatewayTelemetryOutbox };
        }
      } catch (error) {
        lastError = error;
        stableSignature = "";
        stableSince = 0;
      }
      await delay(100);
    }
    throw new Error(`automation execution oracle did not converge: ${safeMessage(lastError)}`, { cause: lastError });
  }

  private queryAutomationExecutionRows() {
    return this.queryJson<AutomationExecutionDatabaseRow[]>(`
      SELECT coalesce(json_agg(json_build_object(
        'eventId', ae."eventId",
        'sequence', ae.sequence::text,
        'revision', ae.revision,
        'kind', ae.kind::text,
        'ruleId', ae."ruleId",
        'occurrenceKey', ae."occurrenceKey",
        'payload', ae.payload,
        'payloadHash', ae."payloadHash",
        'lightingScheduleId', ae."lightingScheduleId",
        'vehicleEventRuleId', ae."vehicleEventRuleId",
        'manualOverrideId', ae."manualOverrideId",
        'manualCommandId', mo."commandId"
      ) ORDER BY ae.sequence), '[]'::json)
      FROM "AutomationExecution" ae
      LEFT JOIN "ManualOverride" mo ON mo.id=ae."manualOverrideId"
      WHERE ae."gatewayId"=${sqlString(this.gateway.id)}
    `);
  }

  private async readAutomationTelemetryOutbox() {
    const path = this.automationTelemetryOutboxPath;
    const installation = this.requireInstallation();
    if (!path) throw new Error("Gateway automation telemetry outbox path is unavailable");
    const content = await readFile(path, "utf8");
    return inspectAutomationTelemetryOutbox(JSON.parse(content), {
      siteId: installation.siteId,
      gatewayId: this.gateway.id
    });
  }

  private assertCleanAutomationIngestion() {
    const evidenceErrors = this.mqttEvidence.filter(({ direction }) =>
      direction === "handler-error" || direction === "automation-observer-error");
    if (evidenceErrors.length > 0) throw new Error("automation MQTT evidence contains an ingest or observer error");
    const checks = [
      { file: "api.log", pattern: /UNEXPECTED_ERROR|P2028|mqtt inbound message handling failed|fixture state transaction failed before PUBACK|fixture state application ACK publish failed/ },
      { file: "gateway.log", pattern: /Gateway MQTT .* failed/ }
    ];
    for (const check of checks) {
      const path = join(this.labDir, check.file);
      if (!existsSync(path)) throw new Error(`automation log is missing: ${check.file}`);
      const content = readFileSync(path, "utf8");
      const matched = content.match(check.pattern);
      if (matched) throw new Error(`automation ingest log is not clean: ${check.file}: ${matched[0]}`);
    }
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
    const deniedReads = [
      `sites/${siteId}/gateways/${randomUUID()}/commands/#`,
      `sites/${siteId}/gateways/${gatewayId}/acks/#`
    ];
    const apiPublisher = await connectMqttForLab({
      host: "127.0.0.1",
      port: this.ports.mqtt,
      clientId: `task9-acl-probe-${this.runId}`,
      ca: await readFile(join(this.pkiDir, "ca.crt")),
      cert: await readFile(join(this.pkiDir, "api.crt")),
      key: await readFile(join(this.pkiDir, "api.key"))
    });
    apiPublisher.on("error", () => undefined);
    try {
      await expectReadsDenied(client, apiPublisher, deniedReads);
    } finally {
      await closeMqttWithin(apiPublisher, true, 1_000);
    }
    this.recordMqtt({
      direction: "acl-negative",
      deniedPublishCount: deniedTopics.length,
      deniedReadCount: deniedReads.length
    });
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
    if (this.automationDatabaseEvidence) {
      await writeFile(
        testInfo.outputPath("automation-database-evidence.json"),
        JSON.stringify(this.automationDatabaseEvidence, null, 2)
      );
    }
    if (this.automationPhaseEvidence.length > 0) {
      await writeFile(
        testInfo.outputPath("automation-phase-evidence.json"),
        JSON.stringify(this.automationPhaseEvidence, null, 2)
      );
    }
    if (this.automationConvergenceEvidence.length > 0) {
      await writeFile(
        testInfo.outputPath("automation-convergence-evidence.json"),
        JSON.stringify(this.automationConvergenceEvidence, null, 2)
      );
    }
    for (const name of ["api.log", "web.log", "gateway.log"]) {
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
    this.trackBackgroundTask(
      delay(800).then(() => this.publishInitialFixtureStatesWhenReady()),
      "initial fixture state publication"
    );
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

  private async detachGatewayPublisher() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    const errors: unknown[] = [];
    const handlerResults = await settleWithin(
      [this.mqttHandlerChain],
      this.cleanupTimeoutMs,
      "publisher MQTT handler drain"
    );
    errors.push(...rejectedReasons(handlerResults));
    const background = [...this.backgroundTasks];
    if (background.length > 0) {
      const backgroundResults = await settleWithin(
        background,
        this.cleanupTimeoutMs,
        "publisher background task drain"
      );
      errors.push(...rejectedReasons(backgroundResults));
    }
    if (this.backgroundError) errors.push(this.backgroundError);

    const client = this.mqtt;
    if (client) {
      try {
        await closeMqttStrictWithin(client, false, this.cleanupTimeoutMs, "publisher MQTT close");
        this.mqtt = undefined;
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "publisher handoff failed");
  }

  private trackBackgroundTask(operation: Promise<void>, label: string) {
    let task!: Promise<void>;
    task = operation
      .catch((error) => {
        this.backgroundError ??= new Error(`${label}: ${safeMessage(error)}`, { cause: error });
      })
      .finally(() => this.backgroundTasks.delete(task));
    this.backgroundTasks.add(task);
  }

  private async seedGatewayMqttCertificateLedger(certificatePath: string) {
    const certificate = new X509Certificate(await readFile(certificatePath));
    const inventoryId = await this.scalar(
      `SELECT id FROM "GatewayInventory" WHERE "claimedGatewayId"=${sqlString(this.gateway.id)}`
    );
    if (!inventoryId) throw new Error("claimed GatewayInventory is required for MQTT certificate ledger");
    await this.sql(`
      INSERT INTO "GatewayCertificate" (
        id, "inventoryId", "gatewayId", purpose, "certificateSerial", fingerprint,
        issuer, "notBefore", "notAfter", status, "createdAt", "updatedAt"
      ) VALUES (
        ${sqlString(randomUUID())}, ${sqlString(inventoryId)}, ${sqlString(this.gateway.id)}, 'mqtt',
        ${sqlString(certificate.serialNumber)},
        ${sqlString(certificate.fingerprint256.replaceAll(":", "").toUpperCase())},
        ${sqlString(certificate.issuer)},
        ${sqlString(new Date(certificate.validFrom).toISOString())},
        ${sqlString(new Date(certificate.validTo).toISOString())},
        'active', now(), now()
      )
    `);
  }

  private async seedGatewayIdentityStores(gatewayDir: string, certificateName: string) {
    const sourceCertificate = join(this.pkiDir, `${certificateName}.crt`);
    const sourceKey = join(this.pkiDir, `${certificateName}.key`);
    const sourceCa = join(this.pkiDir, "ca.crt");
    const deviceRoot = join(gatewayDir, "identity", "device");
    const mqttRoot = join(gatewayDir, "identity", "mqtt");
    const deviceGenerationId = randomUUID();
    const mqttGenerationId = randomUUID();
    const deviceGeneration = join(deviceRoot, "generations", deviceGenerationId);
    const mqttGeneration = join(mqttRoot, "generations", mqttGenerationId);
    for (const root of [deviceRoot, mqttRoot]) {
      await mkdir(join(root, "generations"), { recursive: true, mode: 0o750 });
      await mkdir(join(root, "pending-generations"), { recursive: true, mode: 0o750 });
      chmodSync(root, 0o750);
      chmodSync(join(root, "generations"), 0o750);
      chmodSync(join(root, "pending-generations"), 0o750);
    }
    await mkdir(deviceGeneration, { mode: 0o750 });
    await mkdir(mqttGeneration, { mode: 0o750 });
    await copyIdentityFile(sourceCertificate, join(deviceGeneration, "device.crt"), 0o644);
    await copyIdentityFile(sourceKey, join(deviceGeneration, "device.key"), 0o600);
    await this.run("openssl", [
      "req", "-new",
      "-key", join(deviceGeneration, "device.key"),
      "-out", join(deviceGeneration, "device.csr"),
      "-subj", `/CN=${this.gateway.id}`
    ]);
    chmodSync(join(deviceGeneration, "device.csr"), 0o644);
    for (const name of ["device-ca.crt", "api-ca.crt", "mqtt-ca.crt"]) {
      await copyIdentityFile(sourceCa, join(deviceGeneration, name), 0o644);
    }
    await symlink(`generations/${deviceGenerationId}`, join(deviceRoot, "current"));

    await copyIdentityFile(sourceCertificate, join(mqttGeneration, "gateway.crt"), 0o644);
    await copyIdentityFile(sourceKey, join(mqttGeneration, "gateway.key"), 0o600);
    await copyIdentityFile(sourceCa, join(mqttGeneration, "gateway-chain.crt"), 0o644);
    await copyIdentityFile(sourceCa, join(mqttGeneration, "mqtt-ca.crt"), 0o644);
    await symlink(`generations/${mqttGenerationId}`, join(mqttRoot, "current"));

    return {
      deviceRoot,
      deviceCertificatePath: join(deviceRoot, "current", "device.crt"),
      deviceKeyPath: join(deviceRoot, "current", "device.key"),
      mqttRoot,
      mqttCertificatePath: join(mqttRoot, "current", "gateway.crt"),
      mqttKeyPath: join(mqttRoot, "current", "gateway.key"),
      mqttCaPath: join(mqttRoot, "current", "mqtt-ca.crt")
    };
  }

  private async attachAutomationObserver() {
    const installation = this.requireInstallation();
    const observer = await connectMqttForLab({
      host: "127.0.0.1",
      port: this.ports.mqtt,
      clientId: `task19-observer-${this.runId}`,
      ca: await readFile(join(this.pkiDir, "ca.crt")),
      cert: await readFile(join(this.pkiDir, "api.crt")),
      key: await readFile(join(this.pkiDir, "api.key"))
    });
    observer.on("error", (error) => this.recordMqtt({
      direction: "automation-observer-error",
      error: safeMessage(error)
    }));
    observer.on("message", (topic, payload) => {
      const producer = topic.includes("/commands/") || topic.includes("/acks/")
        ? "api"
        : "production-gateway";
      this.recordMqtt({
        direction: "automation-observer",
        producer,
        producerPid: producer === "production-gateway" ? this.automationGateway?.pid ?? null : null,
        topic,
        payload: parseJson(payload)
      });
    });
    await subscribe(observer, [`sites/${installation.siteId}/gateways/${this.gateway.id}/#`]);
    this.automationObserver = observer;
  }

  private handleAutomationIpcMessage(message: unknown) {
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    const result = message as Record<string, unknown>;
    if (typeof result.type !== "string" || typeof result.requestId !== "string") return;
    const pending = this.automationIpcRequests.get(result.requestId);
    if (!pending || result.type !== pending.expectedType) return;
    clearTimeout(pending.timeout);
    this.automationIpcRequests.delete(result.requestId);
    if (result.ok === true) pending.resolve(result);
    else pending.reject(new Error(typeof result.error === "string" ? result.error : "automation private IPC failed"));
  }

  private sendAutomationIpcRequest(
    expectedType: "automation-e2e-sensor-edge-result" | "automation-e2e-clock-advance-result",
    payload: Record<string, unknown>
  ) {
    const gateway = this.automationGateway;
    if (!gateway?.connected) throw new Error("automation Gateway private IPC is not connected");
    const requestId = randomUUID();
    return new Promise<Record<string, unknown>>((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.automationIpcRequests.delete(requestId);
        reject(new Error("automation Gateway private IPC timed out"));
      }, 10_000);
      this.automationIpcRequests.set(requestId, {
        expectedType,
        resolve: resolvePromise,
        reject,
        timeout
      });
      gateway.send({ ...payload, token: this.automationIpcToken, requestId }, (error) => {
        if (!error) return;
        const pending = this.automationIpcRequests.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.automationIpcRequests.delete(requestId);
        pending.reject(error);
      });
    });
  }

  private rejectAutomationIpcRequests(message: string) {
    for (const [requestId, pending] of this.automationIpcRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
      this.automationIpcRequests.delete(requestId);
    }
  }

  private resolveAutomationFixtureId(nameOrId: string) {
    for (const fixture of [this.automationTarget, this.automationSensor]) {
      if (fixture && (fixture.name === nameOrId || fixture.fixtureId === nameOrId)) return fixture.fixtureId;
    }
    throw new Error(`automation fixture is not configured: ${nameOrId}`);
  }

  private async launchAutomationGateway() {
    if (this.automationGateway) throw new Error("automation Gateway is already running");
    if (!this.automationGatewayEnvironment) throw new Error("automation Gateway environment is not prepared");
    this.automationClockMs = undefined;
    const gateway = this.spawnLogged(
      "gateway",
      process.execPath,
      [join(ROOT, "apps/gateway/dist/gateway.mjs")],
      this.automationGatewayEnvironment,
      ROOT,
      true
    );
    this.automationGateway = gateway;
    gateway.on("message", (message) => this.handleAutomationIpcMessage(message));
    gateway.once("exit", () => {
      if (this.automationGateway !== gateway) return;
      this.automationGateway = undefined;
      this.rejectAutomationIpcRequests("automation Gateway child exited");
    });
    await this.waitForAutomationGatewayHeartbeat(gateway, 30_000);
    return gateway;
  }

  private async readAutomationSyncState() {
    return this.queryJson<{
      desiredRevision: number;
      appliedRevision: number;
      syncStatus: string;
      payloadHash: string;
      publishedAt: string | null;
    }>(`
      SELECT json_build_object(
        'desiredRevision', configuration."desiredRevision",
        'appliedRevision', configuration."appliedRevision",
        'syncStatus', configuration."syncStatus"::text,
        'payloadHash', configuration."payloadHash",
        'publishedAt', outbox."publishedAt"
      )
      FROM "GatewayAutomationConfiguration" configuration
      LEFT JOIN "MqttOutbox" outbox
        ON outbox."gatewayId"=configuration."gatewayId"
       AND outbox.revision=configuration."desiredRevision"
       AND outbox."payloadHash"=configuration."payloadHash"
       AND outbox."dispatchId" IS NULL
       AND outbox."applicationAckKey" IS NULL
      WHERE configuration."gatewayId"=${sqlString(this.gateway.id)}
    `);
  }

  private async readLocalAutomationSnapshot() {
    const path = this.automationSnapshotPath;
    if (!path) throw new Error("Gateway automation snapshot path is unavailable");
    return automationSnapshotV1Schema.parse(JSON.parse(await readFile(path, "utf8")));
  }

  private async readAutomationConfigAckRecords() {
    const path = this.automationConfigAckOutboxPath;
    if (!path) throw new Error("Gateway automation config ACK outbox path is unavailable");
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    const installation = this.requireInstallation();
    if (
      !isJsonRecord(value) || value.version !== 2 || !isJsonRecord(value.scope) ||
      value.scope.siteId !== installation.siteId || value.scope.gatewayId !== this.gateway.id ||
      !Array.isArray(value.records)
    ) throw new Error("Gateway automation config ACK outbox identity or shape mismatch");
    return value.records.map((record) => automationConfigAppliedDeliveryV1Schema.parse(record));
  }

  private readAutomationProtocolEvidence(evidenceCursor: number) {
    const installation = this.requireInstallation();
    const topics = {
      request: mqttTopics.automationCurrentConfigRequest(installation.siteId, this.gateway.id),
      snapshot: mqttTopics.automationConfig(installation.siteId, this.gateway.id),
      delivery: mqttTopics.automationConfigApplied(installation.siteId, this.gateway.id),
      receipt: mqttTopics.automationConfigAppliedReceipt(installation.siteId, this.gateway.id)
    };
    const evidence = this.mqttEvidence.slice(evidenceCursor);
    const requestEntry = evidence.find((entry) => entry.topic === topics.request && "payload" in entry);
    const snapshotEntry = evidence.find((entry) => entry.topic === topics.snapshot && "payload" in entry);
    const deliveries = evidence
      .filter((entry) => entry.topic === topics.delivery && "payload" in entry)
      .map((entry) => automationConfigAppliedDeliveryV1Schema.parse(entry.payload));
    const receipts = evidence
      .filter((entry) => entry.topic === topics.receipt && "payload" in entry)
      .map((entry) => automationConfigAppliedReceiptV1Schema.parse(entry.payload));
    if (!requestEntry || !snapshotEntry || deliveries.length === 0 || receipts.length === 0) {
      throw new Error("request, snapshot, config-applied delivery, or application receipt evidence is missing");
    }
    const request = automationCurrentConfigRequestV1Schema.parse(requestEntry.payload);
    const snapshot = automationSnapshotV1Schema.parse(snapshotEntry.payload);
    const receipt = receipts.find((candidate) => deliveries.some((delivery) => (
      delivery.acknowledgementId === candidate.acknowledgementId &&
      isDeepStrictEqual(delivery.acknowledgement, candidate.acknowledgement)
    )));
    if (!receipt) throw new Error("config-applied receipt does not match an exact durable ACK delivery");
    if (
      request.siteId !== installation.siteId || request.gatewayId !== this.gateway.id ||
      snapshot.siteId !== installation.siteId || snapshot.gatewayId !== this.gateway.id ||
      receipt.siteId !== installation.siteId || receipt.gatewayId !== this.gateway.id
    ) throw new Error("automation convergence protocol scope mismatch");
    return {
      requestId: request.requestId,
      responseRevision: snapshot.revision,
      acknowledgementId: receipt.acknowledgementId,
      receiptRevision: receipt.acknowledgement.revision
    };
  }

  private async waitForAutomationGatewayHeartbeat(child: ChildProcess, timeoutMs: number) {
    const installation = this.requireInstallation();
    const topic = mqttTopicsV2.heartbeat(installation.siteId, this.gateway.id);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      assertChildRunning(child, "automation Gateway");
      const ready = this.mqttEvidence.some((evidence) => {
        if (
          evidence.direction !== "automation-observer" ||
          evidence.producer !== "production-gateway" ||
          evidence.producerPid !== child.pid ||
          evidence.topic !== topic
        ) return false;
        const parsed = gatewayHeartbeatV2Schema.safeParse(evidence.payload);
        return parsed.success &&
          parsed.data.siteId === installation.siteId &&
          parsed.data.gatewayId === this.gateway.id &&
          parsed.data.gatewaySerial === this.gateway.serialNumber &&
          parsed.data.firmwareVersion === "task19-software-automation-simulator";
      });
      if (ready) return;
      await delay(100);
    }
    throw new Error("timed out waiting for production Gateway identity heartbeat");
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
    this.mqttProcess = mqtt;
    await Promise.all([
      waitForRedisIdentity(redis, this.ports.redis),
      waitForOwnedPort(mqtt, this.ports.mqtt)
    ]);
    const probe = await connectMqttForLab({
      host: "127.0.0.1",
      port: this.ports.mqtt,
      clientId: `task9-broker-probe-${this.runId}`,
      ca: await readFile(join(this.pkiDir, "ca.crt")),
      cert: await readFile(join(this.pkiDir, "api.crt")),
      key: await readFile(join(this.pkiDir, "api.key"))
    });
    probe.on("error", () => undefined);
    await closeMqtt(probe, true);
  }

  private async assertPortsAvailable() {
    for (const port of Object.values(this.ports)) {
      if (await canConnect(port)) throw new Error(`Task 9 격리 포트 ${port}가 이미 사용 중입니다.`);
    }
  }

  private async writeMosquittoConfig() {
    await writeFile(join(this.labDir, "mosquitto.acl"), await readFile(join(ROOT, "infra/mosquitto.acl.example")));
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

  private spawnLogged(
    name: string,
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd = ROOT,
    ipc = false
  ) {
    const log = openSync(join(this.labDir, `${name}.log`), "a");
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd,
        detached: true,
        env: { ...process.env, ...env },
        stdio: ipc ? ["ignore", log, log, "ipc"] : ["ignore", log, log]
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

  private async readStartupDiagnostics() {
    const sections: string[] = [];
    for (const name of ["postgres.log", "redis.log", "mqtt.log", "api.log", "web.log", "gateway.log"]) {
      const path = join(this.labDir, name);
      if (!existsSync(path)) continue;
      const contents = await readFile(path, "utf8").catch(() => "");
      if (contents) sections.push(`\n--- ${name} ---\n${contents.slice(-8_000)}`);
    }
    return sections.join("");
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

  private async waitForDatabaseCount(statement: string, expected: number, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (Number(await this.scalar(statement)) >= expected) return;
      await delay(100);
    }
    throw new Error("timed out waiting for isolated database ingestion");
  }

  private async waitForDatabaseValue(statement: string, expected: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.scalar(statement) === expected) return;
      await delay(100);
    }
    throw new Error(`timed out waiting for isolated database value: ${expected}`);
  }

  private async stopStages() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    const errors: unknown[] = [];
    this.rejectAutomationIpcRequests("real backend lab is stopping");

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
        if (this.automationObserver) {
          const observerClose = await settleWithin(
            [closeMqtt(this.automationObserver, false)],
            this.cleanupTimeoutMs,
            "automation observer close"
          );
          errors.push(...rejectedReasons(observerClose));
        }
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
      this.automationObserver = undefined;
      this.apiProcess = undefined;
      this.mqttProcess = undefined;
      this.automationGateway = undefined;
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

async function copyIdentityFile(source: string, destination: string, mode: number) {
  await copyFile(source, destination);
  chmodSync(destination, mode);
}

function automationExecutionKey(eventId: string, sequence: number) {
  return `${eventId}:${sequence}`;
}

function expectedAutomationActionPhases(actions: Array<Record<string, unknown>>) {
  const expected = [
    { phase: "schedule-active", sourceType: "schedule", brightness: 40 },
    { phase: "vehicle-detected", sourceType: "vehicle_event_rule", brightness: 80 },
    { phase: "manual-active", sourceType: "manual_override", brightness: 60 },
    { phase: "manual-expired", sourceType: "vehicle_event_rule", brightness: 80 },
    { phase: "vehicle-hold-expired", sourceType: "schedule", brightness: 40 }
  ];
  if (actions.length !== expected.length) {
    throw new Error(`expected ${expected.length} target action phases, received ${actions.length}`);
  }
  return expected.map((phase, index) => {
    const action = actions[index];
    if (action.sourceType !== phase.sourceType || action.brightness !== phase.brightness) {
      throw new Error(
        `automation action phase mismatch at ${phase.phase}: ${String(action.sourceType)}/${String(action.brightness)}`
      );
    }
    return {
      phase: phase.phase,
      producer: "production-gateway",
      eventId: action.eventId,
      sequence: action.sequence,
      kind: action.kind,
      brightness: action.brightness,
      sourceType: action.sourceType,
      sourceId: action.sourceId,
      revision: action.revision,
      occurrenceKey: action.occurrenceKey
    };
  });
}

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

function isAllowedOperatorApiPath(path: string) {
  const pathname = path.split("?", 1)[0];
  return pathname.startsWith("/api/auth/") || pathname.startsWith("/api/operator/");
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

type MqttClientFactory = (brokerUrl: string, options: Parameters<typeof connect>[1]) => MqttClient;

export function connectMqttForLab(
  options: Parameters<typeof connect>[1],
  createClient: MqttClientFactory = connect,
  cleanupTimeoutMs = 1_000
) {
  const reconnectPeriod = options?.reconnectPeriod ?? 1_000;
  return new Promise<MqttClient>((resolvePromise, reject) => {
    const client = createClient(`mqtts://${options?.host}:${options?.port}`, {
      ...options,
      protocolVersion: 5,
      rejectUnauthorized: true,
      reconnectPeriod: 0
    });
    const onConnect = () => {
      client.removeListener("error", onError);
      client.options.reconnectPeriod = reconnectPeriod;
      resolvePromise(client);
    };
    const onError = (error: Error) => {
      client.removeListener("connect", onConnect);
      client.removeListener("error", onError);
      client.options.reconnectPeriod = 0;
      const suppressCleanupError = () => undefined;
      client.on("error", suppressCleanupError);
      void closeMqttWithin(client, true, cleanupTimeoutMs).finally(() => {
        client.removeListener("error", suppressCleanupError);
        reject(error);
      });
    };
    client.once("connect", onConnect);
    client.once("error", onError);
  });
}

function subscribe(client: MqttClient, topics: string[]) {
  return new Promise<void>((resolvePromise, reject) => client.subscribe(topics, { qos: 1 }, (error, granted) => {
    if (error) return reject(error);
    if (granted.some((grant) => grant.qos === 128)) return reject(new Error("MQTT subscription was not authorized"));
    resolvePromise();
  }));
}

async function expectReadsDenied(client: MqttClient, publisher: MqttClient, topics: string[]) {
  const subscribed: string[] = [];
  const marker = randomUUID();
  let delivered = false;
  const onMessage = (_topic: string, payload: Buffer) => {
    if (payload.toString() === marker) delivered = true;
  };
  client.on("message", onMessage);
  try {
    for (const topic of topics) {
      if (await subscribeForNegativeRead(client, topic)) subscribed.push(topic);
    }
    for (const topic of topics) await publish(publisher, topic.replace(/#$/, "review-probe"), marker, { qos: 1 });
    await delay(250);
    if (delivered) throw new Error("lab gateway ACL allowed an unauthorized read");
  } finally {
    client.removeListener("message", onMessage);
    if (subscribed.length > 0) await unsubscribe(client, subscribed);
  }
}

function subscribeForNegativeRead(client: MqttClient, topic: string) {
  return new Promise<boolean>((resolvePromise, reject) => client.subscribe(topic, { qos: 1 }, (error, granted) => {
    if (error && safeMessage(error).toLowerCase().includes("not authorized")) return resolvePromise(false);
    if (error) return reject(error);
    resolvePromise(granted.some((grant) => grant.qos !== 128));
  }));
}

function unsubscribe(client: MqttClient, topics: string[]) {
  return new Promise<void>((resolvePromise, reject) => client.unsubscribe(topics, (error) => (
    error ? reject(error) : resolvePromise()
  )));
}

function publish(client: MqttClient, topic: string, payload: string, options: IClientPublishOptions) {
  return new Promise<void>((resolvePromise, reject) => client.publish(topic, payload, options, (error) => error ? reject(error) : resolvePromise()));
}

function closeMqtt(client: MqttClient, force: boolean) {
  if (!client) return Promise.resolve();
  return new Promise<void>((resolvePromise) => client.end(force, {}, () => resolvePromise()));
}

function closeMqttWithin(client: MqttClient, force: boolean, timeoutMs: number) {
  return new Promise<void>((resolvePromise) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise();
    };
    const timeout = setTimeout(finish, timeoutMs);
    try {
      client.end(force, {}, finish);
    } catch {
      finish();
    }
  });
}

function closeMqttStrictWithin(
  client: MqttClient,
  force: boolean,
  timeoutMs: number,
  label: string
) {
  return new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolvePromise();
    };
    const timeout = setTimeout(() => finish(new Error(`${label} timed out`)), timeoutMs);
    try {
      client.end(force, {}, () => finish());
    } catch (error) {
      finish(error);
    }
  });
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
