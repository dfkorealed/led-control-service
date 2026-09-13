import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BioByteConnection } from "./bio-byte-connection";
import { BioDongleClient, type BioClientEvent } from "./bio-dongle-client";
import { encodeCrcFrame } from "./bio-frame-codec";
import type { BioOperation } from "./bio-command-codec";

const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/bio-protocol-v1.json", import.meta.url), "utf8")) as {
  requests: { name: string; operation: BioOperation; sequence: number; hex: string }[];
};
const capturedControls = fixture.requests.filter((vector) => vector.operation.kind === "setHighBrightness" || vector.operation.kind === "setControlMode");

const target = { kind: "unicast", logicalAddress: 0x1234, networkId: 0 } as const;
const verifiedTarget = { ...target, nativeUuid: "001122334455" } as const;
const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
class Device extends EventEmitter implements BioByteConnection {
  isOpen = false;
  writes: Buffer[] = [];
  async open() { this.isOpen = true; }
  async write(bytes: Uint8Array) { this.writes.push(Buffer.from(bytes)); }
  async close() { this.isOpen = false; }
  onData(listener: (bytes: Buffer) => void): () => void {
    this.on("data", listener);
    return () => { this.off("data", listener); };
  }
  onDisconnect(listener: (error: Error) => void): () => void {
    this.on("error", listener);
    return () => { this.off("error", listener); };
  }
  receive(hex: string) { this.emit("data", Buffer.from(hex, "hex")); }
}
function harness(initialSequence = 75, options: { scanDurationMs?: number; observationTimeoutMs?: number } = {}) {
  const device = new Device();
  const client = new BioDongleClient({
    initialSequence,
    ...options,
    connectionFactory: () => device
  });
  return { client, device };
}

function discoveryHex(nativeUuid: string, logicalAddress: number, rssi = -45) {
  const payload = Buffer.alloc(28);
  payload.writeInt8(rssi, 0);
  Buffer.from(nativeUuid, "hex").copy(payload, 1);
  payload[7] = 0x83;
  payload[8] = 46;
  payload.writeUInt16BE(logicalAddress, 9);
  payload.writeUInt16BE(0xc000, 11);
  payload.writeUInt16BE(0, 13);
  Buffer.from("0a010505085932020100030000", "hex").copy(payload, 15);
  return encodeCrcFrame(0x12, payload).toString("hex");
}

function modeReportHex(nativeUuid: string, logicalAddress: number, mode: 0 | 1 | 3) {
  const payload = Buffer.alloc(18);
  payload.writeInt8(-42, 0);
  Buffer.from(nativeUuid, "hex").copy(payload, 1);
  payload[7] = 0x83;
  payload[8] = 120;
  payload.writeUInt16BE(logicalAddress, 9);
  payload.writeUInt16BE(0x01fe, 11);
  payload.writeUInt16BE(0, 13);
  payload.set([0x4f, 0x12, mode], 15);
  return encodeCrcFrame(0x12, payload).toString("hex");
}

function brightnessReportHex(nativeUuid: string, logicalAddress: number, raw: number) {
  const payload = Buffer.alloc(18);
  payload.writeInt8(-42, 0);
  Buffer.from(nativeUuid, "hex").copy(payload, 1);
  payload[7] = 0x83;
  payload[8] = 121;
  payload.writeUInt16BE(logicalAddress, 9);
  payload.writeUInt16BE(0x01fe, 11);
  payload.writeUInt16BE(0, 13);
  payload.set([0x4f, 0x13, raw], 15);
  return encodeCrcFrame(0x12, payload).toString("hex");
}

async function finishScan(h: ReturnType<typeof harness>, notifications: string[]) {
  const scanning = h.client.scan();
  await flush();
  h.device.receive("55aa1101002055");
  await flush();
  for (const notification of notifications) h.device.receive(notification);
  await vi.advanceTimersByTimeAsync(100);
  await flush();
  h.device.receive("55aa1101002055");
  return scanning;
}

