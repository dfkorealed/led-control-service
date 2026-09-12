import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BioSerialTransport, type BioTransportSnapshot } from "./bio-serial-transport";
import { LinuxUsbIdentityInspector, type UsbIdentityFs } from "./linux-usb-identity-inspector";
import { NodeSerialConnection, type SerialPortDevice } from "./node-serial-connection";

const hex = (value: string) => Buffer.from(value, "hex");
const flush = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
const settled = <T>(promise: Promise<T>) => promise.then((value) => value, (error: unknown) => error);

class Device extends EventEmitter implements SerialPortDevice {
  isOpen = false;
  writes: string[] = [];
  writeError?: Error;
  open(callback: (error?: Error | null) => void) { this.isOpen = true; callback(); }
  write(bytes: Buffer, callback: (error?: Error | null) => void) { this.writes.push(bytes.toString("hex")); callback(this.writeError); return true; }
  drain(callback: (error?: Error | null) => void) { callback(); }
  flush(callback: (error?: Error | null) => void) { callback(); }
  close(callback: (error?: Error | null) => void) { this.isOpen = false; this.emit("close"); callback(); }
  receive(value: string) { this.emit("data", hex(value)); }
}

function harness(options: { protocol?: "crc16" | "gs" | "auto"; validateReadiness?: () => Promise<void>; vendor?: string; timeoutMs?: number } = {}) {
  const devices: Device[] = [];
  const fs: UsbIdentityFs = {
    stat: async () => ({ rdev: 48128, isCharacterDevice: () => true }),
    realpath: async () => "/sys/devices/usb1/1-1",
    readdir: async () => ["1-1"],
    readFile: async (path) => path.endsWith("idVendor") ? options.vendor ?? "1a86" : "5523"
  };
  const transport = new BioSerialTransport({
    devicePath: "/dev/bio-dongle", protocol: options.protocol ?? "gs", timeoutMs: options.timeoutMs,
    inspector: new LinuxUsbIdentityInspector(fs),
    connectionFactory: (path) => {
      const device = new Device(); devices.push(device);
      return new NodeSerialConnection(path, () => device);
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

describe("BioSerialTransport", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

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

  it("fails USB validation before opening any port", async () => {
    const value = harness({ vendor: "ffff" });
    await expect(value.transport.start()).rejects.toMatchObject({ code: "USB_IDENTITY" });
    expect(value.devices).toHaveLength(0); await value.transport.stop();
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

  it("waits for the retired file descriptor to close before opening a replacement", async () => {
    const value = harness(); await ready(value);
    const device = value.devices[0];
    let close!: () => void;
    device.close = (callback) => { close = () => { device.isOpen = false; callback(); }; };
    device.emit("error", new Error("disconnected"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(value.devices).toHaveLength(1);
    close(); await flush();
    expect(value.devices).toHaveLength(2);
    expect(value.devices[1].writes).toEqual(["4753820000"]);
    await value.transport.stop();
  });

  it("does not advance queued writes while a prior response arrived before serial drain", async () => {
    const value = harness(); await ready(value);
    const device = value.devices[0];
    const drains: (() => void)[] = [];
    device.drain = (callback) => { drains.push(() => callback()); };
    const first = value.transport.request({ command: 0, payload: hex("") });
    const second = settled(value.transport.request({ command: 0, payload: hex("01") }));
    await flush(); device.receive("47530100fe"); await first; await flush();
    expect(device.writes).toEqual(["4753820000", "47530000ff"]);
    drains.shift()!(); await flush();
    expect(device.writes).toEqual(["4753820000", "47530000ff", "4753000101fd"]);
    await value.transport.stop(); expect(await second).toMatchObject({ code: "STOPPED" });
    drains.shift()!(); await flush(); expect(value.transport.snapshot().ready).toBe(false);
  });
});
