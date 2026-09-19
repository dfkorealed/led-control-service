import { buildEditorChanges, type EditorChangeSet } from "./editor-diff";
import type { FloorEditorState, FloorMapObject } from "./editor-types";
import { parseCommonMapDraft, type CommonMapDraft } from "./common-map-store";

const prefix = "led-floor-draft:v1:";
let generation = 0;
export const editorDraftGeneration = () => generation;
export function editorDraftKey(userId: string, state: FloorEditorState) {
  return prefix + [userId, state.floor.siteId, state.floor.id, state.floor.mapRevision,
    ...(state.floor.mapDocument ? [state.floor.mapDocument.generationId] : [])].map(encodeURIComponent).join(":");
}
export function clearEditorDrafts() {
  generation++;
  try { Object.keys(localStorage).filter((key) => key.startsWith(prefix)).forEach((key) => localStorage.removeItem(key)); } catch { /* Storage is optional in restricted browser contexts. */ }
}
export function removeEditorDraft(userId: string, baseline: FloorEditorState) {
  try { localStorage.removeItem(editorDraftKey(userId, baseline)); } catch { /* A storage failure must not prevent saving to the server. */ }
}
export function saveEditorDraft(userId: string, baseline: FloorEditorState, state: FloorEditorState,
  commonMapDraft?: CommonMapDraft | null, expectedGeneration = generation): boolean {
  if (expectedGeneration !== generation || baseline.floor.id !== state.floor.id || baseline.floor.siteId !== state.floor.siteId
    || baseline.floor.mapRevision !== state.floor.mapRevision || baseline.floor.mapDocument?.generationId !== state.floor.mapDocument?.generationId) return false;
  try {
    const common = commonMapDraft ? parseCommonMapDraft(commonMapDraft) : undefined;
    if (baseline.floor.mapDocument && (!common || !matchesCommonScope(common, userId, baseline))) return false;
    const changes = buildEditorChanges(baseline, state);
    if (!validChanges(changes, baseline)) return false;
    localStorage.setItem(editorDraftKey(userId, baseline), JSON.stringify({ version: 1, savedAt: Date.now(),
      changes, ...(common ? { commonMapDraft: common } : {}) }));
    return true;
  } catch { return false; }
}
export function loadEditorDraft(userId: string, baseline: FloorEditorState): (FloorEditorState & { commonMapDraft?: CommonMapDraft }) | null {
  try {
    const raw = localStorage.getItem(editorDraftKey(userId, baseline));
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (saved.version !== 1 || !Number.isFinite(saved.savedAt) || Date.now() - saved.savedAt > 7 * 86400_000) return null;
    const commonMapDraft = saved.commonMapDraft === undefined ? undefined : parseCommonMapDraft(saved.commonMapDraft);
    if (baseline.floor.mapDocument ? !commonMapDraft || !matchesCommonScope(commonMapDraft, userId, baseline) : commonMapDraft !== undefined) return null;
    // Never restore credentials, telemetry or an arbitrary object graph from browser storage.
    // Validate the same narrow mutation DTO the server accepts against the freshly authorized baseline.
    if (!validChanges(saved.changes, baseline)) return null;
    const changes: EditorChangeSet = { ...saved.changes, slotAssignments: saved.changes.slotAssignments ?? [] };
    const fixtureIds = new Set(baseline.fixtures.map((f) => f.id));
    const objectIds = new Set(baseline.objects.map((o) => o.id));
    const slotIds = new Set(baseline.lightSlots.map((slot) => slot.id));
    if (changes.fixtureUpdates.some((f) => !fixtureIds.has(f.id))
      || changes.slotAssignments.some((assignment) => !slotIds.has(assignment.slotId)
        || assignment.assignedFixtureId !== null && !fixtureIds.has(assignment.assignedFixtureId))
      || changes.objectUpdates.some((o) => !objectIds.has(o.id))
      || changes.objectDeletes.some((id) => !objectIds.has(id))) return null;
    const patches = new Map(changes.fixtureUpdates.map((f) => [f.id, f]));
    const slotAssignments = new Map(changes.slotAssignments.map((assignment) => [assignment.slotId, assignment.assignedFixtureId]));
    const objects = new Map(changes.objectUpdates.map((o) => [o.id, o.patch]));
    return {
      ...baseline,
      ...(commonMapDraft ? { commonMapDraft } : {}),
      floor: changes.floorPlan === undefined ? baseline.floor : { ...baseline.floor,
        floorPlan: changes.floorPlan ? { ...changes.floorPlan, version: baseline.floor.floorPlan?.version ?? 1 } : null },
      fixtures: baseline.fixtures.map((fixture) => {
        const patch = patches.get(fixture.id); if (!patch) return fixture;
        const next = { ...fixture, ...patch };
        if (next.placementStatus === "unplaced" || next.x !== fixture.x || next.y !== fixture.y || patch.positionVerified === false) next.positionVerifiedAt = null;
        return next;
      }),
      lightSlots: baseline.lightSlots.map((slot) => slotAssignments.has(slot.id)
        ? { ...slot, assignedFixtureId: slotAssignments.get(slot.id) ?? null }
        : slot),
      objects: [
        ...baseline.objects.filter((o) => !changes.objectDeletes.includes(o.id)).map((o) => ({ ...o, ...objects.get(o.id) } as FloorMapObject)),
        ...changes.objectCreates.map((o) => ({ ...o, id: `draft-${crypto.randomUUID()}`, floorId: baseline.floor.id } as FloorMapObject))
      ]
    };
  } catch { return null; }
}

