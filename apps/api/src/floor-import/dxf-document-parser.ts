import { Buffer } from "node:buffer";
import { computeCadBounds, iterateCadDocumentExpansion } from "./cad-geometry";
import type { CadPoint, CadPolylineVertex, NormalizedCadAttribute, NormalizedCadBlock, NormalizedCadDocument, NormalizedCadEntity, NormalizedCadPolyline } from "./cad-types";

export interface DxfParserLimits {
  maxInputBytes: number;
  maxLineBytes: number;
  maxEntityBodyPairs: number;
  maxEntities: number;
  maxBlocks: number;
  maxCoordinates: number;
  maxCoordinateMagnitude: number;
  maxZCoordinateMagnitude: number;
  maxExpandedEntities: number;
  maxBlockDepth: number;
  maxNormalizedOutputBytes: number;
  maxRetainedModelBytes: number;
  maxDurationMs: number;
  maxCpuMs: number;
  now: () => number;
  cpuNow: () => number;
}

export const DEFAULT_DXF_PARSER_LIMITS: Readonly<DxfParserLimits> = Object.freeze({
  maxInputBytes: 256 * 1024 * 1024,
  maxLineBytes: 1024 * 1024,
  maxEntityBodyPairs: 250_000,
  maxEntities: 1_000_000,
  maxBlocks: 100_000,
  maxCoordinates: 5_000_000,
  maxCoordinateMagnitude: 1_000_000_000,
  maxZCoordinateMagnitude: 100_000_000_000,
  maxExpandedEntities: 1_000_000,
  maxBlockDepth: 32,
  maxNormalizedOutputBytes: 128 * 1024 * 1024,
  maxRetainedModelBytes: 192 * 1024 * 1024,
  maxDurationMs: 60_000,
  maxCpuMs: 45_000,
  now: () => performance.now(),
  cpuNow: () => {
    const usage = process.cpuUsage();
    return (usage.user + usage.system) / 1_000;
  }
});

interface DxfPair { code: number; value: string; line: number }
interface EntityRecord { type: string; body: DxfPair[]; section: string }

const DXF_DECIMAL = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;
const DXF_INTEGER = /^[+-]?\d+$/;

function resolveLimits(options: Partial<DxfParserLimits>): DxfParserLimits {
  const limits = { ...DEFAULT_DXF_PARSER_LIMITS, ...options };
  for (const key of [
    "maxInputBytes", "maxLineBytes", "maxEntityBodyPairs", "maxEntities", "maxBlocks", "maxCoordinates",
    "maxCoordinateMagnitude", "maxZCoordinateMagnitude", "maxExpandedEntities", "maxBlockDepth", "maxNormalizedOutputBytes", "maxRetainedModelBytes", "maxDurationMs", "maxCpuMs"
  ] as const) {
    if (!Number.isFinite(limits[key]) || limits[key] <= 0) throw new Error(`Invalid DXF ${key}`);
  }
  return limits;
}

function parseCode(raw: string, line: number): number {
  const text = raw.trim();
  if (!DXF_INTEGER.test(text)) throw new Error(`Malformed DXF group code at line ${line}`);
  const code = Number(text);
  if (!Number.isSafeInteger(code) || code < 0 || code > 1071) throw new Error(`Malformed DXF group code at line ${line}`);
  return code;
}

function* readBufferedPairs(source: string, limits: DxfParserLimits, checkBudget: () => void): Generator<DxfPair> {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length % 2 !== 0) throw new Error("Malformed DXF pair at EOF");
  for (let index = 0; index < lines.length; index += 2) {
    checkBudget();
    if (Buffer.byteLength(lines[index], "utf8") > limits.maxLineBytes || Buffer.byteLength(lines[index + 1], "utf8") > limits.maxLineBytes) {
      throw new Error("DXF line byte limit exceeded");
    }
    yield { code: parseCode(lines[index], index + 1), value: lines[index + 1], line: index + 1 };
  }
}

