import { Buffer } from "node:buffer";
import { cadBulgeArc, computeCadBounds, expandCadDocument, multiplyCadMatrices, transformPoint, type CadMatrix, type ExpandedCadEntity } from "./cad-geometry";
import type { CadPoint, NormalizedCadDocument } from "./cad-types";

export interface CadSvgRendererLimits {
  maxRenderedEntities: number;
  maxOutputBytes: number;
  maxBlockDepth: number;
  padding: number;
}

const DEFAULT_LIMITS: CadSvgRendererLimits = {
  maxRenderedEntities: 100_000,
  maxOutputBytes: 8 * 1024 * 1024,
  maxBlockDepth: 16,
  padding: 1
};

function xml(value: string): string {
  const valid = Array.from(value, character => {
    const codePoint = character.codePointAt(0)!;
    return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff)
      ? character
      : "\uFFFD";
  }).join("");
  return valid.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
  })[character]!);
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

export function renderCadDocumentSvg(document: NormalizedCadDocument, options: Partial<CadSvgRendererLimits> = {}): string {
  const limits = { ...DEFAULT_LIMITS, ...options };
  if (!Number.isInteger(limits.maxRenderedEntities) || limits.maxRenderedEntities < 1 ||
      !Number.isInteger(limits.maxOutputBytes) || limits.maxOutputBytes < 1 ||
      !Number.isInteger(limits.maxBlockDepth) || limits.maxBlockDepth < 1 ||
      !Number.isFinite(limits.padding) || limits.padding < 0) throw new Error("Invalid CAD SVG renderer limits");
  const expanded = expandCadDocument(document, limits);
  const bounds = computeCadBounds(expanded);
  const width = Math.max(1, bounds.maxX - bounds.minX + limits.padding * 2);
  const height = Math.max(1, bounds.maxY - bounds.minY + limits.padding * 2);
  const project = (point: CadPoint) => ({
    x: point.x - bounds.minX + limits.padding,
    y: bounds.maxY - point.y + limits.padding,
    z: point.z
  });
  const projection: CadMatrix = { a: 1, b: 0, c: 0, d: -1, e: -bounds.minX + limits.padding, f: bounds.maxY + limits.padding };
  const projectedPoints = (points: readonly CadPoint[]) => points.map(point => {
    const projected = project(point);
    return `${number(projected.x)},${number(projected.y)}`;
  }).join(" ");
  const pieces: string[] = [];
  let outputBytes = 0;
  const append = (piece: string) => {
    outputBytes += Buffer.byteLength(piece, "utf8");
    if (outputBytes > limits.maxOutputBytes) throw new Error("CAD SVG output limit exceeded");
    pieces.push(piece);
  };
  const attributes = (item: ExpandedCadEntity) => {
    const block = item.blockName === null ? "" : ` data-block-name="${xml(item.blockName)}"`;
    const insertLayer = item.insertLayer === null ? "" : ` data-insert-layer="${xml(item.insertLayer)}"`;
    return `data-source-entity-id="${xml(item.sourceEntityId)}" data-layer="${xml(item.entity.layer)}"${insertLayer}${block}`;
  };

  append(`<svg xmlns="http://www.w3.org/2000/svg" width="${number(width)}" height="${number(height)}" viewBox="0 0 ${number(width)} ${number(height)}" role="img" aria-label="CAD floor plan">`);
  append(`<rect x="0" y="0" width="${number(width)}" height="${number(height)}" fill="#ffffff"/>`);
  append('<g fill="none" stroke="#1f2937" stroke-width="0.2" vector-effect="non-scaling-stroke">');
  for (const item of expanded) {
    const entity = item.entity;
    const attrs = attributes(item);
    if (entity.type === "line") {
      const start = project(transformPoint(item.matrix, entity.start));
      const end = project(transformPoint(item.matrix, entity.end));
      append(`<line ${attrs} x1="${number(start.x)}" y1="${number(start.y)}" x2="${number(end.x)}" y2="${number(end.y)}"/>`);
    } else if ("vertices" in entity) {
      const points = pointsForPolyline(entity, item.matrix);
      const tag = entity.closed ? "polygon" : "polyline";
      append(`<${tag} ${attrs} points="${projectedPoints(points)}"/>`);
    } else if (entity.type === "circle") {
      append(`<polygon ${attrs} points="${projectedPoints(pointsForCircle(entity.center, entity.radius, item.matrix))}"/>`);
    } else if (entity.type === "arc") {
      append(`<polyline ${attrs} points="${projectedPoints(pointsForArc(item as ExpandedCadEntity & { entity: Extract<ExpandedCadEntity["entity"], { type: "arc" }> }))}"/>`);
    } else {
      const radians = entity.rotation * Math.PI / 180;
      const textTransform: CadMatrix = {
        a: Math.cos(radians), b: Math.sin(radians), c: Math.sin(radians), d: -Math.cos(radians),
        e: entity.position.x, f: entity.position.y
      };
      const matrix = multiplyCadMatrices(projection, multiplyCadMatrices(item.matrix, textTransform));
      append(`<text ${attrs} x="0" y="0" font-size="${number(entity.height)}" fill="#111827" stroke="none" transform="matrix(${number(matrix.a)} ${number(matrix.b)} ${number(matrix.c)} ${number(matrix.d)} ${number(matrix.e)} ${number(matrix.f)})">${xml(entity.text)}</text>`);
    }
  }
  append("</g></svg>");
  return pieces.join("");
}
