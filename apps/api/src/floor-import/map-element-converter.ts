import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  mapElementSchema, mapGroupSchema, mapLayerSchema, normalizeCadMapSize, getMapPolygonValidationError,
  type MapElement, type MapGroup, type MapLayer, type CadScenePrimitive
} from "@led-control/shared";
import { cadEllipseAngles, cadEllipseMatrix, multiplyCadMatrices, transformPoint, type CadMatrix } from "./cad-geometry";
import { iterateCadSemanticEntities, type BuildCadSceneOptions, type CadSemanticEntity } from "./cad-scene-builder";
import type { CadBounds, NormalizedCadDocument } from "./cad-types";
import { cadHatchRingKey, resolveCadHatchRegions } from "./cad-hatch-geometry";

export interface CadMapConversionMetadata {
  width: number;
  height: number;
  gridSize: number;
  groups: MapGroup[];
  layers: MapLayer[];
  /** Compact tiles retain CAD layerName strings; canonical storage uses IDs. */
  displayLayerBindings: Array<{ layerName: string; layerId: string }>;
  elementCount: number;
  unsupportedEntityCounts: Readonly<Record<string, number>>;
  unconvertedEntityCounts: Readonly<Record<string, number>>;
}

export const CAD_MAP_MAX_METADATA_BYTES = 8 * 1024 * 1024;

export type ConvertCadMapElementsOptions = Omit<BuildCadSceneOptions, "onSemanticEntity"> & {
  importJobId: string;
  regionBounds: CadBounds;
  maxMetadataBytes?: number;
  /** Only called on successful exhaustion, never after cancellation or failure. */
  onMetadata?: (metadata: CadMapConversionMetadata) => void | Promise<void>;
};

const identity = () => ({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 });
const id = (kind: string, value: unknown) => `map-${kind}-${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32)}`;
const displayName = (value: string) => Array.from(value).slice(0, 200).join("").trim() || "0";
const angle = (value: number) => ((value + 180) % 360 + 360) % 360 - 180;

function primitiveShape(primitive: CadScenePrimitive): Pick<MapElement, "type" | "geometry" | "transform"> {
  const transform = identity();
  switch (primitive.type) {
    case "ellipse": {
      const { center, radiusX, radiusY, rotation } = primitive.geometry;
      return { type: "ellipse", geometry: { center: { x: 0, y: 0 }, radiusX, radiusY },
        transform: { ...transform, x: center.x, y: center.y, rotation: angle(rotation) } };
    }
    case "rectangle": {
      const { origin, width, height, rotation } = primitive.geometry;
      return { type: "rectangle", geometry: { origin: { x: 0, y: 0 }, width, height },
        transform: { ...transform, x: origin.x, y: origin.y, rotation: angle(rotation) } };
    }
    case "text": {
      const { position, width, height, fontSize, text, rotation } = primitive.geometry;
      // Compact text is baseline-anchored; offset its common top-left locally so rotation applies once.
      return { type: "text", geometry: { position: { x: 0, y: -height }, width, height, fontSize, text },
        transform: { ...transform, x: position.x, y: position.y, rotation: angle(rotation) } };
    }
    case "polyline": {
      const { points, closed } = primitive.geometry;
      // A closed CAD stroke can revisit/cross vertices without defining a valid filled polygon.
      // Preserve every segment and its closing edge as a common path, not a repaired/filled area.
      // WIPEOUT receives its fill later, so it must still validate as a filled shape.
      if (closed && primitive.sourceType !== "WIPEOUT" && primitive.style.fillColor === null && getMapPolygonValidationError(points, [])) {
        return { type: "polyline", geometry: { points: [...points, points[0]] }, transform };
      }
      return closed ? { type: "polygon", geometry: { outer: points, holes: [] }, transform }
        : { type: "polyline", geometry: { points }, transform };
    }
    default: return { type: primitive.type, geometry: primitive.geometry, transform };
  }
}

/** A transformed circular/elliptical arc is still an ordinary arc with a
 * positive nonuniform scale. SVD removes shear/reflection from its transform;
 * the inverse principal-axis basis carries those effects into its parameters. */