async function* readStreamingPairs(
  input: AsyncIterable<Buffer | string> | Iterable<Buffer | string>, limits: DxfParserLimits, checkBudget: () => void
): AsyncGenerator<DxfPair> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let bytesRead = 0;
  let codeLine: { code: number; line: number } | null = null;
  let lineNumber = 0;
  const emit = (raw: string): DxfPair | null => {
    lineNumber++;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (Buffer.byteLength(line, "utf8") > limits.maxLineBytes) throw new Error("DXF line byte limit exceeded");
    if (!codeLine) { codeLine = { code: parseCode(line, lineNumber), line: lineNumber }; return null; }
    const pair = { ...codeLine, value: line };
    codeLine = null;
    return pair;
  };

  for await (const rawChunk of input) {
    checkBudget();
    const chunk = typeof rawChunk === "string" ? Buffer.from(rawChunk) : rawChunk;
    bytesRead += chunk.byteLength;
    if (bytesRead > limits.maxInputBytes) throw new Error("DXF input limit exceeded");
    const decoded = decoder.decode(chunk, { stream: true });
    if (decoded.includes("\0")) throw new Error("Malformed DXF input contains NUL");
    pending += decoded;
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const pair = emit(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      if (pair) yield pair;
      newline = pending.indexOf("\n");
    }
    if (Buffer.byteLength(pending, "utf8") > limits.maxLineBytes + 1) throw new Error("DXF line byte limit exceeded");
  }
  pending += decoder.decode();
  if (pending.includes("\0")) throw new Error("Malformed DXF input contains NUL");
  if (pending.length > 0) { const pair = emit(pending); if (pair) yield pair; }
  if (codeLine) throw new Error("Malformed DXF pair at EOF");
}

class DxfDocumentBuilder {
  private section: string | null = null;
  private awaitingSectionName = false;
  private record: EntityRecord | null = null;
  private currentBlock: NormalizedCadBlock | null = null;
  private polyline: { header: DxfPair[]; vertices: CadPolylineVertex[] } | null = null;
  private attributeInsert: Extract<NormalizedCadEntity, { type: "insert" }> | null = null;
  private attributeCount = 0;
  private sawEof = false;
  private generatedId = 0;
  private rawEntityCount = 0;
  private coordinateCount = 0;
  private normalizedBytes = 64;
  private retainedModelBytes = 64;
  private currentBodyBytes = 0;
  private inTable = false;
  private inLayerTable = false;
  private readonly hiddenLayers = new Set<string>();
  private readonly declaredLayers = new Set<string>();
  private readonly sourceEntityIds = new Set<string>();
  private readonly blocks: NormalizedCadBlock[] = [];
  private readonly entities: NormalizedCadEntity[] = [];

  constructor(private readonly limits: DxfParserLimits, private readonly checkBudget: () => void) {}

