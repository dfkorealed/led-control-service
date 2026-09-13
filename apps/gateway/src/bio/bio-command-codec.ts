import type { BioFrame } from "./bio-frame-codec";
import type { BioUsbRequest } from "./bio-usb-transport";
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

/**
 * 캡처 기반 command 계약
 *
 * - [확인됨] 외부 0A/0B는 GET_NWK 요청/응답이며 0B는 CRC16 + payload 13 bytes만 허용한다.
 *   네트워크/비밀번호로 보이는 개별 필드 의미는 [미확인]이고 이 parser 밖으로 내보내지 않는다.
 * - [확인됨] 외부 10은 dongle TX, 11은 1-byte dongle ACK, 12는 비동기 module RX다.
 *   ACK status 0은 dongle 수락일 뿐 조명이 실제 적용했다는 뜻이 아니다.
 * - [확인됨] 10/12 payload header는 byte 0 RSSI, 1..6 native UUID, 7 control/TTL,
 *   8 sequence, 9..10 source/logical address, 11..12 destination, 13..14 network ID,
 *   15 이후 inner body이며 주소/네트워크 값은 big-endian이다.
 * - [미확인] 03 payload의 세부 필드와 전체 12 inner opcode 목록은 문서화되지 않았다.
 *   아래에서 명시적으로 고정한 캡처 조합 외에는 unsupported로 유지한다.
 */

export class BioEvidenceUnavailableError extends Error {
  readonly code = "BIO_EVIDENCE_UNAVAILABLE";
  constructor() { super("This BIO operation has no approved request/response evidence"); }
}

function unsigned(value: number, max: number, min = 0): void {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError("Invalid BIO command parameter");
}

/** [확인됨] 설치 앱 1.2.0 캡처 조합만 허용하며 임의 opcode/percent 변환을 노출하지 않는다. */
export function encodeBioCommand(operation: BioOperation, sequence: number): BioUsbRequest {
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
      // [확인됨] CD 13은 Scene.highBrightness의 raw 설정값이다. 현재 출력이나 선형 percent가
      // 아니다. 캡처상 bit 0은 lamp answer 미요청, bit 7은 debug 비활성이고 외부 11은 온다.
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
  // [확인됨] TX LampHeader: RSSI=0, 빈 UUID, ctrl=1/ttl=0, byte sequence,
  // big-endian source/destination/network ID. inner body offset은 15다.
  payload[7] = 0x80;
  payload[8] = sequence;
  payload.writeUInt16BE(0x01fe, 9);
  payload.writeUInt16BE(target.kind === "unicast" ? target.logicalAddress : 0xffff, 11);
  payload.writeUInt16BE(target.networkId, 13);
  payload.set(body, 15);
  return { command: 0x10, payload };
}

function invalid(): never { throw new BioUsbError("MALFORMED_FRAME", "Invalid BIO traced response"); }

/** [확인됨] caller가 checksum 검증된 frame을 주며 민감한 0B 필드는 parser 밖으로 내보내지 않는다. */
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
