import type { CadBounds, CadElementOverride, CadElementTransform, CadScenePrimitive, CadSceneTile } from "@led-control/shared";
import earcut from "earcut";
import { CadDisplayStrokeAccumulator } from "./cad-scene-display";
import { packCadDisplayText } from "./cad-scene-text-layout";

const CAD_SCENE_VERSION = 1;
const CAD_SCENE_MAX_TILE_BYTE_SIZE = 16 * 1_024 * 1_024;
const CAD_SCENE_MAX_SELECTED_PRIMITIVES = 500_000;
const CAD_SCENE_MAX_POINTS_PER_PRIMITIVE = 65_536;
const HEADER_SIZE = 48;
const NULL_STRING_INDEX = 0xffff_ffff;
const MAX_UTF8_STRING_BYTES = 4 * 65_536;
const MIN_PRIMITIVE_BYTES = 106;

export interface CadGeometrySpan {
  elementId: string;
  groupId: string | null;
  indexStart: number;
  indexCount: number;
}

export interface CadGeometryBatch {
  styleKey: string;
  layerName: string;
  color: string;
  opacity: number;
  positions: Float32Array;
  indices: Uint32Array;
  spans: CadGeometrySpan[];
}

export interface CadPickEntry {
  elementId: string;
  groupId: string | null;
  layerName: string;
  bounds: CadBounds;
  zOrder: number;
  pointStart: number;
  pointCount: number;
  closed: boolean;
  filled: boolean;
  strokeWidth: number;
}

export interface CadGeometryBuildResult {
  batches: CadGeometryBatch[];
  textBatches: CadTextBatch[];
  pickEntries: CadPickEntry[];
  pickPoints: Float32Array;
  spatialIndex: CadSpatialIndex;
  memory: CadSceneMemoryEstimate;
}

export interface CadSceneMemoryEstimate {
  cpuBytes: number;
  gpuBytes: number;
  textAtlasBytes: number;
}

export interface CadTextEntry {
  elementId: string;
  groupId: string | null;
  text: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  rotation: number;
  fontSize: number;
  bounds: CadBounds;
  clipBounds: CadBounds | null;
}

export interface CadTextBatch {
  styleKey: string;
  layerName: string;
  color: string;
  opacity: number;
  entries: CadTextEntry[];
  fontPixelSize?: number;
}

export interface CadSpatialIndex {
  cellSize: number;
  buckets: Record<string, Uint32Array>;
}

export interface DecodedCadSceneTile extends CadGeometryBuildResult {
  descriptor: CadSceneTile;
  byteSize: number;
}

export interface CadSceneWorkerClient {
  decode(payload: Uint8Array, descriptor: CadSceneTile, quality?: CadSceneDisplayQuality): Promise<DecodedCadSceneTile>;
  decodeSource?(payload: Uint8Array, descriptor: CadSceneTile): Promise<DecodedCadSceneTile>;
  destroy(): void;
}

export interface CadSceneDisplayQuality {
  /** Upper edge of a reusable zoom band, in CSS pixels per world unit. */
  zoomBand: number;
  maxErrorPixels: number;
  excludedIds: readonly string[];
  overrides?: readonly CadElementOverride[];
  /** Display readability only; never changes the persisted CAD stroke. */
  minimumStrokePixels?: number;
}

