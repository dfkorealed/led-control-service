import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  CAD_SCENE_MAX_POINTS_PER_PRIMITIVE,
  CAD_SCENE_MAX_SELECTED_PRIMITIVES,
  CAD_SCENE_MAX_TILE_BYTE_SIZE,
  CAD_SCENE_VERSION,
  cadScenePrimitiveSchema,
  type CadBounds,
  type CadScenePrimitive
} from "@led-control/shared";
import { MAP_DISPLAY_VERSION, mapDisplayPrimitiveSchema,
  type OrderedMapDisplayPrimitive } from "@led-control/shared";

const MAGIC = Buffer.from("CDTL", "ascii");
const HEADER_SIZE = 48;
const NULL_STRING_INDEX = 0xffff_ffff;
const MAX_UTF8_STRING_BYTES = 4 * 65_536;
const MIN_PRIMITIVE_BYTES = 106;

const primitiveTypeCode = {
  line: 1,
  polyline: 2,
  rectangle: 3,
  triangle: 4,
  ellipse: 5,
  arc: 6,
  text: 7
} as const;

export interface CadSceneTileIntegrity {
  byteSize: number;
  sha256: string;
  bounds?: CadBounds;
}
export type SceneTileDecodeExpectation = Partial<CadSceneTileIntegrity> & { version?: number };

class BinaryWriter {
  private buffer = Buffer.allocUnsafe(1_024);
  private offset = 0;

  constructor(private readonly maximumBytes: number) {}

  int32(value: number): void {
    this.ensureCapacity(4);
    this.buffer.writeInt32LE(value, this.offset);
    this.offset += 4;
  }

  uint8(value: number): void {
    this.ensureCapacity(1);
    this.buffer.writeUInt8(value, this.offset);
    this.offset += 1;
  }

  uint32(value: number): void {
    this.ensureCapacity(4);
    this.buffer.writeUInt32LE(value, this.offset);
    this.offset += 4;
  }

  float64(value: number): void {
    this.ensureCapacity(8);
    this.buffer.writeDoubleLE(value, this.offset);
    this.offset += 8;
  }

  bytes(value: Uint8Array): void {
    this.ensureCapacity(value.byteLength);
    Buffer.from(value.buffer, value.byteOffset, value.byteLength).copy(this.buffer, this.offset);
    this.offset += value.byteLength;
  }

  finish(): Buffer {
    return Buffer.from(this.buffer.subarray(0, this.offset));
  }

  private ensureCapacity(additionalBytes: number): void {
    const required = this.offset + additionalBytes;
    if (!Number.isSafeInteger(required) || required > this.maximumBytes) {
      throw new Error("CAD scene tile byte size limit exceeded");
    }
    if (required <= this.buffer.byteLength) return;
    let capacity = this.buffer.byteLength;
    while (capacity < required) capacity = Math.min(this.maximumBytes, capacity * 2);
    const next = Buffer.allocUnsafe(capacity);
    this.buffer.copy(next, 0, 0, this.offset);
    this.buffer = next;
  }
}

class BinaryReader {
  private offset = 0;

  constructor(private readonly payload: Buffer) {}