  accept(pair: DxfPair): void {
    this.checkBudget();
    if (this.sawEof) throw new Error("Malformed DXF content after EOF");
    if (pair.code !== 0) {
      if (this.awaitingSectionName) {
        if (pair.code !== 2) throw new Error("Malformed DXF SECTION header");
        this.section = pair.value.trim().toUpperCase();
        if (!this.section) throw new Error("Malformed DXF SECTION name");
        this.awaitingSectionName = false;
      } else if (this.record) {
        this.currentBodyBytes += 32 + Buffer.byteLength(pair.value, "utf8") * 2;
        this.assertRetainedBudget();
        this.record.body.push(pair);
        if (this.record.body.length > this.limits.maxEntityBodyPairs) throw new Error("DXF entity body pair limit exceeded");
      }
      return;
    }

    this.finishRecord();
    const marker = pair.value.trim().toUpperCase();
    if (this.awaitingSectionName) throw new Error("Malformed DXF SECTION header");
    if (!this.section) {
      if (marker === "SECTION") this.awaitingSectionName = true;
      else if (marker === "EOF") this.sawEof = true;
      else throw new Error(`Malformed DXF top-level marker: ${marker}`);
      return;
    }
    if (this.section === "TABLES") {
      if (marker === "ENDSEC") {
        if (this.inTable) throw new Error("Unterminated DXF table");
        this.section = null;
      } else if (marker === "TABLE" || (marker === "LAYER" && this.inLayerTable)) {
        this.beginRecord(marker);
      } else if (marker === "ENDTAB") {
        if (!this.inTable) throw new Error("Orphan DXF ENDTAB marker");
        this.inTable = false;
        this.inLayerTable = false;
      } else if (marker === "SECTION" || marker === "EOF") {
        throw new Error("Unterminated DXF TABLES section");
      } else {
        this.beginRecord(marker);
      }
      return;
    }
    if (this.section !== "BLOCKS" && this.section !== "ENTITIES") {
      if (marker === "ENDSEC") this.section = null;
      else if (marker === "SECTION" || marker === "EOF") throw new Error(`Unterminated DXF ${this.section} section`);
      return;
    }
    if (this.section === "BLOCKS" && !this.currentBlock) {
      if (marker === "ENDSEC") this.section = null;
      else if (marker === "BLOCK") this.record = { type: marker, body: [], section: this.section };
      else if (marker === "ENDBLK") throw new Error("Orphan DXF ENDBLK entity");
      else throw new Error("Malformed DXF BLOCKS section");
      return;
    }
    if (marker === "ENDSEC") {
      if (this.currentBlock) throw new Error("Unterminated DXF BLOCK entity");
      if (this.polyline) throw new Error("Unterminated DXF POLYLINE entity sequence");
      if (this.attributeInsert) throw new Error("DXF INSERT attribute sequence requires SEQEND");
      this.section = null;
      return;
    }
    if (marker === "ENDBLK") {
      if (!this.currentBlock) throw new Error("Orphan DXF ENDBLK entity");
      if (this.polyline || this.attributeInsert) throw new Error("Unterminated DXF entity before ENDBLK");
      this.blocks.push(this.currentBlock);
      this.addOutputBytes({ name: this.currentBlock.name, basePoint: this.currentBlock.basePoint });
      this.currentBlock = null;
      return;
    }
    if (this.polyline) {
      if (marker === "VERTEX") this.beginRecord(marker);
      else if (marker === "SEQEND") this.finishPolyline();
      else throw new Error("Unterminated DXF POLYLINE entity");
      return;
    }
    if (this.attributeInsert) {
      if (marker === "ATTRIB") this.beginRecord(marker);
      else if (marker === "SEQEND") this.finishAttributes();
      else throw new Error("DXF INSERT attribute sequence requires SEQEND");
      return;
    }
    if (marker === "ATTRIB" || marker === "SEQEND") throw new Error(`Orphan DXF ${marker} entity`);
    if (marker === "BLOCK" || marker === "SECTION" || marker === "EOF") throw new Error(`Malformed DXF ${this.section} structure`);
    this.beginRecord(marker);
  }

  finish(): NormalizedCadDocument {
    this.finishRecord();
    if (!this.sawEof) throw new Error("DXF EOF marker is missing");
    if (this.awaitingSectionName || this.section || this.currentBlock) throw new Error("Unterminated DXF SECTION or BLOCK");
    if (this.polyline || this.attributeInsert) throw new Error("Unterminated DXF entity sequence");
    if (new Set(this.blocks.map(block => block.name)).size !== this.blocks.length) throw new Error("Duplicate DXF block name");
    const rawBounds = computeCadBounds(iterateCadDocumentExpansion(
      { blocks: this.blocks, entities: this.entities },
      { maxRenderedEntities: this.limits.maxExpandedEntities, maxBlockDepth: this.limits.maxBlockDepth, checkBudget: this.checkBudget }
    ), this.checkBudget);
    if (Object.values(rawBounds).some(value => Math.abs(value) > this.limits.maxCoordinateMagnitude)) {
      throw new Error("DXF transformed coordinate limit exceeded");
    }
    const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
    const document: NormalizedCadDocument = {
      version: 1,
      bounds: { minX: round(rawBounds.minX), minY: round(rawBounds.minY), maxX: round(rawBounds.maxX), maxY: round(rawBounds.maxY) },
      blocks: this.blocks,
      entities: this.entities
    };
    if (this.normalizedBytes + this.sizeOf(document.bounds) > this.limits.maxNormalizedOutputBytes) {
      throw new Error("DXF normalized output limit exceeded");
    }
    this.checkBudget();
    return document;
  }