function semanticArc(semantic: CadSemanticEntity): Pick<MapElement, "type" | "geometry" | "transform"> | null {
  const entity = semantic.source.entity;
  if (entity.type !== "arc" && entity.type !== "ellipse") return null;
  if (entity.type === "ellipse" && cadEllipseAngles(entity).sweepAngle === 360) return null;
  const projection = semantic.transform;
  const projected: CadMatrix = { a: projection.scaleX, b: 0, c: 0, d: projection.scaleY, e: projection.translateX, f: projection.translateY };
  const basis = entity.type === "ellipse" ? cadEllipseMatrix(entity)
    : { a: entity.radius, b: 0, c: 0, d: entity.radius, e: entity.center.x, f: entity.center.y };
  const matrix = multiplyCadMatrices(multiplyCadMatrices(projected, semantic.source.matrix), basis);
  const xx = matrix.a ** 2 + matrix.c ** 2, xy = matrix.a * matrix.b + matrix.c * matrix.d, yy = matrix.b ** 2 + matrix.d ** 2;
  const discriminant = Math.hypot(xx - yy, 2 * xy);
  const rx = Math.sqrt((xx + yy + discriminant) / 2);
  // det/rx avoids catastrophic cancellation for very thin, valid ellipses.
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  const ry = Math.abs(determinant) / rx;
  if (!(rx > 0 && ry > 0)) return null;
  const rotation = discriminant <= 1e-12 ? 0 : Math.atan2(2 * xy, xx - yy) / 2;
  const parameters = entity.type === "ellipse" ? cadEllipseAngles(entity)
    : { startAngle: entity.startAngle, sweepAngle: ((entity.endAngle - entity.startAngle) % 360 + 360) % 360 || 360 };
  const parameter = (degrees: number) => {
    const t = degrees * Math.PI / 180;
    const x = matrix.a * Math.cos(t) + matrix.c * Math.sin(t);
    const y = matrix.b * Math.cos(t) + matrix.d * Math.sin(t);
    return (Math.atan2((-Math.sin(rotation) * x + Math.cos(rotation) * y) / ry,
      (Math.cos(rotation) * x + Math.sin(rotation) * y) / rx) * 180 / Math.PI + 360) % 360;
  };
  const startAngle = parameter(parameters.startAngle);
  const center = transformPoint(matrix, { x: 0, y: 0, z: 0 });
  return {
    type: "arc", geometry: { center: { x: 0, y: 0 }, radius: rx, startAngle,
      endAngle: parameters.sweepAngle === 360 ? startAngle : parameter(parameters.startAngle + parameters.sweepAngle),
      counterClockwise: determinant > 0 },
    transform: { x: center.x, y: center.y, scaleX: 1, scaleY: ry / rx, rotation: angle(rotation * 180 / Math.PI) }
  };
}

function hatchEntries(primitives: readonly CadScenePrimitive[]) {
  const originals = new Map(primitives.map(primitive => {
    if (primitive.type !== "polyline" || !primitive.geometry.closed) throw new Error("Invalid semantic HATCH ring");
    return [cadHatchRingKey(primitive.geometry.points), primitive] as const;
  }));
  const regions = resolveCadHatchRegions([...primitives].map(primitive => {
    if (primitive.type !== "polyline") throw new Error("Invalid semantic HATCH ring");
    return primitive.geometry.points;
  }));
  const usedIds = new Set<string>();
  const entries: Array<{ primitive: CadScenePrimitive; shape: Pick<MapElement, "type" | "geometry" | "transform"> }> = [];
  for (const { boundary, parts } of regions) {
    const original = originals.get(cadHatchRingKey(boundary.outer));
    const base = original ?? primitives[0];
    for (const [index, geometry] of parts.entries()) {
      const elementId = index === 0 && !usedIds.has(base.elementId) ? base.elementId
        : id("hatch-part", [base.elementId, cadHatchRingKey(geometry.outer), geometry.holes.map(cadHatchRingKey).sort()]);
      usedIds.add(elementId);
      entries.push({ primitive: { ...base, elementId, style: { ...base.style, fillColor: "#e5e7eb",
        ...(parts.length > 1 ? { strokeColor: null } : {}) } },
        shape: { type: "polygon", geometry, transform: identity() } });
    }
    if (parts.length > 1) for (const ring of [boundary.outer, ...boundary.holes]) {
      // General polylines preserve real boundary strokes; partition diagonals have no stroke.
      entries.push({ primitive: { ...base, elementId: id("hatch-boundary", [base.elementId, cadHatchRingKey(ring)]),
        style: { ...base.style, fillColor: null } },
        shape: { type: "polyline", geometry: { points: [...ring, ring[0]] }, transform: identity() } });
    }
  }
  return entries;
}

/** Adapter for buildCadScene.onSemanticEntity. It retains only bounded
 * group/layer metadata, not the canonical elements or tile payloads. */
