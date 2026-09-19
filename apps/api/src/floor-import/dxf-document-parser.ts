import { Buffer } from "node:buffer";
import {
  CAD_MAX_PARSED_COORDINATES,
  CAD_MAX_PARSED_ENTITIES,
  CAD_MAX_SPLINE_CONTROL_POINTS,
  CAD_MAX_SPLINE_KNOTS,
  CAD_MAX_SPLINE_SAMPLES_PER_DOCUMENT,
  CAD_MAX_UNSUPPORTED_ENTITY_TYPE_BYTES,
  CAD_MAX_UNSUPPORTED_ENTITY_TYPES
} from "./cad-runtime-contract";
import type { CadPoint, CadPolylineVertex, NormalizedCadAttribute, NormalizedCadBlock, NormalizedCadDocument, NormalizedCadEntity, NormalizedCadHatchEdgeLoop, NormalizedCadPolyline } from "./cad-types";
import { selectPrimaryCadBounds } from "./cad-viewport";

export interface DxfParserLimits {
  maxInputBytes: number;
  maxLineBytes: number;
  maxEntityBodyPairs: number;
  maxEntities: number;
  maxBlocks: number;
  maxCoordinates: number;
  maxSplineControlPoints: number;
  maxSplineKnots: number;
  maxSplineSamples: number;
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
  maxEntities: CAD_MAX_PARSED_ENTITIES,
  maxBlocks: 100_000,
  maxCoordinates: CAD_MAX_PARSED_COORDINATES,
  maxSplineControlPoints: CAD_MAX_SPLINE_CONTROL_POINTS,
  maxSplineKnots: CAD_MAX_SPLINE_KNOTS,
  maxSplineSamples: CAD_MAX_SPLINE_SAMPLES_PER_DOCUMENT,
  maxCoordinateMagnitude: 1_000_000_000,
  maxZCoordinateMagnitude: 100_000_000_000,
  maxExpandedEntities: 1_000_000,
  maxBlockDepth: 32,
  maxNormalizedOutputBytes: 128 * 1024 * 1024,
  maxRetainedModelBytes: 224 * 1024 * 1024,
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
    "maxInputBytes", "maxLineBytes", "maxEntityBodyPairs", "maxEntities", "maxBlocks", "maxCoordinates", "maxSplineControlPoints", "maxSplineKnots", "maxSplineSamples",
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
  input: AsyncIterable<Buffer | string> | Iterable<Buffer | string>,
  limits: DxfParserLimits,
  checkBudget: () => void,
  ignoreRemaining: () => boolean = () => false
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
    if (ignoreRemaining()) {
      pending = "";
      codeLine = null;
      continue;
    }
    pending += decoded;
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const pair = emit(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      if (pair) yield pair;
      if (ignoreRemaining()) {
        pending = "";
        codeLine = null;
        break;
      }
      newline = pending.indexOf("\n");
    }
    if (Buffer.byteLength(pending, "utf8") > limits.maxLineBytes + 1) throw new Error("DXF line byte limit exceeded");
  }
  pending += decoder.decode();
  if (pending.includes("\0")) throw new Error("Malformed DXF input contains NUL");
  if (ignoreRemaining()) return;
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
  private modelComplete = false;
  private opaqueTail = false;
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
  private readonly directUnsupportedEntityCounts = new Map<string, number>();
  private readonly blockUnsupportedEntityCounts = new Map<string, Map<string, number>>();
  private readonly unsupportedEntityTypes = new Set<string>();
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
        if (this.modelComplete && this.section === "OBJECTS") this.opaqueTail = true;
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
      this.modelComplete = this.section === "ENTITIES";
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
    if (!this.sawEof && !this.opaqueTail) throw new Error("DXF EOF marker is missing");
    if (this.awaitingSectionName || (!this.opaqueTail && this.section) || this.currentBlock) {
      throw new Error("Unterminated DXF SECTION or BLOCK");
    }
    if (this.polyline || this.attributeInsert) throw new Error("Unterminated DXF entity sequence");
    if (new Set(this.blocks.map(block => block.name)).size !== this.blocks.length) throw new Error("Duplicate DXF block name");
    const blockNames = new Set(this.blocks.map(block => block.name));
    const retainDrawableReferences = (entities: NormalizedCadEntity[]) => entities.filter(
      entity => entity.type !== "insert" || blockNames.has(entity.blockName)
    );
    // LibreDWG can emit INSERT records for unsupported custom objects without
    // serializing their block definition. They have no drawable geometry, so
    // retain the rest of the map while excluding only those orphan references.
    const blocks = this.blocks.map(block => ({ ...block, entities: retainDrawableReferences(block.entities) }));
    const entities = retainDrawableReferences(this.entities);
    const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
    const document: NormalizedCadDocument = {
      version: 1,
      bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      blocks,
      entities,
      unsupportedEntityCounts: this.countReachableUnsupported(blocks, entities)
    };
    const selection = selectPrimaryCadBounds(document, {
      maxRenderedEntities: this.limits.maxExpandedEntities,
      maxBlockDepth: this.limits.maxBlockDepth,
      maxSplineSamples: this.limits.maxSplineSamples,
      maxCoordinateMagnitude: this.limits.maxCoordinateMagnitude,
      checkBudget: this.checkBudget
    });
    document.bounds = Object.fromEntries(Object.entries(selection.bounds).map(([key, value]) => [key, round(value)])) as unknown as NormalizedCadDocument["bounds"];
    document.primaryBoundsSelection = {
      excludedEntityCount: selection.excludedEntityCount,
      totalEntityCount: selection.totalEntityCount
    };
    if (this.normalizedBytes + this.sizeOf(document.bounds) > this.limits.maxNormalizedOutputBytes) {
      throw new Error("DXF normalized output limit exceeded");
    }
    this.checkBudget();
    return document;
  }

  isOpaqueTail(): boolean { return this.opaqueTail; }

  private beginRecord(type: string): void {
    this.rawEntityCount++;
    if (this.rawEntityCount > this.limits.maxEntities) throw new Error("DXF entity limit exceeded");
    this.currentBodyBytes = 32 + Buffer.byteLength(type, "utf8") * 2;
    this.assertRetainedBudget();
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
          // LAYER bit 1 is globally frozen; bit 2 only defaults the layer to
          // frozen in newly created viewports and remains visible in model space.
          if (color < 0 || (flags & 1) !== 0) this.hiddenLayers.add(key);
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
      if (!entity) {
        if (visible && (record.section === "BLOCKS" || this.isModelSpace(record.body))) {
          this.recordUnsupported(record.type);
        }
        return;
      }
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

  private recordUnsupported(type: string): void {
    const typeBytes = Buffer.byteLength(type, "utf8");
    if (typeBytes < 1 || typeBytes > CAD_MAX_UNSUPPORTED_ENTITY_TYPE_BYTES) {
      throw new Error("DXF unsupported entity type byte limit exceeded");
    }
    if (!this.unsupportedEntityTypes.has(type)) {
      if (this.unsupportedEntityTypes.size >= CAD_MAX_UNSUPPORTED_ENTITY_TYPES) {
        throw new Error("DXF unsupported entity type count limit exceeded");
      }
      this.unsupportedEntityTypes.add(type);
      this.addOutputBytes({ [type]: 0 });
    }
    const counts = this.currentBlock
      ? this.blockUnsupportedEntityCounts.get(this.currentBlock.name) ?? new Map<string, number>()
      : this.directUnsupportedEntityCounts;
    if (!counts.has(type)) {
      this.retainedModelBytes += 96 + typeBytes * 2;
      this.assertRetainedBudget();
    }
    counts.set(type, (counts.get(type) ?? 0) + 1);
    if (this.currentBlock) this.blockUnsupportedEntityCounts.set(this.currentBlock.name, counts);
  }

  private countReachableUnsupported(
    blocks: NormalizedCadBlock[], entities: NormalizedCadEntity[]
  ): Readonly<Record<string, number>> {
    const counts = new Map(this.directUnsupportedEntityCounts);
    const byName = new Map(blocks.map(block => [block.name, block]));
    let occurrenceCount = [...counts.values()].reduce((sum, count) => sum + count, 0);
    const add = (type: string, count: number) => counts.set(type, (counts.get(type) ?? 0) + count);
    const visit = (items: NormalizedCadEntity[], stack: readonly string[]) => {
      for (const entity of items) {
        this.checkBudget();
        const reference = entity.type === "insert" ? entity.blockName : entity.type === "dimension" ? entity.blockName : null;
        if (!reference) continue;
        const block = byName.get(reference);
        if (!block) continue;
        if (stack.includes(reference)) throw new Error(`Cyclic CAD block reference: ${reference}`);
        if (stack.length >= this.limits.maxBlockDepth) throw new Error("CAD block depth limit exceeded");
        const unsupported = this.blockUnsupportedEntityCounts.get(reference);
        if (unsupported) for (const [type, count] of unsupported) {
          occurrenceCount += count;
          if (occurrenceCount > this.limits.maxExpandedEntities) throw new Error("CAD rendered entity limit exceeded");
          add(type, count);
        }
        visit(block.entities, [...stack, reference]);
      }
    };
    visit(entities, []);
    return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
  }

  private parseEntity(type: string, body: readonly DxfPair[]): NormalizedCadEntity | null {
    if (!["LINE", "LWPOLYLINE", "CIRCLE", "ARC", "ELLIPSE", "TEXT", "MTEXT", "INSERT", "SPLINE", "WIPEOUT", "HATCH", "DIMENSION", "POINT"].includes(type)) return null;
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
    if (type === "ELLIPSE") {
      const center = this.point(body, 10, 20, 30, "ellipse center");
      const majorAxis = this.point(body, 11, 21, 31, "ellipse major axis");
      const axisRatio = this.positive(this.number(this.first(body, 40), "ellipse axis ratio"), "ellipse axis ratio");
      if (axisRatio > 1 || Math.hypot(majorAxis.x, majorAxis.y, majorAxis.z) === 0) throw new Error("Invalid DXF ellipse axes");
      const normal = {
        x: this.number(this.first(body, 210), "ellipse normal.x", 0),
        y: this.number(this.first(body, 220), "ellipse normal.y", 0),
        z: this.number(this.first(body, 230), "ellipse normal.z", 1)
      };
      // A tilted 3D ellipse is outside the 2D import contract. Return it through
      // the existing reachable-unsupported accounting instead of flattening it.
      if (majorAxis.z !== 0 || normal.x !== 0 || normal.y !== 0 || Math.abs(normal.z) !== 1) return null;
      return {
        type: "ellipse", ...common, center, majorAxis, axisRatio,
        startParameter: this.number(this.first(body, 41), "ellipse start parameter", 0),
        endParameter: this.number(this.first(body, 42), "ellipse end parameter", Math.PI * 2),
        normalZ: normal.z as 1 | -1
      };
    }
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
    if (type === "SPLINE") {
      if (!this.first(body, 71) || !this.first(body, 40) || !this.first(body, 10)) return null;
      const degree = this.integer(this.first(body, 71), "spline degree");
      if (degree < 1 || degree > 32) throw new Error("Invalid DXF spline degree");
      const knots = body.filter(pair => pair.code === 40).map(pair => this.number(pair, "spline knot"));
      const controlPoints = this.repeatedPoints(body, 10, 20, 30, "spline control point");
      const weights = body.filter(pair => pair.code === 41).map(pair => this.positive(this.number(pair, "spline weight"), "spline weight"));
      if (controlPoints.length > this.limits.maxSplineControlPoints) throw new Error("DXF spline control point limit exceeded");
      if (knots.length > this.limits.maxSplineKnots) throw new Error("DXF spline knot limit exceeded");
      const declaredKnots = this.integer(this.first(body, 72), "spline knot count", knots.length);
      const declaredControls = this.integer(this.first(body, 73), "spline control point count", controlPoints.length);
      if (declaredKnots !== knots.length || declaredControls !== controlPoints.length ||
          controlPoints.length < degree + 1 || knots.length !== controlPoints.length + degree + 1 ||
          (weights.length !== 0 && weights.length !== controlPoints.length)) {
        throw new Error("Malformed DXF SPLINE definition");
      }
      for (let index = 1; index < knots.length; index++) {
        if (knots[index] < knots[index - 1]) throw new Error("Malformed DXF SPLINE knot order");
      }
      if (!(knots[degree] < knots[controlPoints.length])) throw new Error("Invalid DXF spline knot domain");
      return {
        type: "spline", ...common, degree, knots, weights, controlPoints,
        closed: (this.integer(this.first(body, 70), "spline flags", 0) & 1) === 1
      };
    }
    if (type === "WIPEOUT") {
      const clip = this.repeatedPoints(body, 14, 24, 34, "wipeout boundary");
      if (clip.length < 3) return null;
      const declaredClipCount = this.integer(this.first(body, 91), "WIPEOUT boundary count");
      if (declaredClipCount !== clip.length) throw new Error("DXF WIPEOUT boundary count mismatch");
      const base = this.optionalPoint(body, 10, 20, 30, { x: 0, y: 0, z: 0 }, "wipeout base");
      const u = this.optionalPoint(body, 11, 21, 31, { x: 1, y: 0, z: 0 }, "wipeout u vector");
      const v = this.optionalPoint(body, 12, 22, 32, { x: 0, y: 1, z: 0 }, "wipeout v vector");
      return {
        type: "wipeout", ...common,
        vertices: clip.map(point => ({
          x: base.x + point.x * u.x + point.y * v.x,
          y: base.y + point.x * u.y + point.y * v.y,
          z: base.z + point.z
        }))
      };
    }
    if (type === "HATCH") {
      const hatchStyle = this.integer(this.first(body, 75), "HATCH style", 0);
      if (hatchStyle !== 0 && hatchStyle !== 1 && hatchStyle !== 2) throw new Error("Invalid DXF HATCH style");
      const pathStarts = body.flatMap((pair, index) => pair.code === 92 ? [index] : []);
      const declaredLoopCount = this.integer(this.first(body, 91), "HATCH boundary loop count");
      if (declaredLoopCount !== pathStarts.length) throw new Error("DXF HATCH boundary loop count mismatch");
      const loops: Extract<NormalizedCadEntity, { type: "hatch" }>["loops"] = [];
      let unsupportedEdge = false;
      for (let pathIndex = 0; pathIndex < pathStarts.length; pathIndex++) {
        const start = pathStarts[pathIndex];
        const end = pathStarts[pathIndex + 1] ?? body.length;
        const trailing = body.slice(start + 1, end).findIndex(pair => [75, 76, 98].includes(pair.code));
        const pathBody = body.slice(start + 1, trailing < 0 ? end : start + 1 + trailing);
        const flags = this.integer(body[start], "HATCH boundary path flags");
        // The short DXF table lists only low bits; ObjectARX also defines
        // SelfIntersecting, Duplicate, annotation flags, etc. Preserve all bits.
        if (flags < 0 || flags > 0x7fffffff) throw new Error("Invalid DXF HATCH boundary path flags");
        const declaredCount = this.integer(this.first(pathBody, 93), "HATCH boundary item count");
        if ((flags & 2) !== 0) {
          const vertices: CadPolylineVertex[] = [];
          let pending: Partial<CadPolylineVertex> | null = null;
          const finishVertex = () => {
            if (!pending || pending.x === undefined || pending.y === undefined) throw new Error("Malformed DXF HATCH boundary vertex");
            vertices.push({ x: pending.x, y: pending.y, z: pending.z ?? 0, bulge: pending.bulge ?? 0 });
            pending = null;
          };
          for (const pair of pathBody) {
            if (pair.code === 97) break;
            if (pair.code === 10) { if (pending) finishVertex(); pending = { x: this.number(pair, "hatch boundary.x"), z: 0, bulge: 0 }; }
            else if (pair.code === 20) {
              if (!pending || pending.y !== undefined) throw new Error("Malformed DXF HATCH boundary vertex");
              pending.y = this.number(pair, "hatch boundary.y");
            } else if (pair.code === 30 && pending) pending.z = this.number(pair, "hatch boundary.z", 0, this.limits.maxZCoordinateMagnitude);
            else if (pair.code === 42 && pending) pending.bulge = this.number(pair, "hatch boundary bulge");
          }
          if (pending) finishVertex();
          if (declaredCount !== vertices.length) throw new Error("DXF HATCH boundary vertex count mismatch");
          if (vertices.length < 2) throw new Error("Malformed DXF HATCH boundary loop");
          loops.push({ type: "polyline", flags, vertices, closed: this.integer(this.first(pathBody, 73), "hatch boundary closed", 1) !== 0 });
          continue;
        }
        const edgeStarts = pathBody.flatMap((pair, index) => pair.code === 72 ? [index] : []);
        if (declaredCount !== edgeStarts.length) throw new Error("DXF HATCH boundary edge count mismatch");
        const edges: NormalizedCadHatchEdgeLoop["edges"] = [];
        for (let edgeIndex = 0; edgeIndex < edgeStarts.length; edgeIndex++) {
          const edgeStart = edgeStarts[edgeIndex];
          const edgeBody = pathBody.slice(edgeStart + 1, edgeStarts[edgeIndex + 1] ?? pathBody.length);
          const edgeType = this.integer(pathBody[edgeStart], "HATCH boundary edge type");
          if (edgeType === 1) {
            edges.push({ type: "line", start: this.point(edgeBody, 10, 20, 30, "hatch line start"), end: this.point(edgeBody, 11, 21, 31, "hatch line end") });
          } else if (edgeType === 2) {
            edges.push({
              type: "arc", center: this.point(edgeBody, 10, 20, 30, "hatch arc center"),
              radius: this.positive(this.number(this.first(edgeBody, 40), "hatch arc radius"), "hatch arc radius"),
              startAngle: this.angle(this.number(this.first(edgeBody, 50), "hatch arc start angle")),
              endAngle: this.angle(this.number(this.first(edgeBody, 51), "hatch arc end angle")),
              counterClockwise: this.integer(this.first(edgeBody, 73), "hatch arc direction", 1) !== 0
            });
          } else {
            unsupportedEdge = true;
          }
        }
        loops.push({ type: "edges", flags, edges });
      }
      if (loops.length === 0) throw new Error("Malformed DXF HATCH boundary");
      if (unsupportedEdge) return null;
      return { type: "hatch", ...common, hatchStyle, loops };
    }
    if (type === "DIMENSION") {
      const definitionPoint = this.point(body, 10, 20, 30, "dimension definition point");
      const rawBlockName = this.first(body, 2)?.value.trim();
      return {
        type: "dimension", ...common,
        blockName: rawBlockName ? this.requireName(rawBlockName, "dimension block name") : null,
        definitionPoint,
        blockPosition: this.optionalPoint(body, 12, 22, 32, { x: 0, y: 0, z: 0 }, "dimension block position"),
        textPosition: this.optionalPoint(body, 11, 21, 31, definitionPoint, "dimension text position"),
        extensionStart: this.optionalPoint(body, 13, 23, 33, definitionPoint, "dimension extension start"),
        extensionEnd: this.optionalPoint(body, 14, 24, 34, definitionPoint, "dimension extension end"),
        rotation: this.angle(this.number(this.first(body, 53), "dimension text rotation", 0)),
        text: this.first(body, 1)?.value ?? ""
      };
    }
    if (type === "POINT") return { type: "point", ...common, position: this.point(body, 10, 20, 30, "point position") };
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

  private optionalPoint(
    body: readonly DxfPair[], x: number, y: number, z: number, fallback: CadPoint, label: string
  ): CadPoint {
    const xPair = this.first(body, x);
    const yPair = this.first(body, y);
    if (!xPair && !yPair) return { ...fallback };
    if (!xPair || !yPair) throw new Error(`Malformed DXF ${label}`);
    return {
      x: this.number(xPair, `${label}.x`),
      y: this.number(yPair, `${label}.y`),
      z: this.number(this.first(body, z), `${label}.z`, 0, this.limits.maxZCoordinateMagnitude)
    };
  }

  private repeatedPoints(body: readonly DxfPair[], x: number, y: number, z: number, label: string): CadPoint[] {
    const points: CadPoint[] = [];
    let pending: Partial<CadPoint> | null = null;
    const finish = () => {
      if (!pending || pending.x === undefined || pending.y === undefined) throw new Error(`Malformed DXF ${label}`);
      points.push({ x: pending.x, y: pending.y, z: pending.z ?? 0 });
      pending = null;
    };
    for (const pair of body) {
      if (pair.code === x) { if (pending) finish(); pending = { x: this.number(pair, `${label}.x`), z: 0 }; }
      else if (pair.code === y && pending) {
        if (pending.y !== undefined) throw new Error(`Malformed DXF ${label}`);
        pending.y = this.number(pair, `${label}.y`);
      } else if (pair.code === z && pending) pending.z = this.number(pair, `${label}.z`, 0, this.limits.maxZCoordinateMagnitude);
    }
    if (pending) finish();
    return points;
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
  for (const pair of readBufferedPairs(source, limits, checkBudget)) {
    builder.accept(pair);
    if (builder.isOpaqueTail()) break;
  }
  return builder.finish();
}

export async function parseAsciiDxfStream(
  input: AsyncIterable<Buffer | string> | Iterable<Buffer | string>, options: Partial<DxfParserLimits> = {}
): Promise<NormalizedCadDocument> {
  const limits = resolveLimits(options);
  const checkBudget = createBudgetCheck(limits);
  const builder = new DxfDocumentBuilder(limits, checkBudget);
  for await (const pair of readStreamingPairs(input, limits, checkBudget, () => builder.isOpaqueTail())) {
    builder.accept(pair);
  }
  return builder.finish();
}