  private beginRecord(type: string): void {
    this.rawEntityCount++;
    if (this.rawEntityCount > this.limits.maxEntities) throw new Error("DXF entity limit exceeded");
    this.record = { type, body: [], section: this.section! };
  }

  private finishRecord(): void {
    const record = this.record;
    if (!record) return;
    this.record = null;
    try {
      if (record.section === "TABLES") {
        if (record.type === "TABLE") {
          this.inTable = true;
          this.inLayerTable = this.requireName(this.first(record.body, 2)?.value, "table name").toUpperCase() === "LAYER";
        } else if (record.type === "LAYER" && this.inLayerTable) {
          const name = this.requireName(this.first(record.body, 2)?.value, "layer name");
          const key = name.normalize("NFKC").toUpperCase();
          if (this.declaredLayers.has(key)) throw new Error(`Duplicate DXF layer: ${name}`);
          this.declaredLayers.add(key);
          const flags = this.integer(this.first(record.body, 70), "layer flags", 0);
          const color = this.integer(this.first(record.body, 62), "layer color", 7);
          if (color < 0 || (flags & 3) !== 0) this.hiddenLayers.add(key);
        }
        return;
      }
      if (record.type === "BLOCK") {
        if (this.currentBlock) throw new Error("Malformed nested DXF BLOCK");
        if (this.blocks.length >= this.limits.maxBlocks) throw new Error("DXF block limit exceeded");
        this.currentBlock = {
          name: this.requireName(this.first(record.body, 2)?.value ?? this.first(record.body, 3)?.value, "block name"),
          basePoint: {
            x: this.number(this.first(record.body, 10), "block base.x", 0),
            y: this.number(this.first(record.body, 20), "block base.y", 0),
            z: this.number(this.first(record.body, 30), "block base.z", 0, this.limits.maxZCoordinateMagnitude)
          },
          entities: []
        };
        return;
      }
      if (record.type === "VERTEX") {
        if (!this.polyline) throw new Error("Orphan DXF VERTEX entity");
        this.polyline.vertices.push({ ...this.point(record.body, 10, 20, 30, "vertex"), bulge: this.number(this.first(record.body, 42), "vertex bulge", 0) });
        return;
      }
      if (record.type === "ATTRIB") {
        if (!this.attributeInsert) throw new Error("Orphan DXF ATTRIB entity");
        this.attributeCount++;
        if (!this.isEntityVisible(record.body)) return;
        const attribute: NormalizedCadAttribute = {
          sourceEntityId: this.idAndLayer(record.body).sourceEntityId,
          tag: this.requireName(this.first(record.body, 2)?.value, "attribute tag"),
          value: this.first(record.body, 1)?.value ?? "",
          position: this.point(record.body, 10, 20, 30, "attribute position"),
          rotation: this.angle(this.number(this.first(record.body, 50), "attribute rotation", 0)),
          height: this.positive(this.number(this.first(record.body, 40), "attribute height", 1), "attribute height")
        };
        this.attributeInsert.attributes.push(attribute);
        this.addOutputBytes(attribute);
        return;
      }
      if (record.type === "POLYLINE") {
        this.polyline = { header: record.body, vertices: [] };
        return;
      }
      const visible = this.isEntityVisible(record.body);
      const entity = visible || record.type === "INSERT" ? this.parseEntity(record.type, record.body) : null;
      if (!entity) return;
      if (visible) this.appendEntity(entity, record.section === "ENTITIES" && !this.isModelSpace(record.body));
      if (entity.type === "insert") {
        const flags = record.body.filter(pair => pair.code === 66);
        if (flags.length > 1) throw new Error("Duplicate DXF INSERT group 66 attribute sequence flag");
        const sequence = this.integer(flags[0], "INSERT group 66", 0);
        if (sequence !== 0 && sequence !== 1) throw new Error("Invalid DXF INSERT group 66 attribute sequence flag");
        if (sequence === 1) { this.attributeInsert = entity; this.attributeCount = 0; }
      }
    } finally {
      this.currentBodyBytes = 0;
    }
  }