  int32(): number {
    this.require(4);
    const value = this.payload.readInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  get remaining(): number {
    return this.payload.length - this.offset;
  }

  uint8(): number {
    this.require(1);
    return this.payload.readUInt8(this.offset++);
  }

  uint32(): number {
    this.require(4);
    const value = this.payload.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  float64(): number {
    this.require(8);
    const value = this.payload.readDoubleLE(this.offset);
    this.offset += 8;
    return value;
  }

  bytes(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0) throw new Error("Invalid CAD scene tile field length");
    this.require(length);
    const value = this.payload.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  private require(length: number): void {
    if (length > this.remaining) throw new Error("CAD scene tile payload is truncated");
  }
}

function sha256(payload: Uint8Array): Buffer {
  return createHash("sha256").update(payload).digest();
}

function primitiveStrings(primitive: CadScenePrimitive): Array<string | null> {
  return [
    primitive.elementId,
    primitive.groupId,
    primitive.layerName,
    primitive.sourceType,
    primitive.style.strokeColor,
    primitive.style.fillColor,
    primitive.type === "text" ? primitive.geometry.text : null
  ];
}

function prepareCadSceneTile(input: readonly CadScenePrimitive[], validate = true, version: 1 | 2 = 1): {
  primitives: CadScenePrimitive[];
  strings: string[];
  indexOf: (value: string | null) => number;
  byteSize: number;
} {
  if (input.length > CAD_SCENE_MAX_SELECTED_PRIMITIVES) {
    throw new Error("CAD scene tile primitive limit exceeded");
  }
  const primitives: CadScenePrimitive[] = [];
  const tracker = new CadSceneTileSizeTracker(CAD_SCENE_MAX_TILE_BYTE_SIZE, version);

  for (const inputPrimitive of input) {
    const primitive = validate ? (version === 2 ? mapDisplayPrimitiveSchema : cadScenePrimitiveSchema).parse(inputPrimitive) : inputPrimitive;
    if (!tracker.tryAdd(primitive)) throw new Error("CAD scene tile byte size limit exceeded");
    primitives.push(primitive);
  }

  return {
    primitives,
    strings: tracker.stringTable,
    indexOf: value => tracker.stringIndex(value),
    byteSize: tracker.byteSize
  };
}

function encodedStringBytes(value: string): number {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MAX_UTF8_STRING_BYTES) throw new Error("CAD scene tile UTF-8 string length limit exceeded");
  return bytes;
}

function primitiveByteSize(primitive: CadScenePrimitive): number {
  const baseSize = 73 + 1 + (primitive.clipBounds === null ? 0 : 32);
  if (primitive.type === "line") return baseSize + 32;
  if (primitive.type === "polyline") return baseSize + 5 + primitive.geometry.points.length * 16;
  if (primitive.type === "rectangle") return baseSize + 40;
  if (primitive.type === "triangle") return baseSize + 48;
  if (primitive.type === "ellipse") return baseSize + 40;
  if (primitive.type === "arc") return baseSize + 41;
  return baseSize + 52;
}

export class CadSceneTileSizeTracker {
  private readonly identities = new Map<string, { zIndex: number; layerName: string; groupId: string | null }>();
  private readonly indices = new Map<string, number>();
  private readonly strings: string[] = [];
  private size = HEADER_SIZE + 4;
  private count = 0;

  constructor(private readonly maximumByteSize = CAD_SCENE_MAX_TILE_BYTE_SIZE, private readonly version: 1 | 2 = 1) {
    if (!Number.isSafeInteger(maximumByteSize) || maximumByteSize < HEADER_SIZE + 4 ||
        maximumByteSize > CAD_SCENE_MAX_TILE_BYTE_SIZE) {
      throw new Error("Invalid CAD scene tile byte size limit");
    }
  }

  get byteSize(): number {
    return this.size;
  }

  get primitiveCount(): number {
    return this.count;
  }

  get stringTable(): string[] {
    return [...this.strings];
  }

  stringIndex(value: string | null): number {
    if (value === null) return NULL_STRING_INDEX;
    const index = this.indices.get(value);
    if (index === undefined) throw new Error("Missing CAD scene tile string index");
    return index;
  }