export function createCadMapElementConverter(options: {
  importJobId: string;
  regionBounds: CadBounds;
  unsupportedEntityCounts?: Readonly<Record<string, number>>;
  maxMetadataBytes?: number;
}) {
  const { width, height, gridSize } = normalizeCadMapSize(options.regionBounds);
  const maximumMetadataBytes = options.maxMetadataBytes ?? CAD_MAP_MAX_METADATA_BYTES;
  if (!Number.isSafeInteger(maximumMetadataBytes) || maximumMetadataBytes < 1 || maximumMetadataBytes > CAD_MAP_MAX_METADATA_BYTES) {
    throw new Error("Invalid CAD map metadata byte limit");
  }
  let metadataBytes = Buffer.byteLength(JSON.stringify(options.unsupportedEntityCounts ?? {}), "utf8");
  const chargeMetadata = (value: unknown) => {
    metadataBytes += Buffer.byteLength(JSON.stringify(value), "utf8") + 1;
    if (metadataBytes > maximumMetadataBytes) throw new Error("CAD map metadata byte limit exceeded");
  };
  const groups = new Map<string, MapGroup>();
  const layers = new Map<string, MapLayer>();
  const displayLayerBindings = new Map<string, { layerName: string; layerId: string }>();
  const unconverted = new Map<string, number>();
  let elementCount = 0;
  const convertSemanticEntity = (semantic: CadSemanticEntity): MapElement[] => {
    const { source, primitives } = semantic;
    // A missing inner boundary changes the filled area, so a partial HATCH is
    // not a successful conversion even if its outer ring remains drawable.
    if (source.entity.type === "hatch" && primitives.length !== source.entity.loops.length) {
      throw new Error("CAD HATCH ring collapsed during projection");
    }
    if (!primitives.length) {
      const type = source.entity.type.toUpperCase();
      unconverted.set(type, (unconverted.get(type) ?? 0) + 1);
      return [];
    }
    const putGroup = (groupId: string, parentId: string | null, name: string) => {
      if (groups.has(groupId)) return;
      const group = mapGroupSchema.parse({ id: groupId, parentId, name: displayName(name), visible: true, locked: false });
      chargeMetadata(group);
      groups.set(groupId, group);
    };
    let groupId: string | null = null;
    const path = source.occurrencePath ?? [];
    path.forEach((segment, index) => {
      const current = id("group", path.slice(0, index + 1));
      putGroup(current, groupId, segment);
      groupId = current;
    });
    if ((!path.length || source.entity.type === "dimension" || source.entity.type === "hatch") && primitives[0].groupId) {
      const current = id("group", [...path, source.entity.sourceEntityId]);
      putGroup(current, groupId, source.entity.sourceEntityId);
      groupId = current;
    }
    const entries = source.entity.type === "hatch"
      ? hatchEntries(primitives)
      : primitives.map(primitive => ({ primitive, shape: semanticArc(semantic) ?? primitiveShape(primitive) }));
    return entries.map(({ primitive, shape }) => {
      const layerId = id("layer", primitive.layerName);
      if (!layers.has(layerId)) {
        const layer = mapLayerSchema.parse({ id: layerId, name: displayName(primitive.layerName), order: layers.size, visible: true, locked: false });
        chargeMetadata(layer);
        layers.set(layerId, layer);
        const binding = { layerName: primitive.layerName, layerId };
        chargeMetadata(binding);
        displayLayerBindings.set(primitive.layerName, binding);
      }
      const element = mapElementSchema.parse({
        id: primitive.elementId, groupId, layerId, zIndex: elementCount,
        visible: true, locked: false, ...shape,
        style: { ...primitive.style,
          ...(source.entity.type === "wipeout" ? { fillColor: "#ffffff", strokeColor: null } : {}) },
        provenance: { importJobId: options.importJobId, sourceId: source.sourceEntityId }
      });
      elementCount++;
      return element;
    });
  };
  const getMetadata = (): CadMapConversionMetadata => {
    const metadata = { width, height, gridSize, groups: [...groups.values()], layers: [...layers.values()], elementCount,
      displayLayerBindings: [...displayLayerBindings.values()],
      unsupportedEntityCounts: { ...options.unsupportedEntityCounts }, unconvertedEntityCounts: Object.fromEntries(unconverted) };
    if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > maximumMetadataBytes) throw new Error("CAD map metadata byte limit exceeded");
    return metadata;
  };
  return { convertSemanticEntity, getMetadata };
}

export async function* convertCadMapElements(document: NormalizedCadDocument, options: ConvertCadMapElementsOptions): AsyncGenerator<MapElement> {
  const converter = createCadMapElementConverter({ ...options, unsupportedEntityCounts: document.unsupportedEntityCounts });
  for (const semantic of iterateCadSemanticEntities(document, options.regionBounds, options)) {
    for (const element of converter.convertSemanticEntity(semantic)) yield element;
  }
  const metadata = converter.getMetadata();
  await options.onMetadata?.(metadata);
}