  private finishPolyline(): void {
    const active = this.polyline!;
    this.polyline = null;
    if (active.vertices.length < 2) throw new Error("Unterminated or empty DXF POLYLINE entity");
    const entity: NormalizedCadPolyline = {
      type: "polyline", ...this.idAndLayer(active.header), vertices: active.vertices,
      closed: (this.integer(this.first(active.header, 70), "polyline flags", 0) & 1) === 1
    };
    if (this.isEntityVisible(active.header)) {
      this.appendEntity(entity, this.section === "ENTITIES" && !this.isModelSpace(active.header));
    }
  }

  private finishAttributes(): void {
    if (this.attributeCount === 0) throw new Error("DXF INSERT group 66=1 requires at least one ATTRIB");
    this.attributeInsert = null;
    this.attributeCount = 0;
  }

  private appendEntity(entity: NormalizedCadEntity, paperSpace: boolean): void {
    if (this.currentBlock) this.currentBlock.entities.push(entity);
    else if (!paperSpace) this.entities.push(entity);
    if (this.currentBlock || !paperSpace) this.addOutputBytes(entity);
  }

  private parseEntity(type: string, body: readonly DxfPair[]): NormalizedCadEntity | null {
    if (!["LINE", "LWPOLYLINE", "CIRCLE", "ARC", "TEXT", "MTEXT", "INSERT"].includes(type)) return null;
    const common = this.idAndLayer(body);
    if (type === "LINE") return { type: "line", ...common, start: this.point(body, 10, 20, 30, "line start"), end: this.point(body, 11, 21, 31, "line end") };
    if (type === "LWPOLYLINE") {
      const vertices: CadPolylineVertex[] = [];
      let pending: Partial<CadPolylineVertex> | null = null;
      const finish = () => {
        if (!pending || pending.x === undefined || pending.y === undefined) throw new Error("Malformed DXF LWPOLYLINE vertex");
        vertices.push({ x: pending.x, y: pending.y, z: pending.z ?? 0, bulge: pending.bulge ?? 0 });
        pending = null;
      };
      for (const pair of body) {
        if (pair.code === 10) { if (pending) finish(); pending = { x: this.number(pair, "vertex.x"), z: 0, bulge: 0 }; }
        else if (pair.code === 20) { if (!pending || pending.y !== undefined) throw new Error("Malformed DXF LWPOLYLINE vertex"); pending.y = this.number(pair, "vertex.y"); }
        else if (pair.code === 30 && pending) pending.z = this.number(pair, "vertex.z");
        else if (pair.code === 42 && pending) pending.bulge = this.number(pair, "vertex bulge");
      }
      if (pending) finish();
      if (vertices.length < 2) throw new Error("Malformed DXF LWPOLYLINE vertices");
      return { type: "lwpolyline", ...common, vertices, closed: (this.integer(this.first(body, 70), "polyline flags", 0) & 1) === 1 };
    }
    if (type === "CIRCLE") return { type: "circle", ...common, center: this.point(body, 10, 20, 30, "circle center"), radius: this.positive(this.number(this.first(body, 40), "circle radius"), "circle radius") };
    if (type === "ARC") return {
      type: "arc", ...common, center: this.point(body, 10, 20, 30, "arc center"),
      radius: this.positive(this.number(this.first(body, 40), "circle radius"), "arc radius"),
      startAngle: this.angle(this.number(this.first(body, 50), "arc start angle")),
      endAngle: this.angle(this.number(this.first(body, 51), "arc end angle"))
    };
    if (type === "TEXT" || type === "MTEXT") {
      const text = body.filter(pair => type === "MTEXT" ? pair.code === 3 || pair.code === 1 : pair.code === 1).map(pair => pair.value).join("");
      if (Buffer.byteLength(text, "utf8") > 64 * 1024) throw new Error("DXF text output limit exceeded");
      return {
        type: type.toLowerCase() as "text" | "mtext", ...common,
        position: this.point(body, 10, 20, 30, "text position"),
        rotation: this.angle(this.number(this.first(body, 50), "text rotation", 0)),
        height: this.positive(this.number(this.first(body, 40), "text height", 1), "text height"), text
      };
    }
    if (type === "INSERT") return {
      type: "insert", ...common, blockName: this.requireName(this.first(body, 2)?.value, "block name"),
      position: this.point(body, 10, 20, 30, "insert position"),
      rotation: this.angle(this.number(this.first(body, 50), "insert rotation", 0)),
      scale: {
        x: this.nonZero(this.number(this.first(body, 41), "insert x scale", 1), "insert x scale"),
        y: this.nonZero(this.number(this.first(body, 42), "insert y scale", 1), "insert y scale"),
        z: this.nonZero(this.number(this.first(body, 43), "insert z scale", 1), "insert z scale")
      }, attributes: []
    };
    return null;
  }

