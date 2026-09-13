import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BioFrameCodec, encodeCrcFrame, type BioFrame } from "./bio-frame-codec";
import { decodeBioResponse, encodeBioCommand, type BioOperation } from "./bio-command-codec";

const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/bio-protocol-v1.json", import.meta.url), "utf8")) as {
  source: { sha256: string };
  requests: { name: string; operation: BioOperation; sequence: number; hex: string; sourceSha256: string }[];
  responses: { name: string; hex: string; sourceSha256: string }[];
};
function response(name: string): BioFrame {
  const vector = fixture.responses.find((item) => item.name === name)!;
  const event = new BioFrameCodec().push(Buffer.from(vector.hex, "hex"))[0];
  if (event.type !== "frame") throw new Error("Invalid normalized golden response");
  return event.frame;
}

describe("BIO installed 1.2.0 traced command codec", () => {
  it.each(fixture.requests)("encodes $name byte for byte", ({ operation, sequence, hex, sourceSha256 }) => {
    expect(sourceSha256).toBe(fixture.source.sha256);
    const request = encodeBioCommand(operation, sequence);
    expect(encodeCrcFrame(request.command, request.payload).toString("hex")).toBe(hex);
  });

  it("does not expose the network-read payload or interpret the probe as device info", () => {
    expect(decodeBioResponse(response("probe-network-response"))).toEqual({ kind: "probe", protocol: "crc16", responseCommand: 0x0b, payloadBytes: 13 });
  });

  it("distinguishes outer acceptance from physical application", () => {
    expect(decodeBioResponse(response("outer-ack"))).toEqual({ kind: "outer-ack", accepted: true, status: 0, deviceApplied: false });
    expect(decodeBioResponse({ protocol: "crc16", command: 0x11, payload: Buffer.from([1]) })).toEqual({ kind: "outer-ack", accepted: false, status: 1, deviceApplied: false });
  });

  it("parses the normalized discovery identity, signed RSSI, header and firmware", () => {
    expect(decodeBioResponse(response("lamp-notification-seq-46"))).toEqual({
      kind: "discovery", deviceUuid: "bio:001122334455", logicalAddress: 0x1234, networkId: 0,
      destination: 0xc000, rssiDbm: -45, sequence: 46, ttl: 3, control: true,
      deviceType: 1, firmware: { major: 5, minor: 5, revision: 8, build: 12889 },
      sensorType: 2, infraredType: 1, ambientLightType: 0, hardwareType: 3
    });
  });

  it.each([[119, "force-on"], [120, "sensor"], [148, "force-off"], [149, "sensor"]] as const)("parses mode report sequence %i without calling it brightness read-back", (sequence, mode) => {
    expect(decodeBioResponse(response(`lamp-notification-seq-${sequence}`))).toMatchObject({
      kind: "control-mode-report", deviceUuid: "bio:001122334455", logicalAddress: 0x1234,
      networkId: 0, destination: 0x01fe, sequence, mode
    });
  });

  it.each([6, 11, 12, 27, 35])("keeps unsolicited sensor/alive sequence %i opaque", (sequence) => {
    const parsed = decodeBioResponse(response(`lamp-notification-seq-${sequence}`));
    expect(parsed).toMatchObject({ kind: "unsupported-notification", outerCommand: 0x12 });
    expect(parsed).not.toHaveProperty("brightness");
    expect(parsed).not.toHaveProperty("payload");
  });

  it("classifies unsolicited dongle info without treating it as a matching request ACK", () => {
    expect(decodeBioResponse(response("unsolicited-dongle-info"))).toEqual({ kind: "unsupported-notification", outerCommand: 3, payloadBytes: 12 });
  });

  it.each([
    { kind: "identify" }, { kind: "assignAddress" }, { kind: "readBrightness" },
    { kind: "setHighBrightness", target: { kind: "unicast", networkId: 0, logicalAddress: 0xffff }, rawHighBrightness: 255 },
    { kind: "setHighBrightness", target: { kind: "unicast", networkId: 0, logicalAddress: 0 }, rawHighBrightness: 255 },
    { kind: "setHighBrightness", target: { kind: "broadcast", networkId: -1 }, rawHighBrightness: 255 },
    { kind: "setHighBrightness", target: { kind: "broadcast", networkId: 0 }, rawHighBrightness: 256 },
    { kind: "setHighBrightness", target: { kind: "broadcast", networkId: 0 }, rawHighBrightness: -1 },
    { kind: "setHighBrightness", target: { kind: "broadcast", networkId: 0 }, rawHighBrightness: 99.5 },
    { kind: "setHighBrightness", target: { kind: "group", networkId: 0 }, rawHighBrightness: 255 },
    { kind: "setControlMode", target: { kind: "broadcast", networkId: 0 }, mode: "unobserved-mode" }
  ])("rejects untraced operations and invalid addresses/values: %j", (operation) => {
    expect(() => encodeBioCommand(operation as BioOperation, 1)).toThrow();
  });

  it.each([-1, 256, 1.5, NaN])("rejects invalid sequence %s instead of silently wrapping caller data", (sequence) => {
    expect(() => encodeBioCommand({ kind: "scan" }, sequence)).toThrow();
  });

  it.each([
    { command: 0x83, payload: Buffer.alloc(0) },
    { command: 0x0b, payload: Buffer.alloc(12) },
    { command: 0x11, payload: Buffer.alloc(0) },
    { command: 0x12, payload: Buffer.alloc(15) }
  ])("rejects wrong or truncated response $command", (frame) => {
    expect(() => decodeBioResponse({ protocol: "crc16", ...frame })).toThrow();
  });

  it("rejects GS as unobserved by this installed-app profile", () => {
    expect(() => decodeBioResponse({ protocol: "gs", command: 0x11, payload: Buffer.from([0]) })).toThrow();
  });
});
