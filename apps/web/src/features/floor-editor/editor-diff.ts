import type { SaveEditorStateInput } from "@led-control/shared";
import type { EditorFixture, FloorEditorState, FloorMapObject } from "./editor-types";

const fixtureFields = ["name", "ratedWatt", "x", "y", "size"] as const;
const objectFields = [
  "type", "x", "y", "width", "height", "points", "rotation", "strokeColor",
  "fillColor", "strokeWidth", "text", "fontSize", "zIndex", "locked", "visible"
] as const;

export function buildEditorChanges(initial: FloorEditorState, current: FloorEditorState): SaveEditorStateInput {
  const initialFixtures = new Map(initial.fixtures.map((fixture) => [fixture.id, fixture]));
  const initialObjects = new Map(initial.objects.map((object) => [object.id, object]));
  const currentObjectIds = new Set(current.objects.map((object) => object.id));
  const fixtureUpdates: SaveEditorStateInput["fixtureUpdates"] = [];
  const objectCreates: SaveEditorStateInput["objectCreates"] = [];
  const objectUpdates: SaveEditorStateInput["objectUpdates"] = [];

  for (const fixture of current.fixtures) {
    const baseline = initialFixtures.get(fixture.id);
    if (!baseline) continue;
    const patch = changedFields(baseline, fixture, fixtureFields);
    if (Object.keys(patch).length > 0) fixtureUpdates.push({ id: fixture.id, ...patch });
  }

  for (const object of current.objects) {
    const baseline = initialObjects.get(object.id);
    if (!baseline) {
      objectCreates.push(toObjectCreate(object));
      continue;
    }
    const patch = changedFields(baseline, object, objectFields);
    if (Object.keys(patch).length > 0) {
      objectUpdates.push({ id: object.id, patch: patch as SaveEditorStateInput["objectUpdates"][number]["patch"] });
    }
  }

  const changes: SaveEditorStateInput = {
    expectedRevision: initial.floor.mapRevision,
    fixtureUpdates,
    objectCreates,
    objectUpdates,
    objectDeletes: initial.objects.filter((object) => !currentObjectIds.has(object.id)).map((object) => object.id)
  };
  if (!sameFloorPlan(initial.floor.floorPlan, current.floor.floorPlan)) {
    changes.floorPlan = toFloorPlanUpdate(current.floor.floorPlan);
  }
  return changes;
}

export function hasEditorChanges(changes: SaveEditorStateInput) {
  return changes.floorPlan !== undefined
    || changes.fixtureUpdates.length > 0
    || changes.objectCreates.length > 0
    || changes.objectUpdates.length > 0
    || changes.objectDeletes.length > 0;
}

function changedFields<T extends object, K extends keyof T>(baseline: T, current: T, fields: readonly K[]) {
  const patch: Partial<Pick<T, K>> = {};
  for (const field of fields) {
    if (!equalValue(baseline[field], current[field])) patch[field] = current[field];
  }
  return patch;
}

function equalValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((value, index) => {
    const candidate = right[index];
    return typeof value === "object" && value !== null && typeof candidate === "object" && candidate !== null
      ? value.x === candidate.x && value.y === candidate.y
      : Object.is(value, candidate);
  });
}

function toObjectCreate(object: FloorMapObject): SaveEditorStateInput["objectCreates"][number] {
  const base = {
    x: object.x,
    y: object.y,
    rotation: object.rotation,
    strokeColor: object.strokeColor,
    strokeWidth: object.strokeWidth,
    zIndex: object.zIndex,
    locked: object.locked,
    visible: object.visible,
    ...(object.text === undefined ? {} : { text: object.text }),
    ...(object.fillColor === undefined ? {} : { fillColor: object.fillColor }),
    ...(object.fontSize === undefined ? {} : { fontSize: object.fontSize })
  };
  if (object.type === "triangle") {
    return { ...base, type: "triangle", width: object.width, height: object.height, points: object.points ?? [] };
  }
  if (object.type === "line") {
    return { ...base, type: "line", width: object.width, height: 0, points: null };
  }
  if (object.type === "text") {
    return { ...base, type: "text", width: object.width, height: object.height, points: null };
  }
  return { ...base, type: "rectangle", width: object.width, height: object.height, points: null };
}

function sameFloorPlan(left: FloorEditorState["floor"]["floorPlan"], right: FloorEditorState["floor"]["floorPlan"]) {
  if (left === right) return true;
  if (!left || !right) return left === right;
  return left.imageUrl === right.imageUrl
    && left.sourceType === right.sourceType
    && left.originalFileUrl === right.originalFileUrl
    && left.renderedImageUrl === right.renderedImageUrl
    && left.width === right.width
    && left.height === right.height;
}

function toFloorPlanUpdate(floorPlan: FloorEditorState["floor"]["floorPlan"]): SaveEditorStateInput["floorPlan"] {
  if (!floorPlan || floorPlan.sourceType === "none") return null;
  const sourceType = floorPlan.sourceType ?? "image";
  return {
    sourceType,
    imageUrl: floorPlan.imageUrl,
    originalFileUrl: floorPlan.originalFileUrl ?? floorPlan.imageUrl,
    renderedImageUrl: floorPlan.renderedImageUrl ?? floorPlan.imageUrl,
    width: floorPlan.width,
    height: floorPlan.height
  };
}