  private isModelSpace(body: readonly DxfPair[]): boolean {
    const space = this.first(body, 67);
    if (space && this.integer(space, "entity space") !== 0) return false;
    const layout = this.first(body, 410)?.value.trim().toUpperCase();
    return !layout || layout === "MODEL";
  }

  private isEntityVisible(body: readonly DxfPair[]): boolean {
    const visibility = this.first(body, 60);
    if (visibility && this.integer(visibility, "entity visibility") !== 0) return false;
    const layer = (this.first(body, 8)?.value ?? "0").trim().normalize("NFKC").toUpperCase();
    return !this.hiddenLayers.has(layer);
  }

  private first(body: readonly DxfPair[], code: number): DxfPair | undefined { return body.find(pair => pair.code === code); }

  private requireName(value: string | undefined, label: string): string {
    const normalized = value?.trim();
    if (!normalized || normalized.length > 512) throw new Error(`Invalid DXF ${label}`);
    return normalized;
  }

  private idAndLayer(body: readonly DxfPair[]): { sourceEntityId: string; layer: string } {
    const sourceEntityId = this.requireName(this.first(body, 5)?.value ?? `generated-${++this.generatedId}`, "entity id");
    const key = sourceEntityId.toLocaleUpperCase();
    if (this.sourceEntityIds.has(key)) throw new Error(`Duplicate DXF source identity or handle collision: ${sourceEntityId}`);
    this.sourceEntityIds.add(key);
    this.retainedModelBytes += 48 + Buffer.byteLength(key, "utf8") * 2;
    this.assertRetainedBudget();
    return { sourceEntityId, layer: this.requireName(this.first(body, 8)?.value ?? "0", "layer") };
  }

  private number(pair: DxfPair | undefined, label: string, fallback?: number, maxMagnitude = this.limits.maxCoordinateMagnitude): number {
    if (!pair) { if (fallback !== undefined) return fallback; throw new Error(`Missing DXF ${label}`); }
    const text = pair.value.trim();
    if (!DXF_DECIMAL.test(text)) throw new Error(`Invalid DXF decimal for ${label} at line ${pair.line}`);
    const value = Number(text);
    if (!Number.isFinite(value)) throw new Error(`Invalid DXF number for ${label} at line ${pair.line}`);
    if (Math.abs(value) > maxMagnitude) throw new Error(`DXF coordinate limit exceeded for ${label}`);
    this.coordinateCount++;
    if (this.coordinateCount > this.limits.maxCoordinates) throw new Error("DXF coordinate count limit exceeded");
    return value;
  }

