import type { BioFrame } from "./bio-frame-codec";
import type { BioUsbRequest } from "./bio-usb-transport";
import { BioUsbError } from "./bio-usb-error";
import { bioRawToPercent } from "./bio-brightness-table";

export type BioLampTarget = { kind: "broadcast"; networkId: number } | { kind: "unicast"; networkId: number; logicalAddress: number };
export type BioControlMode = "force-on" | "force-off" | "sensor";
export type BioOperation = { kind: "probe" | "scan" | "stopScan" }
  | { kind: "assignAddress"; target: BioLampTarget; nativeUuid: string; logicalAddress: number }
  | { kind: "readHighBrightness"; target: BioLampTarget }
  | { kind: "setHighBrightness"; target: BioLampTarget; rawHighBrightness: number }
  | { kind: "readControlMode"; target: BioLampTarget }
  | { kind: "setControlMode"; target: BioLampTarget; mode: BioControlMode };

export interface BioReadbackExpectation {
  nativeUuid: string;
  logicalAddress: number;
}

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
export type BioSensorStatusCandidate = BioLampObservation & {
  kind: "sensor-status-candidate";
  innerOpcode: 0x09;
  innerBody: Buffer;
};
export type BioAliveStatus = BioLampObservation & {
  kind: "alive-status";
  innerOpcode: 0x0c;
  innerBody: Buffer;
};
export type BioResponse =
  | { kind: "probe"; protocol: "crc16"; responseCommand: 0x0b; payloadBytes: 13 }
  | { kind: "outer-ack"; accepted: boolean; status: number; deviceApplied: false }
  | (BioLampObservation & { kind: "discovery"; deviceType: number; firmware: { major: number; minor: number; revision: number; build: number }; sensorType: number; infraredType: number; ambientLightType: number; hardwareType: number })
  | (BioLampObservation & { kind: "high-brightness-report"; rawHighBrightness: number; brightnessPercent: number | null })
  | (BioLampObservation & { kind: "control-mode-report"; mode: BioControlMode })
  | BioSensorStatusCandidate
  | BioAliveStatus
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
 * - [확인됨] 설치 APK 정적 분석에서 `Network.setUnicastAddressByUuid`는 base opcode
 *   0x38, DPID 0x81, UUID 6 bytes, 16-bit ADDRESS를 사용한다. debug 비활성 serializer의
 *   실제 첫 byte는 0xB8이며 ADDRESS는 big-endian이다. 이 근거는 Task 9 HIL과 별개다.
 * - [확인됨] high brightness/control mode GET inner body는 각각 4E13/4E12이고,
 *   device report는 4F13<raw>/4F12<mode>다. 외부 11 ACK는 이 값을 포함하지 않는다.
 */

export class BioEvidenceUnavailableError extends Error {
  readonly code = "BIO_EVIDENCE_UNAVAILABLE";
  constructor() { super("This BIO operation has no approved request/response evidence"); }
}

function unsigned(value: number, max: number, min = 0): void {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError("Invalid BIO command parameter");
}

function nativeUuidBytes(nativeUuid: string): Buffer {
  if (!/^[0-9a-f]{12}$/.test(nativeUuid)) throw new RangeError("BIO native UUID must be normalized 6-byte hex");
  return Buffer.from(nativeUuid, "hex");
}

