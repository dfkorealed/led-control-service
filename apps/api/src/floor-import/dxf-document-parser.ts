import { Buffer } from "node:buffer";
import { computeCadBounds, expandCadDocument } from "./cad-geometry";
import type {
  CadPoint,
  NormalizedCadBlock,
  NormalizedCadDocument,
  NormalizedCadEntity,
  NormalizedCadPolyline
} from "./cad-types";

export interface DxfParserLimits {
  maxInputBytes: number;
  maxEntities: number;
  maxCoordinateMagnitude: number;
  maxNormalizedOutputBytes: number;
  maxDurationMs: number;
  now: () => number;
}

const DEFAULT_LIMITS: DxfParserLimits = {
  maxInputBytes: 16 * 1024 * 1024,
  maxEntities: 100_000,
  maxCoordinateMagnitude: 1_000_000,
  maxNormalizedOutputBytes: 32 * 1024 * 1024,
  maxDurationMs: 5_000,
  now: () => performance.now()
};

interface DxfPair {
  code: number;
  value: string;
  line: number;
}

function validateLimits(limits: DxfParserLimits): void {
  for (const key of ["maxInputBytes", "maxEntities", "maxCoordinateMagnitude", "maxNormalizedOutputBytes", "maxDurationMs"] as const) {
    if (!Number.isFinite(limits[key]) || limits[key] <= 0) throw new Error(`Invalid DXF ${key}`);
  }
}

function readPairs(source: string, checkTime: () => void): DxfPair[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length % 2 !== 0) throw new Error("Malformed DXF pair at EOF");
  const pairs: DxfPair[] = [];
  for (let index = 0; index < lines.length; index += 2) {
    checkTime();
    const codeText = lines[index].trim();
    if (!/^[+-]?\d+$/.test(codeText)) throw new Error(`Malformed DXF group code at line ${index + 1}`);
    const code = Number(codeText);
    if (!Number.isSafeInteger(code) || code < 0 || code > 1071) throw new Error(`Malformed DXF group code at line ${index + 1}`);
    pairs.push({ code, value: lines[index + 1], line: index + 1 });
  }
  return pairs;
}