class BinaryReader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly payload: Uint8Array) {
    this.view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  }

  get remaining(): number {
    return this.payload.byteLength - this.offset;
  }

  uint8(): number {
    this.require(1);
    return this.view.getUint8(this.offset++);
  }

  uint16(): number {
    this.require(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  uint32(): number {
    this.require(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  float64(): number {
    this.require(8);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    if (!Number.isFinite(value)) throw new Error("Invalid CAD scene tile number");
    return value;
  }

  bytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0) throw new Error("Invalid CAD scene tile field length");
    this.require(length);
    const result = this.payload.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  private require(length: number): void {
    if (length > this.remaining) throw new Error("CAD scene tile payload is truncated");
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function sha256(payload: Uint8Array): Promise<Uint8Array> {
  const copy = payload.slice();
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy));
}

function toHex(payload: Uint8Array): string {
  let result = "";
  for (const value of payload) result += value.toString(16).padStart(2, "0");
  return result;
}

function readBoolean(reader: BinaryReader): boolean {
  const value = reader.uint8();
  if (value !== 0 && value !== 1) throw new Error("Invalid CAD scene tile boolean");
  return value === 1;
}

function readPoint(reader: BinaryReader): { x: number; y: number } {
  return { x: reader.float64(), y: reader.float64() };
}

function readBounds(reader: BinaryReader): CadBounds {
  const bounds = {
    minX: reader.float64(),
    minY: reader.float64(),
    maxX: reader.float64(),
    maxY: reader.float64()
  };
  if (bounds.minX > bounds.maxX || bounds.minY > bounds.maxY) {
    throw new Error("Invalid CAD scene tile bounds");
  }
  return bounds;
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

function readPrimitive(reader: BinaryReader, strings: readonly string[]): CadScenePrimitive {
  const type = reader.uint8();
  const elementId = stringAt(strings, reader.uint32())!;
  const groupId = stringAt(strings, reader.uint32(), true);
  const layerName = stringAt(strings, reader.uint32())!;
  const sourceType = stringAt(strings, reader.uint32())!;
  const bounds = readBounds(reader);
  const clipBounds = readBoolean(reader) ? readBounds(reader) : null;
  const style = {
    strokeColor: stringAt(strings, reader.uint32(), true),
    fillColor: stringAt(strings, reader.uint32(), true),
    strokeWidth: reader.float64(),
    opacity: reader.float64()
  };
  if (style.strokeWidth < 0 || style.opacity < 0 || style.opacity > 1) {
    throw new Error("Invalid CAD scene tile primitive style");
  }
  const base = { elementId, groupId, layerName, sourceType, bounds, clipBounds, style };

  if (type === 1) {
    return { ...base, type: "line", geometry: { start: readPoint(reader), end: readPoint(reader) } };
  }
  if (type === 2) {
    const pointCount = reader.uint32();
    if (pointCount < 2 || pointCount > CAD_SCENE_MAX_POINTS_PER_PRIMITIVE) {
      throw new Error("Invalid CAD scene tile polyline point count");
    }
    const closed = readBoolean(reader);
    const points = Array.from({ length: pointCount }, () => readPoint(reader));
    return { ...base, type: "polyline", geometry: { points, closed } };
  }
  if (type === 3) {
    const origin = readPoint(reader);
    const width = reader.float64();
    const height = reader.float64();
    const rotation = reader.float64();
    if (width <= 0 || height <= 0) throw new Error("Invalid CAD scene tile rectangle size");
    return { ...base, type: "rectangle", geometry: { origin, width, height, rotation } };
  }
  if (type === 4) {
    return {
      ...base,
      type: "triangle",
      geometry: { points: [readPoint(reader), readPoint(reader), readPoint(reader)] }
    };
  }
  if (type === 5) {
    const center = readPoint(reader);
    const radiusX = reader.float64();
    const radiusY = reader.float64();
    const rotation = reader.float64();
    if (radiusX <= 0 || radiusY <= 0) throw new Error("Invalid CAD scene tile ellipse radius");
    return { ...base, type: "ellipse", geometry: { center, radiusX, radiusY, rotation } };
  }
  if (type === 6) {
    const center = readPoint(reader);
    const radius = reader.float64();
    const startAngle = reader.float64();
    const endAngle = reader.float64();
    const counterClockwise = readBoolean(reader);
    if (radius <= 0) throw new Error("Invalid CAD scene tile arc radius");
    return { ...base, type: "arc", geometry: { center, radius, startAngle, endAngle, counterClockwise } };
  }
  if (type === 7) {
    const position = readPoint(reader);
    const text = stringAt(strings, reader.uint32())!;
    const width = reader.float64();
    const height = reader.float64();
    const rotation = reader.float64();
    const fontSize = reader.float64();
    if (width < 0 || height < 0 || fontSize <= 0) throw new Error("Invalid CAD scene tile text size");
    return { ...base, type: "text", geometry: { position, text, width, height, rotation, fontSize } };
  }
  throw new Error(`Unsupported CAD scene tile primitive type: ${type}`);
}

export async function decodeCadSceneTilePayload(
  payload: Uint8Array,
  descriptor: CadSceneTile
): Promise<CadScenePrimitive[]> {
  if (payload.byteLength > CAD_SCENE_MAX_TILE_BYTE_SIZE) {
    throw new Error("CAD scene tile byte size limit exceeded");
  }
  if (payload.byteLength !== descriptor.byteSize) throw new Error("CAD scene tile byte size mismatch");
  const payloadHash = await sha256(payload);
  if (toHex(payloadHash) !== descriptor.sha256) throw new Error("CAD scene tile SHA-256 mismatch");
  if (payload.byteLength < HEADER_SIZE) throw new Error("CAD scene tile payload is truncated");

  const header = new BinaryReader(payload.subarray(0, HEADER_SIZE));
  const magic = new TextDecoder("ascii").decode(header.bytes(4));
  if (magic !== "CDTL") throw new Error("Invalid CAD scene tile magic");
  const version = header.uint16();
  if (version !== CAD_SCENE_VERSION || version !== descriptor.version) {
    throw new Error(`Unsupported CAD scene tile version: ${version}`);
  }
  if (header.uint16() !== 0) throw new Error("Unsupported CAD scene tile flags");
  const bodyLength = header.uint32();
  const primitiveCount = header.uint32();
  if (primitiveCount !== descriptor.primitiveCount) throw new Error("CAD scene tile primitive count mismatch");
  if (primitiveCount > CAD_SCENE_MAX_SELECTED_PRIMITIVES) {
    throw new Error("CAD scene tile primitive limit exceeded");
  }
  if (bodyLength !== payload.byteLength - HEADER_SIZE) throw new Error("CAD scene tile payload length mismatch");
  const expectedBodyHash = header.bytes(32);
  const body = payload.subarray(HEADER_SIZE);
  if (!bytesEqual(expectedBodyHash, await sha256(body))) {
    throw new Error("CAD scene tile body integrity check failed");
  }

  const reader = new BinaryReader(body);
  const stringCount = reader.uint32();
  const reservedPrimitiveBytes = primitiveCount * MIN_PRIMITIVE_BYTES;
  if (!Number.isSafeInteger(reservedPrimitiveBytes) || reservedPrimitiveBytes > reader.remaining) {
    throw new Error("CAD scene tile primitive count exceeds payload capacity");
  }
  const strings = decodeStrings(reader, stringCount, primitiveCount, reservedPrimitiveBytes);
  const primitives: CadScenePrimitive[] = [];
  for (let index = 0; index < primitiveCount; index++) primitives.push(readPrimitive(reader, strings));
  if (reader.remaining !== 0) throw new Error("CAD scene tile payload has trailing bytes");

  for (const primitive of primitives) {
    const bounds = primitive.bounds;
    if (bounds.minX < descriptor.bounds.minX || bounds.minY < descriptor.bounds.minY ||
        bounds.maxX > descriptor.bounds.maxX || bounds.maxY > descriptor.bounds.maxY) {
      throw new Error("CAD scene primitive bounds exceed tile bounds");
    }
    const clip = primitive.clipBounds;
    if (clip !== null && (clip.minX !== descriptor.bounds.minX || clip.minY !== descriptor.bounds.minY ||
        clip.maxX !== descriptor.bounds.maxX || clip.maxY !== descriptor.bounds.maxY)) {
      throw new Error("CAD scene primitive clip bounds must match tile bounds");
    }
  }
  return primitives;
}

interface MutableBatch {
  styleKey: string;
  layerName: string;
  color: string;
  opacity: number;
  positions: number[];
  indices: number[];
  spans: CadGeometrySpan[];
}

interface Point {
  x: number;
  y: number;
}

function rotatePoint(point: Point, origin: Point, rotationDegrees: number): Point {
  const radians = rotationDegrees * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: origin.x + point.x * cosine - point.y * sine,
    y: origin.y + point.x * sine + point.y * cosine
  };
}

function rectanglePoints(primitive: Extract<CadScenePrimitive, { type: "rectangle" }>): Point[] {
  const { origin, width, height, rotation } = primitive.geometry;
  return [
    rotatePoint({ x: 0, y: 0 }, origin, rotation),
    rotatePoint({ x: width, y: 0 }, origin, rotation),
    rotatePoint({ x: width, y: height }, origin, rotation),
    rotatePoint({ x: 0, y: height }, origin, rotation)
  ];
}

function textBoundsPoints(primitive: Extract<CadScenePrimitive, { type: "text" }>): Point[] {
  const { position, width, height, rotation } = primitive.geometry;
  return [
    rotatePoint({ x: 0, y: -height }, position, rotation),
    rotatePoint({ x: width, y: -height }, position, rotation),
    rotatePoint({ x: width, y: 0 }, position, rotation),
    rotatePoint({ x: 0, y: 0 }, position, rotation)
  ];
}

function sampledCurvePoints(primitive: Extract<CadScenePrimitive, { type: "ellipse" | "arc" }>, error?: number): Point[] {
  // Allocate half the display error to chord deviation, leaving room for
  // coordinate quantization. Exact decoding retains its established sampling.
  const segments = (radius: number, sweep: number, fallback: number) => error === undefined ? fallback
    : Math.max(2, Math.ceil(sweep / (2 * Math.acos(Math.max(-1, 1 - Math.min(radius, error / 2) / Math.max(radius, 1e-9))))));
  if (primitive.type === "ellipse") {
    const { center, radiusX, radiusY, rotation } = primitive.geometry;
    const segmentCount = segments(Math.max(radiusX, radiusY), Math.PI * 2, Math.max(12, Math.min(96, Math.ceil(Math.max(radiusX, radiusY) / 8))));
    return Array.from({ length: segmentCount }, (_, index) => {
      const angle = index / segmentCount * Math.PI * 2;
      return rotatePoint(
        { x: radiusX * Math.cos(angle), y: radiusY * Math.sin(angle) },
        center,
        rotation
      );
    });
  }
  const { center, radius, startAngle, endAngle, counterClockwise } = primitive.geometry;
  const normalize = (value: number) => ((value % 360) + 360) % 360;
  const start = normalize(startAngle);
  const end = normalize(endAngle);
  const positiveSweep = (end - start + 360) % 360 || 360;
  const sweep = counterClockwise ? positiveSweep : -(360 - positiveSweep || 360);
  const segmentCount = segments(radius, Math.abs(sweep) * Math.PI / 180, Math.max(4, Math.min(96, Math.ceil(Math.abs(sweep) / 12))));
  return Array.from({ length: segmentCount + 1 }, (_, index) => {
    const radians = (start + sweep * index / segmentCount) * Math.PI / 180;
    return { x: center.x + radius * Math.cos(radians), y: center.y + radius * Math.sin(radians) };
  });
}

function mutableBatch(
  batches: Map<string, MutableBatch>,
  layerName: string,
  drawKind: "fill" | "stroke",
  color: string,
  opacity: number,
  strokeWidth: number
): MutableBatch {
  const styleKey = JSON.stringify([
    layerName,
    drawKind,
    color,
    opacity,
    drawKind === "stroke" ? strokeWidth : 0
  ]);
  const existing = batches.get(styleKey);
  if (existing) return existing;
  const created = { styleKey, layerName, color, opacity, positions: [], indices: [], spans: [] };
  batches.set(styleKey, created);
  return created;
}

function addPolygon(batch: MutableBatch, points: readonly Point[], primitive: CadScenePrimitive): void {
  const clippedPoints = primitive.clipBounds ? clipPolygon(points, primitive.clipBounds) : [...points];
  if (clippedPoints.length < 3) return;
  const vertexOffset = batch.positions.length / 2;
  const indexStart = batch.indices.length;
  for (const point of clippedPoints) batch.positions.push(point.x, point.y);
  const triangulated = earcut(clippedPoints.flatMap(point => [point.x, point.y]));
  for (const index of triangulated) batch.indices.push(vertexOffset + index);
  batch.spans.push({
    elementId: primitive.elementId,
    groupId: primitive.groupId,
    indexStart,
    indexCount: batch.indices.length - indexStart
  });
}

function addStroke(
  batch: MutableBatch,
  points: readonly Point[],
  closed: boolean,
  strokeWidth: number,
  primitive: CadScenePrimitive,
  display?: CadDisplayStrokeAccumulator
): void {
  if (points.length < 2 || strokeWidth <= 0) return;
  const indexStart = batch.indices.length;
  const segmentCount = closed ? points.length : points.length - 1;
  for (let index = 0; index < segmentCount; index++) {
    const rawStart = points[index];
    const rawEnd = points[(index + 1) % points.length];
    const clipped = primitive.clipBounds
      ? clipSegment(rawStart, rawEnd, primitive.clipBounds)
      : { start: rawStart, end: rawEnd };
    if (!clipped) continue;
    const { start, end } = clipped;
    if (display) {
      display.add(start, end);
      continue;
    }
    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    const length = Math.hypot(deltaX, deltaY);
    if (length === 0) continue;
    const normalX = -deltaY / length * strokeWidth / 2;
    const normalY = deltaX / length * strokeWidth / 2;
    const vertexOffset = batch.positions.length / 2;
    batch.positions.push(
      start.x + normalX, start.y + normalY,
      start.x - normalX, start.y - normalY,
      end.x - normalX, end.y - normalY,
      end.x + normalX, end.y + normalY
    );
    batch.indices.push(
      vertexOffset, vertexOffset + 1, vertexOffset + 2,
      vertexOffset, vertexOffset + 2, vertexOffset + 3
    );
  }
  const indexCount = batch.indices.length - indexStart;
  if (indexCount > 0 && !display) {
    batch.spans.push({ elementId: primitive.elementId, groupId: primitive.groupId, indexStart, indexCount });
  }
}

function primitivePoints(primitive: CadScenePrimitive, error?: number): { points: Point[]; closed: boolean } {
  if (primitive.type === "line") return { points: [primitive.geometry.start, primitive.geometry.end], closed: false };
  if (primitive.type === "polyline") {
    return { points: primitive.geometry.points, closed: primitive.geometry.closed };
  }
  if (primitive.type === "rectangle") return { points: rectanglePoints(primitive), closed: true };
  if (primitive.type === "triangle") return { points: primitive.geometry.points, closed: true };
  if (primitive.type === "ellipse") return { points: sampledCurvePoints(primitive, error), closed: true };
  if (primitive.type === "arc") return { points: sampledCurvePoints(primitive, error), closed: false };
  return { points: [], closed: false };
}

function displayOverride(primitive: CadScenePrimitive, override: CadElementOverride, error: number): CadScenePrimitive {
  const style = {
    ...primitive.style,
    strokeColor: override.strokeColor ?? primitive.style.strokeColor,
    fillColor: override.fillColor ?? primitive.style.fillColor,
    strokeWidth: override.strokeWidth ?? primitive.style.strokeWidth
  };
  const transform = override.transform;
  const base = { ...primitive, style };
  if (!transform) return primitive.type === "text"
    ? { ...primitive, style, geometry: { ...primitive.geometry, text: override.text ?? primitive.geometry.text } }
    : base;
  const point = (value: Point) => displayTransformPoint(value, transform);
  const bounds = (value: CadBounds): CadBounds => {
    const corners = [{ x: value.minX, y: value.minY }, { x: value.maxX, y: value.minY },
      { x: value.maxX, y: value.maxY }, { x: value.minX, y: value.maxY }].map(point);
    return { minX: Math.min(...corners.map(p => p.x)), minY: Math.min(...corners.map(p => p.y)),
      maxX: Math.max(...corners.map(p => p.x)), maxY: Math.max(...corners.map(p => p.y)) };
  };
  const transformed = { ...base, bounds: bounds(primitive.bounds), clipBounds: primitive.clipBounds ? bounds(primitive.clipBounds) : null };
  if (primitive.type === "text") return {
    ...transformed, type: "text", geometry: {
      ...primitive.geometry, text: override.text ?? primitive.geometry.text,
      position: point(primitive.geometry.position),
      width: primitive.geometry.width * Math.abs(transform.scaleX),
      height: primitive.geometry.height * Math.abs(transform.scaleY),
      fontSize: primitive.geometry.fontSize * Math.max(Math.abs(transform.scaleX), Math.abs(transform.scaleY)),
      rotation: primitive.geometry.rotation + transform.rotation
    }
  };
  const geometry = primitivePoints(primitive, error / Math.max(Math.abs(transform.scaleX), Math.abs(transform.scaleY)));
  return { ...transformed, type: "polyline", geometry: { points: geometry.points.map(point), closed: geometry.closed } };
}

function displayTransformPoint(point: Point, transform: CadElementTransform): Point {
  const radians = transform.rotation * Math.PI / 180;
  const x = point.x * transform.scaleX;
  const y = point.y * transform.scaleY;
  return { x: transform.translateX + x * Math.cos(radians) - y * Math.sin(radians),
    y: transform.translateY + x * Math.sin(radians) + y * Math.cos(radians) };
}

export function buildCadGeometryBatches(primitives: readonly CadScenePrimitive[], quality?: CadSceneDisplayQuality,
  options: { includePickIndex?: boolean } = {}): CadGeometryBuildResult {
  if (quality && (!(quality.zoomBand > 0) || !Number.isFinite(quality.zoomBand) || !(quality.maxErrorPixels > 0) || !Number.isFinite(quality.maxErrorPixels))) {
    throw new Error("Invalid CAD display quality");
  }
  const error = quality ? quality.maxErrorPixels / quality.zoomBand : undefined;
  const quantum = error === undefined ? 0 : error / 2;
  const excluded = new Set(quality?.excludedIds);
  const overrides = new Map(quality?.overrides?.map(value => [value.elementId, value]));
  const displaySegments = new Map<string, CadDisplayStrokeAccumulator>();
  const mutableBatches = new Map<string, MutableBatch>();
  const mutableTextBatches = new Map<string, CadTextBatch>();
  const pickEntries: CadPickEntry[] = [];
  const pickPoints: number[] = [];
  const includePicking = !quality && options.includePickIndex !== false;
  primitives.forEach((primitive, zOrder) => {
    if (excluded.has(primitive.elementId) || (primitive.groupId && excluded.has(primitive.groupId))) return;
    const override = overrides.get(primitive.elementId);
    if (override?.hidden) return;
    if (override && error !== undefined) primitive = displayOverride(primitive, override, error);
    const pickPointStart = pickPoints.length / 2;
    const pickGeometry = !includePicking || primitive.type === "text"
      ? { points: [] as Point[], closed: false }
      : primitivePoints(primitive);
    for (const point of pickGeometry.points) pickPoints.push(point.x, point.y);
    if (primitive.type === "text") {
      const color = primitive.style.strokeColor ?? primitive.style.fillColor;
      if (color !== null) {
        const fontPixelSize = quality ? Math.max(2, Math.min(32, 2 ** Math.ceil(Math.log2(Math.max(1, primitive.geometry.height * quality.zoomBand * 2))))) : undefined;
        const styleKey = JSON.stringify([
          primitive.layerName,
          "text",
          color,
          primitive.style.opacity,
          ...(fontPixelSize === undefined ? [] : [fontPixelSize])
        ]);
        const batch = mutableTextBatches.get(styleKey) ?? {
          styleKey,
          layerName: primitive.layerName,
          color,
          opacity: primitive.style.opacity,
          entries: [],
          ...(fontPixelSize === undefined ? {} : { fontPixelSize })
        };
        batch.entries.push({
          // Exclusions/overrides already ran before display batching. IDs are
          // only needed by exact picking, not retained display text quads.
          elementId: quality ? "" : primitive.elementId,
          groupId: quality ? null : primitive.groupId,
          text: primitive.geometry.text,
          position: primitive.geometry.position,
          width: primitive.geometry.width,
          height: primitive.geometry.height,
          rotation: primitive.geometry.rotation,
          fontSize: primitive.geometry.fontSize,
          bounds: primitive.bounds,
          clipBounds: primitive.clipBounds
        });
        mutableTextBatches.set(styleKey, batch);
      }
    } else {
      const { points, closed } = primitivePoints(primitive, error);
      const fillColor = primitive.style.fillColor;
      if (fillColor !== null && closed) {
        addPolygon(
          mutableBatch(mutableBatches, primitive.layerName, "fill", fillColor, primitive.style.opacity, 0),
          points,
          primitive
        );
      }
      const strokeColor = primitive.style.strokeColor;
      if (strokeColor !== null && primitive.style.strokeWidth > 0) {
        const width = quality ? Math.max((quality.minimumStrokePixels ?? 0.5) / quality.zoomBand,
          Math.round(primitive.style.strokeWidth / quantum) * quantum) : primitive.style.strokeWidth;
        const batch = mutableBatch(mutableBatches, primitive.layerName, "stroke", strokeColor, primitive.style.opacity, width);
        const segments = quality ? displaySegments.get(batch.styleKey) ?? new CadDisplayStrokeAccumulator(quantum, width) : undefined;
        if (segments) displaySegments.set(batch.styleKey, segments);
        addStroke(
          batch,
          points,
          closed,
          width,
          primitive,
          segments
        );
      }
    }
    if (includePicking) pickEntries.push({
      elementId: primitive.elementId,
      groupId: primitive.groupId,
      layerName: primitive.layerName,
      bounds: primitive.bounds,
      zOrder,
      pointStart: pickPointStart,
      pointCount: pickGeometry.points.length,
      closed: pickGeometry.closed,
      filled: pickGeometry.closed && primitive.style.fillColor !== null,
      strokeWidth: primitive.style.strokeColor === null ? 0 : primitive.style.strokeWidth
    });
  });

  for (const [key, accumulator] of displaySegments) {
    const batch = mutableBatches.get(key)!;
    accumulator.emit(batch.positions, batch.indices);
  }
  const spatialIndex = buildSpatialIndex(pickEntries);
  const batches = Array.from(mutableBatches.values(), batch => ({
    styleKey: batch.styleKey,
    layerName: batch.layerName,
    color: batch.color,
    opacity: batch.opacity,
    positions: Float32Array.from(batch.positions),
    indices: Uint32Array.from(batch.indices),
    spans: quality ? [] : batch.spans
  }));
  const textBatches = [...mutableTextBatches.values()];
  const packedPickPoints = Float32Array.from(pickPoints);
  return {
    batches,
    textBatches,
    pickEntries,
    pickPoints: packedPickPoints,
    spatialIndex,
    memory: estimateCadSceneMemory(batches, textBatches, pickEntries, packedPickPoints, spatialIndex)
  };
}

function stringBytes(value: string | null): number {
  return value === null ? 0 : value.length * 2;
}

export function extractCadSourceElement(tile: DecodedCadSceneTile, elementId: string): DecodedCadSceneTile {
  const pickPoints: number[] = [];
  const pickEntries = tile.pickEntries.filter(entry => entry.elementId === elementId).map(entry => {
    const pointStart = pickPoints.length / 2;
    for (let i = 0; i < entry.pointCount * 2; i++) pickPoints.push(tile.pickPoints[entry.pointStart * 2 + i]);
    return { ...entry, pointStart };
  });
  const batches: CadGeometryBatch[] = [];
  for (const batch of tile.batches) {
    const spans = batch.spans.filter(span => span.elementId === elementId);
    if (spans.length === 0) continue;
    const positions: number[] = [];
    const indices: number[] = [];
    const vertices = new Map<number, number>();
    const nextSpans = spans.map(span => {
      const indexStart = indices.length;
      for (let i = span.indexStart; i < span.indexStart + span.indexCount; i++) {
        const original = batch.indices[i];
        let vertex = vertices.get(original);
        if (vertex === undefined) {
          vertex = positions.length / 2;
          vertices.set(original, vertex);
          positions.push(batch.positions[original * 2], batch.positions[original * 2 + 1]);
        }
        indices.push(vertex);
      }
      return { ...span, indexStart };
    });
    batches.push({ ...batch, positions: Float32Array.from(positions), indices: Uint32Array.from(indices), spans: nextSpans });
  }
  const textBatches = tile.textBatches.map(batch => ({ ...batch, entries: batch.entries.filter(entry => entry.elementId === elementId) }))
    .filter(batch => batch.entries.length > 0);
  const packedPoints = Float32Array.from(pickPoints);
  const spatialIndex = buildSpatialIndex(pickEntries);
  return { ...tile, batches, textBatches, pickEntries, pickPoints: packedPoints, spatialIndex,
    memory: estimateCadSceneMemory(batches, textBatches, pickEntries, packedPoints, spatialIndex) };
}

function estimateCadSceneMemory(
  batches: readonly CadGeometryBatch[],
  textBatches: readonly CadTextBatch[],
  pickEntries: readonly CadPickEntry[],
  pickPoints: Float32Array,
  spatialIndex: CadSpatialIndex
): CadSceneMemoryEstimate {
  let cpuBytes = pickPoints.byteLength;
  let gpuBytes = 0;
  for (const batch of batches) {
    const bufferBytes = batch.positions.byteLength + batch.indices.byteLength;
    cpuBytes += bufferBytes + 128 + stringBytes(batch.styleKey) + stringBytes(batch.layerName) +
      stringBytes(batch.color);
    gpuBytes += bufferBytes + batch.positions.byteLength;
    for (const span of batch.spans) {
      cpuBytes += 96 + stringBytes(span.elementId) + stringBytes(span.groupId);
    }
  }
  let textEntryCount = 0;
  let textAtlasBytes = 0;
  for (const batch of textBatches) {
    textAtlasBytes += batch.fontPixelSize === undefined
      ? batch.entries.length * 2048 * 40 * 4
      : packCadDisplayText(batch).byteSize;
    cpuBytes += 128 + stringBytes(batch.styleKey) + stringBytes(batch.layerName) + stringBytes(batch.color);
    for (const entry of batch.entries) {
      textEntryCount++;
      cpuBytes += 192 + stringBytes(entry.elementId) + stringBytes(entry.groupId) + stringBytes(entry.text);
    }
  }
  for (const entry of pickEntries) {
    cpuBytes += 176 + stringBytes(entry.elementId) + stringBytes(entry.groupId) + stringBytes(entry.layerName);
  }
  for (const [key, bucket] of Object.entries(spatialIndex.buckets)) {
    cpuBytes += 48 + stringBytes(key) + bucket.byteLength;
  }
  gpuBytes += textEntryCount * 256;
  return {
    cpuBytes: Math.ceil(cpuBytes),
    gpuBytes: Math.ceil(gpuBytes),
    textAtlasBytes
  };
}

function clipPolygon(points: readonly Point[], bounds: CadBounds): Point[] {
  type Edge = "left" | "right" | "top" | "bottom";
  const inside = (point: Point, edge: Edge) => {
    if (edge === "left") return point.x >= bounds.minX;
    if (edge === "right") return point.x <= bounds.maxX;
    if (edge === "top") return point.y >= bounds.minY;
    return point.y <= bounds.maxY;
  };
  const intersection = (start: Point, end: Point, edge: Edge): Point => {
    if (edge === "left" || edge === "right") {
      const x = edge === "left" ? bounds.minX : bounds.maxX;
      const ratio = (x - start.x) / (end.x - start.x);
      return { x, y: start.y + (end.y - start.y) * ratio };
    }
    const y = edge === "top" ? bounds.minY : bounds.maxY;
    const ratio = (y - start.y) / (end.y - start.y);
    return { x: start.x + (end.x - start.x) * ratio, y };
  };
  let output = [...points];
  for (const edge of ["left", "right", "top", "bottom"] as const) {
    const input = output;
    output = [];
    if (input.length === 0) break;
    let start = input.at(-1)!;
    for (const end of input) {
      const startInside = inside(start, edge);
      const endInside = inside(end, edge);
      if (endInside) {
        if (!startInside) output.push(intersection(start, end, edge));
        output.push(end);
      } else if (startInside) {
        output.push(intersection(start, end, edge));
      }
      start = end;
    }
  }
  return output;
}

function clipSegment(start: Point, end: Point, bounds: CadBounds): { start: Point; end: Point } | null {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  let minimum = 0;
  let maximum = 1;
  const tests: Array<[number, number]> = [
    [-deltaX, start.x - bounds.minX],
    [deltaX, bounds.maxX - start.x],
    [-deltaY, start.y - bounds.minY],
    [deltaY, bounds.maxY - start.y]
  ];
  for (const [direction, distance] of tests) {
    if (direction === 0) {
      if (distance < 0) return null;
      continue;
    }
    const ratio = distance / direction;
    if (direction < 0) minimum = Math.max(minimum, ratio);
    else maximum = Math.min(maximum, ratio);
    if (minimum > maximum) return null;
  }
  return {
    start: { x: start.x + deltaX * minimum, y: start.y + deltaY * minimum },
    end: { x: start.x + deltaX * maximum, y: start.y + deltaY * maximum }
  };
}

function buildSpatialIndex(entries: readonly CadPickEntry[], cellSize = 64): CadSpatialIndex {
  const mutableBuckets = new Map<string, number[]>();
  entries.forEach((entry, entryIndex) => {
    const firstX = Math.floor(entry.bounds.minX / cellSize);
    const lastX = Math.floor(entry.bounds.maxX / cellSize);
    const firstY = Math.floor(entry.bounds.minY / cellSize);
    const lastY = Math.floor(entry.bounds.maxY / cellSize);
    for (let cellY = firstY; cellY <= lastY; cellY++) {
      for (let cellX = firstX; cellX <= lastX; cellX++) {
        const key = `${cellX}:${cellY}`;
        const bucket = mutableBuckets.get(key) ?? [];
        bucket.push(entryIndex);
        mutableBuckets.set(key, bucket);
      }
    }
  });
  const buckets: Record<string, Uint32Array> = {};
  for (const [key, values] of mutableBuckets) buckets[key] = Uint32Array.from(values);
  return { cellSize, buckets };
}

class InlineCadSceneWorkerClient implements CadSceneWorkerClient {
  async decode(payload: Uint8Array, descriptor: CadSceneTile, quality?: CadSceneDisplayQuality): Promise<DecodedCadSceneTile> {
    const primitives = await decodeCadSceneTilePayload(payload, descriptor);
    return { ...buildCadGeometryBatches(primitives, quality), descriptor, byteSize: payload.byteLength };
  }

  destroy(): void {}
}

interface WorkerDecodeRequest {
  id: number;
  payload: Uint8Array;
  descriptor: CadSceneTile;
  quality?: CadSceneDisplayQuality;
}

interface WorkerDecodeResponse {
  id: number;
  result?: DecodedCadSceneTile;
  error?: string;
}

export class BrowserCadSceneWorkerClient implements CadSceneWorkerClient {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: DecodedCadSceneTile) => void;
    reject: (reason: Error) => void;
  }>();
  private readonly worker: Worker;

  constructor() {
    this.worker = new Worker(new URL("./cad-scene-worker.ts", import.meta.url), { type: "module" });
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleError);
  }

  decode(payload: Uint8Array, descriptor: CadSceneTile, quality?: CadSceneDisplayQuality): Promise<DecodedCadSceneTile> {
    const id = this.nextId++;
    const transferable = payload.slice();
    const result = new Promise<DecodedCadSceneTile>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.worker.postMessage({ id, payload: transferable, descriptor, quality } satisfies WorkerDecodeRequest, [
      transferable.buffer
    ]);
    return result;
  }

  destroy(): void {
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleError);
    this.worker.terminate();
    for (const request of this.pending.values()) request.reject(new Error("CAD scene worker was destroyed"));
    this.pending.clear();
  }

  private readonly handleMessage = (event: MessageEvent<WorkerDecodeResponse>) => {
    const request = this.pending.get(event.data.id);
    if (!request) return;
    this.pending.delete(event.data.id);
    if (event.data.result) request.resolve(event.data.result);
    else request.reject(new Error(event.data.error ?? "CAD scene worker failed"));
  };

  private readonly handleError = () => {
    for (const request of this.pending.values()) request.reject(new Error("CAD scene worker failed"));
    this.pending.clear();
  };
}

