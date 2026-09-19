import { describe, expect, it } from "vitest";
import {
  CAD_MAP_DEFAULT_LONG_SIDE,
  CAD_MAP_EXTREME_MIN_SHORT_SIDE,
  CAD_MAP_MAX_LONG_SIDE,
  CAD_MAP_MIN_SHORT_SIDE,
  CAD_REGION_PREVIEW_MAX_BYTE_SIZE,
  CAD_REGION_PREVIEW_MAX_HEIGHT,
  CAD_REGION_PREVIEW_MAX_WIDTH,
  CAD_SCENE_MAX_EXPANDED_PRIMITIVES,
  CAD_SCENE_MAX_MANIFEST_BYTES,
  CAD_SCENE_MAX_POINTS_PER_PRIMITIVE,
  CAD_SCENE_MAX_PARTS_PER_TILE,
  CAD_SCENE_MAX_SELECTED_PRIMITIVES,
  CAD_SCENE_MAX_TILE_BYTE_SIZE,
  CAD_SCENE_MAX_TOTAL_TILE_BYTES,
  CAD_SCENE_MAX_TILES_PER_AXIS,
  CAD_SCENE_TILE_SIZE,
  cadElementOverrideSchema,
  cadElementOverridePatchSchema,
  cadRegionSchema,
  cadSceneManifestSchema,
  cadScenePrimitiveSchema,
  cadSceneTileSchema,
  normalizeCadMapSize
} from "./cad-scene-contracts";
import {
  floorImportRegionListResponseSchema,
  floorImportRegionSelectInputSchema
} from "./cad-import-contracts";

const sceneId = "00000000-0000-4000-8000-000000000001";
const assetId = "00000000-0000-4000-8000-000000000002";
const jobId = "00000000-0000-4000-8000-000000000003";
const sha256 = "a".repeat(64);
const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 50 };
const style = {
  strokeColor: "#112233",
  fillColor: null,
  strokeWidth: 1,
  opacity: 1
};

function primitive(geometry: Record<string, unknown>) {
  return {
    elementId: "element-1",
    groupId: null,
    layerName: "WALLS",
    sourceType: "LINE",
    bounds,
    clipBounds: null,
    style,
    ...geometry
  };
}

const tile = {
  version: 1,
  sceneId,
  tileX: 0,
  tileY: 0,
  lod: 0,
  part: 0,
  assetId,
  primitiveCount: 7,
  byteSize: 1_024,
  sha256,
  bounds: { minX: 0, minY: 0, maxX: CAD_SCENE_TILE_SIZE, maxY: CAD_SCENE_TILE_SIZE }
};

const region = {
  regionId: "region-main-floor",
  bounds,
  primitiveCount: 7,
  textCount: 1,
  lightCandidateCount: 2,
  area: 5_000,
  preview: {
    assetId,
    width: 640,
    height: 360,
    byteSize: 2_048,
    sha256
  }
};
const sourceBounds = { minX: 0, minY: 0, maxX: 1_600, maxY: 900 };
const manifestTransform = {
  scaleX: 9.511111,
  scaleY: -9.511111,
  translateX: 583.111111,
  translateY: 8_888
};
const manifest = {
  version: 1,
  sceneId,
  regionId: region.regionId,
  manifestAssetId: "00000000-0000-4000-8000-000000000004",
  width: CAD_MAP_DEFAULT_LONG_SIDE,
  height: 9_216,
  padding: 328,
  gridSize: 80,
  tileSize: CAD_SCENE_TILE_SIZE,
  lodMode: "additive",
  primitiveCount: 7,
  tileCount: 1,
  byteSize: 4_096,
  sha256,
  sourceBounds,
  transform: manifestTransform,
  tiles: [tile]
};