export function parseAsciiDxf(input: string | Buffer, options: Partial<DxfParserLimits> = {}): NormalizedCadDocument {
  const limits = { ...DEFAULT_LIMITS, ...options };
  validateLimits(limits);
  const inputBytes = typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength;
  if (inputBytes > limits.maxInputBytes) throw new Error("DXF input limit exceeded");
  const source = typeof input === "string" ? input : input.toString("utf8");
  if (source.includes("\0")) throw new Error("Malformed DXF input contains NUL");
  const startedAt = limits.now();
  const checkTime = () => {
    if (limits.now() - startedAt > limits.maxDurationMs) throw new Error("DXF parsing time limit exceeded");
  };
  const pairs = readPairs(source, checkTime);
  let cursor = 0;
  let generatedId = 0;
  let rawEntityCount = 0;
  let sawEof = false;
  const blocks: NormalizedCadBlock[] = [];
  const entities: NormalizedCadEntity[] = [];

  const registerEntity = () => {
    rawEntityCount++;
    if (rawEntityCount > limits.maxEntities) throw new Error("DXF entity limit exceeded");
  };
  const requireName = (value: string | undefined, label: string) => {
    const normalized = value?.trim();
    if (!normalized || normalized.length > 512) throw new Error(`Invalid DXF ${label}`);
    return normalized;
  };
  const number = (pair: DxfPair | undefined, label: string, fallback?: number) => {
    if (!pair) {
      if (fallback !== undefined) return fallback;
      throw new Error(`Missing DXF ${label}`);
    }
    const parsed = Number(pair.value.trim());
    if (!Number.isFinite(parsed)) throw new Error(`Invalid DXF number for ${label} at line ${pair.line}`);
    if (Math.abs(parsed) > limits.maxCoordinateMagnitude) throw new Error(`DXF coordinate limit exceeded for ${label}`);
    return parsed;
  };
  const first = (body: readonly DxfPair[], code: number) => body.find(pair => pair.code === code);
  const point = (body: readonly DxfPair[], xCode: number, yCode: number, zCode: number, label: string): CadPoint => ({
    x: number(first(body, xCode), `${label}.x`),
    y: number(first(body, yCode), `${label}.y`),
    z: number(first(body, zCode), `${label}.z`, 0)
  });
  const idAndLayer = (body: readonly DxfPair[]) => ({
    sourceEntityId: requireName(first(body, 5)?.value ?? `generated-${++generatedId}`, "entity id"),
    layer: requireName(first(body, 8)?.value ?? "0", "layer")
  });
  const positive = (value: number, label: string) => {
    if (value <= 0) throw new Error(`Invalid DXF ${label}`);
    return value;
  };
  const angle = (value: number) => ((value % 360) + 360) % 360;

  const consumeBody = (): DxfPair[] => {
    const body: DxfPair[] = [];
    while (cursor < pairs.length && pairs[cursor].code !== 0) {
      checkTime();
      body.push(pairs[cursor++]);
    }
    return body;
  };

  const parsePolyline = (header: DxfPair[], sourceType: "POLYLINE"): NormalizedCadPolyline => {
    const vertices: CadPoint[] = [];
    let ended = false;
    while (cursor < pairs.length) {
      checkTime();
      const marker = pairs[cursor++];
      if (marker.code !== 0) throw new Error("Malformed DXF POLYLINE entity");
      if (marker.value.trim().toUpperCase() === "SEQEND") {
        consumeBody();
        ended = true;
        break;
      }
      if (marker.value.trim().toUpperCase() !== "VERTEX") throw new Error("Unterminated DXF POLYLINE entity");
      registerEntity();
      const vertex = consumeBody();
      vertices.push(point(vertex, 10, 20, 30, "vertex"));
    }
    if (!ended || vertices.length < 2) throw new Error("Unterminated or empty DXF POLYLINE entity");
    return { type: sourceType.toLowerCase() as "polyline", ...idAndLayer(header), vertices, closed: (number(first(header, 70), "polyline flags", 0) & 1) === 1 };
  };

  const parseEntity = (marker: DxfPair): NormalizedCadEntity | null => {
    registerEntity();
    const type = marker.value.trim().toUpperCase();
    const body = consumeBody();
    if (type === "POLYLINE") return parsePolyline(body, type);
    const common = idAndLayer(body);
    if (type === "LINE") return { type: "line", ...common, start: point(body, 10, 20, 30, "line start"), end: point(body, 11, 21, 31, "line end") };
    if (type === "LWPOLYLINE") {
      const vertices: CadPoint[] = [];
      let pending: { x: number; z: number } | null = null;
      for (const pair of body) {
        if (pair.code === 10) {
          if (pending) throw new Error("Malformed DXF LWPOLYLINE vertex");
          pending = { x: number(pair, "vertex.x"), z: 0 };
        } else if (pair.code === 20) {
          if (!pending) throw new Error("Malformed DXF LWPOLYLINE vertex");
          vertices.push({ x: pending.x, y: number(pair, "vertex.y"), z: pending.z });
          pending = null;
        } else if (pair.code === 30 && pending) {
          pending.z = number(pair, "vertex.z");
        }
      }
      if (pending || vertices.length < 2) throw new Error("Malformed DXF LWPOLYLINE vertices");
      return { type: "lwpolyline", ...common, vertices, closed: (number(first(body, 70), "polyline flags", 0) & 1) === 1 };
    }
    if (type === "CIRCLE") return { type: "circle", ...common, center: point(body, 10, 20, 30, "circle center"), radius: positive(number(first(body, 40), "circle radius"), "circle radius") };
    if (type === "ARC") return {
      type: "arc", ...common, center: point(body, 10, 20, 30, "arc center"),
      radius: positive(number(first(body, 40), "arc radius"), "arc radius"),
      startAngle: angle(number(first(body, 50), "arc start angle")),
      endAngle: angle(number(first(body, 51), "arc end angle"))
    };
    if (type === "TEXT" || type === "MTEXT") {
      const textParts = type === "MTEXT" ? body.filter(pair => pair.code === 3 || pair.code === 1) : body.filter(pair => pair.code === 1);
      const text = textParts.map(pair => pair.value).join("");
      if (Buffer.byteLength(text, "utf8") > 64 * 1024) throw new Error("DXF text output limit exceeded");
      return {
        type: type.toLowerCase() as "text" | "mtext", ...common,
        position: point(body, 10, 20, 30, "text position"),
        rotation: angle(number(first(body, 50), "text rotation", 0)),
        height: positive(number(first(body, 40), "text height", 1), "text height"), text
      };
    }
    if (type === "INSERT") return {
      type: "insert", ...common, blockName: requireName(first(body, 2)?.value, "block name"),
      position: point(body, 10, 20, 30, "insert position"),
      rotation: angle(number(first(body, 50), "insert rotation", 0)),
      scale: {
        x: positive(number(first(body, 41), "insert x scale", 1), "insert x scale"),
        y: positive(number(first(body, 42), "insert y scale", 1), "insert y scale"),
        z: positive(number(first(body, 43), "insert z scale", 1), "insert z scale")
      }
    };
    return null;
  };

  const parseEntitiesUntil = (terminator: string): NormalizedCadEntity[] => {
    const parsed: NormalizedCadEntity[] = [];
    while (cursor < pairs.length) {
      checkTime();
      const marker = pairs[cursor++];
      if (marker.code !== 0) throw new Error("Malformed DXF entity marker");
      const type = marker.value.trim().toUpperCase();
      if (type === terminator) {
        consumeBody();
        return parsed;
      }
      const entity = parseEntity(marker);
      if (entity) parsed.push(entity);
    }
    throw new Error(`Unterminated DXF ${terminator}`);
  };

  const parseBlocks = () => {
    while (cursor < pairs.length) {
      checkTime();
      const marker = pairs[cursor++];
      if (marker.code !== 0) throw new Error("Malformed DXF block marker");
      const type = marker.value.trim().toUpperCase();
      if (type === "ENDSEC") return;
      if (type !== "BLOCK") throw new Error("Malformed DXF BLOCKS section");
      const header = consumeBody();
      const name = requireName(first(header, 2)?.value ?? first(header, 3)?.value, "block name");
      const basePoint: CadPoint = {
        x: number(first(header, 10), "block base.x", 0),
        y: number(first(header, 20), "block base.y", 0),
        z: number(first(header, 30), "block base.z", 0)
      };
      blocks.push({ name, basePoint, entities: parseEntitiesUntil("ENDBLK") });
    }
    throw new Error("Unterminated DXF BLOCKS section");
  };

  while (cursor < pairs.length) {
    checkTime();
    const marker = pairs[cursor++];
    if (marker.code !== 0) throw new Error("Malformed DXF top-level marker");
    const type = marker.value.trim().toUpperCase();
    if (type === "EOF") {
      sawEof = true;
      if (cursor !== pairs.length) throw new Error("Malformed DXF content after EOF");
      break;
    }
    if (type !== "SECTION") throw new Error("Malformed DXF top-level structure");
    const section = pairs[cursor++];
    if (!section || section.code !== 2) throw new Error("Malformed DXF SECTION header");
    const sectionName = section.value.trim().toUpperCase();
    if (sectionName === "BLOCKS") parseBlocks();
    else if (sectionName === "ENTITIES") entities.push(...parseEntitiesUntil("ENDSEC"));
    else {
      let ended = false;
      while (cursor < pairs.length) {
        const pair = pairs[cursor++];
        checkTime();
        if (pair.code === 0 && pair.value.trim().toUpperCase() === "ENDSEC") { ended = true; break; }
      }
      if (!ended) throw new Error(`Unterminated DXF ${sectionName} section`);
    }
  }
  if (!sawEof) throw new Error("DXF EOF marker is missing");
  if (new Set(blocks.map(block => block.name)).size !== blocks.length) throw new Error("Duplicate DXF block name");

  const expanded = expandCadDocument({ blocks, entities }, { maxRenderedEntities: limits.maxEntities });
  const rawBounds = computeCadBounds(expanded);
  if (Object.values(rawBounds).some(value => Math.abs(value) > limits.maxCoordinateMagnitude)) {
    throw new Error("DXF transformed coordinate limit exceeded");
  }
  checkTime();
  const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
  const document: NormalizedCadDocument = {
    version: 1,
    bounds: { minX: round(rawBounds.minX), minY: round(rawBounds.minY), maxX: round(rawBounds.maxX), maxY: round(rawBounds.maxY) },
    blocks,
    entities
  };
  if (Buffer.byteLength(JSON.stringify(document), "utf8") > limits.maxNormalizedOutputBytes) throw new Error("DXF normalized output limit exceeded");
  checkTime();
  return document;
}