export function createCadSceneWorkerClient(): CadSceneWorkerClient {
  return typeof Worker === "undefined" ? new InlineCadSceneWorkerClient() : new BrowserCadSceneWorkerClient();
}

const workerScope = globalThis as typeof globalThis & {
  document?: Document;
  postMessage?: (message: WorkerDecodeResponse, transfer?: Transferable[]) => void;
};

if (typeof workerScope.document === "undefined" && typeof workerScope.postMessage === "function") {
  globalThis.addEventListener("message", (event: MessageEvent<WorkerDecodeRequest>) => {
    const { id, payload, descriptor, quality } = event.data;
    void decodeCadSceneTilePayload(payload, descriptor).then(primitives => {
      const result: DecodedCadSceneTile = {
        ...buildCadGeometryBatches(primitives, quality),
        descriptor,
        byteSize: payload.byteLength
      };
      const transfer: Transferable[] = [];
      result.batches.forEach(batch => transfer.push(batch.positions.buffer, batch.indices.buffer));
      transfer.push(result.pickPoints.buffer);
      Object.values(result.spatialIndex.buckets).forEach(bucket => transfer.push(bucket.buffer));
      workerScope.postMessage?.({ id, result }, transfer);
    }).catch((error: unknown) => {
      workerScope.postMessage?.({ id, error: error instanceof Error ? error.message : "CAD scene worker failed" });
    });
  });
}
