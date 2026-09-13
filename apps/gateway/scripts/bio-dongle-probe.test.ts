import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinuxUsbIdentityInspector } from "../src/bio/linux-usb-identity-inspector";
import { NodeSerialConnection, type SerialPortDevice } from "../src/bio/node-serial-connection";
import { runBioDongleProbe } from "./bio-dongle-probe";

class Device extends EventEmitter implements SerialPortDevice {
  isOpen = false;
  writes: string[] = [];
  closeError?: Error;
  open(callback: (error?: Error | null) => void) { this.isOpen = true; callback(); }
  write(bytes: Buffer, callback: (error?: Error | null) => void) { this.writes.push(bytes.toString("hex")); callback(); return true; }
  drain(callback: (error?: Error | null) => void) { callback(); }
  flush(callback: (error?: Error | null) => void) { callback(); }
  close(callback: (error?: Error | null) => void) { this.isOpen = false; callback(this.closeError); }
}

function harness(vendorId = "1a86") {
  const device = new Device();
  const output: string[] = [];
  const paths: string[] = [];
  const dependencies = {
    output: (line: string) => output.push(line),
    inspector: new LinuxUsbIdentityInspector({
      stat: async () => ({ rdev: 48128, isCharacterDevice: () => true }),
      realpath: async () => "/sys/devices/usb1/1-1",
      readdir: async () => ["1-1"],
      readFile: async (path: string) => path.endsWith("idVendor") ? vendorId : "5523"
    }),
    connectionFactory: (path: string) => { paths.push(path); return new NodeSerialConnection(path, () => device); }
  };
  return { device, output, paths, dependencies };
}
const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };

describe("read-only BIO probe CLI", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.each([
    ["crc16", "55aa82000000", "55aa83006080"],
    ["gs", "4753820000", "475383007c"]
  ])("sends only the exact %s probe and closes after validated 83", async (protocol, request, response) => {
    const h = harness();
    const result = runBioDongleProbe(["--profile", "legacy", "--device", "/dev/bio-dongle", "--protocol", protocol], h.dependencies);
    await flush();
    expect(h.device.writes).toEqual([request]);
    h.device.emit("data", Buffer.from(response, "hex"));
    expect(await result).toBe(0);
    expect(h.paths).toEqual(["/dev/bio-dongle"]);
    expect(h.device.isOpen).toBe(false);
    expect(JSON.parse(h.output[0])).toEqual({ ok: true, operation: "probe", protocol, responseCommand: "0x83", payloadBytes: 0, payload: "[REDACTED]" });
    await vi.advanceTimersByTimeAsync(40000);
    expect(h.device.writes).toEqual([request]);
  });

  it("redacts actual response bytes, including ASCII identifiers", async () => {
    const h = harness();
    const result = runBioDongleProbe(["--profile", "legacy", "--protocol", "gs"], h.dependencies);
    await flush();
    // Synthetic parser fixture, not a hardware command vector: 83+06+'secret' = 030F, folded complement ED.
    h.device.emit("data", Buffer.from("47538306736563726574ed", "hex"));
    expect(await result).toBe(0);
    expect(h.output.join("\n")).not.toMatch(/secret|736563726574/);
    expect(JSON.parse(h.output[0])).toMatchObject({ payloadBytes: 6, payload: "[REDACTED]" });
    expect(h.paths).toEqual(["/dev/serial/by-id/usb-1a86_CH57x-if00-port0"]);
  });

  it.each([
    ["scan"], ["--command", "0x82"], ["--payload", "00"], ["--raw"],
    ["--protocol", "auto"], ["--protocol", "gs", "--protocol", "crc16"],
    ["--device", "/dev/ttyUSB0"], ["--device"], ["--timeout-ms", "0"],
    ["--timeout-ms", "10001"], ["--timeout-ms", "1.5"], ["--timeout-ms", "1e3"],
    ["--protocol", "gs"], ["--profile", "unknown"]
  ])("rejects unsupported arguments %j before opening hardware", async (...args) => {
    const h = harness();
    expect(await runBioDongleProbe(args, h.dependencies)).toBe(2);
    expect(h.paths).toEqual([]);
    expect(h.device.writes).toEqual([]);
    expect(JSON.parse(h.output[0])).toMatchObject({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it.each([
    ["4753830000", "MALFORMED_FRAME"],
    ["475385007a", "LATE_RESPONSE"],
    ["55aa83006080", "LATE_RESPONSE"]
  ])("rejects invalid/wrong response %s", async (response, error) => {
    const h = harness();
    const result = runBioDongleProbe(["--profile", "legacy", "--protocol", "gs"], h.dependencies);
    await flush();
    h.device.emit("data", Buffer.from(response, "hex"));
    expect(await result).toBe(1);
    expect(JSON.parse(h.output[0])).toMatchObject({ ok: false, error });
    expect(h.device.isOpen).toBe(false);
    await vi.advanceTimersByTimeAsync(40000);
    expect(h.device.writes).toEqual(["4753820000"]);
  });

  it("stops at the chosen timeout without fallback or reconnect probes", async () => {
    const h = harness();
    const result = runBioDongleProbe(["--timeout-ms", "500"], h.dependencies);
    await flush();
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toBe(1);
    expect(JSON.parse(h.output[0])).toMatchObject({ ok: false, error: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(40000);
    expect(h.device.writes).toEqual(["55aa0a000710"]);
    expect(h.device.isOpen).toBe(false);
  });

  it("fails USB identity preflight without writing", async () => {
    const h = harness("ffff");
    expect(await runBioDongleProbe([], h.dependencies)).toBe(1);
    expect(h.device.writes).toEqual([]);
    expect(JSON.parse(h.output[0])).toMatchObject({ ok: false, error: "USB_IDENTITY" });
  });

  it("does not report success or disclose native errors when close fails", async () => {
    const h = harness();
    h.device.closeError = new Error("secret=736563726574");
    const result = runBioDongleProbe([], h.dependencies);
    await flush();
    h.device.emit("data", Buffer.from("55aa0b0d0001000000000000010c000320c50e", "hex"));
    expect(await result).toBe(1);
    expect(h.output).toHaveLength(1);
    expect(JSON.parse(h.output[0])).toMatchObject({ ok: false, error: "CLOSE_FAILED" });
    expect(h.output[0]).not.toMatch(/secret|736563726574/);
  });

  it("defaults to the observed network query and tolerates separate discovery/info notifications", async () => {
    const h = harness();
    const result = runBioDongleProbe([], h.dependencies); await flush();
    expect(h.device.writes).toEqual(["55aa0a000710"]);
    h.device.emit("data", Buffer.from("55aa030c02050320682f0000000300001147", "hex"));
    h.device.emit("data", Buffer.from("55aa121cd3001122334455832e1234c00000000a0105050859320201000300006bcc", "hex"));
    h.device.emit("data", Buffer.from("55aa0b0d0001000000000000010c000320c50e", "hex"));
    expect(await result).toBe(0);
    expect(JSON.parse(h.output[0])).toEqual({ ok: true, operation: "probe", protocol: "crc16", responseCommand: "0x0b", payloadBytes: 13, payload: "[REDACTED]" });
    expect(h.output.join("\n")).not.toContain("001122334455");
    expect(h.device.isOpen).toBe(false);
  });
});
