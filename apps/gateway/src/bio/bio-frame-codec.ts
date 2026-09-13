export type BioProtocol = "crc16" | "gs";
export interface BioFrame {
  protocol: BioProtocol;
  command: number;
  payload: Buffer;
}
export interface BioPendingCandidate {
  protocol?: BioProtocol;
  command?: number;
}
export type BioFrameEvent =
  | { type: "frame"; frame: BioFrame }
  | { type: "malformed"; reason: string };

/**
 * BIO 외부 프레임 호환성 메모
 *
 * - [확인됨] CRC16 프레임은 `55 AA | command | length | payload | crc16` 순서다.
 *   CRC는 command부터 payload까지 계산한 MODBUS CRC16이고 trailer만 little-endian이다.
 * - [확인됨] GS 프레임은 `47 53 | command | length | payload | checksum` 순서다.
 *   checksum은 command/length/payload의 end-around carry 합을 1의 보수한 한 바이트다.
 * - [확인됨] 램프 주소와 network ID는 패킷 안에서 big-endian인 반면, CRC trailer와
 *   캡처된 일부 정수 필드는 little-endian이다. 이름이 비슷해도 encoder를 바꿔 쓰면 안 된다.
 * - [미확인] 제조사가 선언한 최대 payload는 확보하지 못했다. 63-byte 제한은 현재 캡처와
 *   메모리/재동기화 경계를 위한 방어값이며, 더 큰 프레임 지원 근거로 완화하지 않는다.
 */

export function crc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xa001 : 0);
  }
  return crc;
}

function gsChecksum(bytes: Uint8Array): number {
  let sum = bytes.reduce((total, byte) => total + byte, 0);
  while (sum > 0xff) sum = (sum & 0xff) + (sum >>> 8);
  return (~sum) & 0xff;
}

function unsigned(value: number, max: number) {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new RangeError("Invalid BIO unsigned integer");
}

function body(command: number, payload: Uint8Array) {
  unsigned(command, 0xff);
  if (payload.length > 63) throw new RangeError("BIO payload exceeds 63 bytes");
  return Buffer.concat([Buffer.from([command, payload.length]), payload]);
}

export function encodeCrcFrame(command: number, payload: Uint8Array): Buffer {
  const bytes = body(command, payload);
  return Buffer.concat([Buffer.from([0x55, 0xaa]), bytes, encodeShort(crc16(bytes))]);
}
export function encodeGsFrame(command: number, payload: Uint8Array): Buffer {
  const bytes = body(command, payload);
  return Buffer.concat([Buffer.from([0x47, 0x53]), bytes, Buffer.from([gsChecksum(bytes)])]);
}
export function encodeAddress(value: number): Buffer {
  return encodeWord(value);
}
export function encodeWord(value: number): Buffer {
  unsigned(value, 0xffff);
  const result = Buffer.alloc(2);
  result.writeUInt16BE(value);
  return result;
}
export function encodeShort(value: number): Buffer {
  unsigned(value, 0xffff);
  const result = Buffer.alloc(2);
  result.writeUInt16LE(value);
  return result;
}
export function encodeInt(value: number): Buffer {
  unsigned(value, 0xffffffff);
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value);
  return result;
}

export class BioFrameCodec {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): BioFrameEvent[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const events: BioFrameEvent[] = [];
    while (this.buffer.length >= 2) {
      const protocol = this.buffer[0] === 0x55 && this.buffer[1] === 0xaa ? "crc16"
        : this.buffer[0] === 0x47 && this.buffer[1] === 0x53 ? "gs" : undefined;
      if (!protocol) {
        this.buffer = this.buffer.subarray(1);
        continue;
      }
      if (this.buffer.length < 4) break;
      const length = this.buffer[3];
      if (length > 63) {
        events.push({ type: "malformed", reason: "length" });
        this.buffer = this.buffer.subarray(2);
        continue;
      }
      const frameLength = length + (protocol === "crc16" ? 6 : 5);
      if (this.buffer.length < frameLength) break;
      const bytes = this.buffer.subarray(2, 4 + length);
      const valid = protocol === "crc16" ? crc16(bytes) === this.buffer.readUInt16LE(4 + length)
        : gsChecksum(bytes) === this.buffer[4 + length];
      if (!valid) {
        events.push({ type: "malformed", reason: "checksum" });
        // Search again after a bad candidate; a real header may occur within it.
        this.buffer = this.buffer.subarray(2);
        continue;
      }
      events.push({ type: "frame", frame: { protocol, command: this.buffer[2], payload: Buffer.from(this.buffer.subarray(4, 4 + length)) } });
      this.buffer = this.buffer.subarray(frameLength);
    }
    return events;
  }
  reset(): void {
    this.buffer = Buffer.alloc(0);
  }

  /**
   * [추정] 한 요청 세대에서 시작된 header 후보는 tail이 나중에 와도 그 세대 소유다.
   * 따라서 payload를 노출하지 않고 protocol/command만 알려 주어 transport가 startup
   * 알림인지, 다음 요청이 절대 소유하면 안 되는 지연 응답인지 판정하게 한다.
   */
  hasPendingFrame(): boolean {
    return this.buffer.length > 1 || this.buffer[0] === 0x47 || this.buffer[0] === 0x55;
  }

  pendingCandidate(): BioPendingCandidate | undefined {
    if (!this.hasPendingFrame()) return undefined;
    const protocol = this.buffer[0] === 0x55 && this.buffer[1] === 0xaa ? "crc16"
      : this.buffer[0] === 0x47 && this.buffer[1] === 0x53 ? "gs" : undefined;
    return {
      ...(protocol ? { protocol } : {}),
      ...(this.buffer.length >= 3 ? { command: this.buffer[2] } : {})
    };
  }
}
