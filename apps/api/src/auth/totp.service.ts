import { Injectable } from "@nestjs/common";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const PERIOD_SECONDS = 30;

@Injectable()
export class TotpService {
  generateSecret() {
    return this.encodeBase32(randomBytes(20));
  }

  buildUri(secret: string, loginId: string) {
    const issuer = "DF Korea LED Control";
    const label = `${issuer}:${loginId}`;
    return `otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${PERIOD_SECONDS}`;
  }

  verify(secret: string, candidate: string, nowMs = Date.now()) {
    if (!/^\d{6}$/.test(candidate)) return false;
    for (const offset of [-1, 0, 1]) {
      const expected = this.codeAt(secret, nowMs + offset * PERIOD_SECONDS * 1_000);
      if (timingSafeEqual(Buffer.from(candidate), Buffer.from(expected))) return true;
    }
    return false;
  }

  codeAt(secret: string, nowMs: number, digits = 6) {
    const counter = Math.floor(nowMs / 1_000 / PERIOD_SECONDS);
    const message = Buffer.alloc(8);
    message.writeBigUInt64BE(BigInt(counter));
    const digest = createHmac("sha1", this.decodeBase32(secret)).update(message).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const binary = ((digest[offset] & 0x7f) << 24)
      | ((digest[offset + 1] & 0xff) << 16)
      | ((digest[offset + 2] & 0xff) << 8)
      | (digest[offset + 3] & 0xff);
    return String(binary % (10 ** digits)).padStart(digits, "0");
  }

  private encodeBase32(input: Buffer) {
    let bits = 0;
    let value = 0;
    let output = "";
    for (const byte of input) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        output += ALPHABET[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
    return output;
  }

  private decodeBase32(input: string) {
    const normalized = input.trim().toUpperCase().replace(/=+$/, "");
    if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) throw new Error("Invalid Base32 secret");
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];
    for (const character of normalized) {
      value = (value << 5) | ALPHABET.indexOf(character);
      bits += 5;
      if (bits >= 8) {
        bytes.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    return Buffer.from(bytes);
  }
}