  tryAdd(primitive: CadScenePrimitive): boolean {
    if (this.version === 2) {
      const { zIndex, fragmentOrder } = primitive as OrderedMapDisplayPrimitive;
      // Exact mapDisplayOrderingSchema scalar bounds, without a Zod result
      // allocation for every repeated sizing pass. External geometry stays parsed.
      if (!Number.isInteger(zIndex) || zIndex < -2147483648 || zIndex > 2147483647 ||
          !Number.isInteger(fragmentOrder) || fragmentOrder < 0 || fragmentOrder > 0xffffffff) {
        throw new Error("Invalid common display ordering");
      }
      const previous = this.identities.get(primitive.elementId);
      if (previous && (previous.zIndex !== zIndex || previous.layerName !== primitive.layerName || previous.groupId !== primitive.groupId)) {
        throw new Error("Conflicting common display canonical identity/ordering");
      }
    }
    const unseen: string[] = [];
    let addedBytes = primitiveByteSize(primitive) + (this.version === 2 ? 8 : 0);
    for (const value of primitiveStrings(primitive)) {
      if (value === null || this.indices.has(value) || unseen.includes(value)) continue;
      addedBytes += 4 + encodedStringBytes(value);
      unseen.push(value);
    }
    const nextSize = this.size + addedBytes;
    if (!Number.isSafeInteger(nextSize) || nextSize > this.maximumByteSize) return false;
    if (this.version === 2) this.identities.set(primitive.elementId, {
      zIndex: (primitive as OrderedMapDisplayPrimitive).zIndex, layerName: primitive.layerName, groupId: primitive.groupId
    });
    for (const value of unseen) {
      this.indices.set(value, this.strings.length);
      this.strings.push(value);
    }
    this.size = nextSize;
    this.count++;
    return true;
  }
}

export class MapDisplayTileSizeTracker extends CadSceneTileSizeTracker {
  constructor(maximumByteSize = CAD_SCENE_MAX_TILE_BYTE_SIZE) { super(maximumByteSize, MAP_DISPLAY_VERSION); }
}

export function estimateMapDisplayTileByteSize(input: readonly OrderedMapDisplayPrimitive[]): number {
  return prepareCadSceneTile(input, true, MAP_DISPLAY_VERSION).byteSize;
}

export function estimateCadSceneTileByteSize(input: readonly CadScenePrimitive[]): number {
  return prepareCadSceneTile(input).byteSize;
}

function writePoint(writer: BinaryWriter, point: { x: number; y: number }): void {
  writer.float64(point.x);
  writer.float64(point.y);
}

function writePrimitive(
  writer: BinaryWriter,
  primitive: CadScenePrimitive,
  stringIndex: (value: string | null) => number,
  version: 1 | 2
): void {
  writer.uint8(primitiveTypeCode[primitive.type]);
  writer.uint32(stringIndex(primitive.elementId));
  writer.uint32(stringIndex(primitive.groupId));
  writer.uint32(stringIndex(primitive.layerName));
  writer.uint32(stringIndex(primitive.sourceType));
  if (version === MAP_DISPLAY_VERSION) {
    writer.int32((primitive as OrderedMapDisplayPrimitive).zIndex);
    writer.uint32((primitive as OrderedMapDisplayPrimitive).fragmentOrder);
  }
  writer.float64(primitive.bounds.minX);
  writer.float64(primitive.bounds.minY);
  writer.float64(primitive.bounds.maxX);
  writer.float64(primitive.bounds.maxY);
  writer.uint8(primitive.clipBounds === null ? 0 : 1);
  if (primitive.clipBounds !== null) {
    writer.float64(primitive.clipBounds.minX);
    writer.float64(primitive.clipBounds.minY);
    writer.float64(primitive.clipBounds.maxX);
    writer.float64(primitive.clipBounds.maxY);
  }
  writer.uint32(stringIndex(primitive.style.strokeColor));
  writer.uint32(stringIndex(primitive.style.fillColor));
  writer.float64(primitive.style.strokeWidth);
  writer.float64(primitive.style.opacity);

  if (primitive.type === "line") {
    writePoint(writer, primitive.geometry.start);
    writePoint(writer, primitive.geometry.end);
  } else if (primitive.type === "polyline") {
    writer.uint32(primitive.geometry.points.length);
    writer.uint8(primitive.geometry.closed ? 1 : 0);
    primitive.geometry.points.forEach(point => writePoint(writer, point));
  } else if (primitive.type === "rectangle") {
    writePoint(writer, primitive.geometry.origin);
    writer.float64(primitive.geometry.width);
    writer.float64(primitive.geometry.height);
    writer.float64(primitive.geometry.rotation);
  } else if (primitive.type === "triangle") {
    primitive.geometry.points.forEach(point => writePoint(writer, point));
  } else if (primitive.type === "ellipse") {
    writePoint(writer, primitive.geometry.center);
    writer.float64(primitive.geometry.radiusX);
    writer.float64(primitive.geometry.radiusY);
    writer.float64(primitive.geometry.rotation);
  } else if (primitive.type === "arc") {
    writePoint(writer, primitive.geometry.center);
    writer.float64(primitive.geometry.radius);
    writer.float64(primitive.geometry.startAngle);
    writer.float64(primitive.geometry.endAngle);
    writer.uint8(primitive.geometry.counterClockwise ? 1 : 0);
  } else {
    writePoint(writer, primitive.geometry.position);
    writer.uint32(stringIndex(primitive.geometry.text));
    writer.float64(primitive.geometry.width);
    writer.float64(primitive.geometry.height);
    writer.float64(primitive.geometry.rotation);
    writer.float64(primitive.geometry.fontSize);
  }
}

function encodeCadSceneTileInternal(input: readonly CadScenePrimitive[], validate: boolean, version: 1 | 2 = 1): Buffer {
  const { primitives, strings, indexOf, byteSize: expectedSize } = prepareCadSceneTile(input, validate, version);
  const writer = new BinaryWriter(CAD_SCENE_MAX_TILE_BYTE_SIZE - HEADER_SIZE);
  writer.uint32(strings.length);
  for (const value of strings) {
    encodedStringBytes(value);
    const encoded = Buffer.from(value, "utf8");
    writer.uint32(encoded.byteLength);
    writer.bytes(encoded);
  }
  primitives.forEach(primitive => writePrimitive(writer, primitive, indexOf, version));
  const body = writer.finish();
  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header.writeUInt16LE(version, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt32LE(body.byteLength, 8);
  header.writeUInt32LE(primitives.length, 12);
  sha256(body).copy(header, 16);
  const payload = Buffer.concat([header, body], expectedSize);
  if (payload.byteLength !== expectedSize) throw new Error("CAD scene tile size estimate mismatch");
  return payload;
}

export function encodeCadSceneTile(input: readonly CadScenePrimitive[]): Buffer {
  return encodeCadSceneTileInternal(input, true);
}

/** Builder-only fast path for primitives constructed from normalized CAD data. */
export function encodeTrustedCadSceneTile(input: readonly CadScenePrimitive[]): Buffer {
  return encodeCadSceneTileInternal(input, false);
}

export function encodeMapDisplayTile(input: readonly OrderedMapDisplayPrimitive[]): Buffer {
  return encodeCadSceneTileInternal(input, true, MAP_DISPLAY_VERSION);
}

/** Geometry is builder-owned; ordering/ranges/identity are still checked. */
export function encodeTrustedMapDisplayTile(input: readonly OrderedMapDisplayPrimitive[]): Buffer {
  return encodeCadSceneTileInternal(input, false, MAP_DISPLAY_VERSION);
}

function readBoolean(reader: BinaryReader): boolean {
  const value = reader.uint8();
  if (value !== 0 && value !== 1) throw new Error("Invalid CAD scene tile boolean");
  return value === 1;
}

function readPoint(reader: BinaryReader): { x: number; y: number } {
  return { x: reader.float64(), y: reader.float64() };
}

function decodeStrings(
  reader: BinaryReader,
  count: number,
  primitiveCount: number,
  reservedPrimitiveBytes: number
): string[] {
  const maximumStringBytes = reader.remaining - reservedPrimitiveBytes;
  const maximumCount = Math.min(primitiveCount * 7 + 1, Math.floor(maximumStringBytes / 4));
  if (count > maximumCount) throw new Error("CAD scene tile string table limit exceeded");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const strings: string[] = [];
  for (let index = 0; index < count; index++) {
    const length = reader.uint32();
    if (length > MAX_UTF8_STRING_BYTES || length > reader.remaining - reservedPrimitiveBytes) {
      throw new Error("CAD scene tile string length limit exceeded");
    }
    strings.push(decoder.decode(reader.bytes(length)));
  }
  return strings;
}

function stringAt(strings: readonly string[], index: number, nullable = false): string | null {
  if (nullable && index === NULL_STRING_INDEX) return null;
  const value = strings[index];
  if (value === undefined) throw new Error("Invalid CAD scene tile string reference");
  return value;
}

function readBase(reader: BinaryReader, strings: readonly string[], version: 1 | 2) {
  const elementId = stringAt(strings, reader.uint32())!;
  const groupId = stringAt(strings, reader.uint32(), true);
  const layerName = stringAt(strings, reader.uint32())!;
  const sourceType = stringAt(strings, reader.uint32())!;
  const ordering = version === MAP_DISPLAY_VERSION ? { zIndex: reader.int32(), fragmentOrder: reader.uint32() } : {};
  const bounds = {
    minX: reader.float64(),
    minY: reader.float64(),
    maxX: reader.float64(),
    maxY: reader.float64()
  };
  const hasClipBounds = readBoolean(reader);
  const clipBounds = hasClipBounds ? {
    minX: reader.float64(),
    minY: reader.float64(),
    maxX: reader.float64(),
    maxY: reader.float64()
  } : null;
  return {
    ...ordering,
    elementId,
    groupId,
    layerName,
    sourceType,
    bounds,
    clipBounds,
    style: {
      strokeColor: stringAt(strings, reader.uint32(), true),
      fillColor: stringAt(strings, reader.uint32(), true),
      strokeWidth: reader.float64(),
      opacity: reader.float64()
    }
  };
}

function readPrimitive(reader: BinaryReader, strings: readonly string[], version: 1 | 2): CadScenePrimitive {
  const type = reader.uint8();
  const base = readBase(reader, strings, version);
  let primitive: unknown;
  if (type === primitiveTypeCode.line) {
    primitive = { ...base, type: "line", geometry: { start: readPoint(reader), end: readPoint(reader) } };
  } else if (type === primitiveTypeCode.polyline) {
    const pointCount = reader.uint32();
    if (pointCount < 2 || pointCount > CAD_SCENE_MAX_POINTS_PER_PRIMITIVE) {
      throw new Error("Invalid CAD scene tile polyline point count");
    }
    const closed = readBoolean(reader);
    const points = Array.from({ length: pointCount }, () => readPoint(reader));
    primitive = { ...base, type: "polyline", geometry: { points, closed } };
  } else if (type === primitiveTypeCode.rectangle) {
    primitive = {
      ...base,
      type: "rectangle",
      geometry: {
        origin: readPoint(reader),
        width: reader.float64(),
        height: reader.float64(),
        rotation: reader.float64()
      }
    };
  } else if (type === primitiveTypeCode.triangle) {
    primitive = {
      ...base,
      type: "triangle",
      geometry: { points: [readPoint(reader), readPoint(reader), readPoint(reader)] }
    };
  } else if (type === primitiveTypeCode.ellipse) {
    primitive = {
      ...base,
      type: "ellipse",
      geometry: {
        center: readPoint(reader),
        radiusX: reader.float64(),
        radiusY: reader.float64(),
        rotation: reader.float64()
      }
    };
  } else if (type === primitiveTypeCode.arc) {
    primitive = {
      ...base,
      type: "arc",
      geometry: {
        center: readPoint(reader),
        radius: reader.float64(),
        startAngle: reader.float64(),
        endAngle: reader.float64(),
        counterClockwise: readBoolean(reader)
      }
    };
  } else if (type === primitiveTypeCode.text) {
    primitive = {
      ...base,
      type: "text",
      geometry: {
        position: readPoint(reader),
        text: stringAt(strings, reader.uint32())!,
        width: reader.float64(),
        height: reader.float64(),
        rotation: reader.float64(),
        fontSize: reader.float64()
      }
    };
  } else {
    throw new Error(`Unsupported CAD scene tile primitive type: ${type}`);
  }
  return (version === MAP_DISPLAY_VERSION ? mapDisplayPrimitiveSchema : cadScenePrimitiveSchema).parse(primitive);
}

export function getCadSceneTileIntegrity(payload: Uint8Array): CadSceneTileIntegrity {
  return {
    byteSize: payload.byteLength,
    sha256: sha256(payload).toString("hex")
  };
}

export function decodeCadSceneTile(
  input: Uint8Array,
  expectedIntegrity?: SceneTileDecodeExpectation
): CadScenePrimitive[] {
  return decodeSceneTile(input, expectedIntegrity, CAD_SCENE_VERSION);
}

export function decodeMapDisplayTile(input: Uint8Array, expectedIntegrity?: SceneTileDecodeExpectation): OrderedMapDisplayPrimitive[] {
  return decodeSceneTile(input, expectedIntegrity, MAP_DISPLAY_VERSION) as OrderedMapDisplayPrimitive[];
}

function decodeSceneTile(input: Uint8Array, expectedIntegrity: SceneTileDecodeExpectation | undefined, expectedVersion: 1 | 2): CadScenePrimitive[] {
  const payload = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (payload.byteLength > CAD_SCENE_MAX_TILE_BYTE_SIZE) {
    throw new Error("CAD scene tile byte size limit exceeded");
  }
  if (expectedIntegrity?.byteSize !== undefined && payload.byteLength !== expectedIntegrity.byteSize) {
    throw new Error("CAD scene tile byte size mismatch");
  }
  if (expectedIntegrity?.sha256 !== undefined) {
    const expected = Buffer.from(expectedIntegrity.sha256, "hex");
    const actual = sha256(payload);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new Error("CAD scene tile SHA-256 mismatch");
    }
  }
  if (payload.byteLength < HEADER_SIZE) throw new Error("CAD scene tile payload is truncated");
  if (!payload.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Invalid CAD scene tile magic");
  const version = payload.readUInt16LE(4);
  if (version !== expectedVersion || (expectedIntegrity?.version !== undefined && version !== expectedIntegrity.version)) {
    throw new Error(`Unsupported or mismatched scene tile version: ${version}`);
  }
  if (payload.readUInt16LE(6) !== 0) throw new Error("Unsupported CAD scene tile flags");
  const bodyLength = payload.readUInt32LE(8);
  const primitiveCount = payload.readUInt32LE(12);
  if (primitiveCount > CAD_SCENE_MAX_SELECTED_PRIMITIVES) {
    throw new Error("CAD scene tile primitive limit exceeded");
  }
  if (bodyLength !== payload.byteLength - HEADER_SIZE) throw new Error("CAD scene tile payload length mismatch");
  const body = payload.subarray(HEADER_SIZE);
  if (!timingSafeEqual(payload.subarray(16, HEADER_SIZE), sha256(body))) {
    throw new Error("CAD scene tile body integrity check failed");
  }

  const reader = new BinaryReader(body);
  const stringCount = reader.uint32();
  const reservedPrimitiveBytes = primitiveCount * (MIN_PRIMITIVE_BYTES + (version === 2 ? 8 : 0));
  if (!Number.isSafeInteger(reservedPrimitiveBytes) || reservedPrimitiveBytes > reader.remaining) {
    throw new Error("CAD scene tile primitive count exceeds payload capacity");
  }
  const strings = decodeStrings(reader, stringCount, primitiveCount, reservedPrimitiveBytes);
  const primitives: CadScenePrimitive[] = [];
  const identityTracker = version === 2 ? new MapDisplayTileSizeTracker() : null;
  for (let index = 0; index < primitiveCount; index++) {
    const primitive = readPrimitive(reader, strings, expectedVersion);
    if (identityTracker && !identityTracker.tryAdd(primitive)) throw new Error("Common display tile byte size limit exceeded");
    primitives.push(primitive);
  }
  if (reader.remaining !== 0) throw new Error("CAD scene tile payload has trailing bytes");
  if (expectedIntegrity?.bounds) {
    const tileBounds = expectedIntegrity.bounds;
    for (const primitive of primitives) {
      const bounds = primitive.bounds;
      if (bounds.minX < tileBounds.minX || bounds.minY < tileBounds.minY ||
          bounds.maxX > tileBounds.maxX || bounds.maxY > tileBounds.maxY) {
        throw new Error("CAD scene primitive bounds exceed tile bounds");
      }
      const clip = primitive.clipBounds;
      if (clip !== null && (clip.minX !== tileBounds.minX || clip.minY !== tileBounds.minY ||
          clip.maxX !== tileBounds.maxX || clip.maxY !== tileBounds.maxY)) {
        throw new Error("CAD scene primitive clip bounds must match tile bounds");
      }
    }
  }
  return primitives;
}
