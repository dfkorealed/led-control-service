import { getMobileFileChunkByteLength } from '@led-control/shared/mobile-webview-contracts';
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decode one bounded chunk without Node Buffer or browser globals (Hermes compatible). */
export function decodeChunk(value: string): Uint8Array {
  const size = getMobileFileChunkByteLength(value);
  const bytes = new Uint8Array(size);
  let output = 0;
  for (let i = 0; i < value.length; i += 4) {
    const a = alphabet.indexOf(value[i]); const b = alphabet.indexOf(value[i + 1]);
    const c = value[i + 2] === '=' ? 0 : alphabet.indexOf(value[i + 2]);
    const d = value[i + 3] === '=' ? 0 : alphabet.indexOf(value[i + 3]);
    const packed = (a << 18) | (b << 12) | (c << 6) | d;
    if (output < size) bytes[output++] = (packed >> 16) & 255;
    if (output < size) bytes[output++] = (packed >> 8) & 255;
    if (output < size) bytes[output++] = packed & 255;
  }
  return bytes;
}
