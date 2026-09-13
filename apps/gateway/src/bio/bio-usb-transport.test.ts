import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BioByteConnection } from "./bio-byte-connection";
import { BioUsbTransport, type BioTransportSnapshot } from "./bio-usb-transport";

const hex = (value: string) => Buffer.from(value, "hex");
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
const settled = <T>(promise: Promise<T>) => promise.then((value) => value, (error: unknown) => error);
const validInfo03 = Buffer.from("55aa030c02050320682f0000000300001147", "hex");
const validGsInfo03 = Buffer.from("4753030c000000000000000000000000f0", "hex");
const validNetwork0b = "55aa0b0d0001000000000000010c000320c50e";
const validNotification12 = Buffer.from("55aa121cd3001122334455832e1234c00000000a0105050859320201000300006bcc", "hex");

class FakeBioByteConnection implements BioByteConnection {
  readonly writes: Buffer[] = [];
  private readonly dataListeners = new Set<(bytes: Buffer) => void>();
  private readonly disconnectListeners = new Set<(error: Error) => void>();

  async open(): Promise<void> {}
  async write(bytes: Uint8Array): Promise<void> { this.writes.push(Buffer.from(bytes)); }
  async close(): Promise<void> {}
  onData(listener: (bytes: Buffer) => void): () => void {
    this.dataListeners.add(listener);
    return () => { this.dataListeners.delete(listener); };
  }
  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => { this.disconnectListeners.delete(listener); };
  }
  emit(bytes: Buffer): void {
    for (const listener of this.dataListeners) listener(bytes);
  }
}

function createTransport(connection: BioByteConnection): BioUsbTransport {
  return new BioUsbTransport({
    profile: "android-v1.2.0",
    protocol: "crc16",
    connectionFactory: () => connection,
    validateReadiness: async () => {}
  });
}

class HarnessConnection extends EventEmitter implements BioByteConnection {
  isOpen = false;
  writes: string[] = [];
  writeError?: Error;
  async open() { this.isOpen = true; }
  async write(bytes: Uint8Array) {
    this.writes.push(Buffer.from(bytes).toString("hex"));
    if (this.writeError) throw this.writeError;
  }
  async close() { this.isOpen = false; this.emit("close"); }
  onData(listener: (bytes: Buffer) => void): () => void {
    this.on("data", listener);
    return () => { this.off("data", listener); };
  }
  onDisconnect(listener: (error: Error) => void): () => void {
    const closed = () => listener(new Error("BIO byte connection closed"));
    this.on("error", listener);
    this.on("close", closed);
    return () => { this.off("error", listener); this.off("close", closed); };
  }
  receive(value: string) { this.emit("data", hex(value)); }
}

function harness(options: { protocol?: "crc16" | "gs" | "auto"; profile?: "android-v1.2.0"; validateReadiness?: () => Promise<void>; timeoutMs?: number; configureDevice?: (device: HarnessConnection) => void } = {}) {
  const devices: HarnessConnection[] = [];
  const transport = new BioUsbTransport({
    protocol: options.protocol ?? "gs", profile: options.profile, timeoutMs: options.timeoutMs,
    connectionFactory: () => {
      const device = new HarnessConnection(); devices.push(device);
      options.configureDevice?.(device);
      return device;
    },
    validateReadiness: options.validateReadiness ?? (async () => {})
  });
  return { transport, devices };
}

async function ready(value: ReturnType<typeof harness>) {
  const starting = value.transport.start();
  void starting.catch(() => {});
  await flush();
  expect(value.devices).toHaveLength(1);
  value.devices.at(-1)!.receive("475383007c");
  await starting;
}

