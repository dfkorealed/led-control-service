import type { EditorDocumentChanges, SaveEditorStateInput } from "@led-control/shared";
import type { EditorFixture, FloorEditorState, FloorMapObject } from "./editor-types";

const fixtureFields = ["name", "ratedWatt", "x", "y", "size"] as const;
const objectFields = [
  "type", "x", "y", "width", "height", "points", "rotation", "strokeColor",
  "fillColor", "strokeWidth", "text", "fontSize", "zIndex", "locked", "visible"
] as const;

export type EditorChangeSet = Omit<SaveEditorStateInput, "leaseToken" | "leaseFence" | "fixtureUpdates"> & {
  fixtureUpdates: Array<SaveEditorStateInput["fixtureUpdates"][number] & {
    placementStatus?: "unplaced" | "placed"; positionVerified?: boolean;
  }>;
};

export function buildEditorChanges(initial: FloorEditorState, current: FloorEditorState, documentChanges?: EditorDocumentChanges): EditorChangeSet {
  if (initial.floor.mapDocument && (current.floor.mapDocument?.generationId !== initial.floor.mapDocument.generationId
    || current.floor.siteId !== initial.floor.siteId || current.floor.id !== initial.floor.id)) {
    throw new Error("Map document scope changed");
  }
  const initialFixtures = new Map(initial.fixtures.map((fixture) => [fixture.id, fixture]));
  const initialObjects = new Map(initial.objects.map((object) => [object.id, object]));
  const initialSlots = new Map(initial.lightSlots.map((slot) => [slot.id, slot]));
  const currentObjectIds = new Set(current.objects.map((object) => object.id));
  const fixtureUpdates: EditorChangeSet["fixtureUpdates"] = [];
  const objectCreates: EditorChangeSet["objectCreates"] = [];
  const objectUpdates: EditorChangeSet["objectUpdates"] = [];
  const slotAssignments: EditorChangeSet["slotAssignments"] = [];

  for (const fixture of current.fixtures) {
    const baseline = initialFixtures.get(fixture.id);
    if (!baseline) continue;
    const patch = changedFields(baseline, fixture, fixtureFields);
    const placementPatch: { placementStatus?: "unplaced" | "placed"; positionVerified?: boolean } = {};
    if ((baseline.placementStatus ?? "placed") !== (fixture.placementStatus ?? "placed")) {
      placementPatch.placementStatus = fixture.placementStatus ?? "placed";
    }
    if ((baseline.positionVerifiedAt ?? null) !== (fixture.positionVerifiedAt ?? null)
      || fixture.positionVerified !== undefined && fixture.positionVerified !== baseline.positionVerified) {
      placementPatch.positionVerified = fixture.positionVerified ?? Boolean(fixture.positionVerifiedAt);
    }
    if (Object.keys(patch).length > 0 || Object.keys(placementPatch).length > 0) {
      fixtureUpdates.push({ id: fixture.id, ...patch, ...placementPatch });
    }
  }

  for (const object of current.objects) {
    const baseline = initialObjects.get(object.id);
    if (!baseline) {
      objectCreates.push(toObjectCreate(object));
      continue;
    }
    const patch = changedFields(baseline, object, objectFields);
    if (Object.keys(patch).length > 0) {
      objectUpdates.push({ id: object.id, patch: patch as EditorChangeSet["objectUpdates"][number]["patch"] });
    }
  }

  for (const slot of current.lightSlots) {
    const baseline = initialSlots.get(slot.id);
    if (baseline && baseline.assignedFixtureId !== slot.assignedFixtureId) {
      slotAssignments.push({ slotId: slot.id, assignedFixtureId: slot.assignedFixtureId });
    }
  }

  const changes: EditorChangeSet = {
    expectedRevision: initial.floor.mapRevision,
    fixtureUpdates,
    slotAssignments,
    objectCreates,
    objectUpdates,
    objectDeletes: initial.objects.filter((object) => !currentObjectIds.has(object.id)).map((object) => object.id)
  };
  const initialFloorPlan = toFloorPlanUpdate(editorFloorPlan(initial));
  const currentFloorPlan = toFloorPlanUpdate(editorFloorPlan(current));
  if (!sameFloorPlan(initialFloorPlan, currentFloorPlan)) {
    changes.floorPlan = currentFloorPlan;
  }
  if (documentChanges) {
    if (!initial.floor.mapDocument || documentChanges.generationId !== initial.floor.mapDocument.generationId) throw new Error("Map generation mismatch");
    if (changes.objectCreates.length || changes.objectUpdates.length || changes.objectDeletes.length) throw new Error("Mixed legacy object and document changes are forbidden");
    changes.documentChanges = documentChanges;
  }
  return changes;
}

export function editorFloorPlan(state: FloorEditorState): FloorEditorState["floor"]["floorPlan"] {
  const document = state.floor.mapDocument;
  return state.floor.floorPlan ?? (document ? { imageUrl: "", sourceType: "none", originalFileUrl: null, renderedImageUrl: null,
    width: document.width, height: document.height, gridSize: document.gridSize, version: 1 } : null);
}

export function hasEditorChanges(changes: EditorChangeSet) {
  return changes.floorPlan !== undefined
    || changes.fixtureUpdates.length > 0
    || changes.slotAssignments.length > 0
    || changes.objectCreates.length > 0
    || changes.objectUpdates.length > 0
    || changes.objectDeletes.length > 0
    || (changes.documentChanges?.operations.length ?? 0) > 0;
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

function toObjectCreate(object: FloorMapObject): EditorChangeSet["objectCreates"][number] {
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

function sameFloorPlan(
  left: EditorChangeSet["floorPlan"],
  right: EditorChangeSet["floorPlan"]
) {
  if (left === right) return true;
  if (!left || !right) return left === right;
  return left.imageUrl === right.imageUrl
    && left.sourceType === right.sourceType
    && left.originalFileUrl === right.originalFileUrl
    && left.renderedImageUrl === right.renderedImageUrl
    && left.width === right.width
    && left.height === right.height
    && (left.gridSize ?? 10) === (right.gridSize ?? 10);
}

function toFloorPlanUpdate(floorPlan: FloorEditorState["floor"]["floorPlan"]): EditorChangeSet["floorPlan"] {
  if (!floorPlan) return null;
  const sourceType = floorPlan.sourceType ?? "image";
  if (sourceType === "none") {
    return {
      sourceType,
      imageUrl: "",
      originalFileUrl: null,
      renderedImageUrl: null,
      width: floorPlan.width,
      height: floorPlan.height,
      gridSize: floorPlan.gridSize ?? 10
    };
  }
  if (sourceType === "pdf") {
    return {
      sourceType: "pdf",
      imageUrl: floorPlan.imageUrl,
      originalFileUrl: floorPlan.originalFileUrl ?? floorPlan.imageUrl,
      renderedImageUrl: floorPlan.renderedImageUrl ?? null,
      width: floorPlan.width,
      height: floorPlan.height,
      gridSize: floorPlan.gridSize ?? 10
    };
  }
  return {
    sourceType: "image",
    imageUrl: floorPlan.imageUrl,
    originalFileUrl: floorPlan.originalFileUrl ?? floorPlan.imageUrl,
    renderedImageUrl: floorPlan.renderedImageUrl ?? floorPlan.imageUrl,
    width: floorPlan.width,
    height: floorPlan.height,
    gridSize: floorPlan.gridSize ?? 10
  };
}