function requireUnicast(target: BioLampTarget): Extract<BioLampTarget, { kind: "unicast" }> {
  if (target.kind !== "unicast") throw new BioEvidenceUnavailableError();
  return target;
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
    case "assignAddress": {
      target = requireUnicast(operation.target);
      unsigned(operation.logicalAddress, 0x7fff, 1);
      const uuid = nativeUuidBytes(operation.nativeUuid);
      // [확인됨] inner `B8 81` 뒤에는 대상 UUID 6 bytes와 새 unicast address가 온다.
      // LampHeader destination은 새 주소가 아니라 검색에서 관측한 현재 주소(target)다.
      // [미확인] 외부 11 ACK만으로 장치 적용을 판정할 수 없어 재검색은 Task 5 책임이다.
      body = [0xb8, 0x81, ...uuid, operation.logicalAddress >>> 8, operation.logicalAddress & 0xff];
      break;
    }
    case "readHighBrightness":
      target = requireUnicast(operation.target);
      body = [0x4e, 0x13];
      break;
    case "setHighBrightness":
      target = operation.target;
      unsigned(operation.rawHighBrightness, 255);
      // [확인됨] 설치 APK의 deep_all/DEEP_VALUES와 CD13 serializer가 함께 증명하는
      // positive integer-percent raw만 허용한다. 0%는 raw write가 아니라 force-off 경로다.
      // 기존 캡처의 157/254/255도 모두 이 표에 포함된다. [미확인] 표의 모든 값이 실제
      // firmware에 적용되는지는 Task 9 HIL 전까지 확인되지 않았으므로 표 밖 raw bypass는 없다.
      const mappedPercent = bioRawToPercent(operation.rawHighBrightness);
      if (mappedPercent === null || mappedPercent === 0) {
        throw new BioEvidenceUnavailableError();
      }
      // [확인됨] CD 13은 Scene.highBrightness의 raw 설정값이다. 현재 출력이나 선형 percent가
      // 아니다. 캡처상 bit 0은 lamp answer 미요청, bit 7은 debug 비활성이고 외부 11은 온다.
      body = [0xcd, 0x13, operation.rawHighBrightness];
      break;
    case "readControlMode":
      target = requireUnicast(operation.target);
      body = [0x4e, 0x12];
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
  const header: BioLampObservation = {
    deviceUuid: `bio:${p.subarray(1, 7).toString("hex")}`, logicalAddress: p.readUInt16BE(9),
    networkId: p.readUInt16BE(13), destination: p.readUInt16BE(11), rssiDbm: p.readInt8(0),
    sequence: p[8], ttl: p[7] & 0x7f, control: (p[7] & 0x80) !== 0
  };
  // APK 정적 분석은 inner opcode 0x09/0x0c의 이름만 확인하며, 0x09 body의 의미나
  // 센서 상태 판정 규칙은 증명하지 않는다. 따라서 0x09는 shadow evidence용 원본 바이트만
  // 보존하고 active/detected 같은 boolean 상태를 만들지 않는다. 0x0c는 liveness 신호로만
  // 취급하며 자동화 입력으로 절대 사용해서는 안 된다.
  if (opcode === 0x09) {
    return { kind: "sensor-status-candidate", ...header, innerOpcode: 0x09, innerBody: Buffer.from(p.subarray(16)) };
  }
  if (opcode === 0x0c) {
    return { kind: "alive-status", ...header, innerOpcode: 0x0c, innerBody: Buffer.from(p.subarray(16)) };
  }
  // Other observed notifications stay opaque until their own contract is traced.
  if (opcode !== 0x0a && !(opcode === 0x4f && (p[16] === 0x12 || p[16] === 0x13))) return unsupported;
  if (opcode === 0x0a) {
    if (p.length !== 28) return invalid();
    return { kind: "discovery", ...header, deviceType: p[16],
      firmware: { major: p[17], minor: p[18], revision: p[19], build: p.readUInt16LE(20) },
      sensorType: p[22], infraredType: p[23], ambientLightType: p[24], hardwareType: p[25] };
  }
  if (p.length !== 18) return invalid();
  if (p[16] === 0x13) {
    return { kind: "high-brightness-report", ...header, rawHighBrightness: p[17], brightnessPercent: bioRawToPercent(p[17]) };
  }
  if (![0, 1, 3].includes(p[17])) return invalid();
  return { kind: "control-mode-report", ...header, mode: p[17] === 0 ? "sensor" : p[17] === 1 ? "force-off" : "force-on" };
}

/**
 * [확인됨] device read-back은 외부 0x12의 UUID와 source address가 요청 대상과 모두
 * 일치할 때만 소유할 수 있다. 외부 0x11은 dongle acceptance라서 여기서 거부한다.
 * [추정] UUID/address mismatch는 지연 응답 또는 다른 조명의 비동기 보고일 수 있으므로
 * 값을 현재 요청에 적용하지 않고 payload를 노출하지 않는 MALFORMED_FRAME으로 닫는다.
 */
export function decodeBioReadback(frame: BioFrame, expected: BioReadbackExpectation): Extract<BioResponse,
  { kind: "high-brightness-report" | "control-mode-report" }> {
  const expectedUuid = nativeUuidBytes(expected.nativeUuid).toString("hex");
  unsigned(expected.logicalAddress, 0x7fff, 1);
  const response = decodeBioResponse(frame);
  if ((response.kind !== "high-brightness-report" && response.kind !== "control-mode-report")
    || response.deviceUuid !== `bio:${expectedUuid}`
    || response.logicalAddress !== expected.logicalAddress) return invalid();
  return response;
}