async function drivePendingScan(h: ReturnType<typeof harness>, notifications: string[]) {
  await flush();
  h.device.receive("55aa1101002055");
  await flush();
  for (const notification of notifications) h.device.receive(notification);
  await vi.advanceTimersByTimeAsync(100);
  await flush();
  h.device.receive("55aa1101002055");
  await flush();
}

function requestBody(device: Device, index: number) {
  return device.writes[index].subarray(19, -2).toString("hex");
}

function commandBodies(device: Device) {
  return device.writes
    .filter((bytes) => bytes[0] === 0x55 && bytes[1] === 0xaa && bytes[2] === 0x10)
    .map((bytes) => bytes.subarray(19, -2).toString("hex"));
}

async function recoverReady(device: Device) {
  device.receive("55aa030c02050320682f0000000300001147");
  await flush();
  device.receive("55aa0b0d0001000000000000010c000320c50e");
  await flush();
}
async function ready(h: ReturnType<typeof harness>) {
  const probe = h.client.probe(); void probe.catch(() => {}); await flush();
  h.device.receive("55aa030c02050320682f0000000300001147"); await flush();
  h.device.receive("55aa0b0d0001000000000000010c000320c50e");
  return probe;
}

describe("BIO evidence-gated dongle client", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens using the observed read-only network query and returns no network secret", async () => {
    const h = harness();
    expect(await ready(h)).toEqual({ kind: "probe", protocol: "crc16", responseCommand: 11, payloadBytes: 13 });
    expect(h.device.writes.map((b) => b.toString("hex"))).toEqual(["55aa82000000", "4753820000", "55aa0a000710"]);
    await h.client.close();
    expect(h.device.isOpen).toBe(false);
  });

  it("returns only dongle acceptance for the observed unicast raw high-brightness setting", async () => {
    const h = harness(); await ready(h);
    const result = h.client.setBrightness(target, { rawHighBrightness: 254 }); await flush();
    expect(h.device.writes[3].toString("hex")).toBe("55aa101200000000000000804b01fe12340000cd13fe2962");
    h.device.receive("55aa1101002055");
    expect(await result).toEqual({ outcome: "dongle-accepted", deviceApplied: false });
    await h.client.close();
  });

  it.each(capturedControls)("preserves captured control $name at the byte boundary", async ({ operation, sequence, hex }) => {
    const h = harness(sequence); await ready(h);
    const result = operation.kind === "setHighBrightness"
      ? h.client.setBrightness(operation.target, { rawHighBrightness: operation.rawHighBrightness })
      : operation.kind === "setControlMode" ? h.client.setControlMode(operation.target, operation.mode)
      : Promise.reject(new Error("Expected a captured control operation"));
    await flush();
    expect(h.device.writes[3].toString("hex")).toBe(hex);
    h.device.receive("55aa1101002055");
    expect(await result).toEqual({ outcome: "dongle-accepted", deviceApplied: false });
    await h.client.close();
  });

  it.each([
    { name: "broadcast force-off", invoke: (client: BioDongleClient) => client.setControlMode({ kind: "broadcast", networkId: 0 }, "force-off") },
    { name: "broadcast non-table raw 127", invoke: (client: BioDongleClient) => client.setBrightness({ kind: "broadcast", networkId: 0 }, { rawHighBrightness: 127 }) },
    { name: "unicast non-table raw 127", invoke: (client: BioDongleClient) => client.setBrightness(target, { rawHighBrightness: 127 }) },
    { name: "raw zero instead of force-off", invoke: (client: BioDongleClient) => client.setBrightness(target, { rawHighBrightness: 0 }) }
  ])("rejects $name before any additional byte write or sequence consumption", async ({ invoke }) => {
    const h = harness(75); await ready(h);
    let failure: unknown;
    const rejected = invoke(h.client).catch((error: unknown) => { failure = error; });
    try {
      await flush();
      expect(failure).toMatchObject({ code: "BIO_EVIDENCE_UNAVAILABLE" });
      expect(h.device.writes.map((bytes) => bytes.toString("hex"))).toEqual(["55aa82000000", "4753820000", "55aa0a000710"]);
      await rejected;
      const accepted = h.client.setBrightness(target, { rawHighBrightness: 254 }); await flush();
      expect(h.device.writes[3].toString("hex")).toBe("55aa101200000000000000804b01fe12340000cd13fe2962");
      h.device.receive("55aa1101002055"); await accepted;
    } finally {
      await h.client.close();
    }
  });

  it("aggregates the latest RSSI/address by UUID and requires the final stop ACK", async () => {
    const h = harness(71, { scanDurationMs: 100 }); await ready(h);
    const events: BioClientEvent[] = [];
    h.client.onEvent((event) => events.push(event));
    const result = h.client.scan(); let settled = false; void result.then(() => { settled = true; });
    await flush();
    expect(h.device.writes[3].toString("hex")).toBe("55aa101100000000000000804701feffff00008305daee");
    h.device.receive(discoveryHex("001122334455", 0x1234, -60));
    h.device.receive(discoveryHex("aabbccddeeff", 0x2222, -50));
    h.device.receive(discoveryHex("001122334455", 0x1235, -41));
    await flush();
    expect(events[0]).toMatchObject({ kind: "discovery", deviceUuid: "bio:001122334455", logicalAddress: 0x1234 });
    expect(settled).toBe(false);
    h.device.receive("55aa1101002055");
    await flush();
    await vi.advanceTimersByTimeAsync(100); await flush();
    expect(h.device.writes[4].subarray(19, 20).toString("hex")).toBe("85");
    expect(settled).toBe(false);
    h.device.receive("55aa1101002055");
    await expect(result).resolves.toEqual([
      {
        nativeUuid: "001122334455", deviceUuid: "bio:001122334455", logicalAddress: 0x1235,
        networkId: 0, firmwareVersion: "5.5.8.12889", rssi: -41
      },
      {
        nativeUuid: "aabbccddeeff", deviceUuid: "bio:aabbccddeeff", logicalAddress: 0x2222,
        networkId: 0, firmwareVersion: "5.5.8.12889", rssi: -50
      }
    ]);
    await h.client.close();
  });

  it("calls stopScan from finally after a scan-start error and does not return without its ACK", async () => {
    const h = harness(71, { scanDurationMs: 100 }); await ready(h);
    const scanning = h.client.scan();
    await flush();
    h.device.emit("data", encodeCrcFrame(0x11, Buffer.from([1])));
    await flush();
    expect(h.device.writes[4].subarray(19, 20).toString("hex")).toBe("85");
    let settled = false;
    void scanning.catch(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    h.device.receive("55aa1101002055");
    await expect(scanning).rejects.toMatchObject({ code: "BIO_DONGLE_REJECTED" });
    await h.client.close();
  });

  it("rejects collected scan results when the final stop ACK times out", async () => {
    const h = harness(71, { scanDurationMs: 100 }); await ready(h);
    const scanning = h.client.scan(); void scanning.catch(() => {});
    await flush();
    h.device.receive("55aa1101002055");
    h.device.receive(discoveryHex("001122334455", 0x1234));
    await vi.advanceTimersByTimeAsync(100); await flush();
    expect(commandBodies(h.device).at(-1)).toBe("85");
    await vi.advanceTimersByTimeAsync(300);

    await expect(scanning).rejects.toMatchObject({ code: "TIMEOUT" });
    await h.client.close();
  });

  it("keeps a device mode observation separate from the transport ACK", async () => {
    const h = harness(77); await ready(h);
    const events: BioClientEvent[] = [];
    const unsubscribe = h.client.onEvent((event) => events.push(event));
    const result = h.client.setControlMode(target, "force-on"); await flush();
    expect(h.device.writes[3].toString("hex")).toBe("55aa101200000000000000804d01fe12340000cc120358ac");
    h.device.receive("55aa1212da0011223344558377123401fe00004f1203e39455aa1101002055");
    expect(await result).toEqual({ outcome: "dongle-accepted", deviceApplied: false });
    expect(events).toMatchObject([{ kind: "control-mode-report", mode: "force-on", sequence: 119 }]);
    unsubscribe();
    h.device.receive("55aa1212d70011223344558378123401fe00004f1200010a");
    expect(events).toHaveLength(1);
    await h.client.close();
  });

  it("identifies the current scan-cache UUID for exactly two seconds and verifies sensor restoration", async () => {
    const h = harness(75, { scanDurationMs: 100, observationTimeoutMs: 100 }); await ready(h);
    await finishScan(h, [discoveryHex("001122334455", 0x1234)]);

    const identifying = h.client.startIdentify("bio:001122334455");
    await flush();
    expect(requestBody(h.device, 5)).toBe("cc1203");
    h.device.receive("55aa1101002055");
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.device.writes).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(1); await flush();
    expect(requestBody(h.device, 6)).toBe("cc1200");
    h.device.receive(modeReportHex("001122334455", 0x1234, 0) + "55aa1101002055");

    await expect(identifying).resolves.toMatchObject({
      deviceUuid: "bio:001122334455",
      logicalAddress: 0x1234
    });
    await h.client.close();
  });

  it("cancels identify early but still makes one verified sensor restore attempt", async () => {
    const h = harness(75, { scanDurationMs: 100, observationTimeoutMs: 100 }); await ready(h);
    await finishScan(h, [discoveryHex("001122334455", 0x1234)]);
    const identifying = h.client.startIdentify("001122334455");
    void identifying.catch(() => {});
    await flush();
    h.device.receive("55aa1101002055");

    const stopping = h.client.stopIdentify("bio:001122334455");
    await flush();
    expect(requestBody(h.device, 6)).toBe("cc1200");
    h.device.receive("55aa1101002055");
    h.device.receive(modeReportHex("001122334455", 0x1234, 0));

    await expect(identifying).rejects.toMatchObject({ name: "AbortError" });
    await expect(stopping).resolves.toBeUndefined();
    expect(h.device.writes.filter((_, index) => index >= 5 && requestBody(h.device, index) === "cc1200")).toHaveLength(1);
    await h.client.close();
  });

  it("restores sensor mode after a force-on error and preserves the original failure when restore is confirmed", async () => {
    const h = harness(75, { scanDurationMs: 100, observationTimeoutMs: 100 }); await ready(h);
    await finishScan(h, [discoveryHex("001122334455", 0x1234)]);
    const identifying = h.client.startIdentify("bio:001122334455");
    void identifying.catch(() => {});
    await flush();
    h.device.emit("data", encodeCrcFrame(0x11, Buffer.from([1])));
    await flush();
    expect(requestBody(h.device, 6)).toBe("cc1200");
    h.device.receive(modeReportHex("001122334455", 0x1234, 0) + "55aa1101002055");

    await expect(identifying).rejects.toMatchObject({ code: "BIO_DONGLE_REJECTED" });
    await h.client.close();
  });

  it("fails identify with the exact restore-unconfirmed code when sensor ACK has no matching UUID/address report", async () => {
    const h = harness(75, { scanDurationMs: 100, observationTimeoutMs: 100 }); await ready(h);
    await finishScan(h, [discoveryHex("001122334455", 0x1234)]);
    const identifying = h.client.startIdentify("bio:001122334455");
    void identifying.catch(() => {});
    await flush();
    h.device.receive("55aa1101002055");
    await vi.advanceTimersByTimeAsync(2000); await flush();
    h.device.receive("55aa1101002055");
    h.device.receive(modeReportHex("aabbccddeeff", 0x1234, 0));
    await vi.advanceTimersByTimeAsync(100);

    await expect(identifying).rejects.toMatchObject({ code: "BIO_IDENTIFY_RESTORE_UNCONFIRMED" });
    await h.client.close();
  });

  it("waits for transport recovery after a force-on timeout and then attempts sensor restore", async () => {
    const h = harness(75, { scanDurationMs: 100, observationTimeoutMs: 100 }); await ready(h);
    await finishScan(h, [discoveryHex("001122334455", 0x1234)]);
    const identifying = h.client.startIdentify("bio:001122334455"); void identifying.catch(() => {});
    await flush();
    expect(commandBodies(h.device).at(-1)).toBe("cc1203");

    await vi.advanceTimersByTimeAsync(300);
    expect(commandBodies(h.device).filter((body) => body === "cc1200")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2000); await flush();
    await recoverReady(h.device);
    expect(commandBodies(h.device).at(-1)).toBe("cc1200");
    h.device.receive(modeReportHex("001122334455", 0x1234, 0) + "55aa1101002055");

    await expect(identifying).rejects.toMatchObject({ code: "TIMEOUT" });
    await h.client.close();
  });

  it.each([
    { name: "new only", notifications: [discoveryHex("001122334455", 0x2345)], expected: { outcome: "confirmed", address: 0x2345 } },
    { name: "old only", notifications: [discoveryHex("001122334455", 0x1234)], expected: { outcome: "unchanged", address: 0x1234 } },
    { name: "both", notifications: [discoveryHex("001122334455", 0x1234), discoveryHex("001122334455", 0x2345)], expected: { outcome: "unknown", code: "BIO_ADDRESS_STATE_UNKNOWN" } },
    { name: "neither", notifications: [], expected: { outcome: "unknown", code: "BIO_ADDRESS_STATE_UNKNOWN" } }
  ])("reconciles address state from scan evidence: $name", async ({ notifications, expected }) => {
    const h = harness(75, { scanDurationMs: 100 }); await ready(h);
    const reconciling = h.client.reconcileAddress("bio:001122334455", 0x1234, 0x2345);
    await drivePendingScan(h, notifications);
    const result = await reconciling;
    expect(result).toMatchObject(expected.outcome === "unknown" ? expected : {
      outcome: expected.outcome,
      device: { deviceUuid: "bio:001122334455", logicalAddress: expected.address }
    });
    await h.client.close();
  });

  it("rejects address reconciliation when another UUID occupies the requested address", async () => {
    const h = harness(75, { scanDurationMs: 100 }); await ready(h);
    const reconciling = h.client.reconcileAddress("bio:001122334455", 0x1234, 0x2345);
    void reconciling.catch(() => {});
    await drivePendingScan(h, [discoveryHex("aabbccddeeff", 0x2345)]);
    await expect(reconciling).rejects.toMatchObject({ code: "BIO_ADDRESS_CONFLICT" });
    await h.client.close();
  });

  it("reconciles old-only before retrying the same assignment once, then confirms new-only evidence", async () => {
    const h = harness(75, { scanDurationMs: 100 }); await ready(h);
    await finishScan(h, [discoveryHex("001122334455", 0x1234)]);
    const assigning = h.client.assignAddress("bio:001122334455", 0x2345);
    await flush();
    expect(requestBody(h.device, 5)).toBe("b8810011223344552345");
    h.device.receive("55aa1101002055");

    await drivePendingScan(h, [discoveryHex("001122334455", 0x1234)]);
    expect(requestBody(h.device, 8)).toBe("b8810011223344552345");
    expect(h.device.writes.filter((_, index) => index >= 5 && requestBody(h.device, index).startsWith("b881"))).toHaveLength(2);
    h.device.receive("55aa1101002055");
    await drivePendingScan(h, [discoveryHex("001122334455", 0x2345)]);

    await expect(assigning).resolves.toMatchObject({ outcome: "confirmed", device: { logicalAddress: 0x2345 } });
    expect(h.device.writes.filter((_, index) => index >= 5 && requestBody(h.device, index).startsWith("b881"))).toHaveLength(2);
    await h.client.close();
  });

  it("after an assignment ACK timeout reconciles before one bounded retry", async () => {
    const h = harness(75, { scanDurationMs: 100 }); await ready(h);
    await finishScan(h, [discoveryHex("001122334455", 0x1234)]);
    const assigning = h.client.assignAddress("bio:001122334455", 0x2345); void assigning.catch(() => {});
    await flush();
    expect(commandBodies(h.device).at(-1)).toBe("b8810011223344552345");

    await vi.advanceTimersByTimeAsync(300);
    expect(commandBodies(h.device).filter((body) => body.startsWith("b881"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000); await flush();
    await recoverReady(h.device);
    expect(commandBodies(h.device).at(-1)).toBe("8305");
    expect(commandBodies(h.device).filter((body) => body.startsWith("b881"))).toHaveLength(1);

    await drivePendingScan(h, [discoveryHex("001122334455", 0x1234)]);
    expect(commandBodies(h.device).at(-1)).toBe("b8810011223344552345");
    expect(commandBodies(h.device).filter((body) => body.startsWith("b881"))).toHaveLength(2);
    h.device.receive("55aa1101002055");
    await drivePendingScan(h, [discoveryHex("001122334455", 0x2345)]);

    await expect(assigning).resolves.toMatchObject({ outcome: "confirmed", device: { logicalAddress: 0x2345 } });
    expect(commandBodies(h.device).filter((body) => body.startsWith("b881"))).toHaveLength(2);
    await h.client.close();
  });

  it("sets 60% using raw 198 and returns applied only after brightness and mode read-back match", async () => {
    const h = harness(75, { observationTimeoutMs: 100 }); await ready(h);
    const setting = h.client.setOutput(verifiedTarget, 60);
    await flush();
    expect(requestBody(h.device, 3)).toBe("cd13c6");
    h.device.receive("55aa1101002055"); await flush();
    expect(requestBody(h.device, 4)).toBe("cc1203");
    h.device.receive("55aa1101002055"); await flush();
    expect(requestBody(h.device, 5)).toBe("4e13");
    h.device.receive("55aa1101002055");
    h.device.receive(brightnessReportHex("001122334455", 0x1234, 198));
    await flush();
    expect(requestBody(h.device, 6)).toBe("4e12");
    h.device.receive("55aa1101002055");
    h.device.receive(modeReportHex("001122334455", 0x1234, 3));

    await expect(setting).resolves.toEqual({
      brightnessPercent: 60,
      powerOn: true,
      rawHighBrightness: 198,
      mode: "force-on"
    });
    await h.client.close();
  });

  it("sets 0% with force-off and verifies only control mode", async () => {
    const h = harness(75, { observationTimeoutMs: 100 }); await ready(h);
    const setting = h.client.setOutput(verifiedTarget, 0);
    await flush();
    expect(requestBody(h.device, 3)).toBe("cc1201");
    h.device.receive("55aa1101002055"); await flush();
    expect(requestBody(h.device, 4)).toBe("4e12");
    h.device.receive(modeReportHex("001122334455", 0x1234, 1) + "55aa1101002055");

    await expect(setting).resolves.toEqual({ brightnessPercent: 0, powerOn: false, mode: "force-off" });
    expect(h.device.writes.slice(3).some((_, offset) => requestBody(h.device, offset + 3).includes("4e13"))).toBe(false);
    await h.client.close();
  });

  it("fails with exact mismatch codes and never promotes outer ACK to applied", async () => {
    const brightness = harness(75, { observationTimeoutMs: 100 }); await ready(brightness);
    const wrongBrightness = brightness.client.setOutput(verifiedTarget, 60); void wrongBrightness.catch(() => {});
    await flush();
    brightness.device.receive("55aa1101002055"); await flush();
    brightness.device.receive("55aa1101002055"); await flush();
    brightness.device.receive("55aa1101002055");
    brightness.device.receive(brightnessReportHex("001122334455", 0x1234, 199));
    await expect(wrongBrightness).rejects.toMatchObject({ code: "BIO_BRIGHTNESS_STATE_MISMATCH" });
    await brightness.client.close();

    const mode = harness(75, { observationTimeoutMs: 100 }); await ready(mode);
    const wrongMode = mode.client.setOutput(verifiedTarget, 0); void wrongMode.catch(() => {});
    await flush();
    mode.device.receive("55aa1101002055"); await flush();
    mode.device.receive("55aa1101002055");
    mode.device.receive(modeReportHex("001122334455", 0x1234, 0));
    await expect(wrongMode).rejects.toMatchObject({ code: "BIO_CONTROL_MODE_STATE_MISMATCH" });
    await mode.client.close();
  });

  it("handles an observation timeout while its GET is queued or awaiting ACK without an unhandled rejection or leaked waiter", async () => {
    const h = harness(75, { observationTimeoutMs: 50 }); await ready(h);
    const unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", recordUnhandled);
    try {
      const blocker = h.client.stopScan(); void blocker.catch(() => {});
      const reading = h.client.readBrightness(verifiedTarget); void reading.catch(() => {});
      await flush();
      expect(commandBodies(h.device).at(-1)).toBe("85");

      await vi.advanceTimersByTimeAsync(50);
      h.device.receive("55aa1101002055");
      await flush();
      expect(commandBodies(h.device).at(-1)).toBe("4e13");
      await vi.advanceTimersByTimeAsync(50);
      h.device.receive("55aa1101002055");

      await expect(blocker).resolves.toEqual({ outcome: "dongle-accepted", deviceApplied: false });
      await expect(reading).rejects.toMatchObject({ code: "TIMEOUT" });
      await flush();
      expect(unhandled).toEqual([]);
      expect((h.client as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      process.off("unhandledRejection", recordUnhandled);
      await h.client.close();
    }
  });

  it("cleans the matching-report waiter immediately when the GET outer ACK is rejected", async () => {
    const h = harness(75, { observationTimeoutMs: 100 }); await ready(h);
    const reading = h.client.readBrightness(verifiedTarget); void reading.catch(() => {});
    await flush();
    h.device.emit("data", encodeCrcFrame(0x11, Buffer.from([1])));

    await expect(reading).rejects.toMatchObject({ code: "BIO_DONGLE_REJECTED" });
    expect((h.client as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    h.device.receive(brightnessReportHex("001122334455", 0x1234, 198));
    await flush();
    expect((h.client as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0);
    await h.client.close();
  });

  it("serializes two same-target GET operations through each command and its own report", async () => {
    const h = harness(75, { observationTimeoutMs: 100 }); await ready(h);
    const first = h.client.readBrightness(verifiedTarget); void first.catch(() => {});
    const second = h.client.readBrightness(verifiedTarget); void second.catch(() => {});
    let secondSettled = false;
    void second.finally(() => { secondSettled = true; }).catch(() => {});
    await flush();
    expect(commandBodies(h.device).filter((body) => body === "4e13")).toHaveLength(1);

    h.device.receive("55aa1101002055");
    await flush();
    expect(commandBodies(h.device).filter((body) => body === "4e13")).toHaveLength(1);
    h.device.receive(brightnessReportHex("001122334455", 0x1234, 198));
    await expect(first).resolves.toMatchObject({ rawHighBrightness: 198 });
    await flush();
    expect(commandBodies(h.device).filter((body) => body === "4e13")).toHaveLength(2);

    h.device.receive("55aa1101002055");
    await flush();
    expect(secondSettled).toBe(false);
    h.device.receive(brightnessReportHex("001122334455", 0x1234, 199));
    await expect(second).resolves.toMatchObject({ rawHighBrightness: 199 });
    await h.client.close();
  });

  it("ignores a delayed control-mode DPID during brightness GET and accepts brightness before outer ACK", async () => {
    const h = harness(75, { observationTimeoutMs: 100 }); await ready(h);
    const reading = h.client.readBrightness(verifiedTarget); void reading.catch(() => {});
    let settled = false;
    void reading.finally(() => { settled = true; }).catch(() => {});
    await flush();

    h.device.receive(modeReportHex("001122334455", 0x1234, 3));
    h.device.receive(brightnessReportHex("001122334455", 0x1234, 198));
    await flush();
    expect(settled).toBe(false);
    h.device.receive("55aa1101002055");

    await expect(reading).resolves.toMatchObject({ kind: "high-brightness-report", rawHighBrightness: 198 });
    await h.client.close();
  });

  it("ignores a delayed brightness DPID during control-mode GET and accepts mode before outer ACK", async () => {
    const h = harness(75, { observationTimeoutMs: 100 }); await ready(h);
    const reading = h.client.readDeviceInfo(verifiedTarget); void reading.catch(() => {});
    let settled = false;
    void reading.finally(() => { settled = true; }).catch(() => {});
    await flush();

    h.device.receive(brightnessReportHex("001122334455", 0x1234, 198));
    h.device.receive(modeReportHex("001122334455", 0x1234, 0));
    await flush();
    expect(settled).toBe(false);
    h.device.receive("55aa1101002055");

    await expect(reading).resolves.toMatchObject({ kind: "control-mode-report", mode: "sensor" });
    await h.client.close();
  });

  it("rejects invalid service percentages and non-table raw writes before serializing them", async () => {
    const h = harness(); await ready(h);
    for (const percent of [-1, 1.5, 101]) {
      await expect(h.client.setOutput(verifiedTarget, percent)).rejects.toThrow(/percent/i);
    }
    await expect(h.client.setBrightness(target, { rawHighBrightness: 127 }))
      .rejects.toMatchObject({ code: "BIO_EVIDENCE_UNAVAILABLE" });
    expect(h.device.writes).toHaveLength(3);
    await h.client.close();
  });

  it("rejects unknown identify/address targets and incomplete read-back identity before a serial write", async () => {
    const h = harness(); await ready(h);
    for (const operation of [
      () => h.client.startIdentify("bio:001122334455"), () => h.client.stopIdentify("bio:001122334455"),
      () => h.client.assignAddress("bio:001122334455", 1), () => h.client.readBrightness(target), () => h.client.readDeviceInfo(target)
    ]) await expect(operation()).rejects.toMatchObject({ code: "BIO_DEVICE_NOT_FOUND" });
    expect(h.device.writes).toHaveLength(3);
    await h.client.close();
  });

  it("serializes requests, advances the byte sequence and sends stop only once per call", async () => {
    const h = harness(255); await ready(h);
    const first = h.client.stopScan(); const second = h.client.stopScan(); await flush();
    expect(h.device.writes).toHaveLength(4);
    expect(h.device.writes[3][12]).toBe(255);
    h.device.receive("55aa1101002055"); await first; await flush();
    expect(h.device.writes).toHaveLength(5);
    expect(h.device.writes[4][12]).toBe(0);
    h.device.receive("55aa1101002055"); await second;
    await h.client.close();
  });

  it("fails a nonzero dongle error instead of reporting acceptance", async () => {
    const h = harness(); await ready(h);
    const result = h.client.setBrightness(target, { rawHighBrightness: 255 });
    const failure = expect(result).rejects.toMatchObject({ code: "BIO_DONGLE_REJECTED" }); await flush();
    h.device.emit("data", encodeCrcFrame(0x11, Buffer.from([1]))); await failure;
    await h.client.close();
  });

  it("reports malformed notification metadata without exposing its bytes or disrupting the ACK", async () => {
    const h = harness(); await ready(h);
    const events: BioClientEvent[] = []; h.client.onEvent((event) => events.push(event));
    const result = h.client.stopScan(); await flush();
    h.device.emit("data", encodeCrcFrame(0x12, Buffer.from("secret")));
    h.device.receive("55aa1101002055"); await result;
    expect(events).toEqual([{ kind: "invalid-notification" }]);
    await h.client.close();
  });

  it("does not enable writes before probe and rejects an invalid initial sequence", async () => {
    const h = harness();
    await expect(h.client.scan()).rejects.toMatchObject({ code: "NOT_READY" });
    expect(h.device.writes).toEqual([]);
    expect(() => harness(256)).toThrow();
    await h.client.close();
  });
});
