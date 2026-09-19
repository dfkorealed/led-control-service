import { createHash, timingSafeEqual } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { MapAssetRef, MapElement, mapElementSchema, MAP_DOCUMENT_MAX_SELECTED_ELEMENTS } from "@led-control/shared";

export const MAP_CHUNK_MAX_BYTES = 8 * 1024 * 1024;
export const MAP_DOCUMENT_MAX_BYTES = 512 * 1024 * 1024;
export const MAP_ENCODED_MAX_BYTES = MAP_CHUNK_MAX_BYTES + 65_536;
const HEADER_BYTES = 40;
const MAGIC = Buffer.from("MDC1");
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The envelope version is a file format, not a document generation/revision.
 * No HTTP Content-Encoding: gzip is set: the compressed body has a binary header.
 */
export function encodeMapPayload(decoded: Uint8Array): Buffer {
  if (decoded.byteLength < 1 || decoded.byteLength > MAP_CHUNK_MAX_BYTES) throw new Error("map decoded byte budget exceeded");
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header);
  header.writeUInt32BE(decoded.byteLength, 4);
  createHash("sha256").update(decoded).digest().copy(header, 8);
  const result = Buffer.concat([header, gzipSync(decoded)]);
  if (result.length > MAP_ENCODED_MAX_BYTES) throw new Error("map encoded byte budget exceeded");
  return result;
}

export function decodeMapPayload(bytes: Uint8Array, expected?: Pick<MapAssetRef, "byteSize" | "decodedByteSize" | "sha256">): Buffer {
  if (bytes.byteLength <= HEADER_BYTES || bytes.byteLength > MAP_ENCODED_MAX_BYTES) throw new Error("invalid map encoded length");
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!buffer.subarray(0, 4).equals(MAGIC)) throw new Error("invalid map format");
  const decodedSize = buffer.readUInt32BE(4);
  if (decodedSize < 1 || decodedSize > MAP_CHUNK_MAX_BYTES) throw new Error("map decoded byte budget exceeded");
  if (expected && (expected.byteSize !== buffer.length || expected.decodedByteSize !== decodedSize ||
    createHash("sha256").update(buffer).digest("hex") !== expected.sha256)) throw new Error("map asset integrity mismatch");
  // Bound inflation using the untrusted declared size AND the hard format ceiling.
  const decoded = gunzipSync(buffer.subarray(HEADER_BYTES), { maxOutputLength: decodedSize });
  if (decoded.length !== decodedSize || !timingSafeEqual(createHash("sha256").update(decoded).digest(), buffer.subarray(8, 40))) {
    throw new Error("map decoded integrity mismatch");
  }
  return decoded;
}

export function parseMapJson(bytes: Uint8Array): unknown { return JSON.parse(utf8.decode(bytes)); }

export function validateMapChunk(value: unknown): MapElement[] {
  if (!Array.isArray(value) || value.length > MAP_DOCUMENT_MAX_SELECTED_ELEMENTS) throw new Error("invalid map chunk elements");
  const ids = new Set<string>();
  return value.map(input => {
    const element = mapElementSchema.parse(input);
    if (ids.has(element.id)) throw new Error("duplicate map element ID");
    ids.add(element.id);
    return element;
  });
}

export function encodeMapChunk(elements: MapElement[]): Uint8Array {
  if (!Array.isArray(elements) || elements.length > MAP_DOCUMENT_MAX_SELECTED_ELEMENTS) throw new Error("invalid map chunk elements");
  const parts: string[] = [];
  const ids = new Set<string>();
  let size = 2;
  for (const input of elements) {
    const element = mapElementSchema.parse(input);
    if (ids.has(element.id)) throw new Error("duplicate map element ID");
    const serialized = JSON.stringify(element);
    size += Buffer.byteLength(serialized) + (parts.length ? 1 : 0);
    if (size > MAP_CHUNK_MAX_BYTES) throw new Error("map decoded byte budget exceeded");
    ids.add(element.id); parts.push(serialized);
  }
  return encodeMapPayload(Buffer.from(`[${parts.join(",")}]`));
}

export function decodeMapChunk(bytes: Uint8Array): MapElement[] {
  return validateMapChunk(parseMapJson(decodeMapPayload(bytes)));
}
