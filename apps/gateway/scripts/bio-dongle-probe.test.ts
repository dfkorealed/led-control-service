import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BioUsbDescriptor, BioUsbDeviceHandle, BioUsbDriver } from "../src/bio/node-usb-driver";
import { runBioDongleProbe } from "./bio-dongle-probe";

const descriptor: BioUsbDescriptor = {
  idVendor: 0x1a86,
  idProduct: 0x5523,
  busNumber: 1,
  deviceAddress: 4,
  interfaceNumber: 0,
  bulkOutAddress: 0x02,
  bulkInAddress: 0x82,
  maxPacketSize: 32
};

class ProbeHandle extends EventEmitter implements BioUsbDeviceHandle {
  readonly calls: Array<[string, ...unknown[]]> = [];
  readonly writes: string[] = [];
  private input?: (bytes: Buffer) => void;

  descriptor(): BioUsbDescriptor {
    this.calls.push(["descriptor"]);
    return { ...descriptor };
  }
  open(): void { this.calls.push(["open"]); }
  detachKernelDriver(): boolean { this.calls.push(["detachKernelDriver"]); return true; }
  claim(): void { this.calls.push(["claim"]); }
  async controlOut(request: number, value: number, index: number): Promise<void> {
    this.calls.push(["controlOut", request, value, index]);
  }
  async controlIn(request: number, value: number, index: number, length: number): Promise<Buffer> {
    this.calls.push(["controlIn", request, value, index, length]);
    return Buffer.alloc(length);
  }
  async transferOut(bytes: Uint8Array): Promise<void> {
    const hex = Buffer.from(bytes).toString("hex");
    this.calls.push(["transferOut", hex]);
    this.writes.push(hex);
    if (hex === "4753820000") {
      queueMicrotask(() => this.input?.(Buffer.from("55aa030c02050320682f0000000300001147", "hex")));
    }
    if (hex === "55aa0a000710") {
      queueMicrotask(() => this.input?.(Buffer.from("55aa0b0d0001000000000000010c000320c50e", "hex")));
    }
  }
  startInput(listener: (bytes: Buffer) => void): void { this.calls.push(["startInput"]); this.input = listener; }
  async stopInput(): Promise<void> { this.calls.push(["stopInput"]); }
  async release(): Promise<void> { this.calls.push(["release"]); }
  reattachKernelDriver(): void { this.calls.push(["reattachKernelDriver"]); }
  close(): void { this.calls.push(["close"]); }
}

class ProbeDriver implements BioUsbDriver {
  finds = 0;
  constructor(readonly handle: ProbeHandle) {}
  findExactDevice(): BioUsbDeviceHandle { this.finds += 1; return this.handle; }
}

function harness() {
  const handle = new ProbeHandle();
  const driver = new ProbeDriver(handle);
  const output: string[] = [];
  return {
    handle,
    driver,
    output,
    dependencies: {
      driverFactory: () => driver,
      output: (line: string) => output.push(line),
      now: (() => {
        const values = [100, 137];
        return () => values.shift() ?? 137;
      })()
    }
  };
}

describe("read-only BIO direct USB probe CLI", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("uses direct USB for only converter startup and GET_NWK, then emits redacted metadata", async () => {
    const h = harness();

    expect(await runBioDongleProbe([], h.dependencies)).toBe(0);

    expect(h.driver.finds).toBe(1);
    expect(h.handle.calls.slice(0, 13)).toEqual([
      ["descriptor"],
      ["open"],
      ["detachKernelDriver"],
      ["claim"],
      ["controlOut", 0xa1, 0x0000, 0x0000],
      ["controlIn", 0x5f, 0x0000, 0x0000, 2],
      ["controlOut", 0x9a, 0x1312, 0xd982],
      ["controlOut", 0x9a, 0x0f2c, 0x0004],
      ["controlIn", 0x95, 0x2518, 0x0000, 2],
      ["controlOut", 0x9a, 0x2727, 0x0000],
      ["controlOut", 0xa4, 0x00ff, 0x0000],
      ["controlOut", 0xa1, 0xc39c, 0xcc8b],
      ["descriptor"]
    ]);
    expect(h.handle.writes).toEqual(["55aa82000000", "4753820000", "55aa0a000710"]);
    expect(h.handle.calls.slice(-4)).toEqual([
      ["stopInput"], ["release"], ["reattachKernelDriver"], ["close"]
    ]);
    expect(JSON.parse(h.output[0])).toEqual({
      adapterKind: "bio-usb",
      descriptor: "1a86:5523/interface0/out02/in82/packet32",
      converterInfo: { protocol: "crc16", command: "0x03", payloadBytes: 12 },
      networkProbe: { protocol: "crc16", command: "0x0b", payloadBytes: 13 },
      elapsedMs: 37
    });
    expect(h.output[0]).not.toMatch(/001122334455|password|raw|payload\s*"/i);
  });

  it.each([
    ["scan"], ["--command", "0x10"], ["--payload", "00"], ["--raw"],
    ["--device", "/dev/bus/usb/001/004"], ["--protocol", "gs"], ["--profile", "legacy"],
    ["--timeout-ms"], ["--timeout-ms", "0"], ["--timeout-ms", "10001"],
    ["--timeout-ms", "1.5"], ["--timeout-ms", "100", "--timeout-ms", "200"]
  ])("rejects unsupported arguments %j before selecting USB", async (...args) => {
    const h = harness();

    expect(await runBioDongleProbe(args, h.dependencies)).toBe(2);

    expect(h.driver.finds).toBe(0);
    expect(h.handle.writes).toEqual([]);
    expect(JSON.parse(h.output[0])).toEqual({ error: "INVALID_ARGUMENTS", elapsedMs: 37 });
  });

  it("does not expose raw or lamp-state command hooks in the CLI source", () => {
    const source = readFileSync(new URL("./bio-dongle-probe.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/setBrightness|setControlMode|assignAddress/);
    expect(source).not.toMatch(/--command|--payload|--raw|0x10/);
  });

  it("redacts native failures and still closes a partially acquired direct device", async () => {
    const h = harness();
    h.handle.transferOut = async () => { throw new Error("uuid=001122334455 password=secret raw=deadbeef"); };

    expect(await runBioDongleProbe([], h.dependencies)).toBe(1);

    expect(JSON.parse(h.output[0])).toEqual({ error: "DISCONNECTED", elapsedMs: 37 });
    expect(h.output[0]).not.toMatch(/001122334455|password|secret|deadbeef|raw/i);
    expect(h.handle.calls.slice(-4)).toEqual([
      ["stopInput"], ["release"], ["reattachKernelDriver"], ["close"]
    ]);
  });
});
