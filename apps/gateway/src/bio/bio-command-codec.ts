import type { BioFrame } from "./bio-frame-codec";
import type { BioUsbRequest } from "./bio-usb-transport";
import { BioUsbError } from "./bio-usb-error";
import { bioRawToPercent } from "./bio-brightness-table";

/**
 * BIO USB 패킷을 읽는 법 (숫자는 모두 16진수, byte 위치는 0부터 시작)
 *
 * 1 byte는 8 bit이며, `0x`는 16진수 표기다(예: 0x12는 10진수 18).
 * 프론트엔드에 비유하면 바깥 command는 HTTP 요청의 종류, payload는 요청 본문,
 * inner body는 그 본문 안에 들어 있는 "조명에 시킬 일/조명이 보고한 값"이다.
 * `bio-frame-codec.ts`가 USB 프레임의 경계와 CRC를 검사한 다음 이 파일에 넘긴다.
 * CRC는 전송 중 바이트 손상을 찾는 검사값이지, 인증이나 암호화가 아니다.
 *
 *   55 AA | 바깥 command 1 byte | payload 길이 1 byte | payload | CRC16 2 bytes
 *
 * 바깥 command: 0A=네트워크 조회, 0B=그 응답, 10=동글을 통한 송신,
 * 11=동글의 수락/거절, 12=조명에서 온 비동기 보고, 03=동글 시작 정보(내용 미해석).
 * 0A/0B는 네트워크 조회이므로 아래 15-byte 조명 헤더를 사용하지 않는다.
 * 11의 payload는 상태 1 byte뿐이다. 0이면 "동글이 수락"이며 조명 적용 완료가 아니다.
 *
 * 10/12의 payload = 조명 헤더 15 bytes + inner body:
 *   [0]     RSSI: 수신 신호 세기, signed 8-bit dBm. 송신 때는 0.
 *   [1..6]  native UUID: 조명 제조사 측 6-byte 식별자. 송신 때는 0으로 채움.
 *   [7]     bit 7=control 플래그, bit 0..6=TTL. 송신 값 80은 control=1, TTL=0.
 *   [8]     sequence: 송신 순서 번호 0..255. 이것만으로 비동기 보고의 주인을 판정하지 않음.
 *   [9..10] 송신자 주소: 송신 때 게이트웨이 01FE, 수신 때 보고한 조명의 주소.
 *   [11..12] 목적지 주소: 개별 조명 주소 또는 전체 대상 FFFF.
 *   [13..14] network ID: 조명이 속한 BIO 네트워크.
 *   [15..]  inner body: 아래 encode/decode의 실제 명령 또는 보고 내용.
 * 주소/network ID는 big-endian(예: 1234 => 12 34), CRC trailer는 little-endian이다.
 * logical address는 BIO 네트워크 주소이며 서비스 DB의 fixtureId와는 다르다.
 * 정규화 테스트의 network ID 0000과 UUID 001122334455는 실제 현장 값이 아니다.
 *
 * 예: `10 | 11 | 00 00 00 00 00 00 00 80 54 01 FE 12 34 00 00 4E 13`
 *     바깥 command 10, payload 0x11(17) bytes, sequence 54, 조명 주소 1234,
 *     network ID 0000, inner body 4E 13(밝기 설정값 조회)으로 읽는다.
 *
 * 판단 근거: 설치된 앱 1.2.0의 정적 serializer 분석과 수집 패킷을 정규화한
 * `test/fixtures/bio-protocol-v1.json`, byte-for-byte 검사인 `bio-command-codec.test.ts`.
 * fixture의 UUID/주소는 실제 장치 값이 아닌 대체값이다. 검증된 조합만 이 codec에
 * 허용하며, 제조사 문서가 없는 필드(특히 03의 내용과 센서 09의 상태값)는 추측하지 않는다.
 */

/** broadcast는 같은 network ID의 전체 조명, unicast는 특정 logical address 한 대다. */
export type BioLampTarget = { kind: "broadcast"; networkId: number } | { kind: "unicast"; networkId: number; logicalAddress: number };
/** sensor=조명 자체 센서 제어, force-on/off=수동 강제 점등/소등. 밝기와 별개의 상태다. */
export type BioControlMode = "force-on" | "force-off" | "sensor";
/** 사람이 이해하는 동작 이름. encodeBioCommand가 이를 실제 바이트로 바꾼다. */
export type BioOperation = { kind: "probe" | "scan" | "stopScan" }
  | { kind: "assignAddress"; target: BioLampTarget; nativeUuid: string; logicalAddress: number }
  | { kind: "readHighBrightness"; target: BioLampTarget }
  | { kind: "setHighBrightness"; target: BioLampTarget; rawHighBrightness: number }
  | { kind: "readControlMode"; target: BioLampTarget }
  | { kind: "setControlMode"; target: BioLampTarget; mode: BioControlMode };

