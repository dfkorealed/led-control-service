export type BioProtocol = "crc16" | "gs";
export interface BioFrame {
  protocol: BioProtocol;
  command: number;
  payload: Buffer;
}
export type BioFrameEvent =
  | { type: "frame"; frame: BioFrame }
  | { type: "malformed"; reason: string };

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
}
