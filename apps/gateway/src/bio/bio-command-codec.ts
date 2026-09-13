import type { BioFrame } from "./bio-frame-codec";
import type { BioSerialRequest } from "./bio-serial-transport";
import { BioUsbError } from "./bio-usb-error";

export type BioLampTarget = { kind: "broadcast"; networkId: number } | { kind: "unicast"; networkId: number; logicalAddress: number };
export type BioControlMode = "force-on" | "force-off" | "sensor";
export type BioOperation = { kind: "probe" | "scan" | "stopScan" }
  | { kind: "setHighBrightness"; target: BioLampTarget; rawHighBrightness: number }
  | { kind: "setControlMode"; target: BioLampTarget; mode: BioControlMode };

export interface BioLampObservation {
  deviceUuid: string;
  logicalAddress: number;
  networkId: number;
  destination: number;
  rssiDbm: number;
  sequence: number;
  ttl: number;
  control: boolean;
}
export type BioResponse =
  | { kind: "probe"; protocol: "crc16"; responseCommand: 0x0b; payloadBytes: 13 }
  | { kind: "outer-ack"; accepted: boolean; status: number; deviceApplied: false }
  | (BioLampObservation & { kind: "discovery"; deviceType: number; firmware: { major: number; minor: number; revision: number; build: number }; sensorType: number; infraredType: number; ambientLightType: number; hardwareType: number })
  | (BioLampObservation & { kind: "control-mode-report"; mode: BioControlMode })
  | { kind: "unsupported-notification"; outerCommand: number; payloadBytes: number };

export class BioEvidenceUnavailableError extends Error {
  readonly code = "BIO_EVIDENCE_UNAVAILABLE";
  constructor() { super("This BIO operation has no approved request/response evidence"); }
}

function unsigned(value: number, max: number, min = 0): void {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError("Invalid BIO command parameter");
}

/** Installed-app 1.2.0 profile only; arbitrary opcodes and percent conversion are not exposed. */
export function encodeBioCommand(operation: BioOperation, sequence: number): BioSerialRequest {
  unsigned(sequence, 255);
  if (operation.kind === "probe") return { command: 0x0a, payload: Buffer.alloc(0) };
  let target: BioLampTarget = { kind: "broadcast", networkId: 0 };
  let body: number[];
  switch (operation.kind) {
    case "scan": body = [0x83, 5]; break;
    case "stopScan": body = [0x85]; break;
    case "setHighBrightness":
      target = operation.target;
      unsigned(operation.rawHighBrightness, 255);
      // A byte-range check is not evidence: Android 1.2.0 captured 157 only for
      // broadcast, and 254/255 for both targets. Do not extrapolate other values.
      if (operation.rawHighBrightness !== 254 && operation.rawHighBrightness !== 255
        && !(target.kind === "broadcast" && operation.rawHighBrightness === 157)) {
        throw new BioEvidenceUnavailableError();
      }
      // CD13 is Scene.highBrightness (raw setting), not current output or linear percent.
      // bit 0 requests no lamp answer; bit 7 disables debug. Outer 11 is still emitted.
      body = [0xcd, 0x13, operation.rawHighBrightness];
      break;
    case "setControlMode": {
      target = operation.target;
      const mode = operation.mode === "sensor" ? 0 : operation.mode === "force-off" ? 1 : operation.mode === "force-on" ? 3 : undefined;
      // Force-OFF was captured only as unicast; its broadcast encoding is unproven.
      if (mode === undefined || (operation.mode === "force-off" && target.kind !== "unicast")) throw new BioEvidenceUnavailableError();
      body = [target.kind === "unicast" ? 0xcc : 0xcd, 0x12, mode];
      break;
    }
    default: throw new BioEvidenceUnavailableError();
  }
  unsigned(target.networkId, 0xffff);
  if (target.kind !== "broadcast" && target.kind !== "unicast") throw new BioEvidenceUnavailableError();
  if (target.kind === "unicast") unsigned(target.logicalAddress, 0x7fff, 1);
  const payload = Buffer.alloc(15 + body.length);
  // LampHeader: RSSI=0, empty UUID, ctrl=1/ttl=0, byte sequence, BE src/dst/nid.
  payload[7] = 0x80;
  payload[8] = sequence;
  payload.writeUInt16BE(0x01fe, 9);
  payload.writeUInt16BE(target.kind === "unicast" ? target.logicalAddress : 0xffff, 11);
  payload.writeUInt16BE(target.networkId, 13);
  payload.set(body, 15);
  return { command: 0x10, payload };
}

function invalid(): never { throw new BioUsbError("MALFORMED_FRAME", "Invalid BIO traced response"); }

/** The caller supplies a CRC-validated frame; sensitive network fields never leave this parser. */
export function decodeBioResponse(frame: BioFrame): BioResponse {
  const p = frame.payload;
  if (frame.protocol !== "crc16") return invalid();
  if (frame.command === 0x0b) {
    if (p.length !== 13) return invalid();
    return { kind: "probe", protocol: "crc16", responseCommand: 0x0b, payloadBytes: 13 };
  }
  if (frame.command === 0x11) {
    if (p.length !== 1) return invalid();
    return { kind: "outer-ack", accepted: p[0] === 0, status: p[0], deviceApplied: false };
  }
  const unsupported: BioResponse = { kind: "unsupported-notification", outerCommand: frame.command, payloadBytes: p.length };
  if (frame.command === 0x03) return unsupported;
  if (frame.command !== 0x12 || p.length < 16) return invalid();
  const opcode = p[15];
  // Other observed sensor/alive packets are intentionally opaque until their own contract is traced.
  if (opcode !== 0x0a && !(opcode === 0x4f && p[16] === 0x12)) return unsupported;
  const header: BioLampObservation = {
    deviceUuid: `bio:${p.subarray(1, 7).toString("hex")}`, logicalAddress: p.readUInt16BE(9),
    networkId: p.readUInt16BE(13), destination: p.readUInt16BE(11), rssiDbm: p.readInt8(0),
    sequence: p[8], ttl: p[7] & 0x7f, control: (p[7] & 0x80) !== 0
  };
  if (opcode === 0x0a) {
    if (p.length !== 28) return invalid();
    return { kind: "discovery", ...header, deviceType: p[16],
      firmware: { major: p[17], minor: p[18], revision: p[19], build: p.readUInt16LE(20) },
      sensorType: p[22], infraredType: p[23], ambientLightType: p[24], hardwareType: p[25] };
  }
  if (p.length !== 18 || ![0, 1, 3].includes(p[17])) return invalid();
  return { kind: "control-mode-report", ...header, mode: p[17] === 0 ? "sensor" : p[17] === 1 ? "force-off" : "force-on" };
}
