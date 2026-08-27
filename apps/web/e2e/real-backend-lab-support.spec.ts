import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { RealBackendLab, selectDfkScanCandidates } from "./support/real-backend-lab";

test.describe.configure({ mode: "serial" });

test("scan simulator는 shared DFK identity parser로 타사 UUID를 제외한다", () => {
  const candidates = [
    { serialNumber: "DFK-01", deviceUuid: "44464b4c454401010101aabbccddeeff" },
    { serialNumber: "OTHER-01", deviceUuid: "00112233445566778899aabbccddeeff" },
    { serialNumber: "DFK-02", deviceUuid: "44464b4c454401010101112233445566" }
  ];

  expect(selectDfkScanCandidates(candidates)).toEqual([candidates[0], candidates[2]]);
});

test("선점된 lab 포트는 build나 외부 fixture mutation 전에 실패하고 정리한다", async () => {
  const server = createServer((socket) => socket.on("data", () => {
    throw new Error("lab wrote to the external fixture");
  }));
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("external fixture did not bind a TCP port");
  const lab = new RealBackendLab({ ports: { web: address.port } });
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

test("start 중간 실패는 TERM을 무시하는 descendant까지 종료하고 labDir을 지운다", async () => {
  const lab = new RealBackendLab();
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