export interface BioReadbackExpectation {
  /** 보고한 조명의 UUID와 주소가 모두 요청 대상과 같아야 다른 조명의 보고를 오인하지 않는다. */
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
/** `kind`는 수신 바이트 자체가 아니라, 이 파일이 안전하게 분류해 붙인 TypeScript 이름이다. */
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
 * 근거의 범위와 확인하지 않은 부분
 *
 * [확인됨] 0A/0B, 10/11/12의 조합과 아래 명시한 body는 설치 APK/캡처/정규화
 * fixture에서 추적했다. 0B는 정확히 13 bytes이지만 네트워크/비밀번호로 보이는
 * 개별 필드 의미는 확인되지 않았으므로 파싱 결과 밖으로 내보내지 않는다.
 * [확인됨] 주소 지정의 base opcode 38, DPID 81, UUID 6 bytes, 주소 big-endian은
 * APK의 Network.setUnicastAddressByUuid에서 확인했다. debug 비활성 직렬화의
 * 실제 첫 byte는 B8이다. 이는 해당 조합의 정적 근거이지 모든 펌웨어에서 주소
 * 적용까지 검증했다는 뜻은 아니다.
 * [미확인] 03 payload 세부 필드, 12의 전체 inner opcode 목록, 센서 09 body의
 * 감지/해제 의미. 아래에 없는 조합은 추정해서 기능으로 만들지 않는다.
 */

export class BioEvidenceUnavailableError extends Error {
  readonly code = "BIO_EVIDENCE_UNAVAILABLE";
  constructor() { super("This BIO operation has no approved request/response evidence"); }
}

function unsigned(value: number, max: number, min = 0): void {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError("Invalid BIO command parameter");
}

function nativeUuidBytes(nativeUuid: string): Buffer {
  // 수신 BIO header의 UUID와 송신 주소 지정 body의 UUID는 정확히 6 raw bytes다.
  // `bio:` 표시 접두어나 실제 식별자를 로그에서 복사한 다른 형식은 여기서 거절한다.
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
  // 0A는 동글의 GET_NWK: 조명용 15-byte header/body가 없고 payload 길이도 0이다.
  // 응답 0B의 13 bytes는 연결 준비 여부만 확인하며 민감할 수 있는 필드를 해석하지 않는다.
  if (operation.kind === "probe") return { command: 0x0a, payload: Buffer.alloc(0) };
  let target: BioLampTarget = { kind: "broadcast", networkId: 0 };
  let body: number[];
  switch (operation.kind) {
    // [캡처 근거] 83 05는 검색 시작, 85는 검색 중지. 둘 다 전체 대상 header로 보낸다.
    // 83은 여기서는 *inner body*의 첫 byte이며 USB 바깥 command 83이 아니다.
    case "scan": body = [0x83, 5]; break;
    case "stopScan": body = [0x85]; break;
    case "assignAddress": {
      target = requireUnicast(operation.target);
      unsigned(operation.logicalAddress, 0x7fff, 1);
      const uuid = nativeUuidBytes(operation.nativeUuid);
      // B8=주소 지정(앱의 base opcode 38을 debug 비활성으로 직렬화한 값),
      // 81=주소 항목 DPID. 뒤에 UUID 6 bytes와 새 주소 2 bytes(big-endian)를 붙인다.
      // header 목적지는 새 주소가 아닌 검색에서 관측한 *현재* 주소(target)다.
      // 근거: 설치 APK의 Network.setUnicastAddressByUuid와 정규화 fixture/test.
      // 11 ACK는 동글 수락만 증명하므로 실제 변경은 이후 재검색으로 확인해야 한다.
      body = [0xb8, 0x81, ...uuid, operation.logicalAddress >>> 8, operation.logicalAddress & 0xff];
      break;
    }
    case "readHighBrightness":
      target = requireUnicast(operation.target);
      // 4E=조회(GET), 13=high brightness 항목. 여러 조명의 응답을 섞지 않도록
      // 조회는 한 주소(unicast)만 허용한다. 응답 body는 4F 13 <raw>다.
      body = [0x4e, 0x13];
      break;
    case "setHighBrightness":
      target = operation.target;
      unsigned(operation.rawHighBrightness, 255);
      // 화면의 1..100%와 raw 1 byte는 선형 관계가 아니다. 설치 APK의 deep_all
      // 표시값과 Scene.DEEP_VALUES의 같은 index를 짝지은 정확한 표만 허용한다.
      // 0%는 raw 00 쓰기가 아니라 force-off 모드로 처리한다.
      // 근거: APK 배열/CD13 serializer와 157/254/255 등 캡처된 값. 표의 *모든* 값이
      // 실제 펌웨어에서 동일하게 적용되는지는 검증되지 않아 표 밖 보간은 금지한다.
      const mappedPercent = bioRawToPercent(operation.rawHighBrightness);
      if (mappedPercent === null || mappedPercent === 0) {
        throw new BioEvidenceUnavailableError();
      }
      // CD=설정 명령, 13=high brightness 항목, 마지막 1 byte=raw 설정값.
      // 이 값은 "현재 출력 퍼센트" 보고가 아니다. 캡처상 CD의 bit 0은 lamp answer
      // 미요청, bit 7은 debug 비활성이다. 그래도 바깥 11 동글 ACK는 도착한다.
      body = [0xcd, 0x13, operation.rawHighBrightness];
      break;
    case "readControlMode":
      target = requireUnicast(operation.target);
      // 4E=조회(GET), 12=control mode 항목. 응답 body는 4F 12 <mode>다.
      body = [0x4e, 0x12];
      break;
    case "setControlMode": {
      target = operation.target;
      // mode: 00=조명 센서가 제어, 01=강제 소등, 03=강제 점등.
      // 02 등 다른 byte에는 확인된 의미가 없으므로 보내지 않는다.
      const mode = operation.mode === "sensor" ? 0 : operation.mode === "force-off" ? 1 : operation.mode === "force-on" ? 3 : undefined;
      // 12는 control mode 항목. 개별 대상은 CC 12 <mode>, 전체 대상은
      // CD 12 <mode> 조합이 캡처됐다. force-off는 개별 전송만 확인되어
      // broadcast로 보내지 않는다(사용자 의도와 다르게 전체 소등될 위험 방지).
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
  // Buffer.alloc은 [0]=RSSI와 [1..6]=UUID를 0으로 채운다. 송신 header의
  // [7]=80(control=1, TTL=0), [8]=sequence, [9..10]=게이트웨이 출발 주소 01FE,
  // [11..12]=개별 주소 또는 전체 대상 FFFF, [13..14]=network ID다.
  // body는 offset 15부터 복사한다. 근거: 캡처 프레임과 byte-for-byte fixture test.
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
  // 이 파일은 checksum 검증을 다시 하지 않는다. BioFrameCodec가 먼저 CRC16을
  // 확인하고 분리한 BioFrame만 입력받는다. 이 앱 profile의 응답은 CRC16만 허용한다.
  if (frame.protocol !== "crc16") return invalid();
  if (frame.command === 0x0b) {
    // GET_NWK(0A)의 응답. 길이는 확인됐지만 비밀번호 등으로 추정되는 값은
    // 의미가 확정되지 않았고 노출할 필요도 없어 길이 외에는 반환하지 않는다.
    if (p.length !== 13) return invalid();
    return { kind: "probe", protocol: "crc16", responseCommand: 0x0b, payloadBytes: 13 };
  }
  if (frame.command === 0x11) {
    // 0=동글 접수, nonzero=동글 거절. 세부 오류코드 목록은 확인되지 않았다.
    // 조명의 실제 상태는 없으므로 deviceApplied는 항상 false다.
    if (p.length !== 1) return invalid();
    return { kind: "outer-ack", accepted: p[0] === 0, status: p[0], deviceApplied: false };
  }
  const unsupported: BioResponse = { kind: "unsupported-notification", outerCommand: frame.command, payloadBytes: p.length };
  // 시작 과정의 03은 유효 프레임이지만 세부 payload 의미가 확인되지 않았다.
  if (frame.command === 0x03) return unsupported;
  if (frame.command !== 0x12 || p.length < 16) return invalid();
  // 12는 비동기 조명 보고. 공통 header 15 bytes + 최소 inner opcode 1 byte.
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
  // 나머지 opcode를 임의의 센서/밝기 이벤트로 오해하지 않도록 원본 body도 반환하지 않는다.
  if (opcode !== 0x0a && !(opcode === 0x4f && (p[16] === 0x12 || p[16] === 0x13))) return unsupported;
  if (opcode === 0x0a) {
    // inner 0A는 *장치 발견 보고*이며 바깥 command 0A(GET_NWK)와 다르다.
    // 전체 payload 28 bytes 중 [16]=장치 종류, [17..19]=펌웨어 major/minor/revision,
    // [20..21]=build(little-endian), [22..25]=sensor/infrared/ambient/hardware 종류.
    // [26..27] 의미는 확정하지 않아 반환하지 않는다. 근거: 정규화 캡처와 fixture test.
    if (p.length !== 28) return invalid();
    return { kind: "discovery", ...header, deviceType: p[16],
      firmware: { major: p[17], minor: p[18], revision: p[19], build: p.readUInt16LE(20) },
      sensorType: p[22], infraredType: p[23], ambientLightType: p[24], hardwareType: p[25] };
  }
  if (p.length !== 18) return invalid();
  if (p[16] === 0x13) {
    // inner 4F=장치 보고, 13=high brightness, [17]=raw byte.
    // APK 표에 정확히 있는 raw만 서비스 퍼센트로 바꾸고 나머지는 null이다.
    return { kind: "high-brightness-report", ...header, rawHighBrightness: p[17], brightnessPercent: bioRawToPercent(p[17]) };
  }
  if (![0, 1, 3].includes(p[17])) return invalid();
  // inner 4F 12는 mode 보고. 00/01/03 이외 값은 확인된 모드가 아니므로 거절한다.
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
