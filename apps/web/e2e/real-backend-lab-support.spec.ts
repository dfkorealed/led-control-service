import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import type { MqttClient } from "mqtt";
import * as labSupport from "./support/real-backend-lab";

const { connectMqttForLab, RealBackendLab, selectDfkScanCandidates } = labSupport;
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../..");

test.describe.configure({ mode: "serial" });

test("scan simulator는 shared DFK identity parser로 타사 UUID를 제외한다", () => {
  const candidates = [
    { serialNumber: "DFK-01", deviceUuid: "44464b4c454401010101aabbccddeeff" },
    { serialNumber: "OTHER-01", deviceUuid: "00112233445566778899aabbccddeeff" },
    { serialNumber: "DFK-02", deviceUuid: "44464b4c454401010101112233445566" }
  ];

  expect(selectDfkScanCandidates(candidates)).toEqual([candidates[0], candidates[2]]);
});

test("최초 MQTT 연결 오류는 ownership 전달 전에 reconnect와 client를 정리한다", async () => {
  const client = new EventEmitter() as EventEmitter & {
    options: Record<string, unknown>;
    end: (force: boolean, options: object, callback: () => void) => void;
  };
  client.options = {};
  const forceEndCalls: boolean[] = [];
  client.end = (force) => {
    forceEndCalls.push(force);
    // callback hang도 bounded cleanup으로 빠져나와야 한다.
  };
  let connectionOptions: Record<string, unknown> = {};
  const connection = connectMqttForLab(
    { host: "127.0.0.1", port: 1 },
    (_url, options) => {
      connectionOptions = options;
      queueMicrotask(() => client.emit("error", new Error("injected TLS failure")));
      return client as unknown as MqttClient;
    },
    20
  );

  const startedAt = Date.now();
  await expect(connection).rejects.toThrow("injected TLS failure");
  expect(Date.now() - startedAt).toBeLessThan(200);
  expect(connectionOptions.reconnectPeriod).toBe(0);
  expect(forceEndCalls).toEqual([true]);
  expect(client.listenerCount("connect")).toBe(0);
  expect(client.listenerCount("error")).toBe(0);
});

test("lab Mosquitto ACL은 infrastructure 정본과 정확히 일치한다", async () => {
  const lab = new RealBackendLab();
  const internal = lab as unknown as { labDir: string; writeMosquittoConfig: () => Promise<void> };
  await mkdir(internal.labDir, { recursive: true });

  try {
    await internal.writeMosquittoConfig();
    const [actual, canonical] = await Promise.all([
      readFile(join(internal.labDir, "mosquitto.acl"), "utf8"),
      readFile(join(ROOT, "infra/mosquitto.acl.example"), "utf8")
    ]);
    expect(actual).toBe(canonical);
  } finally {
    await lab.stop();
  }
});

