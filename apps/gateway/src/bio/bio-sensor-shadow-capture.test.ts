import { createHmac } from "node:crypto";
import { lstat, mkdtemp, open, readFile, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BioClientEvent } from "./bio-dongle-client";
import { BioSensorShadowCapture, BIO_SENSOR_SHADOW_PHASES, type BioSensorShadowPhase, type BioSensorShadowScheduler } from "./bio-sensor-shadow-capture";

const captureName = "bio-sensor-shadow-20260915T120000Z.jsonl";
const source = { nativeUuid: "001122334455", logicalAddress: 0x1234, firmware: "1.2.3", protocol: "bio-v1", siteId: "site-123", gatewayId: "gateway-123" };
const fixedDate = new Date("2026-09-15T12:00:00.000Z");
const temporaryRoots: string[] = [];

async function evidenceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bio-shadow-"));
  await chmod(root, 0o700);
  temporaryRoots.push(root);
  return root;
}

async function lines(root: string, name = captureName): Promise<Record<string, unknown>[]> {
  return (await readFile(join(root, name), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function notification(kind: "alive-status" | "sensor-status-candidate", sequence: number, overrides: Partial<Extract<BioClientEvent, { kind: "alive-status" }>> = {}): BioClientEvent {
  return {
    kind,
    deviceUuid: `bio:${source.nativeUuid}`,
    logicalAddress: source.logicalAddress,
    networkId: 7,
    destination: 0x01fe,
    rssiDbm: -42,
    sequence,
    ttl: 3,
    control: true,
    innerOpcode: kind === "alive-status" ? 0x0c : 0x09,
    innerBody: Buffer.from([kind === "alive-status" ? 0x0c : 0x09, sequence]),
    ...overrides
  } as BioClientEvent;
}

class FakeScheduler implements BioSensorShadowScheduler {
  private pending: (() => void) | undefined;
  delays: number[] = [];
  setTimeout(callback: () => void, delayMs: number): unknown {
    this.pending = callback;
    this.delays.push(delayMs);
    return callback;
  }
  clearTimeout(handle: unknown): void {
    if (this.pending === handle) this.pending = undefined;
  }
  tick(): void {
    const callback = this.pending;
    if (!callback) throw new Error("No scheduled phase");
    this.pending = undefined;
    callback();
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("BIO sensor shadow capture", () => {
  it("requires a real private evidence directory owned by the effective user", async () => {
    const root = await evidenceRoot();
    await chmod(root, 0o755);
    await expect(BioSensorShadowCapture.create({ evidenceRoot: root, captureName, source })).rejects.toThrow();
    await chmod(root, 0o1700);
    await expect(BioSensorShadowCapture.create({ evidenceRoot: root, captureName, source })).rejects.toThrow();
    await chmod(root, 0o700);
    const link = join(root, "link");
    await symlink(root, link);
    await expect(BioSensorShadowCapture.create({ evidenceRoot: link, captureName, source })).rejects.toThrow();
    const file = join(root, "file");
    await writeFile(file, "x");
    await expect(BioSensorShadowCapture.create({ evidenceRoot: file, captureName, source })).rejects.toThrow();
    const rootStat = await lstat(root);
    expect(rootStat.uid).toBe(process.geteuid?.());
    expect(rootStat.mode & 0o777).toBe(0o700);
  });

  it("creates a private exclusive file and refuses existing and symlink names", async () => {
    const root = await evidenceRoot();
    await expect(BioSensorShadowCapture.create({ evidenceRoot: root, captureName: "../escape.jsonl", source })).rejects.toThrow();
    await expect(BioSensorShadowCapture.create({ evidenceRoot: root, captureName: "bio-sensor-shadow-20260915T120000Z.JSONL", source })).rejects.toThrow();
    const capture = await BioSensorShadowCapture.create({ evidenceRoot: root, captureName, source });
    expect((await lstat(join(root, captureName))).mode & 0o777).toBe(0o600);
    await capture.close();
    const original = await readFile(join(root, captureName), "utf8");
    await expect(BioSensorShadowCapture.create({ evidenceRoot: root, captureName, source })).rejects.toThrow();
    expect(await readFile(join(root, captureName), "utf8")).toBe(original);
    const linkName = "bio-sensor-shadow-20260915T120001Z.jsonl";
    await symlink(join(root, captureName), join(root, linkName));
    await expect(BioSensorShadowCapture.create({ evidenceRoot: root, captureName: linkName, source })).rejects.toThrow();
    expect(await readFile(join(root, captureName), "utf8")).toBe(original);
  });

  it("redacts identity with a per-capture HMAC and records only exact sensor observations", async () => {
    const root = await evidenceRoot();
    const keyA = Buffer.alloc(32, 0x11);
    const keyB = Buffer.alloc(32, 0x22);
    const capture = await BioSensorShadowCapture.create({ evidenceRoot: root, captureName, source, now: () => fixedDate, randomBytes: () => keyA });
    capture.record(notification("alive-status", 1));
    capture.record(notification("sensor-status-candidate", 2));
    capture.record(notification("alive-status", 3, { deviceUuid: "bio:aabbccddeeff" }));
    capture.record(notification("alive-status", 4, { logicalAddress: 0x1235 }));
    capture.record({ kind: "invalid-notification" });
    await capture.close();
    const raw = await readFile(join(root, captureName), "utf8");
    expect(raw).not.toContain(source.nativeUuid);
    expect(raw).not.toContain(`bio:${source.nativeUuid}`);
    expect(raw).not.toContain("site-123");
    expect(raw).not.toContain("gateway-123");
    expect(raw).not.toMatch(/55aa[0-9a-f]{10,}/i);
    expect(raw).not.toContain(keyA.toString("hex"));
    const entries = await lines(root);
    const fingerprint = createHmac("sha256", keyA).update(source.nativeUuid).digest("hex");
    expect(entries[0]).toMatchObject({ type: "capture-start", schemaVersion: 1, apkSha256: "1fb69b7f6241ab757908fb4a6e8d8359d1127be75c84f5cbbf26740e415ef83e" });
    expect((entries[0]!.source as Record<string, unknown>).fingerprint).toBe(fingerprint);
    const observations = entries.filter((entry) => entry.type === "observation");
    expect(observations).toHaveLength(2);
    expect(observations.map((entry) => entry.classification)).toEqual(["liveness", "candidate"]);
    expect(observations.map((entry) => entry.sourceFingerprint)).toEqual([fingerprint, fingerprint]);
    expect(observations.every((entry) => !("active" in entry))).toBe(true);
    const secondName = "bio-sensor-shadow-20260915T120001Z.jsonl";
    const second = await BioSensorShadowCapture.create({ evidenceRoot: root, captureName: secondName, source, randomBytes: () => keyB });
    await second.close();
    expect((await lines(root, secondName))[0]!.source).toMatchObject({ fingerprint: createHmac("sha256", keyB).update(source.nativeUuid).digest("hex") });
    expect((await lines(root, secondName))[0]!.source).not.toEqual(entries[0]!.source);
  });

  it("records the decoder's exact bio-prefixed device UUID for the raw mapped source", async () => {
    const root = await evidenceRoot();
    const capture = await BioSensorShadowCapture.create({ evidenceRoot: root, captureName, source });
    capture.record(notification("alive-status", 1, { deviceUuid: `bio:${source.nativeUuid}` }));
    capture.record(notification("sensor-status-candidate", 2, { deviceUuid: `bio:${source.nativeUuid}` }));
    capture.record(notification("alive-status", 3, { deviceUuid: source.nativeUuid }));
    capture.record(notification("alive-status", 4, { deviceUuid: `other:${source.nativeUuid}` }));
    capture.record(notification("alive-status", 5, { deviceUuid: `bio:${source.nativeUuid}`, logicalAddress: source.logicalAddress + 1 }));
    await capture.close();
    expect((await lines(root)).filter((entry) => entry.type === "observation").map((entry) => [entry.sequence, entry.classification])).toEqual([
      [1, "liveness"], [2, "candidate"]
    ]);
  });

  it("uses the source values validated before the first asynchronous boundary", async () => {
    const root = await evidenceRoot();
    const mutableSource = { ...source };
    const key = Buffer.alloc(32, 0x33);
    const creating = BioSensorShadowCapture.create({ evidenceRoot: root, captureName, source: mutableSource, randomBytes: () => key });
    queueMicrotask(() => {
      mutableSource.nativeUuid = "aabbccddeeff";
      mutableSource.logicalAddress = 0x4321;
      mutableSource.firmware = "gateway-secret";
      mutableSource.protocol = "site-secret";
    });
    const capture = await creating;
    await capture.close();
    expect(mutableSource.nativeUuid).toBe("aabbccddeeff");
    const raw = await readFile(join(root, captureName), "utf8");
    expect(raw).not.toContain("gateway-secret");
    expect(raw).not.toContain("site-secret");
    expect((await lines(root))[0]!.source).toEqual({
      fingerprint: createHmac("sha256", key).update(source.nativeUuid).digest("hex"),
      logicalAddress: source.logicalAddress,
      firmware: source.firmware,
      protocol: source.protocol
    });
  });

  it("uses the exact deterministic phase sequence and ignores records after completion", async () => {
    const root = await evidenceRoot();
    const scheduler = new FakeScheduler();
    const phases: BioSensorShadowPhase[] = [];
    const completed = vi.fn();
    const capture = await BioSensorShadowCapture.create({ evidenceRoot: root, captureName, source, scheduler, now: () => fixedDate, onPhase: (phase) => phases.push(phase), onComplete: completed });
    for (let index = 0; index < 21; index++) {
      scheduler.tick();
      if (index < 20) await vi.waitFor(() => expect(phases).toHaveLength(index + 2));
      else await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1));
    }
    capture.record(notification("alive-status", 99));
    await capture.close();
    await capture.close();
    const entries = await lines(root);
    expect(entries.map((entry) => entry.type === "phase" ? `${entry.type} ${entry.kind}/${entry.cycle}` : entry.type)).toEqual([
      "capture-start", "phase baseline/0",
      ...Array.from({ length: 10 }, (_, i) => [`phase stimulus/${i + 1}`, `phase recovery/${i + 1}`]).flat(),
      "capture-complete"
    ]);
    expect(phases).toEqual(BIO_SENSOR_SHADOW_PHASES.map(({ kind, cycle }) => ({ kind, cycle })));
    expect(scheduler.delays).toEqual(BIO_SENSOR_SHADOW_PHASES.map(({ durationMs }) => durationMs));
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it("preserves synchronous notification order and copies mutable bodies immediately", async () => {
    const root = await evidenceRoot();
    const capture = await BioSensorShadowCapture.create({ evidenceRoot: root, captureName, source });
    const mutable = notification("alive-status", 1);
    capture.record(mutable);
    if (mutable.kind === "alive-status") mutable.innerBody.fill(0xff);
    capture.record(notification("alive-status", 2));
    capture.record(notification("sensor-status-candidate", 3));
    await capture.close();
    const observations = (await lines(root)).filter((entry) => entry.type === "observation");
    expect(observations.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(observations[0]!.innerBodyHex).toBe("0c01");
  });

  it("stops observations and phase callbacks after an early close", async () => {
    const root = await evidenceRoot();
    const scheduler = new FakeScheduler();
    const onPhase = vi.fn();
    const capture = await BioSensorShadowCapture.create({ evidenceRoot: root, captureName, source, scheduler, onPhase });
    await capture.close();
    capture.record(notification("alive-status", 9));
    expect(() => scheduler.tick()).toThrow("No scheduled phase");
    expect((await lines(root)).map((entry) => entry.type)).toEqual(["capture-start", "phase"]);
    expect(onPhase).toHaveBeenCalledTimes(1);
  });

  it("retains the first append failure, discards later records, and never completes", async () => {
    const root = await evidenceRoot();
    const failure = new Error("injected append failure");
    const probe = await open(join(root, "probe"), "wx", 0o600);
    const fileHandlePrototype = Object.getPrototypeOf(probe) as { writeFile: (data: string) => Promise<void> };
    await probe.close();
    const actualWriteFile = fileHandlePrototype.writeFile;
    let failNext = false;
    vi.spyOn(fileHandlePrototype, "writeFile").mockImplementation(function (this: typeof probe, data: string) {
      if (failNext) { failNext = false; return Promise.reject(failure); }
      return actualWriteFile.call(this, data);
    });
    const onFailure = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const capture = await BioSensorShadowCapture.create({ evidenceRoot: root, captureName, source, onFailure });
    failNext = true;
    capture.record(notification("alive-status", 1));
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    capture.record(notification("alive-status", 2));
    await expect(capture.close()).rejects.toBe(failure);
    await expect(capture.close()).rejects.toBe(failure);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
    expect((await lines(root)).some((entry) => entry.type === "capture-complete")).toBe(false);
    expect((await lines(root)).some((entry) => entry.type === "observation")).toBe(false);
  });
});
