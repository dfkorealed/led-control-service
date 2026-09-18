import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { cadBulgeArc, dimensionMatrix, iterateCadDocumentExpansion, multiplyCadMatrices, sampleCadSpline, transformPoint, type CadMatrix, type ExpandedCadEntity } from "./cad-geometry";
import { CAD_RENDERED_SVG_MAX_BYTES, CAD_RENDERED_SVG_RAW_MAX_BYTES } from "./cad-resource-limits";
import { CAD_MAX_SPLINE_SAMPLES_PER_DOCUMENT } from "./cad-runtime-contract";
import { forEachCadTextGlyph, sanitizeCadText } from "./cad-text-layout";
import type { CadPoint, NormalizedCadDocument, NormalizedCadHatchLoop } from "./cad-types";
import { cadViewportScale, cadViewportSvgTransform, createCadViewport, selectPrimaryCadBounds } from "./cad-viewport";

export interface CadSvgRendererLimits {
  maxRenderedEntities: number;
  maxOutputBytes: number;
  maxBlockDepth: number;
  maxSplineSamples: number;
  padding: number;
  trustDocumentBounds: boolean;
  includeEntityMetadata: boolean;
  compactPaths: boolean;
  maxDurationMs: number;
  maxCpuMs: number;
  now: () => number;
  cpuNow: () => number;
}

const DEFAULT_LIMITS: CadSvgRendererLimits = {
  maxRenderedEntities: 100_000,
  maxOutputBytes: 8 * 1024 * 1024,
  maxBlockDepth: 16,
  maxSplineSamples: CAD_MAX_SPLINE_SAMPLES_PER_DOCUMENT,
  padding: 1,
  trustDocumentBounds: false,
  includeEntityMetadata: true,
  compactPaths: false,
  maxDurationMs: 30_000,
  maxCpuMs: 30_000,
  now: () => performance.now(),
  cpuNow: () => {
    const usage = process.cpuUsage();
    return (usage.user + usage.system) / 1_000;
  }
};
const MIN_SERIALIZED_GLYPH_BYTES = 16;
export { CAD_RENDERED_SVG_MAX_BYTES, CAD_RENDERED_SVG_RAW_MAX_BYTES } from "./cad-resource-limits";

function xmlSanitized(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
  })[character]!);
}

function xml(value: string): string {
  return xmlSanitized(sanitizeCadText(value));
}

function xmlByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const escaped = ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" } as Record<string, string>)[character] ?? character;
    bytes += Buffer.byteLength(escaped, "utf8");
  }
  return bytes;
}

