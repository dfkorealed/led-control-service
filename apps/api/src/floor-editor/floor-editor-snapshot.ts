import { createHash } from "node:crypto";
import { FloorEditorSnapshot, floorEditorSnapshotV2Schema, mapDocumentRefSchema, parseFloorEditorSnapshot } from "@led-control/shared";
import { z } from "zod";

const legacySnapshotFields = floorEditorSnapshotV2Schema.innerType().shape;
const mapDocumentSnapshotSchema = z.object({
  version: z.literal(3),
  document: mapDocumentRefSchema,
  fixtures: legacySnapshotFields.fixtures,
  lightSlots: legacySnapshotFields.lightSlots.default([])
}).strict();
export type MapDocumentSnapshot = z.infer<typeof mapDocumentSnapshotSchema>;

export function buildMapDocumentSnapshot(input: Omit<MapDocumentSnapshot, "version">): MapDocumentSnapshot {
  return mapDocumentSnapshotSchema.parse({ ...input, version: 3 });
}
export function parseMapDocumentSnapshot(input: unknown): MapDocumentSnapshot {
  return mapDocumentSnapshotSchema.parse(input);
}
export function parseStoredFloorEditorSnapshot(input: unknown): FloorEditorSnapshot | MapDocumentSnapshot {
  return input && typeof input === "object" && "version" in input && input.version === 3
    ? parseMapDocumentSnapshot(input) : parseFloorEditorSnapshot(input);
}

interface SnapshotFloor {
  floorPlan: null | {
    imageUrl: string;
    sourceType: "none" | "image" | "pdf" | "cad";
    originalFileUrl: string | null;
    renderedImageUrl: string | null;
    width: number;
    height: number;
    gridSize?: number;
  };
  fixtures: Array<{
    id: string;
    name: string;
    ratedWatt: { toString(): string } | string | number;
    x: number;
    y: number;
    size: number;
    placementStatus?: "unplaced" | "placed";
    positionVerifiedAt?: Date | string | null;
  }>;
  mapObjects: Array<{
    id: string;
    type: string;
    x: number;
    y: number;
    width: number | null;
    height: number | null;
    rotation: number;
    points: unknown;
    text: string | null;
    strokeColor: string;
    fillColor: string | null;
    strokeWidth: number;
    fontSize: number | null;
    zIndex: number;
    locked: boolean;
    visible: boolean;
  }>;
  cadScene?: {
    id: string;
    width: number;
    height: number;
  } | null;
  lightSlots?: Array<{
    id: string;
    sourceImportJobId: string;
    sourceCandidateId: string;
    x: number;
    y: number;
    rotation: number;
    assignedFixtureId: string | null;
  }>;
}

export function buildFloorEditorSnapshot(floor: SnapshotFloor): FloorEditorSnapshot {
  return parseFloorEditorSnapshot({
    version: 2,
    floorPlan: floor.floorPlan
      ? {
          imageUrl: floor.floorPlan.imageUrl,
          sourceType: floor.floorPlan.sourceType,
          originalFileUrl: floor.floorPlan.originalFileUrl,
          renderedImageUrl: floor.floorPlan.renderedImageUrl,
          width: floor.floorPlan.width,
          height: floor.floorPlan.height,
          gridSize: floor.floorPlan.gridSize ?? 10
        }
      : null,
    fixtures: [...floor.fixtures]
      .sort((left, right) => compareIds(left.id, right.id))
      .map((fixture) => ({
        id: fixture.id,
        name: fixture.name,
        ratedWatt: String(fixture.ratedWatt),
        x: fixture.x,
        y: fixture.y,
        size: fixture.size,
        placementStatus: fixture.placementStatus ?? "placed",
        positionVerifiedAt: fixture.positionVerifiedAt instanceof Date
          ? fixture.positionVerifiedAt.toISOString() : fixture.positionVerifiedAt ?? null
      })),
    objects: [...floor.mapObjects]
      .sort((left, right) => compareIds(left.id, right.id))
      .map((object) => ({
        id: object.id,
        type: object.type,
        x: object.x,
        y: object.y,
        width: object.width,
        height: object.height,
        rotation: object.rotation,
        points: object.points,
        text: object.text,
        strokeColor: object.strokeColor,
        fillColor: object.fillColor,
        strokeWidth: object.strokeWidth,
        fontSize: object.fontSize,
        zIndex: object.zIndex,
        locked: object.locked,
        visible: object.visible
      })),
    ...(floor.floorPlan?.sourceType === "cad" && floor.cadScene ? {
      cadScene: {
        id: floor.cadScene.id,
        width: floor.cadScene.width,
        height: floor.cadScene.height
      }
    } : {}),
    lightSlots: [...(floor.lightSlots ?? [])]
      .sort((left, right) => compareIds(left.id, right.id))
      .map((slot) => ({
        id: slot.id,
        sourceImportJobId: slot.sourceImportJobId,
        sourceCandidateId: slot.sourceCandidateId,
        x: slot.x,
        y: slot.y,
        rotation: slot.rotation,
        assignedFixtureId: slot.assignedFixtureId
      }))
  });
}

export function hashFloorEditorSnapshot(snapshot: FloorEditorSnapshot | MapDocumentSnapshot) {
  return createHash("sha256").update(stableJson(snapshot)).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareIds(left, right))
      .map(([key, child]) => [key, sortJson(child)])
  );
}

function compareIds(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
