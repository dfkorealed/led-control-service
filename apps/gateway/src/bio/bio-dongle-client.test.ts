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
function harness(initialSequence = 75) {
  const device = new Device();
  const client = new BioDongleClient({
    initialSequence,
    connectionFactory: () => device
  });
  return { client, device };
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
    { name: "unicast raw 157", invoke: (client: BioDongleClient) => client.setBrightness(target, { rawHighBrightness: 157 }) },
    { name: "broadcast uncaptured raw 128", invoke: (client: BioDongleClient) => client.setBrightness({ kind: "broadcast", networkId: 0 }, { rawHighBrightness: 128 }) },
    { name: "unicast uncaptured raw 128", invoke: (client: BioDongleClient) => client.setBrightness(target, { rawHighBrightness: 128 }) }
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

  it("delivers discovery before the scan ACK and never uses discovery as that ACK", async () => {
    const h = harness(71); await ready(h);
    const events: BioClientEvent[] = [];
    h.client.onEvent((event) => events.push(event));
    const result = h.client.scan(); let settled = false; void result.then(() => { settled = true; });
    await flush();
    expect(h.device.writes[3].toString("hex")).toBe("55aa101100000000000000804701feffff00008305daee");
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
    expect(h.device.writes[3].toString("hex")).toBe("55aa101200000000000000804d01fe12340000cc120358ac");
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