function number(value: number): string {
  if (!Number.isFinite(value)) throw new Error("Non-finite CAD SVG geometry");
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function arcSweep(start: number, end: number): number {
  return ((end - start) % 360 + 360) % 360;
}

function pointsForCircle(center: CadPoint, radius: number, matrix: CadMatrix): CadPoint[] {
  return Array.from({ length: 48 }, (_, index) => {
    const radians = index * Math.PI * 2 / 48;
    return transformPoint(matrix, { x: center.x + radius * Math.cos(radians), y: center.y + radius * Math.sin(radians), z: center.z });
  });
}

function pointsForArc(item: ExpandedCadEntity & { entity: Extract<ExpandedCadEntity["entity"], { type: "arc" }> }): CadPoint[] {
  const sweep = arcSweep(item.entity.startAngle, item.entity.endAngle);
  const segments = Math.max(2, Math.ceil(Math.max(sweep, 1) / 6));
  return Array.from({ length: segments + 1 }, (_, index) => {
    const angle = (item.entity.startAngle + sweep * index / segments) * Math.PI / 180;
    return transformPoint(item.matrix, {
      x: item.entity.center.x + item.entity.radius * Math.cos(angle),
      y: item.entity.center.y + item.entity.radius * Math.sin(angle),
      z: item.entity.center.z
    });
  });
}

function pointsForPolyline(
  entity: Extract<ExpandedCadEntity["entity"], { type: "lwpolyline" | "polyline" }>,
  matrix: CadMatrix
): CadPoint[] {
  const points = [transformPoint(matrix, entity.vertices[0])];
  const segmentCount = entity.closed ? entity.vertices.length : entity.vertices.length - 1;
  for (let index = 0; index < segmentCount; index++) {
    const start = entity.vertices[index];
    const end = entity.vertices[(index + 1) % entity.vertices.length];
    const arc = cadBulgeArc(start, end, start.bulge);
    if (!arc) {
      points.push(transformPoint(matrix, end));
      continue;
    }
    const segments = Math.max(2, Math.ceil(Math.abs(arc.sweepAngle) / 6));
    for (let step = 1; step <= segments; step++) {
      const angle = (arc.startAngle + arc.sweepAngle * step / segments) * Math.PI / 180;
      points.push(transformPoint(matrix, {
        x: arc.center.x + arc.radius * Math.cos(angle),
        y: arc.center.y + arc.radius * Math.sin(angle),
        z: arc.center.z
      }));
    }
  }
  return points;
}

function pointsForHatchLoop(loop: NormalizedCadHatchLoop, matrix: CadMatrix): CadPoint[] {
  if (loop.type === "polyline") {
    return pointsForPolyline({ type: "polyline", sourceEntityId: "hatch", layer: "0", vertices: loop.vertices, closed: loop.closed }, matrix);
  }
  const points: CadPoint[] = [];
  for (const edge of loop.edges) {
    if (edge.type === "line") {
      if (points.length === 0) points.push(transformPoint(matrix, edge.start));
      points.push(transformPoint(matrix, edge.end));
      continue;
    }
    const raw = edge.endAngle - edge.startAngle;
    const ccw = ((raw % 360) + 360) % 360 || 360;
    const sweep = edge.counterClockwise ? ccw : -(360 - ccw || 360);
    const segments = Math.max(2, Math.ceil(Math.abs(sweep) / 6));
    for (let step = points.length === 0 ? 0 : 1; step <= segments; step++) {
      const radians = (edge.startAngle + sweep * step / segments) * Math.PI / 180;
      points.push(transformPoint(matrix, {
        x: edge.center.x + edge.radius * Math.cos(radians),
        y: edge.center.y + edge.radius * Math.sin(radians),
        z: edge.center.z
      }));
    }
  }
  return points;
}

function storedPrimarySelection(document: NormalizedCadDocument) {
  return document.primaryBoundsSelection
    ? { bounds: document.bounds, ...document.primaryBoundsSelection }
    : selectPrimaryCadBounds(document);
}

export function renderCadDocumentSvg(document: NormalizedCadDocument, options: Partial<CadSvgRendererLimits> = {}): string {
  const limits = { ...DEFAULT_LIMITS, ...options };
  if (!Number.isInteger(limits.maxRenderedEntities) || limits.maxRenderedEntities < 1 ||
      !Number.isInteger(limits.maxOutputBytes) || limits.maxOutputBytes < 1 ||
      !Number.isInteger(limits.maxBlockDepth) || limits.maxBlockDepth < 1 ||
      !Number.isInteger(limits.maxSplineSamples) || limits.maxSplineSamples < 1 ||
      !Number.isFinite(limits.padding) || limits.padding < 0 ||
      !Number.isFinite(limits.maxDurationMs) || limits.maxDurationMs <= 0 ||
      !Number.isFinite(limits.maxCpuMs) || limits.maxCpuMs <= 0) throw new Error("Invalid CAD SVG renderer limits");
  const wallStarted = limits.now();
  const cpuStarted = limits.cpuNow();
  const checkBudget = () => {
    if (limits.now() - wallStarted > limits.maxDurationMs) throw new Error("CAD SVG wall time limit exceeded");
    if (limits.cpuNow() - cpuStarted > limits.maxCpuMs) throw new Error("CAD SVG CPU time limit exceeded");
  };
  const maxTextGlyphs = Math.max(1, Math.floor(limits.maxOutputBytes / MIN_SERIALIZED_GLYPH_BYTES));
  const bounds = limits.trustDocumentBounds ? document.bounds : storedPrimarySelection(document).bounds;
  const width = Math.max(1, bounds.maxX - bounds.minX + limits.padding * 2);
  const height = Math.max(1, bounds.maxY - bounds.minY + limits.padding * 2);
  const project = (point: CadPoint) => ({
    x: point.x - bounds.minX + limits.padding,
    y: bounds.maxY - point.y + limits.padding,
    z: point.z
  });
  const projection: CadMatrix = { a: 1, b: 0, c: 0, d: -1, e: -bounds.minX + limits.padding, f: bounds.maxY + limits.padding };
  const matrixAttribute = (matrix: CadMatrix) => `matrix(${number(matrix.a)} ${number(matrix.b)} ${number(matrix.c)} ${number(matrix.d)} ${number(matrix.e)} ${number(matrix.f)})`;
  const compactPolylinePath = (entity: Extract<ExpandedCadEntity["entity"], { type: "lwpolyline" | "polyline" }>) => {
    const first = entity.vertices[0];
    const commands = [`M${number(first.x)} ${number(first.y)}`];
    const segmentCount = entity.closed ? entity.vertices.length : entity.vertices.length - 1;
    for (let index = 0; index < segmentCount; index++) {
      checkBudget();
      const start = entity.vertices[index];
      const end = entity.vertices[(index + 1) % entity.vertices.length];
      const arc = cadBulgeArc(start, end, start.bulge);
      if (!arc) commands.push(`L${number(end.x)} ${number(end.y)}`);
      else commands.push(`A${number(arc.radius)} ${number(arc.radius)} 0 ${Math.abs(arc.sweepAngle) > 180 ? 1 : 0} ${arc.sweepAngle < 0 ? 1 : 0} ${number(end.x)} ${number(end.y)}`);
    }
    if (entity.closed) commands.push("Z");
    return commands.join(" ");
  };
  const projectedPoints = (points: readonly CadPoint[]) => points.map(point => {
    const projected = project(point);
    return `${number(projected.x)},${number(projected.y)}`;
  }).join(" ");
  const pieces: string[] = [];
  let outputBytes = 0;
  const ensureOutputCapacity = (bytes: number) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || outputBytes + bytes > limits.maxOutputBytes) {
      throw new Error("CAD SVG output limit exceeded");
    }
  };
  const append = (piece: string) => {
    const bytes = Buffer.byteLength(piece, "utf8");
    ensureOutputCapacity(bytes);
    outputBytes += bytes;
    pieces.push(piece);
  };
  const attributes = (item: ExpandedCadEntity) => {
    if (!limits.includeEntityMetadata) return "";
    const block = item.blockName === null ? "" : ` data-block-name="${xml(item.blockName)}"`;
    const insertLayer = item.insertLayer === null ? "" : ` data-insert-layer="${xml(item.insertLayer)}"`;
    return `data-source-entity-id="${xml(item.sourceEntityId)}" data-layer="${xml(item.entity.layer)}"${insertLayer}${block}`;
  };
  let splineSamples = 0;
  const splinePoints = (entity: Extract<ExpandedCadEntity["entity"], { type: "spline" }>, matrix: CadMatrix) => {
    const points = sampleCadSpline(entity, limits.maxSplineSamples - splineSamples);
    splineSamples += points.length;
    return points.map(point => transformPoint(matrix, point));
  };

  append(`<svg xmlns="http://www.w3.org/2000/svg" width="${number(width)}" height="${number(height)}" viewBox="0 0 ${number(width)} ${number(height)}" role="img" aria-label="CAD floor plan">`);
  append(`<rect x="0" y="0" width="${number(width)}" height="${number(height)}" fill="#ffffff"/>`);
  append('<g fill="none" stroke="#1f2937" stroke-width="0.2" vector-effect="non-scaling-stroke">');
  const renderItems = iterateCadDocumentExpansion(document, {
    maxRenderedEntities: limits.maxRenderedEntities,
    maxBlockDepth: limits.maxBlockDepth
  });
  for (const work of renderItems) {
    checkBudget();
    if (!work) continue;
    const item = work;
    const entity = item.entity;
    const attrs = attributes(item);
    if (entity.type === "line") {
      const start = project(transformPoint(item.matrix, entity.start));
      const end = project(transformPoint(item.matrix, entity.end));
      append(`<line ${attrs} x1="${number(start.x)}" y1="${number(start.y)}" x2="${number(end.x)}" y2="${number(end.y)}"/>`);
    } else if ((entity.type === "lwpolyline" || entity.type === "polyline") && limits.compactPaths) {
      const matrix = multiplyCadMatrices(projection, item.matrix);
      append(`<path ${attrs} d="${compactPolylinePath(entity)}" transform="${matrixAttribute(matrix)}"/>`);
    } else if (entity.type === "lwpolyline" || entity.type === "polyline") {
      const points = pointsForPolyline(entity, item.matrix);
      const tag = entity.closed ? "polygon" : "polyline";
      append(`<${tag} ${attrs} points="${projectedPoints(points)}"/>`);
    } else if (entity.type === "spline") {
      append(`<polyline ${attrs} data-cad-entity="spline" points="${projectedPoints(splinePoints(entity, item.matrix))}"${entity.closed ? ' data-closed="true"' : ""}/>`);
    } else if (entity.type === "wipeout") {
      append(`<polygon ${attrs} data-cad-entity="wipeout" points="${projectedPoints(entity.vertices.map(point => transformPoint(item.matrix, point)))}" fill="#fff" stroke="none"/>`);
    } else if (entity.type === "hatch") {
      const path = entity.loops.map(loop => {
        const points = pointsForHatchLoop(loop, item.matrix).map(project);
        if (points.length === 0) throw new Error("Invalid CAD HATCH boundary");
        return `M${points.map((point, index) => `${index === 0 ? "" : "L"}${number(point.x)} ${number(point.y)}`).join("")}Z`;
      }).join(" ");
      append(`<path ${attrs} data-cad-entity="hatch" d="${path}" fill="#e5e7eb" fill-rule="evenodd"/>`);
    } else if (entity.type === "circle" && limits.compactPaths) {
      const matrix = multiplyCadMatrices(projection, item.matrix);
      append(`<circle ${attrs} cx="${number(entity.center.x)}" cy="${number(entity.center.y)}" r="${number(entity.radius)}" transform="${matrixAttribute(matrix)}"/>`);
    } else if (entity.type === "circle") {
      append(`<polygon ${attrs} points="${projectedPoints(pointsForCircle(entity.center, entity.radius, item.matrix))}"/>`);
    } else if (entity.type === "arc" && limits.compactPaths) {
      const startRadians = entity.startAngle * Math.PI / 180;
      const endRadians = entity.endAngle * Math.PI / 180;
      const start = { x: entity.center.x + entity.radius * Math.cos(startRadians), y: entity.center.y + entity.radius * Math.sin(startRadians) };
      const end = { x: entity.center.x + entity.radius * Math.cos(endRadians), y: entity.center.y + entity.radius * Math.sin(endRadians) };
      const sweep = arcSweep(entity.startAngle, entity.endAngle);
      const matrix = multiplyCadMatrices(projection, item.matrix);
      append(`<path ${attrs} d="M${number(start.x)} ${number(start.y)} A${number(entity.radius)} ${number(entity.radius)} 0 ${sweep > 180 ? 1 : 0} 0 ${number(end.x)} ${number(end.y)}" transform="${matrixAttribute(matrix)}"/>`);
    } else if (entity.type === "arc") {
      append(`<polyline ${attrs} points="${projectedPoints(pointsForArc(item as ExpandedCadEntity & { entity: Extract<ExpandedCadEntity["entity"], { type: "arc" }> }))}"/>`);
    } else if (entity.type === "dimension") {
      const points = [entity.extensionStart, entity.definitionPoint, entity.extensionEnd]
        .map(point => transformPoint(item.matrix, point));
      append(`<polyline ${attrs} data-cad-entity="dimension" points="${projectedPoints(points)}"/>`);
    } else if (entity.type === "point") {
      const point = project(transformPoint(item.matrix, entity.position));
      append(`<path ${attrs} data-cad-entity="point" d="M${number(point.x - 3)} ${number(point.y)}h6M${number(point.x)} ${number(point.y - 3)}v6"/>`);
    } else if (entity.type === "text" || entity.type === "mtext") {
      const radians = entity.rotation * Math.PI / 180;
      const textTransform: CadMatrix = {
        a: Math.cos(radians), b: Math.sin(radians), c: -Math.sin(radians), d: Math.cos(radians),
        e: entity.position.x, f: entity.position.y
      };
      const matrix = multiplyCadMatrices(projection, multiplyCadMatrices(item.matrix, textTransform));
      const text = sanitizeCadText(entity.text);
      const openingPrefix = `<g ${attrs} data-cad-text="true" aria-label="`;
      const openingSuffix = `" fill="#111827" stroke="none" transform="${matrixAttribute(matrix)}">`;
      ensureOutputCapacity(Buffer.byteLength(openingPrefix, "utf8") + xmlByteLength(text) + Buffer.byteLength(openingSuffix, "utf8"));
      append(`${openingPrefix}${xmlSanitized(text)}${openingSuffix}`);
      forEachCadTextGlyph(entity.text, entity.height, { maxGlyphs: maxTextGlyphs }, glyph => {
        checkBudget();
        if (!Number.isFinite(glyph.bounds.minX) || !Number.isFinite(glyph.bounds.minY) ||
            !Number.isFinite(glyph.bounds.maxX) || !Number.isFinite(glyph.bounds.maxY)) return;
        const transform = ` transform="translate(${number(glyph.x)} ${number(glyph.y)}) scale(${number(glyph.scale)})"/>`;
        const wrapperBytes = Buffer.byteLength(`<path d=""${transform}`, "utf8");
        // Inspect trusted path commands first, then charge the exact serialized tag.
        ensureOutputCapacity(wrapperBytes + glyph.pathByteLength());
        const path = glyph.createPath();
        append(`<path d="${path}"${transform}`);
      });
      append("</g>");
    } else {
      throw new Error(`Unsupported normalized CAD SVG entity: ${entity.type}`);
    }
  }
  append("</g></svg>");
  checkBudget();
  return pieces.join("");
}