function matchesCommonScope(draft: CommonMapDraft, userId: string, baseline: FloorEditorState) {
  return draft.scope.authScope === userId && draft.scope.siteId === baseline.floor.siteId
    && draft.scope.floorId === baseline.floor.id && draft.scope.generationId === baseline.floor.mapDocument?.generationId
    && draft.scope.baseRevision === baseline.floor.mapRevision;
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function validFloorPlan(value: unknown, baseline: FloorEditorState): boolean {
  if (value === undefined) return true;
  if (value === null) return !baseline.floor.mapDocument;
  if (!record(value) || Object.keys(value).some((key) => !["sourceType", "imageUrl", "originalFileUrl", "renderedImageUrl", "width", "height", "gridSize"].includes(key))) return false;
  const plan = baseline.floor.floorPlan, document = baseline.floor.mapDocument;
  // Drafts may change settings but cannot smuggle a different uploaded asset or
  // switch a converted document back to a legacy background.
  const sourceType = plan?.sourceType ?? (plan ? "image" : "none");
  if (value.sourceType !== sourceType || value.imageUrl !== (plan?.imageUrl ?? "")
    || value.originalFileUrl !== (sourceType === "none" ? null : plan?.originalFileUrl ?? plan?.imageUrl ?? null)
    || value.renderedImageUrl !== (sourceType === "none" || sourceType === "pdf" ? plan?.renderedImageUrl ?? null : plan?.renderedImageUrl ?? plan?.imageUrl ?? null)) return false;
  return [value.width, value.height].every((n) => Number.isInteger(n) && Number(n) >= 1 && Number(n) <= 32768)
    && Number.isInteger(value.gridSize) && Number(value.gridSize) >= 5 && Number(value.gridSize) <= 200
    && (!document || value.width === document.width && value.height === document.height);
}
function validChanges(value: unknown, baseline: FloorEditorState): value is EditorChangeSet {
  if (!record(value) || value.expectedRevision !== baseline.floor.mapRevision || !validFloorPlan(value.floorPlan, baseline)
    || Object.keys(value).some((key) => !["expectedRevision", "fixtureUpdates", "slotAssignments", "objectCreates", "objectUpdates", "objectDeletes", "floorPlan"].includes(key))) return false;
  const { fixtureUpdates, objectCreates, objectUpdates, objectDeletes } = value;
  const slotAssignments = value.slotAssignments ?? [];
  if (!Array.isArray(fixtureUpdates) || fixtureUpdates.length > 1000 || !Array.isArray(objectCreates) || !Array.isArray(objectUpdates) || !Array.isArray(objectDeletes)
    || !Array.isArray(slotAssignments) || slotAssignments.length > 2000
    || objectCreates.length + objectUpdates.length + objectDeletes.length > 2000) return false;
  const width = baseline.floor.mapDocument?.width ?? baseline.floor.floorPlan?.width ?? 1200;
  const height = baseline.floor.mapDocument?.height ?? baseline.floor.floorPlan?.height ?? 800;
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const coordinate = (key: string, v: unknown) => finite(v) && Number(v) >= 0 && Number(v) <= (key === "x" ? width : height);
  const fixtureValid = (f: unknown) => record(f) && typeof f.id === "string" && Object.entries(f).every(([key, v]) => {
    if (key === "id") return typeof v === "string";
    if (key === "name") return typeof v === "string" && v.trim().length > 0 && v.length <= 200;
    if (key === "x" || key === "y") return coordinate(key, v);
    if (key === "ratedWatt" || key === "size") return finite(v) && Number(v) >= (key === "size" ? 1 : 0) && Number(v) <= 10000;
    if (key === "positionVerified") return typeof v === "boolean" && !(v && f.placementStatus === "unplaced");
    if (key === "placementStatus") return v === "placed" || v === "unplaced";
    return false;
  });
  const objectValid = (o: unknown): boolean => record(o) && Object.entries(o).every(([key, v]) => {
    if (key === "type") return ["rectangle", "triangle", "line", "text"].includes(String(v));
    if (key === "x" || key === "y") return coordinate(key, v);
    if (["width", "height", "rotation", "strokeWidth", "fontSize", "zIndex"].includes(key)) return v === null && key === "fontSize" || finite(v) && Math.abs(Number(v)) <= 1_000_000;
    if (["text", "strokeColor", "fillColor"].includes(key)) return v === null || typeof v === "string" && v.length <= 10000;
    if (key === "visible" || key === "locked") return typeof v === "boolean";
    if (key === "points") return v === null || Array.isArray(v) && v.length === 3 && v.every((p) => record(p) && finite(p.x) && finite(p.y));
    return false;
  });
  const slotIds = new Set<string>();
  const assignedFixtureIds = new Set<string>();
  const slotAssignmentsValid = slotAssignments.every((assignment) => {
    if (!record(assignment) || Object.keys(assignment).some((key) => !["slotId", "assignedFixtureId"].includes(key))
      || typeof assignment.slotId !== "string" || slotIds.has(assignment.slotId)
      || assignment.assignedFixtureId !== null && typeof assignment.assignedFixtureId !== "string"
      || typeof assignment.assignedFixtureId === "string" && assignedFixtureIds.has(assignment.assignedFixtureId)) return false;
    slotIds.add(assignment.slotId);
    if (typeof assignment.assignedFixtureId === "string") assignedFixtureIds.add(assignment.assignedFixtureId);
    return true;
  });
  return fixtureUpdates.every(fixtureValid) && objectDeletes.every((id) => typeof id === "string")
    && slotAssignmentsValid
    && objectUpdates.every((o) => record(o) && typeof o.id === "string" && objectValid(o.patch))
    && objectCreates.every((o) => objectValid(o) && ["type", "x", "y", "width", "height", "rotation", "strokeColor", "strokeWidth", "zIndex", "locked", "visible"].every((key) => key in o));
}