test("선점된 lab 포트는 build나 외부 fixture mutation 전에 실패하고 정리한다", async () => {
  const server = createServer((socket) => socket.on("data", () => {
    throw new Error("lab wrote to the external fixture");
  }));
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("external fixture did not bind a TCP port");
  const lab = new RealBackendLab({ ports: { ...await allocateUnusedLabPorts(), web: address.port } });
  const internal = lab as unknown as { labDir: string; run: () => Promise<void> };
  let mutationCapableSteps = 0;
  internal.run = async () => { mutationCapableSteps += 1; };

  try {
    await expect(lab.start()).rejects.toThrow(`격리 포트 ${address.port}`);
    expect(mutationCapableSteps).toBe(0);
    expect(existsSync(internal.labDir)).toBe(false);
  } finally {
    await lab.stop().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("operator의 응답 없는 customer request도 request 시점에 기록한다", () => {
  const page = new EventEmitter();
  const lab = new RealBackendLab();
  const request = {
    method: () => "GET",
    url: () => "http://127.0.0.1:15173/api/sites/site-1/dashboard",
    failure: () => ({ errorText: "net::ERR_ABORTED" })
  };

  lab.captureNetwork(page as never, "operator");
  page.emit("request", request);
  page.emit("requestfailed", request);

  expect(() => lab.assertOperatorNetworkIsolation()).toThrow("operator requested");
  const records = (lab as unknown as { network: Array<Record<string, unknown>> }).network;
  expect(records).toEqual([expect.objectContaining({
    actor: "operator",
    method: "GET",
    path: "/api/sites/site-1/dashboard",
    status: null,
    outcome: "failed"
  })]);
  expect(Object.keys(records[0]).sort()).toEqual(["actor", "id", "method", "outcome", "path", "status"]);
});

test("operator network isolation은 auth와 operator API만 허용한다", () => {
  const page = new EventEmitter();
  const lab = new RealBackendLab();
  lab.captureNetwork(page as never, "operator");

  for (const path of ["/api/auth/me", "/api/operator/site-admins"]) {
    page.emit("request", {
      method: () => "GET",
      url: () => `http://127.0.0.1:15173${path}`
    });
  }
  expect(() => lab.assertOperatorNetworkIsolation()).not.toThrow();

  page.emit("request", {
    method: () => "GET",
    url: () => "http://127.0.0.1:15173/api/energy/sites/site-1/summary"
  });
  expect(() => lab.assertOperatorNetworkIsolation()).toThrow("operator requested a non-allowlisted API");
});

test("start 중간 실패는 TERM을 무시하는 descendant까지 종료하고 labDir을 지운다", async () => {
  const lab = new RealBackendLab({ ports: await allocateUnusedLabPorts() });
  const internal = lab as unknown as {
    cleanupTimeoutMs: number;
    labDir: string;
    processes: ChildProcess[];
    run: () => Promise<void>;
    writeMosquittoConfig: () => Promise<void>;
    startInfrastructure: () => Promise<void>;
  };
  internal.cleanupTimeoutMs = 100;
  internal.run = async () => undefined;
  internal.writeMosquittoConfig = async () => undefined;
  const descendantPidFile = join(internal.labDir, "descendant.pid");
  let parent: ChildProcess | undefined;
  let descendantPid = 0;
  internal.startInfrastructure = async () => {
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"], { stdio: 'ignore' });",
      `writeFileSync(${JSON.stringify(descendantPidFile)}, String(child.pid));`,
      "setInterval(() => {}, 1000);"
    ].join("");
    parent = spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" });
    internal.processes.push(parent);
    descendantPid = Number(await waitForFile(descendantPidFile));
    throw new Error("injected startup failure");
  };

  try {
    await expect(lab.start()).rejects.toThrow("injected startup failure");
    expect(isAlive(parent.pid)).toBe(false);
    expect(isAlive(descendantPid)).toBe(false);
    expect(existsSync(internal.labDir)).toBe(false);
  } finally {
    if (parent?.pid) killProcessGroup(parent.pid);
    if (descendantPid) killPid(descendantPid);
    await rm(internal.labDir, { recursive: true, force: true });
  }
});

test("MQTT close가 hang되어도 stop은 timeout 뒤 나머지 cleanup을 완료한다", async () => {
  const lab = new RealBackendLab();
  const internal = lab as unknown as {
    cleanupTimeoutMs: number;
    labDir: string;
    mqtt: { end: (force: boolean, options: object, callback: () => void) => void };
  };
  internal.cleanupTimeoutMs = 50;
  await mkdir(internal.labDir, { recursive: true });
  let releaseGracefulClose: (() => void) | undefined;
  internal.mqtt = {
    end: (force, _options, callback) => {
      if (force) callback();
      else releaseGracefulClose = callback;
    }
  };

  const stopping = lab.stop();
  try {
    const result = await Promise.race([
      stopping.then(() => "stopped"),
      delay(250).then(() => "timed-out")
    ]);
    expect(result).toBe("stopped");
    expect(existsSync(internal.labDir)).toBe(false);
  } finally {
    releaseGracefulClose?.();
    await stopping.catch(() => undefined);
    await rm(internal.labDir, { recursive: true, force: true });
  }
});

test("production Gateway handoff는 publisher background 작업과 MQTT close 완료를 순서대로 기다린다", async () => {
  const lab = new RealBackendLab({ cleanupTimeoutMs: 100 });
  const internal = lab as unknown as {
    backgroundTasks: Set<Promise<void>>;
    detachGatewayPublisher: () => Promise<void>;
    eventSequence: number;
    mqtt: { end: (force: boolean, options: object, callback: () => void) => void };
  };
  let releaseBackground!: () => void;
  const background = new Promise<void>((resolve) => {
    releaseBackground = () => {
      internal.eventSequence = 777;
      resolve();
    };
  });
  internal.backgroundTasks.add(background);
  let closeCallback: (() => void) | undefined;
  internal.mqtt = {
    end: (_force, _options, callback) => { closeCallback = callback; }
  };

  let settled = false;
  const handoff = internal.detachGatewayPublisher().finally(() => { settled = true; });
  await delay(10);
  expect(closeCallback).toBeUndefined();
  releaseBackground();
  await waitFor(() => closeCallback !== undefined);
  expect(internal.eventSequence).toBe(777);
  expect(settled).toBe(false);
  closeCallback?.();
  await handoff;
  expect(settled).toBe(true);
});

test("production Gateway handoff는 publisher background 오류와 MQTT close timeout을 허용하지 않는다", async () => {
  const backgroundFailureLab = new RealBackendLab({ cleanupTimeoutMs: 20 });
  const failed = backgroundFailureLab as unknown as {
    backgroundError: unknown;
    detachGatewayPublisher: () => Promise<void>;
    mqtt: { end: (force: boolean, options: object, callback: () => void) => void };
  };
  failed.backgroundError = new Error("injected publisher failure");
  failed.mqtt = { end: (_force, _options, callback) => callback() };
  await expect(failed.detachGatewayPublisher()).rejects.toThrow("injected publisher failure");

  const closeTimeoutLab = new RealBackendLab({ cleanupTimeoutMs: 20 });
  const timedOut = closeTimeoutLab as unknown as {
    detachGatewayPublisher: () => Promise<void>;
    mqtt: { end: (force: boolean, options: object, callback: () => void) => void };
  };
  timedOut.mqtt = { end: () => undefined };
  await expect(timedOut.detachGatewayPublisher()).rejects.toThrow("publisher MQTT close timed out");
});

test("automation readiness heartbeat는 production Gateway child와 exact identity payload에 결속한다", async () => {
  const lab = new RealBackendLab();
  const siteId = "00000000-0000-4000-8000-000000000019";
  const gatewayId = "00000000-0000-4000-8000-000000000020";
  const internal = lab as unknown as {
    installation: { siteId: string; floorId: string; timeZone: string };
    gateway: { id: string; serialNumber: string };
    mqttEvidence: Array<Record<string, unknown>>;
    waitForAutomationGatewayHeartbeat: (child: ChildProcess, timeoutMs: number) => Promise<void>;
  };
  internal.installation = { siteId, floorId: "floor-ready", timeZone: "Asia/Seoul" };
  Object.assign(internal.gateway, { id: gatewayId, serialNumber: "DFK-READY" });
  const child = {
    pid: process.pid,
    exitCode: null,
    signalCode: null
  } as ChildProcess;
  const heartbeat = {
    siteId,
    gatewayId,
    eventId: "00000000-0000-4000-8000-000000000019",
    sequence: 19,
    occurredAt: new Date().toISOString(),
    gatewaySerial: "DFK-READY",
    firmwareVersion: "task19-software-automation-simulator",
    configVersion: 1
  };
  const topic = `sites/${siteId}/gateways/${gatewayId}/state/heartbeat`;
  internal.mqttEvidence.push({
    direction: "automation-observer",
    producer: "lab-publisher",
    producerPid: process.pid,
    topic,
    payload: heartbeat
  });
  internal.mqttEvidence.push({
    direction: "automation-observer",
    producer: "production-gateway",
    producerPid: process.pid + 1,
    topic,
    payload: heartbeat
  });

  let ready = false;
  const waiting = internal.waitForAutomationGatewayHeartbeat(child, 500).then(() => { ready = true; });
  await delay(20);
  expect(ready).toBe(false);
  internal.mqttEvidence.push({
    direction: "automation-observer",
    producer: "production-gateway",
    producerPid: process.pid,
    topic,
    payload: heartbeat
  });
  await waiting;
  expect(ready).toBe(true);
});

test("automation oracle은 lab 자기 발행을 제외하고 production event의 exact ACK와 DB row를 요구한다", () => {
  const correlate = (labSupport as unknown as {
    correlateAutomationExecutionEvidence: (input: Record<string, unknown>) => Record<string, unknown>;
  }).correlateAutomationExecutionEvidence;
  const gatewayId = "00000000-0000-4000-8000-000000000020";
  const eventId = "00000000-0000-4000-8000-000000000021";
  const ruleId = "00000000-0000-4000-8000-000000000022";
  const fixtureId = "00000000-0000-4000-8000-000000000023";
  const payloadHash = `sha256:${"a".repeat(64)}`;
  const event = {
    schemaVersion: 1,
    eventId,
    sequence: 21,
    gatewayId,
    revision: 2,
    ruleId,
    occurrenceKey: "schedule-occurrence-21",
    kind: "action_result",
    occurredAt: "2026-08-31T04:00:00.000Z",
    payload: {
      sourceType: "schedule",
      sourceId: ruleId,
      results: [{
        fixtureId,
        status: "succeeded",
        brightnessPercent: 40,
        faultCode: null,
        errorCode: null,
        occurredAt: "2026-08-31T04:00:00.000Z"
      }]
    }
  };
  const eventTopic = `sites/site-1/gateways/${gatewayId}/events/automation/execution`;
  const ackTopic = `sites/site-1/gateways/${gatewayId}/acks/automation/execution-ingested`;
  const productionEvidence = {
    direction: "automation-observer",
    producer: "production-gateway",
    producerPid: 321,
    topic: eventTopic,
    payload: event
  };
  const labSelfEvidence = {
    direction: "gateway-event",
    producer: "lab-publisher",
    topic: eventTopic,
    payload: { ...event, eventId: "00000000-0000-4000-8000-000000000024", sequence: 22 }
  };
  const databaseRows = [{
    eventId,
    sequence: "21",
    revision: 2,
    kind: "action_result",
    ruleId,
    occurrenceKey: "schedule-occurrence-21",
    payload: event.payload,
    payloadHash,
    lightingScheduleId: ruleId,
    vehicleEventRuleId: null,
    manualOverrideId: null,
    manualCommandId: null
  }];
  const input = {
    siteId: "site-1",
    gatewayId,
    producerPid: 321,
    targetFixtureId: fixtureId,
    mqttEvidence: [labSelfEvidence, productionEvidence],
    databaseRows
  };

  expect(() => correlate(input)).toThrow("pending execution ACK");

  const result = correlate({
    ...input,
    mqttEvidence: [...input.mqttEvidence, {
      direction: "automation-observer",
      producer: "api",
      producerPid: null,
      topic: ackTopic,
      payload: {
        schemaVersion: 1,
        gatewayId,
        eventId,
        sequence: 21,
        reportPayloadHash: payloadHash,
        ingestedAt: "2026-08-31T04:00:01.000Z"
      }
    }]
  });
  expect(result).toMatchObject({
    uniqueProductionEventCount: 1,
    uniqueAckCount: 1,
    databaseRowCount: 1,
    actions: [{ sourceType: "schedule", brightness: 40, revision: 2 }]
  });
});

async function waitForFile(path: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return (await readFile(path, "utf8")).trim();
    } catch {
      await delay(20);
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

function isAlive(pid: number | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessGroup(pid: number) {
  try { process.kill(-pid, "SIGKILL"); } catch { /* already stopped */ }
}

function killPid(pid: number) {
  try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error("timed out waiting for test condition");
}

async function allocateUnusedLabPorts() {
  const keys = ["postgres", "redis", "mqtt", "api", "web"] as const;
  const servers = keys.map(() => createServer());
  try {
    await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => (
      server.listen(0, "127.0.0.1", resolve).once("error", reject)
    ))));
    return Object.fromEntries(servers.map((server, index) => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("dynamic lab port allocation failed");
      return [keys[index], address.port];
    })) as Record<(typeof keys)[number], number>;
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
}
