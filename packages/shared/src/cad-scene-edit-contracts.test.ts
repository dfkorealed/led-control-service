import { describe, expect, it } from "vitest";
import {
  CAD_ELEMENT_MAX_ABS_ROTATION,
  CAD_ELEMENT_MAX_SCALE,
  CAD_ELEMENT_MAX_STROKE_WIDTH,
  CAD_ELEMENT_MAX_TRANSLATION,
  CAD_ELEMENT_MIN_SCALE,
  CAD_SCENE_MAX_EVIDENCE_TILES,
  CAD_SCENE_MAX_LAYER_MUTATIONS,
  CAD_SCENE_MAX_OVERRIDE_MUTATIONS,
  cadSceneDescriptorSchema,
  cadSceneEditInputSchema,
  cadSceneStateSchema
} from "./cad-scene-contracts";
import { floorMapSnapshotSchema } from "./schemas";

const tile = (part = 0) => ({ tileX: 0, tileY: 0, lod: 0 as const, part });
const upsert = (elementId: string, part = 0) => ({
  operation: "upsert" as const,
  locator: tile(part),
  value: { elementId, hidden: true }
});

describe("CAD scene edit contracts", () => {
  it("accepts bounded atomic override and layer mutations", () => {
    const parsed = cadSceneEditInputSchema.parse({
      expectedRevision: 7,
      leaseToken: "lease-token",
      leaseFence: 3,
      overrideMutations: [upsert("cad-element-00000000000000000000000000000001")],
      layerMutations: [{
        locator: tile(), layerName: "WALL", visible: false, locked: true
      }]
    });

    expect(parsed.overrideMutations).toHaveLength(1);
    expect(parsed.layerMutations).toHaveLength(1);
  });

  it("rejects empty, duplicate, conflicting, and oversized edit batches", () => {
    const base = { expectedRevision: 7, leaseToken: "lease-token", leaseFence: 3 };
    const elementId = "cad-element-00000000000000000000000000000001";
    const deletion = { operation: "delete" as const, locator: tile(), elementId };

    expect(() => cadSceneEditInputSchema.parse(base)).toThrow();
    expect(() => cadSceneEditInputSchema.parse({
      ...base,
      overrideMutations: [upsert(elementId), deletion]
    })).toThrow();
    expect(() => cadSceneEditInputSchema.parse({
      ...base,
      overrideMutations: Array.from(
        { length: CAD_SCENE_MAX_OVERRIDE_MUTATIONS + 1 },
        (_, index) => upsert(`cad-element-${index.toString(16).padStart(32, "0")}`)
      )
    })).toThrow();
    expect(() => cadSceneEditInputSchema.parse({
      ...base,
      layerMutations: Array.from(
        { length: CAD_SCENE_MAX_LAYER_MUTATIONS + 1 },
        (_, index) => ({ locator: tile(), layerName: `LAYER-${index}`, visible: true, locked: false })
      )
    })).toThrow();
    expect(() => cadSceneEditInputSchema.parse({
      ...base,
      overrideMutations: Array.from(
        { length: CAD_SCENE_MAX_EVIDENCE_TILES + 1 },
        (_, index) => upsert(`cad-element-${index.toString(16).padStart(32, "0")}`, index)
      )
    })).toThrow();
  });

  it("describes immutable scene content and persisted sparse edit state", () => {
    const descriptor = {
      id: "00000000-0000-4000-8000-000000000101",
      version: 2,
      sourceImportJobId: "00000000-0000-4000-8000-000000000102",
      width: 16_384,
      height: 8_192,
      tileSize: 512,
      primitiveCount: 30_000,
      tileCount: 64,
      manifestAssetId: "00000000-0000-4000-8000-000000000103",
      manifestContentPath: "/floors/00000000-0000-4000-8000-000000000104/import-jobs/00000000-0000-4000-8000-000000000102/scene/manifest/content",
      tileContentPathTemplate: "/floors/00000000-0000-4000-8000-000000000104/import-jobs/00000000-0000-4000-8000-000000000102/scene/tiles/{lod}/{tileX}/{tileY}/{part}/content",
      statePath: "/sites/00000000-0000-4000-8000-000000000105/floors/00000000-0000-4000-8000-000000000104/cad-scene"
    };

    expect(cadSceneDescriptorSchema.parse(descriptor)).toEqual(descriptor);
    expect(cadSceneStateSchema.parse({
      revision: 7,
      scene: descriptor,
      overrides: [{
        elementId: "cad-element-00000000000000000000000000000001",
        locator: { tileX: 2, tileY: 3, lod: 1, part: 4 },
        hidden: false,
        transform: { translateX: 1, translateY: 2, scaleX: 1, scaleY: 1, rotation: 0 },
        strokeColor: "#112233",
        fillColor: null,
        strokeWidth: 2,
        text: null
      }],
      layers: [{ layerName: "WALL", visible: false, locked: true }]
    })).toMatchObject({ revision: 7, scene: descriptor });

    expect(() => cadSceneStateSchema.parse({
      revision: 7,
      scene: descriptor,
      overrides: [{
        elementId: "cad-element-00000000000000000000000000000001",
        locator: { tileX: 2, tileY: 3, lod: 9, part: 4 },
        hidden: false,
        transform: null,
        strokeColor: null,
        fillColor: null,
        strokeWidth: null,
        text: null
      }],
      layers: []
    })).toThrow();

    const snapshot = {
      floorId: "00000000-0000-4000-8000-000000000104",
      revision: 7,
      width: 16_384,
      height: 8_192,
      floorPlan: {
        sourceType: "cad" as const,
        imageUrl: "",
        originalFileUrl: null,
        renderedImageUrl: null,
        width: 16_384,
        height: 8_192,
        gridSize: 80
      },
      cadScene: descriptor,
      objects: [],
      fixtures: []
    };
    expect(floorMapSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(() => floorMapSnapshotSchema.parse({ ...snapshot, cadScene: null })).toThrow();
    expect(() => floorMapSnapshotSchema.parse({
      ...snapshot,
      floorPlan: { ...snapshot.floorPlan, sourceType: "image", imageUrl: "/floor.png" }
    })).toThrow();
  });

  it("bounds persisted transforms and stroke widths for a 32768-unit map", () => {
    const base = { expectedRevision: 7, leaseToken: "lease-token", leaseFence: 3 };
    const elementId = "cad-element-00000000000000000000000000000001";
    const parseValue = (value: Record<string, unknown>) => cadSceneEditInputSchema.parse({
      ...base,
      overrideMutations: [{ operation: "upsert", locator: tile(), value: { elementId, ...value } }]
    }).overrideMutations[0];

    expect(parseValue({
      transform: {
        translateX: CAD_ELEMENT_MAX_TRANSLATION,
        translateY: -CAD_ELEMENT_MAX_TRANSLATION,
        scaleX: CAD_ELEMENT_MIN_SCALE,
        scaleY: CAD_ELEMENT_MAX_SCALE,
        rotation: CAD_ELEMENT_MAX_ABS_ROTATION
      },
      strokeWidth: CAD_ELEMENT_MAX_STROKE_WIDTH
    })).toMatchObject({
      value: {
        transform: {
          translateX: CAD_ELEMENT_MAX_TRANSLATION,
          translateY: -CAD_ELEMENT_MAX_TRANSLATION,
          scaleX: CAD_ELEMENT_MIN_SCALE,
          scaleY: CAD_ELEMENT_MAX_SCALE,
          rotation: 0
        },
        strokeWidth: CAD_ELEMENT_MAX_STROKE_WIDTH
      }
    });

    for (const value of [
      { transform: {
        translateX: CAD_ELEMENT_MAX_TRANSLATION + 1,
        translateY: 0,
        scaleX: 1,
        scaleY: 1,
        rotation: 0
      } },
      { transform: {
        translateX: 0,
        translateY: 0,
        scaleX: CAD_ELEMENT_MIN_SCALE / 2,
        scaleY: CAD_ELEMENT_MAX_SCALE + 1,
        rotation: 0
      } },
      { transform: {
        translateX: 0,
        translateY: 0,
        scaleX: 1,
        scaleY: 1,
        rotation: CAD_ELEMENT_MAX_ABS_ROTATION + 1
      } },
      { strokeWidth: CAD_ELEMENT_MAX_STROKE_WIDTH + 1 },
      { transform: { translateX: 1e308, translateY: 0, scaleX: 1, scaleY: 1, rotation: 0 } },
      { transform: { translateX: 0, translateY: 0, scaleX: 1e308, scaleY: 1, rotation: 0 } },
      { transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotation: 1e308 } },
      { strokeWidth: 1e308 }
    ]) {
      expect(() => parseValue(value)).toThrow();
    }
  });
});
