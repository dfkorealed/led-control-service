import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BioFrameCodec, encodeCrcFrame, type BioFrame } from "./bio-frame-codec";
import { decodeBioReadback, decodeBioResponse, encodeBioCommand, type BioOperation } from "./bio-command-codec";

const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/bio-protocol-v1.json", import.meta.url), "utf8")) as {
  source: { sha256: string; apkSha256: string };
  staticEvidence: {
    installedApkSha256: string;
    addressAssignment: { method: string; baseOpcode: number; noDebugOpcode: number; dpid: number; uuidBytes: number; addressByteOrder: string };
    hardwareValidation: string;
  };
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
  it("records static APK address evidence without claiming hardware validation", () => {
    expect(fixture.staticEvidence).toEqual(expect.objectContaining({
      installedApkSha256: "38b908d233019888da7b0cfb77c8f5f6cf8a6f36cd2afb2f1b0cf59357f95a1d",
      addressAssignment: {
        method: "Network.setUnicastAddressByUuid",
        baseOpcode: 0x38,
        noDebugOpcode: 0xb8,
        dpid: 0x81,
        uuidBytes: 6,
        addressByteOrder: "big-endian"
      },
      hardwareValidation: "not-run-task-9-hil"
    }));
    expect(fixture.staticEvidence.installedApkSha256).toBe(fixture.source.apkSha256);
  });

  it.each(fixture.requests)("encodes $name byte for byte", ({ operation, sequence, hex, sourceSha256 }) => {
    expect(sourceSha256).toBe(fixture.source.sha256);
    const request = encodeBioCommand(operation, sequence);
    expect(encodeCrcFrame(request.command, request.payload).toString("hex")).toBe(hex);
  });

  it.each([
    { kind: "setControlMode", target: { kind: "broadcast", networkId: 0 }, mode: "force-off" },
    { kind: "setHighBrightness", target: { kind: "broadcast", networkId: 0 }, rawHighBrightness: 127 },
    { kind: "setHighBrightness", target: { kind: "unicast", networkId: 0, logicalAddress: 0x1234 }, rawHighBrightness: 127 },
    { kind: "setHighBrightness", target: { kind: "unicast", networkId: 0, logicalAddress: 0x1234 }, rawHighBrightness: 0 }
  ] satisfies BioOperation[])("fails closed for an otherwise-valid but uncaptured combination: %j", (operation) => {
    expect(() => encodeBioCommand(operation, 75)).toThrowError(expect.objectContaining({ code: "BIO_EVIDENCE_UNAVAILABLE" }));
  });

  it.each([26, 128, 198, 254, 255])("serializes APK table-backed positive brightness raw %i", (rawHighBrightness) => {
    const request = encodeBioCommand({ kind: "setHighBrightness", target: {
      kind: "unicast", networkId: 0, logicalAddress: 0x1234
    }, rawHighBrightness }, 75);

    expect(request.payload.subarray(15)).toEqual(Buffer.from([0xcd, 0x13, rawHighBrightness]));
  });

  it.each([2, 25, 127, 253])("rejects arbitrary non-table raw %i", (rawHighBrightness) => {
    expect(() => encodeBioCommand({ kind: "setHighBrightness", target: {
      kind: "unicast", networkId: 0, logicalAddress: 0x1234
    }, rawHighBrightness }, 75)).toThrowError(expect.objectContaining({ code: "BIO_EVIDENCE_UNAVAILABLE" }));
  });

  it("does not expose the network-read payload or interpret the probe as device info", () => {
    expect(decodeBioResponse(response("probe-network-response"))).toEqual({ kind: "probe", protocol: "crc16", responseCommand: 0x0b, payloadBytes: 13 });
  });

  it("distinguishes outer acceptance from physical application", () => {
    expect(decodeBioResponse(response("outer-ack"))).toEqual({ kind: "outer-ack", accepted: true, status: 0, deviceApplied: false });
    expect(decodeBioResponse({ protocol: "crc16", command: 0x11, payload: Buffer.from([1]) })).toEqual({ kind: "outer-ack", accepted: false, status: 1, deviceApplied: false });
  });

  it("serializes UUID address assignment with the observed current address in the header", () => {
    const request = encodeBioCommand({
      kind: "assignAddress",
      target: { kind: "unicast", networkId: 0, logicalAddress: 0x1234 },
      nativeUuid: "001122334455",
      logicalAddress: 0x2345
    }, 0x53);

    expect(request.command).toBe(0x10);
    expect(request.payload.subarray(9, 15)).toEqual(Buffer.from("01fe12340000", "hex"));
    expect(request.payload.subarray(15)).toEqual(Buffer.from("b8810011223344552345", "hex"));
    expect(encodeCrcFrame(request.command, request.payload).toString("hex"))
      .toBe("55aa101900000000000000805301fe12340000b88100112233445523450d89");
  });

  it.each([
    { kind: "assignAddress", target: { kind: "broadcast", networkId: 0 }, nativeUuid: "001122334455", logicalAddress: 0x2345 },
    { kind: "assignAddress", target: { kind: "unicast", networkId: 0, logicalAddress: 0x1234 }, nativeUuid: "bio:001122334455", logicalAddress: 0x2345 },
    { kind: "assignAddress", target: { kind: "unicast", networkId: 0, logicalAddress: 0x1234 }, nativeUuid: "00112233445", logicalAddress: 0x2345 },
    { kind: "assignAddress", target: { kind: "unicast", networkId: 0, logicalAddress: 0x1234 }, nativeUuid: "00112233445g", logicalAddress: 0x2345 },
    { kind: "assignAddress", target: { kind: "unicast", networkId: 0, logicalAddress: 0x1234 }, nativeUuid: "001122334455", logicalAddress: 0 },
    { kind: "assignAddress", target: { kind: "unicast", networkId: 0, logicalAddress: 0x1234 }, nativeUuid: "001122334455", logicalAddress: 0x8000 }
  ] satisfies BioOperation[])("rejects unsafe address assignment before framing: %j", (operation) => {
    expect(() => encodeBioCommand(operation, 0x53)).toThrow();
  });

  it.each([
    { name: "high brightness", operation: { kind: "readHighBrightness", target: { kind: "unicast", networkId: 0, logicalAddress: 0x1234 } }, body: "4e13", hex: "55aa101100000000000000805401fe123400004e13642d" },
    { name: "control mode", operation: { kind: "readControlMode", target: { kind: "unicast", networkId: 0, logicalAddress: 0x1234 } }, body: "4e12", hex: "55aa101100000000000000805401fe123400004e12a5ed" }
  ] satisfies { name: string; operation: BioOperation; body: string; hex: string }[])("serializes $name GET body", ({ operation, body, hex }) => {
    const request = encodeBioCommand(operation, 0x54);
    expect(request.payload.subarray(15)).toEqual(Buffer.from(body, "hex"));
    expect(encodeCrcFrame(request.command, request.payload).toString("hex")).toBe(hex);
  });

  it.each([
    { kind: "readHighBrightness", target: { kind: "broadcast", networkId: 0 } },
    { kind: "readControlMode", target: { kind: "broadcast", networkId: 0 } }
  ] satisfies BioOperation[])("rejects ambiguous broadcast read-back request: %j", (operation) => {
    expect(() => encodeBioCommand(operation, 0x54)).toThrow();
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

  it("parses high-brightness read-back separately from integer service percent", () => {
    const parsed = decodeBioResponse({
      protocol: "crc16",
      command: 0x12,
      payload: Buffer.from("d30011223344558396123401fe00004f13c6", "hex")
    });
    expect(parsed).toMatchObject({
      kind: "high-brightness-report",
      deviceUuid: "bio:001122334455",
      logicalAddress: 0x1234,
      destination: 0x01fe,
      rawHighBrightness: 198,
      brightnessPercent: 60
    });
  });

  it("preserves a non-exact raw read-back without rounding it to a service percent", () => {
    expect(decodeBioResponse({
      protocol: "crc16",
      command: 0x12,
      payload: Buffer.from("d30011223344558396123401fe00004f137f", "hex")
    })).toMatchObject({ kind: "high-brightness-report", rawHighBrightness: 127, brightnessPercent: null });
  });

  it("accepts read-back only when the UUID and current source address match the expected lamp", () => {
    const frame = {
      protocol: "crc16",
      command: 0x12,
      payload: Buffer.from("d30011223344558396123401fe00004f13c6", "hex")
    } as const;
    expect(decodeBioReadback(frame, { nativeUuid: "001122334455", logicalAddress: 0x1234 }))
      .toMatchObject({ kind: "high-brightness-report", rawHighBrightness: 198 });
    expect(() => decodeBioReadback(frame, { nativeUuid: "101122334455", logicalAddress: 0x1234 }))
      .toThrowError(expect.objectContaining({ code: "MALFORMED_FRAME" }));
    expect(() => decodeBioReadback(frame, { nativeUuid: "001122334455", logicalAddress: 0x1235 }))
      .toThrowError(expect.objectContaining({ code: "MALFORMED_FRAME" }));
  });

  it("never treats outer acceptance or an unsupported DPID as device read-back", () => {
    expect(() => decodeBioReadback(response("outer-ack"), { nativeUuid: "001122334455", logicalAddress: 0x1234 }))
      .toThrowError(expect.objectContaining({ code: "MALFORMED_FRAME" }));
    expect(() => decodeBioReadback({
      protocol: "crc16",
      command: 0x12,
      payload: Buffer.from("d30011223344558396123401fe00004f14c6", "hex")
    }, { nativeUuid: "001122334455", logicalAddress: 0x1234 }))
      .toThrowError(expect.objectContaining({ code: "MALFORMED_FRAME" }));
  });

  it.each([
    "d30011223344558396123401fe00004f13",
    "d30011223344558396123401fe00004f13c600",
    "d30011223344558396123401fe00004f12",
    "d30011223344558396123401fe00004f1202",
    "d30011223344558396123401fe00004f120300"
  ])("rejects malformed read-back body %s", (payload) => {
    expect(() => decodeBioResponse({ protocol: "crc16", command: 0x12, payload: Buffer.from(payload, "hex") }))
      .toThrowError(expect.objectContaining({ code: "MALFORMED_FRAME" }));
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
