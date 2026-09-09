import { buildEditorChanges, type EditorChangeSet } from "./editor-diff";
import type { FloorEditorState, FloorMapObject } from "./editor-types";

const prefix = "led-floor-draft:v1:";
let generation = 0;
export const editorDraftGeneration = () => generation;
export function editorDraftKey(userId: string, state: FloorEditorState) {
  return prefix + [userId, state.floor.siteId, state.floor.id, state.floor.mapRevision].map(encodeURIComponent).join(":");
}
export function clearEditorDrafts() {
  generation++;
  try { Object.keys(localStorage).filter((key) => key.startsWith(prefix)).forEach((key) => localStorage.removeItem(key)); } catch { /* Storage is optional in restricted browser contexts. */ }
}
export function removeEditorDraft(userId: string, baseline: FloorEditorState) {
  try { localStorage.removeItem(editorDraftKey(userId, baseline)); } catch { /* A storage failure must not prevent saving to the server. */ }
}
export function saveEditorDraft(userId: string, baseline: FloorEditorState, state: FloorEditorState): boolean {
  if (baseline.floor.id !== state.floor.id || baseline.floor.siteId !== state.floor.siteId) return false;
  try {
    localStorage.setItem(editorDraftKey(userId, baseline), JSON.stringify({ version: 1, savedAt: Date.now(), changes: buildEditorChanges(baseline, state) }));
    return true;
  } catch { return false; }
}
export function loadEditorDraft(userId: string, baseline: FloorEditorState): FloorEditorState | null {
  try {
    const raw = localStorage.getItem(editorDraftKey(userId, baseline));
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (saved.version !== 1 || !Number.isFinite(saved.savedAt) || Date.now() - saved.savedAt > 7 * 86400_000) return null;
    // Never restore credentials, telemetry or an arbitrary object graph from browser storage.
    // Validate the same narrow mutation DTO the server accepts against the freshly authorized baseline.
    if (!validChanges(saved.changes, baseline)) return null;
    const changes: EditorChangeSet = saved.changes;
    const fixtureIds = new Set(baseline.fixtures.map((f) => f.id));
    const objectIds = new Set(baseline.objects.map((o) => o.id));
    if (changes.fixtureUpdates.some((f) => !fixtureIds.has(f.id)) || changes.objectUpdates.some((o) => !objectIds.has(o.id)) || changes.objectDeletes.some((id) => !objectIds.has(id))) return null;
    const patches = new Map(changes.fixtureUpdates.map((f) => [f.id, f]));
    const objects = new Map(changes.objectUpdates.map((o) => [o.id, o.patch]));
    return {
      ...baseline,
      fixtures: baseline.fixtures.map((fixture) => {
        const patch = patches.get(fixture.id); if (!patch) return fixture;
        const next = { ...fixture, ...patch };
        if (next.placementStatus === "unplaced" || next.x !== fixture.x || next.y !== fixture.y || patch.positionVerified === false) next.positionVerifiedAt = null;
        return next;
      }),
      objects: [
        ...baseline.objects.filter((o) => !changes.objectDeletes.includes(o.id)).map((o) => ({ ...o, ...objects.get(o.id) } as FloorMapObject)),
        ...changes.objectCreates.map((o) => ({ ...o, id: `draft-${crypto.randomUUID()}`, floorId: baseline.floor.id } as FloorMapObject))
      ]
    };
  } catch { return null; }
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function validChanges(value: unknown, baseline: FloorEditorState): value is EditorChangeSet {
  if (!record(value) || value.expectedRevision !== baseline.floor.mapRevision || value.floorPlan !== undefined
    || Object.keys(value).some((key) => !["expectedRevision", "fixtureUpdates", "objectCreates", "objectUpdates", "objectDeletes"].includes(key))) return false;
  const { fixtureUpdates, objectCreates, objectUpdates, objectDeletes } = value;
  if (!Array.isArray(fixtureUpdates) || fixtureUpdates.length > 1000 || !Array.isArray(objectCreates) || !Array.isArray(objectUpdates) || !Array.isArray(objectDeletes)
    || objectCreates.length + objectUpdates.length + objectDeletes.length > 2000) return false;
  const width = baseline.floor.floorPlan?.width ?? 1200, height = baseline.floor.floorPlan?.height ?? 800;
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
  return fixtureUpdates.every(fixtureValid) && objectDeletes.every((id) => typeof id === "string")
    && objectUpdates.every((o) => record(o) && typeof o.id === "string" && objectValid(o.patch))
    && objectCreates.every((o) => objectValid(o) && ["type", "x", "y", "width", "height", "rotation", "strokeColor", "strokeWidth", "zIndex", "locked", "visible"].every((key) => key in o));
}
