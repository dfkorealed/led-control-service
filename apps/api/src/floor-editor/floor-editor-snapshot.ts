import { createHash } from "node:crypto";
import { FloorEditorSnapshot, parseFloorEditorSnapshot } from "@led-control/shared";

interface SnapshotFloor {
  floorPlan: null | {
    imageUrl: string;
    sourceType: "none" | "image" | "pdf";
    originalFileUrl: string | null;
    renderedImageUrl: string | null;
    width: number;
    height: number;
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
          height: floor.floorPlan.height
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
      }))
  });
}

export function hashFloorEditorSnapshot(snapshot: FloorEditorSnapshot) {
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
