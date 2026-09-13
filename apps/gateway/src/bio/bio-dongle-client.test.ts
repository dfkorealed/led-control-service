import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BioDongleClient, type BioClientEvent } from "./bio-dongle-client";
import { LinuxUsbIdentityInspector } from "./linux-usb-identity-inspector";
import { NodeSerialConnection, type SerialPortDevice } from "./node-serial-connection";
import { encodeCrcFrame } from "./bio-frame-codec";

const target = { kind: "unicast", logicalAddress: 0x1234, networkId: 0 } as const;
const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
class Device extends EventEmitter implements SerialPortDevice {
  isOpen = false;
  writes: Buffer[] = [];
  open(done: (error?: Error | null) => void) { this.isOpen = true; done(); }
  flush(done: (error?: Error | null) => void) { done(); }
  write(bytes: Buffer, done: (error?: Error | null) => void) { this.writes.push(Buffer.from(bytes)); done(); }
  drain(done: (error?: Error | null) => void) { done(); }
  close(done: (error?: Error | null) => void) { this.isOpen = false; done(); }
  receive(hex: string) { this.emit("data", Buffer.from(hex, "hex")); }
}
function harness(initialSequence = 75) {
  const device = new Device();
  const client = new BioDongleClient({
    initialSequence,
    inspector: new LinuxUsbIdentityInspector({
      stat: async () => ({ rdev: 48128, isCharacterDevice: () => true }),
      realpath: async () => "/sys/devices/usb1/1-1", readdir: async () => ["1-1"],
      readFile: async (path) => path.endsWith("idVendor") ? "1a86" : "5523"
    }),
    connectionFactory: (path) => new NodeSerialConnection(path, () => device)
  });
  return { client, device };
}
async function ready(h: ReturnType<typeof harness>) {
  const probe = h.client.probe(); void probe.catch(() => {}); await flush();
  h.device.receive("55aa0b0d0001000000000000010c000320c50e");
  return probe;
}

describe("BIO evidence-gated dongle client", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens using the observed read-only network query and returns no network secret", async () => {
    const h = harness();
    expect(await ready(h)).toEqual({ kind: "probe", protocol: "crc16", responseCommand: 11, payloadBytes: 13 });
    expect(h.device.writes.map((b) => b.toString("hex"))).toEqual(["55aa0a000710"]);
    await h.client.close();
    expect(h.device.isOpen).toBe(false);
  });

  it("returns only dongle acceptance for the observed unicast raw high-brightness setting", async () => {
    const h = harness(); await ready(h);
    const result = h.client.setBrightness(target, { rawHighBrightness: 254 }); await flush();
    expect(h.device.writes[1].toString("hex")).toBe("55aa101200000000000000804b01fe12340000cd13fe2962");
    h.device.receive("55aa1101002055");
    expect(await result).toEqual({ outcome: "dongle-accepted", deviceApplied: false });
    await h.client.close();
  });

  it("delivers discovery before the scan ACK and never uses discovery as that ACK", async () => {
    const h = harness(71); await ready(h);
    const events: BioClientEvent[] = [];
    h.client.onEvent((event) => events.push(event));
    const result = h.client.scan(); let settled = false; void result.then(() => { settled = true; });
    await flush();
    expect(h.device.writes[1].toString("hex")).toBe("55aa101100000000000000804701feffff00008305daee");
    h.device.receive("55aa121cd3001122334455832e1234c00000000a0105050859320201000300006bcc"); await flush();
    expect(events).toMatchObject([{ kind: "discovery", deviceUuid: "bio:001122334455", logicalAddress: 0x1234 }]);
    expect(settled).toBe(false);
    h.device.receive("55aa1101002055"); await result;
    await h.client.close();
  });

  it("keeps a device mode observation separate from the transport ACK", async () => {
    const h = harness(77); await ready(h);
    const events: BioClientEvent[] = [];
    const unsubscribe = h.client.onEvent((event) => events.push(event));
    const result = h.client.setControlMode(target, "force-on"); await flush();
    expect(h.device.writes[1].toString("hex")).toBe("55aa101200000000000000804d01fe12340000cc120358ac");
    h.device.receive("55aa1212da0011223344558377123401fe00004f1203e39455aa1101002055");
    expect(await result).toEqual({ outcome: "dongle-accepted", deviceApplied: false });
    expect(events).toMatchObject([{ kind: "control-mode-report", mode: "force-on", sequence: 119 }]);
    unsubscribe();
    h.device.receive("55aa1212d70011223344558378123401fe00004f1200010a");
    expect(events).toHaveLength(1);
    await h.client.close();
  });

  it("rejects unobserved identify, address and explicit read operations without a serial write", async () => {
    const h = harness(); await ready(h);
    for (const operation of [
      () => h.client.startIdentify("bio:001122334455"), () => h.client.stopIdentify("bio:001122334455"),
      () => h.client.assignAddress("bio:001122334455", 1), () => h.client.readBrightness(target), () => h.client.readDeviceInfo(target)
    ]) await expect(operation()).rejects.toMatchObject({ code: "BIO_EVIDENCE_UNAVAILABLE" });
    expect(h.device.writes).toHaveLength(1);
    await h.client.close();
  });

  it("serializes requests, advances the byte sequence and sends stop only once per call", async () => {
    const h = harness(255); await ready(h);
    const first = h.client.stopScan(); const second = h.client.stopScan(); await flush();
    expect(h.device.writes).toHaveLength(2);
    expect(h.device.writes[1][12]).toBe(255);
    h.device.receive("55aa1101002055"); await first; await flush();
    expect(h.device.writes).toHaveLength(3);
    expect(h.device.writes[2][12]).toBe(0);
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