  private integer(pair: DxfPair | undefined, label: string, fallback?: number): number {
    if (!pair) { if (fallback !== undefined) return fallback; throw new Error(`Missing DXF ${label}`); }
    const text = pair.value.trim();
    if (!DXF_INTEGER.test(text)) throw new Error(`Invalid DXF integer for ${label} at line ${pair.line}`);
    const value = Number(text);
    if (!Number.isSafeInteger(value)) throw new Error(`Invalid DXF integer for ${label} at line ${pair.line}`);
    return value;
  }

  private point(body: readonly DxfPair[], x: number, y: number, z: number, label: string): CadPoint {
    return {
      x: this.number(this.first(body, x), `${label}.x`),
      y: this.number(this.first(body, y), `${label}.y`),
      z: this.number(this.first(body, z), `${label}.z`, 0, this.limits.maxZCoordinateMagnitude)
    };
  }

  private positive(value: number, label: string): number { if (value <= 0) throw new Error(`Invalid DXF ${label}`); return value; }
  private nonZero(value: number, label: string): number { if (value === 0) throw new Error(`Invalid DXF ${label}`); return value; }
  private angle(value: number): number { return ((value % 360) + 360) % 360; }
  private sizeOf(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8") + 2; }

  private addOutputBytes(value: unknown): void {
    const serializedBytes = this.sizeOf(value);
    this.normalizedBytes += serializedBytes;
    if (this.normalizedBytes > this.limits.maxNormalizedOutputBytes) throw new Error("DXF normalized output limit exceeded");
    // This deterministic accounting includes UTF-16/string duplication and a
    // conservative object/array allocation allowance for each retained value.
    this.retainedModelBytes += serializedBytes * 2 + 96;
    this.assertRetainedBudget();
  }

  private assertRetainedBudget(): void {
    if (this.retainedModelBytes + this.currentBodyBytes > this.limits.maxRetainedModelBytes) {
      throw new Error("DXF retained model memory limit exceeded");
    }
  }
}

function createBudgetCheck(limits: DxfParserLimits): () => void {
  const wallStarted = limits.now();
  const cpuStarted = limits.cpuNow();
  return () => {
    if (limits.now() - wallStarted > limits.maxDurationMs) throw new Error("DXF parsing wall time limit exceeded");
    if (limits.cpuNow() - cpuStarted > limits.maxCpuMs) throw new Error("DXF parsing CPU time limit exceeded");
  };
}

export function parseAsciiDxf(input: string | Buffer, options: Partial<DxfParserLimits> = {}): NormalizedCadDocument {
  const limits = resolveLimits(options);
  const bytes = typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength;
  if (bytes > limits.maxInputBytes) throw new Error("DXF input limit exceeded");
  const source = typeof input === "string" ? input : input.toString("utf8");
  if (source.includes("\0")) throw new Error("Malformed DXF input contains NUL");
  const checkBudget = createBudgetCheck(limits);
  const builder = new DxfDocumentBuilder(limits, checkBudget);
  for (const pair of readBufferedPairs(source, limits, checkBudget)) builder.accept(pair);
  return builder.finish();
}

export async function parseAsciiDxfStream(
  input: AsyncIterable<Buffer | string> | Iterable<Buffer | string>, options: Partial<DxfParserLimits> = {}
): Promise<NormalizedCadDocument> {
  const limits = resolveLimits(options);
  const checkBudget = createBudgetCheck(limits);
  const builder = new DxfDocumentBuilder(limits, checkBudget);
  for await (const pair of readStreamingPairs(input, limits, checkBudget)) builder.accept(pair);
  return builder.finish();
}