describe("CAD scene contracts", () => {
  it("accepts every native primitive and rejects malformed geometry", () => {
    const primitives = [
      primitive({ type: "line", geometry: { start: { x: 0, y: 0 }, end: { x: 100, y: 50 } } }),
      primitive({
        type: "polyline",
        geometry: { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }], closed: false }
      }),
      primitive({
        type: "rectangle",
        geometry: { origin: { x: 0, y: 0 }, width: 100, height: 50, rotation: 0 }
      }),
      primitive({
        type: "triangle",
        geometry: { points: [{ x: 0, y: 50 }, { x: 50, y: 0 }, { x: 100, y: 50 }] }
      }),
      primitive({
        type: "ellipse",
        geometry: { center: { x: 50, y: 25 }, radiusX: 50, radiusY: 25, rotation: 0 }
      }),
      primitive({
        type: "arc",
        geometry: { center: { x: 50, y: 25 }, radius: 25, startAngle: 0, endAngle: 180, counterClockwise: false }
      }),
      primitive({
        type: "text",
        sourceType: "MTEXT",
        geometry: {
          position: { x: 5, y: 10 },
          text: "B1 주차장",
          width: 90,
          height: 20,
          rotation: 0,
          fontSize: 12
        }
      })
    ];

    expect(primitives.map((value) => cadScenePrimitiveSchema.parse(value).type)).toEqual([
      "line",
      "polyline",
      "rectangle",
      "triangle",
      "ellipse",
      "arc",
      "text"
    ]);
    expect(cadScenePrimitiveSchema.safeParse(primitive({
      type: "line",
      geometry: { start: { x: 0, y: 0 }, end: { x: Number.NaN, y: 50 } }
    })).success).toBe(false);
    expect(cadScenePrimitiveSchema.safeParse(primitive({
      type: "spline",
      geometry: { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }
    })).success).toBe(false);
  });

  it("rejects ill-formed UTF-16 scene strings", () => {
    expect(cadScenePrimitiveSchema.safeParse(primitive({
      elementId: `element-${String.fromCharCode(0xd800)}`,
      type: "line",
      geometry: { start: { x: 0, y: 0 }, end: { x: 100, y: 50 } }
    })).success).toBe(false);
    expect(cadScenePrimitiveSchema.safeParse(primitive({
      type: "text",
      geometry: {
        position: { x: 0, y: 0 }, text: String.fromCharCode(0xdc00),
        width: 10, height: 10, rotation: 0, fontSize: 10
      }
    })).success).toBe(false);
  });

  it("requires clipped primitive bounds to stay inside non-null clip bounds", () => {
    expect(cadScenePrimitiveSchema.safeParse(primitive({
      clipBounds: { minX: 0, minY: 0, maxX: 512, maxY: 512 },
      type: "line",
      geometry: { start: { x: 0, y: 0 }, end: { x: 100, y: 50 } }
    })).success).toBe(true);
    expect(cadScenePrimitiveSchema.safeParse(primitive({
      clipBounds: { minX: 1, minY: 0, maxX: 512, maxY: 512 },
      type: "line",
      geometry: { start: { x: 0, y: 0 }, end: { x: 100, y: 50 } }
    })).success).toBe(false);
  });

  it("accepts axis-aligned primitive bounds but rejects a point-sized bound", () => {
    expect(cadScenePrimitiveSchema.safeParse(primitive({
      bounds: { minX: 0, minY: 10, maxX: 100, maxY: 10 },
      type: "line",
      geometry: { start: { x: 0, y: 10 }, end: { x: 100, y: 10 } }
    })).success).toBe(true);
    expect(cadScenePrimitiveSchema.safeParse(primitive({
      bounds: { minX: 10, minY: 10, maxX: 10, maxY: 10 },
      type: "line",
      geometry: { start: { x: 10, y: 10 }, end: { x: 10, y: 10 } }
    })).success).toBe(false);
  });

  it("caps points per primitive and selected-region primitive counts", () => {
    expect(CAD_SCENE_MAX_POINTS_PER_PRIMITIVE).toBe(65_536);
    expect(CAD_SCENE_MAX_SELECTED_PRIMITIVES).toBe(500_000);
    expect(CAD_SCENE_MAX_EXPANDED_PRIMITIVES).toBe(1_000_000);

    const maximumPoints = Array.from(
      { length: CAD_SCENE_MAX_POINTS_PER_PRIMITIVE },
      () => ({ x: 0, y: 0 })
    );
    const polyline = primitive({
      type: "polyline",
      geometry: { points: maximumPoints, closed: false }
    });
    expect(cadScenePrimitiveSchema.safeParse(polyline).success).toBe(true);
    expect(cadScenePrimitiveSchema.safeParse({
      ...polyline,
      geometry: { points: [...maximumPoints, { x: 1, y: 1 }], closed: false }
    }).success).toBe(false);

    expect(cadRegionSchema.safeParse({
      ...region,
      primitiveCount: CAD_SCENE_MAX_SELECTED_PRIMITIVES
    }).success).toBe(true);
    expect(cadRegionSchema.safeParse({
      ...region,
      primitiveCount: CAD_SCENE_MAX_SELECTED_PRIMITIVES + 1
    }).success).toBe(false);
  });

  it("validates strict tile and manifest integrity metadata", () => {
    expect(cadSceneTileSchema.parse(tile)).toEqual(tile);
    expect(cadSceneManifestSchema.parse(manifest)).toEqual(manifest);
    expect(cadSceneTileSchema.safeParse({ ...tile, tileX: CAD_SCENE_MAX_TILES_PER_AXIS }).success).toBe(false);
    expect(cadSceneTileSchema.safeParse({ ...tile, sha256: "not-a-digest" }).success).toBe(false);
    expect(cadSceneManifestSchema.safeParse({ ...manifest, tileSize: 256 }).success).toBe(false);
    expect(cadSceneManifestSchema.safeParse({ ...manifest, tileCount: 2 }).success).toBe(false);
    expect(cadSceneManifestSchema.safeParse({
      ...manifest,
      transform: { scale: 100, translateX: 0, translateY: 0 }
    }).success).toBe(false);
    expect(cadSceneManifestSchema.safeParse({
      ...manifest,
      transform: { ...manifest.transform, scaleX: 0 }
    }).success).toBe(false);
    expect(cadSceneManifestSchema.safeParse({
      ...manifest,
      transform: { ...manifest.transform, scaleY: 0 }
    }).success).toBe(false);
    expect(cadSceneManifestSchema.safeParse({
      ...manifest,
      width: manifest.width - 1
    }).success).toBe(false);
    expect(cadSceneManifestSchema.safeParse({
      ...manifest,
      padding: manifest.padding - 1
    }).success).toBe(false);
    expect(cadSceneManifestSchema.safeParse({
      ...manifest,
      transform: { ...manifest.transform, translateX: manifest.transform.translateX + 1 }
    }).success).toBe(false);
    expect(cadSceneManifestSchema.safeParse({
      ...manifest,
      tiles: [{
        ...tile,
        bounds: { minX: 0, minY: 0, maxX: CAD_SCENE_TILE_SIZE * 2, maxY: CAD_SCENE_TILE_SIZE }
      }]
    }).success).toBe(false);

    const unsupportedSourceBounds = { minX: 0, minY: 0, maxX: 65_000, maxY: 1_000 };
    expect(() => cadSceneManifestSchema.safeParse({
      ...manifest,
      sourceBounds: unsupportedSourceBounds
    })).not.toThrow();
    expect(cadSceneManifestSchema.safeParse({
      ...manifest,
      sourceBounds: unsupportedSourceBounds
    }).success).toBe(false);
  });

  it("supports bounded deterministic tile parts and additive LOD descriptors", () => {
    const secondTile = {
      ...tile,
      assetId: "00000000-0000-4000-8000-000000000005",
      tileX: 1,
      primitiveCount: 1,
      bounds: { minX: 512, minY: 0, maxX: 1_024, maxY: 512 }
    };

    expect(CAD_SCENE_MAX_PARTS_PER_TILE).toBeGreaterThan(1);
    expect(cadSceneManifestSchema.safeParse({
      ...manifest,
      tileCount: 2,
      tiles: [
        { ...tile, primitiveCount: 3 },
        { ...tile, part: 1, assetId: secondTile.assetId, primitiveCount: 4 }
      ]
    }).success).toBe(true);
    expect(cadSceneManifestSchema.safeParse({
      ...manifest,
      tiles: [{ ...tile, part: 1 }]
    }).success).toBe(false);
    expect(cadSceneManifestSchema.safeParse({ ...manifest, lodMode: "replacement" }).success).toBe(false);
    expect(cadSceneManifestSchema.safeParse({
      ...manifest,
      manifestAssetId: tile.assetId
    }).success).toBe(false);
    expect(cadSceneTileSchema.safeParse({ ...tile, part: CAD_SCENE_MAX_PARTS_PER_TILE }).success).toBe(false);
    expect(cadSceneTileSchema.safeParse({ ...tile, primitiveCount: 0 }).success).toBe(false);
    expect(cadSceneManifestSchema.safeParse({
      ...manifest,
      tiles: [{ ...tile, sceneId: "00000000-0000-4000-8000-000000000099" }]
    }).success).toBe(false);
    expect(cadSceneManifestSchema.safeParse({
      ...manifest,
      tileCount: 2,
      tiles: [tile, secondTile]
    }).success).toBe(true);
    expect(cadSceneManifestSchema.safeParse({
      ...manifest,
      tileCount: 2,
      tiles: [tile, { ...secondTile, assetId: tile.assetId }]
    }).success).toBe(false);
    expect(cadSceneManifestSchema.safeParse({
      ...manifest,
      tileCount: 2,
      tiles: [tile, { ...tile, lod: 1, assetId: secondTile.assetId }]
    }).success).toBe(true);
    expect(cadSceneManifestSchema.safeParse({
      ...manifest,
      tileCount: 2,
      tiles: [tile, { ...tile, assetId: secondTile.assetId }]
    }).success).toBe(false);
    expect(cadSceneManifestSchema.safeParse({
      ...manifest,
      primitiveCount: 8,
      tiles: [{ ...tile, primitiveCount: 7 }]
    }).success).toBe(false);
  });

  it("requires primitive and tile counts to describe the same empty state", () => {
    expect(cadSceneManifestSchema.safeParse({
      ...manifest,
      primitiveCount: 0,
      tileCount: 0,
      tiles: []
    }).success).toBe(true);
    expect(cadSceneManifestSchema.safeParse({
      ...manifest,
      primitiveCount: 0
    }).success).toBe(false);
    expect(cadSceneManifestSchema.safeParse({
      ...manifest,
      tileCount: 0,
      tiles: []
    }).success).toBe(false);
  });

  it("caps manifest metadata at 8 MiB", () => {
    expect(CAD_SCENE_MAX_MANIFEST_BYTES).toBe(8 * 1_024 * 1_024);
    expect(CAD_SCENE_MAX_TOTAL_TILE_BYTES).toBe(512 * 1_024 * 1_024);
    expect(cadSceneManifestSchema.safeParse({
      ...manifest,
      byteSize: CAD_SCENE_MAX_MANIFEST_BYTES
    }).success).toBe(true);
    expect(cadSceneManifestSchema.safeParse({
      ...manifest,
      byteSize: CAD_SCENE_MAX_MANIFEST_BYTES + 1
    }).success).toBe(false);

    const oversizedTileSet = Array.from({ length: 33 }, (_, part) => ({
      ...tile,
      part,
      assetId: `00000000-0000-4000-8000-${(part + 100).toString().padStart(12, "0")}`,
      primitiveCount: 1,
      byteSize: CAD_SCENE_MAX_TILE_BYTE_SIZE
    }));
    expect(cadSceneManifestSchema.safeParse({
      ...manifest,
      primitiveCount: 1,
      tileCount: oversizedTileSet.length,
      tiles: oversizedTileSet
    }).success).toBe(false);
  });

  it("validates large-origin translations in logical map units", () => {
    const largeOriginManifest = {
      ...manifest,
      sourceBounds: {
        minX: 1_000_000_000,
        minY: -1_000_000_000,
        maxX: 1_000_001_600,
        maxY: -999_999_100
      },
      transform: {
        scaleX: 9.511111111111111,
        scaleY: -9.511111111111111,
        translateX: -9_511_110_528,
        translateY: -9_511_102_223.11111
      }
    };

    expect(cadSceneManifestSchema.safeParse(largeOriginManifest).success).toBe(true);
    expect(cadSceneManifestSchema.safeParse({
      ...largeOriginManifest,
      transform: {
        ...largeOriginManifest.transform,
        translateX: largeOriginManifest.transform.translateX + 0.009
      }
    }).success).toBe(true);
    expect(cadSceneManifestSchema.safeParse({
      ...largeOriginManifest,
      transform: {
        ...largeOriginManifest.transform,
        translateX: largeOriginManifest.transform.translateX + 0.011
      }
    }).success).toBe(false);
  });

  it("validates region previews and rejects inconsistent statistics", () => {
    expect(cadRegionSchema.parse(region)).toEqual(region);
    expect(cadRegionSchema.safeParse({ ...region, area: 0 }).success).toBe(false);
    expect(cadRegionSchema.safeParse({
      ...region,
      textCount: region.primitiveCount + 1
    }).success).toBe(false);
    expect(cadRegionSchema.safeParse({
      ...region,
      preview: { ...region.preview, sha256: "bad" }
    }).success).toBe(false);
  });

  it("enforces compressed tile and region preview size limits", () => {
    expect(CAD_SCENE_MAX_TILE_BYTE_SIZE).toBe(16 * 1_024 * 1_024);
    expect(CAD_REGION_PREVIEW_MAX_WIDTH).toBe(2_400);
    expect(CAD_REGION_PREVIEW_MAX_HEIGHT).toBe(1_600);
    expect(CAD_REGION_PREVIEW_MAX_BYTE_SIZE).toBe(8 * 1_024 * 1_024);

    expect(cadSceneTileSchema.safeParse({
      ...tile,
      byteSize: CAD_SCENE_MAX_TILE_BYTE_SIZE
    }).success).toBe(true);
    expect(cadSceneTileSchema.safeParse({
      ...tile,
      byteSize: CAD_SCENE_MAX_TILE_BYTE_SIZE + 1
    }).success).toBe(false);
    expect(cadRegionSchema.safeParse({
      ...region,
      preview: {
        ...region.preview,
        width: CAD_REGION_PREVIEW_MAX_WIDTH,
        height: CAD_REGION_PREVIEW_MAX_HEIGHT,
        byteSize: CAD_REGION_PREVIEW_MAX_BYTE_SIZE
      }
    }).success).toBe(true);
    for (const preview of [
      { ...region.preview, width: CAD_REGION_PREVIEW_MAX_WIDTH + 1 },
      { ...region.preview, height: CAD_REGION_PREVIEW_MAX_HEIGHT + 1 },
      { ...region.preview, byteSize: CAD_REGION_PREVIEW_MAX_BYTE_SIZE + 1 }
    ]) {
      expect(cadRegionSchema.safeParse({ ...region, preview }).success).toBe(false);
    }
  });

  it("requires an override patch to contain at least one valid change", () => {
    const patch = {
      elementId: "element-1",
      hidden: true,
      transform: {
        translateX: 10,
        translateY: -5,
        scaleX: 1.25,
        scaleY: 0.75,
        rotation: 15
      },
      strokeColor: "#abcdef",
      fillColor: null,
      strokeWidth: 2,
      text: "출입구"
    };

    expect(cadElementOverridePatchSchema.parse(patch)).toEqual(patch);
    expect(cadElementOverridePatchSchema.safeParse({ elementId: "element-1" }).success).toBe(false);
    expect(cadElementOverridePatchSchema.safeParse({
      elementId: "element-1",
      transform: { ...patch.transform, scaleX: 0 }
    }).success).toBe(false);
    expect(cadElementOverridePatchSchema.safeParse({
      elementId: "element-1",
      strokeColor: "red"
    }).success).toBe(false);

    expect(cadElementOverrideSchema.parse(patch)).toEqual(patch);
    const { text: _missing, ...incompleteOverride } = patch;
    expect(cadElementOverrideSchema.safeParse(incompleteOverride).success).toBe(false);
  });

  it("keeps import region selection consistent with detected regions", () => {
    expect(floorImportRegionListResponseSchema.parse({
      jobId,
      selectionStatus: "auto_selected",
      selectedRegionId: region.regionId,
      excludedRegionPrimitiveCount: 3,
      regions: [region]
    }).excludedRegionPrimitiveCount).toBe(3);
    expect(floorImportRegionListResponseSchema.parse({
      jobId,
      selectionStatus: "selection_required",
      selectedRegionId: null,
      excludedRegionPrimitiveCount: 7,
      regions: [region, { ...region, regionId: "region-detail" }]
    }).selectionStatus).toBe("selection_required");
    expect(floorImportRegionSelectInputSchema.parse({ regionId: region.regionId })).toEqual({
      regionId: region.regionId
    });
    expect(floorImportRegionListResponseSchema.safeParse({
      jobId,
      selectionStatus: "selected",
      selectedRegionId: "missing-region",
      excludedRegionPrimitiveCount: 0,
      regions: [region]
    }).success).toBe(false);
    expect(floorImportRegionListResponseSchema.safeParse({
      jobId,
      selectionStatus: "selection_required",
      selectedRegionId: region.regionId,
      excludedRegionPrimitiveCount: 0,
      regions: [region]
    }).success).toBe(false);
    expect(floorImportRegionListResponseSchema.safeParse({
      jobId,
      selectionStatus: "selected",
      selectedRegionId: region.regionId,
      excludedRegionPrimitiveCount: 0,
      regions: [region]
    }).success).toBe(false);
    expect(floorImportRegionListResponseSchema.safeParse({
      jobId,
      selectionStatus: "auto_selected",
      selectedRegionId: region.regionId,
      regions: [region]
    }).success).toBe(false);
  });
});