describe("BioUsbTransport", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rejects a response candidate that started before the request write", async () => {
    const connection = new FakeBioByteConnection();
    const transport = createTransport(connection);
    const starting = transport.start();
    connection.emit(validInfo03);
    connection.emit(Buffer.from("55aa0b", "hex"));

    await expect(starting).rejects.toMatchObject({ code: "LATE_RESPONSE" });
    expect(connection.writes).toEqual([
      Buffer.from("55aa82000000", "hex"),
      Buffer.from("4753820000", "hex")
    ]);
  });

  // GS 03+00+FC is a synthetic checksum/parser case, not an additional captured payload.
  it.each(["55aa030c02050320682f0000000300001147", "47530300fc"])("sends both converter literals then waits for valid info %s before network read", async (info) => {
    const h = harness({ profile: "android-v1.2.0", protocol: "crc16" });
    const start = h.transport.start(); void start.catch(() => {}); await flush();
    expect(h.devices[0].writes).toEqual(["55aa82000000", "4753820000"]);
    h.devices[0].receive("55aa121cd3001122334455832e1234c00000000a0105050859320201000300006bcc"); await flush();
    expect(h.devices[0].writes).toEqual(["55aa82000000", "4753820000"]);
    h.devices[0].receive(info); await flush();
    expect(h.devices[0].writes).toEqual(["55aa82000000", "4753820000", "55aa0a000710"]);
    h.devices[0].receive("55aa0b0d0001000000000000010c000320c50e");
    await start;
    expect(h.transport.snapshot().ready).toBe(true);
    await h.transport.stop();
  });

  it("preserves power-on info arriving during connection open", async () => {
    const h = harness({ profile: "android-v1.2.0", protocol: "crc16", configureDevice: (device) => {
      device.open = async () => {
        device.isOpen = true;
        device.receive("55aa030c02050320682f0000000300001147");
      };
    } });
    const start = settled(h.transport.start());
    try {
      await flush();
      expect(h.devices[0].writes).toEqual(["55aa82000000", "4753820000", "55aa0a000710"]);
      h.devices[0].receive("55aa0b0d0001000000000000010c000320c50e"); await start;
      expect(h.transport.snapshot().ready).toBe(true);
    } finally {
      await h.transport.stop();
    }
  });

  it("preserves queued startup info on the Android open path", async () => {
    const h = harness({ profile: "android-v1.2.0", protocol: "crc16", configureDevice: (device) => {
      device.open = async () => {
        device.isOpen = true;
        void Promise.resolve().then(() => Promise.resolve()).then(() => {
          device.receive("55aa030c02050320682f0000000300001147");
        });
      };
    } });
    const start = settled(h.transport.start()); await flush();
    expect(h.devices[0].writes).toEqual(["55aa82000000", "4753820000", "55aa0a000710"]);
    h.devices[0].receive("55aa0b0d0001000000000000010c000320c50e"); await start;
    expect(h.transport.snapshot().ready).toBe(true);
    await h.transport.stop();
  });

  it("resynchronizes from a truncated startup notification before valid converter info", async () => {
    const h = harness({ profile: "android-v1.2.0", protocol: "crc16" });
    const notifications: number[] = [];
    h.transport.onNotification((frame) => notifications.push(frame.command));
    const starting = settled(h.transport.start());
    try {
      await flush();
      expect(h.devices[0].writes).toEqual(["55aa82000000", "4753820000"]);

      // Captured metadata boundary: a 16-byte-payload 12 stops after 14
      // total bytes, then checksum recovery finds CRC and GS info frames.
      h.devices[0].receive("55aa121000000000000000000000");
      h.devices[0].receive("55aa030c000000000000000000000000b9ce4753030c000000000000000000000000f0");
      await flush();

      expect(h.devices[0].writes).toEqual([
        "55aa82000000",
        "4753820000",
        "55aa0a000710"
      ]);
      expect(notifications).toEqual([0x03, 0x03]);
      h.devices[0].receive("55aa0b0d0001000000000000010c000320c50e");
      expect(await starting).toBeUndefined();
      expect(h.transport.snapshot().ready).toBe(true);
    } finally {
      await h.transport.stop();
      await starting;
    }
  });

  it("waits for the captured partial GS info tail before granting GET_NWK ownership", async () => {
    const h = harness({ profile: "android-v1.2.0", protocol: "crc16" });
    const notifications: number[] = [];
    h.transport.onNotification((frame) => notifications.push(frame.command));
    const starting = settled(h.transport.start());
    try {
      await flush();
      h.devices[0].receive(Buffer.concat([validInfo03, validGsInfo03.subarray(0, 14)]).toString("hex"));
      await flush();

      expect(h.devices[0].writes).toEqual(["55aa82000000", "4753820000"]);
      h.devices[0].receive(validGsInfo03.subarray(14).toString("hex"));
      await flush();
      expect(h.devices[0].writes).toEqual(["55aa82000000", "4753820000", "55aa0a000710"]);
      expect(notifications).toEqual([0x03, 0x03]);

      h.devices[0].receive(validNetwork0b);
      expect(await starting).toBeUndefined();
      expect(h.transport.snapshot().ready).toBe(true);
    } finally {
      await h.transport.stop();
      await starting;
    }
  });

  it("keeps early info owned through both converter writes and a later partial GS info", async () => {
    let finishSecondLiteral!: () => void;
    const h = harness({ profile: "android-v1.2.0", protocol: "crc16", configureDevice: (device) => {
      device.open = async () => {
        device.isOpen = true;
        device.receive(validInfo03.toString("hex"));
      };
      device.write = async (bytes) => {
        device.writes.push(Buffer.from(bytes).toString("hex"));
        if (device.writes.length === 1) {
          device.receive(validGsInfo03.subarray(0, 14).toString("hex"));
        }
        if (device.writes.length === 2) {
          await new Promise<void>((resolve) => { finishSecondLiteral = resolve; });
        }
      };
    } });
    const starting = settled(h.transport.start());
    try {
      await flush();
      expect(h.devices[0].writes).toEqual(["55aa82000000", "4753820000"]);

      finishSecondLiteral();
      await flush();
      expect(h.devices[0].writes).toEqual(["55aa82000000", "4753820000"]);

      h.devices[0].receive(validGsInfo03.subarray(14).toString("hex"));
      await flush();
      expect(h.devices[0].writes).toEqual(["55aa82000000", "4753820000", "55aa0a000710"]);

      h.devices[0].receive(validNetwork0b);
      expect(await starting).toBeUndefined();
      expect(h.transport.snapshot().ready).toBe(true);
    } finally {
      finishSecondLiteral?.();
      await h.transport.stop();
      await starting;
    }
  });

  it("keeps the original converter-info deadline while a proven startup frame is partial", async () => {
    const h = harness({ profile: "android-v1.2.0", protocol: "crc16", timeoutMs: 300 });
    const starting = settled(h.transport.start());
    try {
      await flush();
      h.devices[0].receive(Buffer.concat([validInfo03, validGsInfo03.subarray(0, 14)]).toString("hex"));
      await vi.advanceTimersByTimeAsync(299);
      expect(h.devices[0].writes).toEqual(["55aa82000000", "4753820000"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await starting).toMatchObject({ code: "TIMEOUT" });
      expect(h.devices[0].writes).toEqual(["55aa82000000", "4753820000"]);
    } finally {
      await h.transport.stop();
      await starting;
    }
  });

  it("does not extend the converter-info deadline for repeated allowlisted notifications", async () => {
    const h = harness({ profile: "android-v1.2.0", protocol: "crc16", timeoutMs: 300 });
    const starting = settled(h.transport.start());
    try {
      await flush();
      for (let elapsed = 0; elapsed < 300; elapsed += 100) {
        h.devices[0].receive(validNotification12.toString("hex"));
        await vi.advanceTimersByTimeAsync(elapsed === 200 ? 99 : 100);
      }
      expect(h.devices[0].writes).toEqual(["55aa82000000", "4753820000"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await starting).toMatchObject({ code: "TIMEOUT" });
      expect(h.devices[0].writes).toEqual(["55aa82000000", "4753820000"]);
    } finally {
      await h.transport.stop();
      await starting;
    }
  });

  it("bounds a classification-incomplete startup header after valid info without granting GET_NWK", async () => {
    const h = harness({ profile: "android-v1.2.0", protocol: "crc16", timeoutMs: 300 });
    const starting = settled(h.transport.start());
    try {
      await flush();
      h.devices[0].receive(`${validInfo03.toString("hex")}55`);
      await vi.advanceTimersByTimeAsync(299);
      expect(h.devices[0].writes).toEqual(["55aa82000000", "4753820000"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await starting).toMatchObject({ code: "TIMEOUT" });
      expect(h.devices[0].writes).toEqual(["55aa82000000", "4753820000"]);
    } finally {
      await h.transport.stop();
      await starting;
    }
  });

  it.each([
    ["partial premature 0b", "55aa0b"],
    ["partial unknown GS command", "475344"]
  ])("rejects %s before request ownership and never writes GET_NWK", async (_name, partial) => {
    const h = harness({ profile: "android-v1.2.0", protocol: "crc16" });
    const starting = settled(h.transport.start());
    try {
      await flush();
      h.devices[0].receive(`${validInfo03.toString("hex")}${partial}`);
      expect(await starting).toMatchObject({ code: "LATE_RESPONSE" });
      expect(h.devices[0].writes).toEqual(["55aa82000000", "4753820000"]);
    } finally {
      await h.transport.stop();
      await starting;
    }
  });

  it("drains a fragmented CRC16 12 startup notification without consuming it as a response", async () => {
    const h = harness({ profile: "android-v1.2.0", protocol: "crc16" });
    const notifications: number[] = [];
    h.transport.onNotification((frame) => notifications.push(frame.command));
    const starting = settled(h.transport.start());
    try {
      await flush();
      h.devices[0].receive(Buffer.concat([validInfo03, validNotification12.subarray(0, 8)]).toString("hex"));
      await flush();
      expect(h.devices[0].writes).toEqual(["55aa82000000", "4753820000"]);

      h.devices[0].receive(validNotification12.subarray(8).toString("hex"));
      await flush();
      expect(h.devices[0].writes).toEqual(["55aa82000000", "4753820000", "55aa0a000710"]);
      expect(notifications).toEqual([0x03, 0x12]);

      h.devices[0].receive(validNetwork0b);
      expect(await starting).toBeUndefined();
    } finally {
      await h.transport.stop();
      await starting;
    }
  });

  it("fails closed when GET_NWK owns a malformed response before valid info", async () => {
    const h = harness({ profile: "android-v1.2.0", protocol: "crc16" });
    const starting = settled(h.transport.start());
    try {
      await flush();
      h.devices[0].receive("55aa030c000000000000000000000000b9ce");
      await flush();
      expect(h.devices[0].writes).toEqual([
        "55aa82000000",
        "4753820000",
        "55aa0a000710"
      ]);

      h.devices[0].receive("55aa0b00068155aa030c000000000000000000000000b9ce");
      expect(await starting).toMatchObject({ code: "MALFORMED_FRAME" });
      expect(h.transport.snapshot().ready).toBe(false);
    } finally {
      await h.transport.stop();
      await starting;
    }
  });

  it("bounds converter writes even when info arrives before a write completes", async () => {
    let finishWrite!: () => void;
    const h = harness({ profile: "android-v1.2.0", protocol: "crc16", configureDevice: (device) => {
      device.write = async (bytes) => {
        device.writes.push(Buffer.from(bytes).toString("hex"));
        await new Promise<void>((resolve) => { finishWrite = resolve; });
      };
    } });
    let outcome: unknown;
    void settled(h.transport.start()).then((value) => { outcome = value; }); await flush();
    h.devices[0].receive("55aa030c02050320682f0000000300001147");
    try {
      await vi.advanceTimersByTimeAsync(300);
      expect(outcome).toMatchObject({ code: "TIMEOUT" });
    } finally {
      await h.transport.stop();
      finishWrite(); await flush();
    }
    expect(h.devices[0].writes).toEqual(["55aa82000000"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["55aa83006080", "55aa0b0d0001000000000000010c000320c50e"])("does not let premature %s replace converter info", async (response) => {
    const h = harness({ profile: "android-v1.2.0", protocol: "crc16" });
    const start = settled(h.transport.start()); await flush();
    h.devices[0].receive(response);
    expect(await start).toMatchObject({ code: "LATE_RESPONSE" });
    expect(h.devices[0].writes).toEqual(["55aa82000000", "4753820000"]);
    await h.transport.stop();
  });

  it("bounds the power-on wait and requires a new generation's own info frame", async () => {
    const h = harness({ profile: "android-v1.2.0", protocol: "crc16" });
    const start = settled(h.transport.start()); await flush();
    expect(h.devices[0].writes).toEqual(["55aa82000000", "4753820000"]);
    await vi.advanceTimersByTimeAsync(300);
    expect(await start).toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.devices).toHaveLength(2);
    h.devices[0].receive("55aa030c02050320682f0000000300001147"); await flush();
    expect(h.devices[1].writes).toEqual(["55aa82000000", "4753820000"]);
    h.devices[1].receive("55aa030c02050320682f0000000300001147"); await flush();
    expect(h.devices[1].writes).toEqual(["55aa82000000", "4753820000", "55aa0a000710"]);
    await h.transport.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["stop", "disconnect", "invalid-crc"])("retires the power-on wait on %s without a late probe", async (cause) => {
    const h = harness({ profile: "android-v1.2.0", protocol: "crc16" });
    const start = settled(h.transport.start()); await flush();
    if (cause === "stop") await h.transport.stop();
    else if (cause === "disconnect") h.devices[0].emit("close");
    else h.devices[0].receive("55aa030c02050320682f0000000300001100");
    expect(await start).toMatchObject({ code: cause === "stop" ? "STOPPED" : cause === "disconnect" ? "DISCONNECTED" : "MALFORMED_FRAME" });
    h.devices[0].receive("55aa030c02050320682f0000000300001147"); await flush();
    expect(h.devices[0].writes).toEqual(["55aa82000000", "4753820000"]);
    expect(h.transport.snapshot().ready).toBe(false);
    await h.transport.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("routes unsolicited 03 and 12 separately without consuming an active or queued ACK", async () => {
    const h = harness({ profile: "android-v1.2.0", protocol: "crc16" });
    const notifications: number[] = [];
    h.transport.onNotification?.((frame) => notifications.push(frame.command));
    const start = settled(h.transport.start()); await flush();
    h.devices[0].receive("55aa030c02050320682f0000000300001147"); await flush();
    h.devices[0].receive("55aa0b0d0001000000000000010c000320c50e");
    await start;
    expect(h.transport.snapshot().ready).toBe(true);
    const first = h.transport.request({ command: 0x10, payload: hex("00000000000000804701feffff00008305") });
    const second = h.transport.request({ command: 0x10, payload: hex("00000000000000804801feffff000085") });
    void first.catch(() => {}); void second.catch(() => {}); await flush();
    h.devices[0].receive("55aa121cd3001122334455832e1234c00000000a0105050859320201000300006bcc");
    await flush();
    expect(notifications).toEqual([3, 18]);
    expect(h.devices[0].writes).toHaveLength(4);
    h.devices[0].receive("55aa1101002055"); await first; await flush();
    expect(h.devices[0].writes).toHaveLength(5);
    h.devices[0].receive("55aa1101002055"); await second;
    await h.transport.stop();
  });

  it("holds a queued request behind partial unsolicited bytes until their ownership is known", async () => {
    const h = harness({ profile: "android-v1.2.0", protocol: "crc16" });
    const start = settled(h.transport.start()); await flush();
    h.devices[0].receive("55aa030c02050320682f0000000300001147"); await flush();
    h.devices[0].receive("55aa0b0d0001000000000000010c000320c50e"); await start;
    const frame = "55aa121cd3001122334455832e1234c00000000a0105050859320201000300006bcc";
    h.devices[0].receive(frame.slice(0, 8));
    expect(h.transport.snapshot().ready).toBe(true);
    const request = h.transport.request({ command: 0x10, payload: hex("00000000000000804801feffff000085") });
    void request.catch(() => {}); await flush();
    expect(h.devices[0].writes).toHaveLength(3);
    h.devices[0].receive(frame.slice(8)); await flush();
    expect(h.devices[0].writes).toHaveLength(4);
    h.devices[0].receive("55aa1101002055"); await request;
    await h.transport.stop();
  });

  it("rejects unobserved GS/auto selection for the installed Android profile", () => {
    expect(() => harness({ profile: "android-v1.2.0", protocol: "gs" })).toThrow();
    expect(() => harness({ profile: "android-v1.2.0", protocol: "auto" })).toThrow();
  });

  it("does not let a notification callback's new request consume a coalesced stale ACK", async () => {
    const h = harness({ profile: "android-v1.2.0", protocol: "crc16" });
    const start = settled(h.transport.start()); await flush();
    h.devices[0].receive("55aa030c02050320682f0000000300001147"); await flush();
    h.devices[0].receive("55aa0b0d0001000000000000010c000320c50e"); await start;
    let requested: Promise<unknown> | undefined;
    h.transport.onNotification(() => {
      requested = settled(h.transport.request({ command: 0x10, payload: hex("00000000000000804801feffff000085") }));
    });
    h.devices[0].receive("55aa121cd3001122334455832e1234c00000000a0105050859320201000300006bcc55aa1101002055");
    await flush();
    expect(await requested).toMatchObject({ code: "LATE_RESPONSE" });
    expect(h.devices[0].writes).toEqual(["55aa82000000", "4753820000", "55aa0a000710"]);
    await h.transport.stop();
  });

  it("rejects a partial idle ACK before any queued request can own it", async () => {
    const h = harness({ profile: "android-v1.2.0", protocol: "crc16" });
    const start = settled(h.transport.start()); await flush();
    h.devices[0].receive("55aa030c02050320682f0000000300001147"); await flush();
    h.devices[0].receive("55aa0b0d0001000000000000010c000320c50e"); await start;
    h.devices[0].receive("55aa11");
    const request = settled(h.transport.request({ command: 0x10, payload: hex("00000000000000804801feffff000085") }));
    await flush();
    expect(h.devices[0].writes).toHaveLength(3);
    h.devices[0].receive("01002055");
    expect(await request).toMatchObject({ code: "LATE_RESPONSE" });
    expect(h.devices[0].writes).toHaveLength(3);
    await h.transport.stop();
  });

  it("bounds incomplete notification blocking and stop cancels its retry", async () => {
    const h = harness({ profile: "android-v1.2.0", protocol: "crc16" });
    const start = settled(h.transport.start()); await flush();
    h.devices[0].receive("55aa030c02050320682f0000000300001147"); await flush();
    h.devices[0].receive("55aa0b0d0001000000000000010c000320c50e"); await start;
    h.devices[0].receive("55aa121c");
    const request = settled(h.transport.request({ command: 0x10, payload: hex("00000000000000804801feffff000085") }));
    await vi.advanceTimersByTimeAsync(299);
    expect(h.transport.snapshot().ready).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await request).toMatchObject({ code: "TIMEOUT" });
    expect(h.devices[0].writes).toEqual(["55aa82000000", "4753820000", "55aa0a000710"]);
    await h.transport.stop();
    await vi.advanceTimersByTimeAsync(40000);
    expect(h.devices).toHaveLength(1);
  });

  it("sends each exact probe literal and requires checksummed command 83 readiness", async () => {
    for (const [protocol, probe, response] of [["crc16", "55aa82000000", "55aa83006080"], ["gs", "4753820000", "475383007c"]] as const) {
      const { transport, devices } = harness({ protocol });
      const starting = transport.start();
      void starting.catch(() => {});
      await flush();
      expect(devices).toHaveLength(1);
      expect(devices[0].writes).toEqual([probe]);
      expect(transport.snapshot()).toMatchObject({ state: "probing", transportConnected: true, protocolReady: false, ready: false });
      devices[0].receive(response.slice(0, 4));
      devices[0].receive(response.slice(4));
      await starting;
      expect(transport.snapshot()).toMatchObject({ state: "ready", protocol, protocolReady: true, ready: true });
      await transport.stop();
    }
  });

  it("blocks requests until mapping readiness completes and exposes state subscriptions", async () => {
    let release!: () => void;
    const { transport, devices } = harness({ validateReadiness: () => new Promise<void>((resolve) => { release = resolve; }) });
    const states: BioTransportSnapshot[] = [];
    const unsubscribe = transport.onState((state) => states.push(state));
    await expect(transport.request({ command: 0, payload: hex("") })).rejects.toMatchObject({ code: "NOT_READY" });
    const starting = transport.start(); await flush();
    devices[0].receive("475383007c"); await flush();
    expect(transport.snapshot()).toMatchObject({ state: "validating", protocolReady: true, ready: false });
    await expect(transport.request({ command: 0, payload: hex("") })).rejects.toMatchObject({ code: "NOT_READY" });
    release(); await starting;
    expect(states.map((state) => state.state)).toContain("ready");
    unsubscribe(); const count = states.length;
    await transport.stop(); expect(states).toHaveLength(count);
  });

  it("allows only one in-flight request and copies queued payload bytes", async () => {
    const value = harness(); await ready(value);
    const first = value.transport.request({ command: 0, payload: hex("") });
    const payload = hex("01");
    const second = value.transport.request({ command: 0, payload }); payload[0] = 99;
    await flush();
    expect(value.devices[0].writes).toEqual(["4753820000", "47530000ff"]);
    value.devices[0].receive("47530100fe"); await first; await flush();
    expect(value.devices[0].writes).toEqual(["4753820000", "47530000ff", "4753000101fd"]);
    value.devices[0].receive("4753010102fb");
    await expect(second).resolves.toMatchObject({ command: 1, payload: hex("02") });
    await value.transport.stop();
  });

  it.each(["timeout", "malformed", "disconnect", "write-error"])("retires %s generation and rejects queued writes without replay after reconnect", async (failure) => {
    const value = harness(); await ready(value);
    const oldDevice = value.devices[0];
    const oldGeneration = value.transport.snapshot().generation;
    const oldData = oldDevice.listeners("data")[0] as (bytes: Buffer) => void;
    if (failure === "write-error") oldDevice.writeError = new Error("lost write");
    const first = settled(value.transport.request({ command: 0, payload: hex("") }));
    const queued = settled(value.transport.request({ command: 0, payload: hex("01") }));
    await flush();
    if (failure === "timeout") {
      await vi.advanceTimersByTimeAsync(299);
      expect(value.transport.snapshot().ready).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
    } else if (failure === "malformed") oldDevice.receive("47530100ff");
    else if (failure === "disconnect") oldDevice.emit("close");
    const code = failure === "timeout" ? "TIMEOUT" : failure === "malformed" ? "MALFORMED_FRAME" : "DISCONNECTED";
    expect(await first).toMatchObject({ code }); expect(await queued).toMatchObject({ code });
    expect(value.transport.snapshot()).toMatchObject({ state: "reconnecting", ready: false, protocolReady: false });
    expect(value.transport.snapshot().generation).toBeGreaterThan(oldGeneration);
    await vi.advanceTimersByTimeAsync(1999); expect(value.devices).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); await flush();
    expect(value.devices[1].writes).toEqual(["4753820000"]);
    await expect(value.transport.request({ command: 0, payload: hex("") })).rejects.toMatchObject({ code: "NOT_READY" });
    // Simulate a callback already queued before listener removal on the old FD.
    oldData(hex("475383007c")); expect(value.transport.snapshot().ready).toBe(false);
    value.devices[1].receive("475383007c"); await flush();
    expect(value.transport.snapshot().ready).toBe(true);
    expect(value.devices[1].writes).toEqual(["4753820000"]);
    const fresh = value.transport.request({ command: 0, payload: hex("") });
    await flush(); oldData(hex("4753010102fb"));
    value.devices[1].receive("4753010103fa");
    await expect(fresh).resolves.toMatchObject({ payload: hex("03") });
    await value.transport.stop();
  });

  it("rejects wrong response command as late instead of resolving current request", async () => {
    const value = harness(); await ready(value);
    const pending = settled(value.transport.request({ command: 0, payload: hex("") }));
    value.devices[0].receive("475383007c");
    expect(await pending).toMatchObject({ code: "LATE_RESPONSE" });
    expect(value.transport.snapshot().ready).toBe(false);
    await value.transport.stop();
  });

  it("rejects duplicate coalesced responses before sending another queued command", async () => {
    const value = harness(); await ready(value);
    const first = value.transport.request({ command: 0, payload: hex("") });
    const queued = settled(value.transport.request({ command: 0, payload: hex("") }));
    value.devices[0].receive("47530100fe47530100fe");
    await first; expect(await queued).toMatchObject({ code: "LATE_RESPONSE" });
    expect(value.devices[0].writes).toEqual(["4753820000", "47530000ff"]);
    await value.transport.stop();
  });

  it.each([
    ["475301", "00fe"],
    ["47", "530100fe"],
    ["55", "aa01000020"]
  ])("retires a duplicate candidate beginning with %s before queued request ownership changes", async (prefix, tail) => {
    const value = harness(); await ready(value);
    const generation = value.transport.snapshot().generation;
    const first = value.transport.request({ command: 0, payload: hex("") });
    const second = settled(value.transport.request({ command: 0, payload: hex("") }));
    value.devices[0].receive(`47530100fe${prefix}`);
    await first; await flush();
    // This candidate began while the first request owned the response stream.
    expect(value.devices[0].writes).toEqual(["4753820000", "47530000ff"]);
    expect(await second).toMatchObject({ code: "LATE_RESPONSE" });
    expect(value.transport.snapshot()).toMatchObject({ state: "reconnecting", ready: false });
    expect(value.transport.snapshot().generation).toBeGreaterThan(generation);
    value.devices[0].receive(tail);
    await vi.advanceTimersByTimeAsync(2000);
    expect(value.devices[1].writes).toEqual(["4753820000"]);
    value.devices[1].receive("475383007c"); await flush();
    expect(value.devices[1].writes).toEqual(["4753820000"]);
    await value.transport.stop();
  });

  it("retires an unsolicited single header byte before a later request can claim it", async () => {
    const value = harness(); await ready(value);
    value.devices[0].receive("47");
    const pending = settled(value.transport.request({ command: 0, payload: hex("") }));
    await vi.advanceTimersByTimeAsync(300);
    expect(await pending).toMatchObject({ code: "NOT_READY" });
    expect(value.devices[0].writes).toEqual(["4753820000"]);
    await value.transport.stop();
  });

  it("tries the GS literal on a new generation after an automatic CRC probe timeout", async () => {
    const value = harness({ protocol: "auto" });
    const starting = settled(value.transport.start()); await flush();
    expect(value.devices).toHaveLength(1);
    expect(value.devices[0].writes).toEqual(["55aa82000000"]);
    await vi.advanceTimersByTimeAsync(300); expect(await starting).toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(value.devices[1].writes).toEqual(["4753820000"]);
    value.devices[1].receive("475383007c"); await flush();
    expect(value.transport.snapshot()).toMatchObject({ ready: true, protocol: "gs" });
    await value.transport.stop();
  });

  it("backs off repeated failed probes at 2/4/8/16/32/32 seconds", async () => {
    const value = harness(); const starting = settled(value.transport.start()); await flush();
    await vi.advanceTimersByTimeAsync(300); await starting;
    for (const [index, delay] of [2000, 4000, 8000, 16000, 32000, 32000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1); expect(value.devices).toHaveLength(index + 1);
      await vi.advanceTimersByTimeAsync(1); expect(value.devices).toHaveLength(index + 2);
      await vi.advanceTimersByTimeAsync(300);
    }
    await value.transport.stop(); await vi.advanceTimersByTimeAsync(64000);
    expect(value.devices).toHaveLength(7);
  });

  it("readiness rejection keeps control blocked", async () => {
    const value = harness({ validateReadiness: async () => { throw new Error("mapping invalid"); } });
    const starting = settled(value.transport.start()); await flush();
    expect(value.devices).toHaveLength(1); value.devices[0].receive("475383007c");
    expect(await starting).toMatchObject({ code: "READINESS" });
    await expect(value.transport.request({ command: 0, payload: hex("") })).rejects.toMatchObject({ code: "NOT_READY" });
    await value.transport.stop();
  });

  it("stop rejects active/queued work and ignores late readiness completion", async () => {
    const value = harness(); await ready(value);
    const active = settled(value.transport.request({ command: 0, payload: hex("") }));
    const queued = settled(value.transport.request({ command: 0, payload: hex("") }));
    await value.transport.stop();
    expect(await active).toMatchObject({ code: "STOPPED" }); expect(await queued).toMatchObject({ code: "STOPPED" });
    let release!: () => void;
    const other = harness({ validateReadiness: () => new Promise<void>((resolve) => { release = resolve; }) });
    const starting = settled(other.transport.start()); await flush(); other.devices[0].receive("475383007c"); await flush();
    await other.transport.stop(); release(); await flush();
    expect(await starting).toMatchObject({ code: "STOPPED" });
    expect(other.transport.snapshot()).toMatchObject({ state: "stopped", ready: false });
  });

  it.each([0, -1, NaN, Infinity, 0.5, 2147483648])("rejects invalid response timeout %s", (timeoutMs) => {
    expect(() => harness({ timeoutMs })).toThrow(RangeError);
  });

  it("uses the configured response timeout without retrying the timed-out write", async () => {
    const value = harness({ timeoutMs: 500 }); await ready(value);
    const pending = settled(value.transport.request({ command: 0, payload: hex("") }));
    await vi.advanceTimersByTimeAsync(499); expect(value.transport.snapshot().ready).toBe(true);
    await vi.advanceTimersByTimeAsync(1); expect(await pending).toMatchObject({ code: "TIMEOUT" });
    expect(value.devices[0].writes).toEqual(["4753820000", "47530000ff"]);
    await value.transport.stop();
  });

  it("does not report start success during the reconnect delay", async () => {
    const value = harness(); await ready(value); value.devices[0].emit("close");
    await expect(value.transport.start()).rejects.toMatchObject({ code: "NOT_READY" });
    await value.transport.stop();
  });

  it("rejects command ff because command + 1 cannot fit a response byte", async () => {
    const value = harness(); await ready(value);
    const pending = settled(value.transport.request({ command: 255, payload: hex("") }));
    await vi.advanceTimersByTimeAsync(300);
    expect(await pending).toBeInstanceOf(RangeError);
    expect(value.devices[0].writes).toEqual(["4753820000"]);
    await value.transport.stop();
  });

  it("waits for the retired connection to close before opening a replacement", async () => {
    const value = harness(); await ready(value);
    const device = value.devices[0];
    let close!: () => void;
    device.close = () => new Promise<void>((resolve) => {
      close = () => { device.isOpen = false; resolve(); };
    });
    device.emit("error", new Error("disconnected"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(value.devices).toHaveLength(1);
    close(); await flush();
    expect(value.devices).toHaveLength(2);
    expect(value.devices[1].writes).toEqual(["4753820000"]);
    await value.transport.stop();
  });

  it("preserves failed connection closure and blocks replacement probes and false stop success", async () => {
    const value = harness(); await ready(value);
    const device = value.devices[0];
    device.close = async () => { throw new Error("connection still open"); };
    const active = settled(value.transport.request({ command: 0, payload: hex("") }));
    const queued = settled(value.transport.request({ command: 0, payload: hex("01") }));
    device.emit("error", new Error("connection fault"));
    await flush();
    expect(await active).toMatchObject({ code: "DISCONNECTED" });
    expect(await queued).toMatchObject({ code: "DISCONNECTED" });
    expect(device.isOpen).toBe(true);
    expect(value.transport.snapshot()).toMatchObject({ state: "close-failed", lastError: "CLOSE_FAILED", ready: false });
    await vi.advanceTimersByTimeAsync(64000);
    expect(value.devices).toHaveLength(1);
    expect(device.writes).toEqual(["4753820000", "47530000ff"]);
    await expect(value.transport.stop()).rejects.toMatchObject({ code: "CLOSE_FAILED" });
    await expect(value.transport.start()).rejects.toMatchObject({ code: "CLOSE_FAILED" });
    await flush();
    expect(value.devices).toHaveLength(1);
    await expect(value.transport.stop()).rejects.toMatchObject({ code: "CLOSE_FAILED" });
  });

  it("reports a direct stop close error without publishing a stopped state", async () => {
    const value = harness(); await ready(value);
    value.devices[0].close = async () => { throw new Error("close failed"); };
    const states: string[] = [];
    value.transport.onState((state) => states.push(state.state));
    await expect(value.transport.stop()).rejects.toMatchObject({ code: "CLOSE_FAILED" });
    expect(states).not.toContain("stopped");
    expect(value.transport.snapshot()).toMatchObject({ state: "close-failed", ready: false });
    expect(value.devices[0].isOpen).toBe(true);
  });

  it("rejects a reconnect attempt already waiting when delayed closure fails", async () => {
    const value = harness(); await ready(value);
    let failClose!: () => void;
    value.devices[0].close = () => new Promise<void>((_resolve, reject) => {
      failClose = () => reject(new Error("late close failure"));
    });
    value.devices[0].emit("error", new Error("fault"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(value.devices).toHaveLength(1);
    let outcome: unknown;
    void settled(value.transport.start()).then((result) => { outcome = result; });
    failClose(); await flush();
    expect(outcome).toMatchObject({ code: "CLOSE_FAILED" });
    expect(value.transport.snapshot()).toMatchObject({ state: "close-failed", ready: false });
    await vi.advanceTimersByTimeAsync(64000);
    expect(value.devices).toHaveLength(1);
    await expect(value.transport.stop()).rejects.toMatchObject({ code: "CLOSE_FAILED" });
  });

  it("does not advance queued writes while a prior response arrived before write completion", async () => {
    const value = harness(); await ready(value);
    const device = value.devices[0];
    const writeCompletions: (() => void)[] = [];
    device.write = async (bytes) => {
      device.writes.push(Buffer.from(bytes).toString("hex"));
      await new Promise<void>((resolve) => { writeCompletions.push(resolve); });
    };
    const first = value.transport.request({ command: 0, payload: hex("") });
    const second = settled(value.transport.request({ command: 0, payload: hex("01") }));
    await flush(); device.receive("47530100fe"); await first; await flush();
    expect(device.writes).toEqual(["4753820000", "47530000ff"]);
    writeCompletions.shift()!(); await flush();
    expect(device.writes).toEqual(["4753820000", "47530000ff", "4753000101fd"]);
    await value.transport.stop(); expect(await second).toMatchObject({ code: "STOPPED" });
    writeCompletions.shift()!(); await flush(); expect(value.transport.snapshot().ready).toBe(false);
  });
});