export interface CadSvgFileResult {
  sizeBytes: number;
  rawSizeBytes: number;
  sha256: string;
  viewport: { width: number; height: number };
  renderedOccurrences: number;
  unsupportedEntityCounts?: Readonly<Record<string, number>>;
  excludedEntityCount?: number;
  contentEncoding: "gzip";
}

/**
 * Writes a compact SVG whose block geometry is defined once and referenced by
 * INSERT occurrences. This is the production renderer: it never retains the
 * complete SVG string or an expanded entity array in memory.
 */
export async function renderCadDocumentSvgFile(
  document: NormalizedCadDocument,
  outputPath: string,
  options: Partial<Pick<CadSvgRendererLimits, "maxOutputBytes" | "maxRenderedEntities" | "maxBlockDepth" | "maxSplineSamples" | "maxDurationMs" | "maxCpuMs" | "now" | "cpuNow">> & { abortSignal?: AbortSignal } = {}
): Promise<CadSvgFileResult> {
  const limits = { ...DEFAULT_LIMITS, ...options, maxOutputBytes: options.maxOutputBytes ?? CAD_RENDERED_SVG_MAX_BYTES };
  const startedAt = limits.now();
  const cpuStarted = limits.cpuNow();
  const checkBudget = () => {
    if (options.abortSignal?.aborted) throw new Error("CAD SVG rendering aborted");
    if (limits.now() - startedAt > limits.maxDurationMs) throw new Error("CAD SVG wall time limit exceeded");
    if (limits.cpuNow() - cpuStarted > limits.maxCpuMs) throw new Error("CAD SVG CPU time limit exceeded");
  };
  if (!Number.isSafeInteger(limits.maxOutputBytes) || limits.maxOutputBytes < 1 || limits.maxOutputBytes > CAD_RENDERED_SVG_MAX_BYTES ||
      !Number.isSafeInteger(limits.maxRenderedEntities) || limits.maxRenderedEntities < 1 ||
      !Number.isSafeInteger(limits.maxBlockDepth) || limits.maxBlockDepth < 1 ||
      !Number.isSafeInteger(limits.maxSplineSamples) || limits.maxSplineSamples < 1) throw new Error("Invalid CAD SVG file renderer limits");

  const primarySelection = storedPrimarySelection(document);
  const blockByName = new Map(document.blocks.map((block, index) => [block.name, { block, id: `cad-block-${index}` }]));
  if (blockByName.size !== document.blocks.length) throw new Error("Duplicate CAD block name");
  let renderedOccurrences = 0;
  const countEntities = (entities: NormalizedCadDocument["entities"], stack: readonly string[]): number => {
    let count = 0;
    for (const entity of entities) {
      checkBudget();
      const reference = entity.type === "insert" ? entity.blockName : entity.type === "dimension" ? entity.blockName : null;
      if (!reference) count++;
      else {
        const target = blockByName.get(reference);
        if (entity.type === "dimension" && !target) {
          count++;
          continue;
        }
        if (!target) throw new Error(`CAD INSERT references missing block: ${reference}`);
        if (stack.includes(reference)) throw new Error(`Cyclic CAD block reference: ${reference}`);
        if (stack.length >= limits.maxBlockDepth) throw new Error("CAD block depth limit exceeded");
        count += countEntities(target.block.entities, [...stack, reference]);
      }
      if (renderedOccurrences + count > limits.maxRenderedEntities) throw new Error("CAD rendered entity limit exceeded");
    }
    return count;
  };
  renderedOccurrences = countEntities(document.entities, []);
  const reachableBlocks = new Set<string>();
  const markReachable = (entities: NormalizedCadDocument["entities"]) => {
    for (const entity of entities) {
      const reference = entity.type === "insert" ? entity.blockName : entity.type === "dimension" ? entity.blockName : null;
      if (!reference || reachableBlocks.has(reference)) continue;
      const target = blockByName.get(reference);
      if (!target) {
        if (entity.type === "dimension") continue;
        throw new Error(`CAD INSERT references missing block: ${reference}`);
      }
      reachableBlocks.add(reference);
      markReachable(target.block.entities);
    }
  };
  markReachable(document.entities);

  const { width, height } = createCadViewport(primarySelection.bounds);
  const pointMarkerRadius = 3 / cadViewportScale(primarySelection.bounds);
  const rawPath = `${outputPath}.raw`;
  const file = await open(rawPath, "wx", 0o600);
  let rawSizeBytes = 0;
  const write = async (piece: string) => {
    checkBudget();
    const bytes = Buffer.from(piece, "utf8");
    if (rawSizeBytes + bytes.length > CAD_RENDERED_SVG_RAW_MAX_BYTES) throw new Error("CAD SVG raw output limit exceeded");
    await file.write(bytes);
    rawSizeBytes += bytes.length;
  };
  const matrix = (entity: Extract<NormalizedCadDocument["entities"][number], { type: "insert" }>, base: CadPoint) => {
    const radians = entity.rotation * Math.PI / 180;
    const a = Math.cos(radians) * entity.scale.x;
    const b = Math.sin(radians) * entity.scale.x;
    const c = -Math.sin(radians) * entity.scale.y;
    const d = Math.cos(radians) * entity.scale.y;
    return `matrix(${number(a)} ${number(b)} ${number(c)} ${number(d)} ${number(entity.position.x - a * base.x - c * base.y)} ${number(entity.position.y - b * base.x - d * base.y)})`;
  };
  const pathForVertices = (vertices: readonly (CadPoint & { bulge?: number })[], closed: boolean) => {
    const first = vertices[0];
    const commands = [`M${number(first.x)} ${number(first.y)}`];
    const count = closed ? vertices.length : vertices.length - 1;
    for (let index = 0; index < count; index++) {
      const start = vertices[index];
      const end = vertices[(index + 1) % vertices.length];
      const arc = cadBulgeArc(start, end, start.bulge ?? 0);
      commands.push(arc
        ? `A${number(arc.radius)} ${number(arc.radius)} 0 ${Math.abs(arc.sweepAngle) > 180 ? 1 : 0} ${arc.sweepAngle < 0 ? 1 : 0} ${number(end.x)} ${number(end.y)}`
        : `L${number(end.x)} ${number(end.y)}`);
    }
    if (closed) commands.push("Z");
    return commands.join(" ");
  };
  const pathForHatchLoop = (loop: NormalizedCadHatchLoop) => {
    if (loop.type === "polyline") return pathForVertices(loop.vertices, loop.closed);
    const commands: string[] = [];
    for (const edge of loop.edges) {
      if (edge.type === "line") {
        if (commands.length === 0) commands.push(`M${number(edge.start.x)} ${number(edge.start.y)}`);
        commands.push(`L${number(edge.end.x)} ${number(edge.end.y)}`);
      } else {
        const raw = edge.endAngle - edge.startAngle;
        const ccw = ((raw % 360) + 360) % 360 || 360;
        const sweep = edge.counterClockwise ? ccw : -(360 - ccw || 360);
        const start = edge.startAngle * Math.PI / 180;
        const end = (edge.startAngle + sweep) * Math.PI / 180;
        if (commands.length === 0) commands.push(`M${number(edge.center.x + edge.radius * Math.cos(start))} ${number(edge.center.y + edge.radius * Math.sin(start))}`);
        if (Math.abs(sweep) >= 360 - 1e-10) {
          const middle = (edge.startAngle + sweep / 2) * Math.PI / 180;
          commands.push(`A${number(edge.radius)} ${number(edge.radius)} 0 0 ${sweep < 0 ? 1 : 0} ${number(edge.center.x + edge.radius * Math.cos(middle))} ${number(edge.center.y + edge.radius * Math.sin(middle))}`);
          commands.push(`A${number(edge.radius)} ${number(edge.radius)} 0 0 ${sweep < 0 ? 1 : 0} ${number(edge.center.x + edge.radius * Math.cos(end))} ${number(edge.center.y + edge.radius * Math.sin(end))}`);
        } else {
          commands.push(`A${number(edge.radius)} ${number(edge.radius)} 0 ${Math.abs(sweep) > 180 ? 1 : 0} ${sweep < 0 ? 1 : 0} ${number(edge.center.x + edge.radius * Math.cos(end))} ${number(edge.center.y + edge.radius * Math.sin(end))}`);
        }
      }
    }
    if (commands.length === 0) throw new Error("Invalid CAD HATCH boundary");
    commands.push("Z");
    return commands.join(" ");
  };
  let splineSamples = 0;
  const pathForSpline = (entity: Extract<NormalizedCadDocument["entities"][number], { type: "spline" }>) => {
    const points = sampleCadSpline(entity, limits.maxSplineSamples - splineSamples);
    splineSamples += points.length;
    return pathForVertices(points, entity.closed);
  };
  const renderEntities = async (entities: NormalizedCadDocument["entities"]) => {
    for (const entity of entities) {
      checkBudget();
      if (entity.type === "insert") {
        const target = blockByName.get(entity.blockName);
        if (!target) throw new Error(`CAD INSERT references missing block: ${entity.blockName}`);
        await write(`<use href="#${target.id}" transform="${matrix(entity, target.block.basePoint)}"/>`);
      } else if (entity.type === "line") {
        await write(`<path d="M${number(entity.start.x)} ${number(entity.start.y)}L${number(entity.end.x)} ${number(entity.end.y)}"/>`);
      } else if (entity.type === "lwpolyline" || entity.type === "polyline") {
        await write(`<path d="${pathForVertices(entity.vertices, entity.closed)}"/>`);
      } else if (entity.type === "spline") {
        await write(`<path data-cad-entity="spline" d="${pathForSpline(entity)}"/>`);
      } else if (entity.type === "wipeout") {
        await write(`<path data-cad-entity="wipeout" d="${pathForVertices(entity.vertices, true)}" fill="#fff" stroke="none"/>`);
      } else if (entity.type === "hatch") {
        await write(`<path data-cad-entity="hatch" d="${entity.loops.map(pathForHatchLoop).join(" ")}" fill="#e5e7eb" fill-rule="evenodd"/>`);
      } else if (entity.type === "circle") {
        await write(`<circle cx="${number(entity.center.x)}" cy="${number(entity.center.y)}" r="${number(entity.radius)}"/>`);
      } else if (entity.type === "arc") {
        const start = entity.startAngle * Math.PI / 180;
        const end = entity.endAngle * Math.PI / 180;
        const sweep = arcSweep(entity.startAngle, entity.endAngle);
        await write(`<path d="M${number(entity.center.x + entity.radius * Math.cos(start))} ${number(entity.center.y + entity.radius * Math.sin(start))}A${number(entity.radius)} ${number(entity.radius)} 0 ${sweep > 180 ? 1 : 0} 1 ${number(entity.center.x + entity.radius * Math.cos(end))} ${number(entity.center.y + entity.radius * Math.sin(end))}"/>`);
      } else if (entity.type === "dimension") {
        const target = entity.blockName ? blockByName.get(entity.blockName) : undefined;
        if (target) {
          const transform = dimensionMatrix(entity, target.block.basePoint);
          await write(`<use data-cad-entity="dimension" href="#${target.id}" transform="matrix(${number(transform.a)} ${number(transform.b)} ${number(transform.c)} ${number(transform.d)} ${number(transform.e)} ${number(transform.f)})"/>`);
        }
        else await write(`<path data-cad-entity="dimension" d="M${number(entity.extensionStart.x)} ${number(entity.extensionStart.y)}L${number(entity.definitionPoint.x)} ${number(entity.definitionPoint.y)}L${number(entity.extensionEnd.x)} ${number(entity.extensionEnd.y)}"/>`);
      } else if (entity.type === "point") {
        await write(`<path data-cad-entity="point" d="M${number(entity.position.x - pointMarkerRadius)} ${number(entity.position.y)}h${number(pointMarkerRadius * 2)}M${number(entity.position.x)} ${number(entity.position.y - pointMarkerRadius)}v${number(pointMarkerRadius * 2)}"/>`);
      } else if (entity.type === "text" || entity.type === "mtext") {
        const text = xml(entity.text);
        await write(`<text x="0" y="0" font-size="${number(entity.height)}" font-family="Arial, Noto Sans KR, sans-serif" fill="#111827" stroke="none" transform="translate(${number(entity.position.x)} ${number(entity.position.y)}) rotate(${number(entity.rotation)}) scale(1 -1)">${text}</text>`);
      } else {
        throw new Error(`Unsupported normalized CAD SVG entity: ${entity.type}`);
      }
    }
  };

  try {
    await write(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="CAD floor plan"><rect width="100%" height="100%" fill="#fff"/><defs>`);
    for (const [name, { block, id }] of blockByName) {
      if (!reachableBlocks.has(name)) continue;
      await write(`<symbol id="${id}" overflow="visible"><g fill="none" stroke="#1f2937" stroke-width="0.2" vector-effect="non-scaling-stroke">`);
      await renderEntities(block.entities);
      await write("</g></symbol>");
    }
    await write(`</defs><g fill="none" stroke="#1f2937" stroke-width="0.2" vector-effect="non-scaling-stroke" transform="${cadViewportSvgTransform(primarySelection.bounds)}">`);
    await renderEntities(document.entities);
    await write("</g></svg>");
    await file.sync();
    await file.close();
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length;
      if (sizeBytes > limits.maxOutputBytes) return callback(new Error("CAD SVG compressed output limit exceeded"));
      hash.update(chunk);
      callback(null, chunk);
    } });
    await pipeline(createReadStream(rawPath), createGzip({ level: 9 }), meter, createWriteStream(outputPath, { flags: "wx", mode: 0o600 }));
    await unlink(rawPath);
    return {
      sizeBytes, rawSizeBytes, sha256: hash.digest("hex"), viewport: { width, height }, renderedOccurrences,
      unsupportedEntityCounts: Object.fromEntries(Object.entries(document.unsupportedEntityCounts ?? {}).sort(([left], [right]) => left.localeCompare(right))),
      excludedEntityCount: primarySelection.excludedEntityCount,
      contentEncoding: "gzip"
    };
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(rawPath).catch(() => undefined);
    await unlink(outputPath).catch(() => undefined);
    throw error;
  }
}