describe("CAD logical map size policy", () => {
  it("uses a 16,384-unit long side for a 16:9 region", () => {
    expect(CAD_MAP_DEFAULT_LONG_SIDE).toBe(16_384);
    expect(CAD_MAP_MIN_SHORT_SIDE).toBe(1_024);
    expect(normalizeCadMapSize({ minX: 100, minY: -50, maxX: 1_700, maxY: 850 })).toEqual({
      width: 16_384,
      height: 9_216,
      padding: 328,
      gridSize: 80
    });
  });

  it("preserves orientation for a portrait region", () => {
    expect(normalizeCadMapSize({ minX: 0, minY: 0, maxX: 900, maxY: 1_600 })).toEqual({
      width: 9_216,
      height: 16_384,
      padding: 328,
      gridSize: 80
    });
  });

  it("caps an extreme region at 32,768 while allowing the short side below 1,024", () => {
    expect(CAD_MAP_MAX_LONG_SIDE).toBe(32_768);
    expect(CAD_MAP_EXTREME_MIN_SHORT_SIDE).toBe(512);
    expect(normalizeCadMapSize({ minX: 0, minY: 0, maxX: 40_000, maxY: 1_000 })).toEqual({
      width: 32_768,
      height: 819,
      padding: 204,
      gridSize: 100
    });
  });

  it("rejects degenerate and unsupported aspect ratios", () => {
    expect(() => normalizeCadMapSize({ minX: 0, minY: 0, maxX: 0, maxY: 100 })).toThrow();
    expect(() => normalizeCadMapSize({ minX: 0, minY: 0, maxX: 65_000, maxY: 1_000 })).toThrow();
    expect(() => normalizeCadMapSize({
      minX: -Number.MAX_VALUE,
      minY: 0,
      maxX: Number.MAX_VALUE,
      maxY: 1
    })).toThrow("finite spans");
  });
});
