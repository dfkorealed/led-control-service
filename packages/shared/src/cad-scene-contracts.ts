import { z } from "zod";
import { POSTGRES_INT_MAX } from "./postgres-contracts.js";

export const CAD_SCENE_VERSION = 1;
export const CAD_SCENE_TILE_SIZE = 512;
export const CAD_SCENE_MAX_TILES_PER_AXIS = 64;
export const CAD_SCENE_MAX_EXPANDED_PRIMITIVES = 1_000_000;
export const CAD_SCENE_MAX_SELECTED_PRIMITIVES = 500_000;
export const CAD_SCENE_MAX_POINTS_PER_PRIMITIVE = 65_536;
export const CAD_SCENE_MAX_TILE_BYTE_SIZE = 16 * 1_024 * 1_024;
export const CAD_SCENE_MAX_TOTAL_TILE_BYTES = 512 * 1_024 * 1_024;
export const CAD_SCENE_MAX_PARTS_PER_TILE = 128;
export const CAD_SCENE_MAX_MANIFEST_BYTES = 8 * 1_024 * 1_024;
export const CAD_SCENE_MAX_OVERRIDE_MUTATIONS = 100;
export const CAD_SCENE_MAX_LAYER_MUTATIONS = 100;
export const CAD_SCENE_MAX_EVIDENCE_TILES = 16;
export const CAD_SCENE_MAX_EVIDENCE_BYTES = 32 * 1_024 * 1_024;
export const CAD_SCENE_MAX_PERSISTED_OVERRIDES = 10_000;
export const CAD_SCENE_MAX_PERSISTED_LAYER_STATES = 2_000;
export const CAD_REGION_PREVIEW_MAX_WIDTH = 2_400;
export const CAD_REGION_PREVIEW_MAX_HEIGHT = 1_600;
export const CAD_REGION_PREVIEW_MAX_BYTE_SIZE = 8 * 1_024 * 1_024;
export const CAD_MAP_DEFAULT_LONG_SIDE = 16_384;
export const CAD_MAP_MAX_LONG_SIDE = 32_768;
export const CAD_MAP_MIN_SHORT_SIDE = 1_024;
export const CAD_MAP_EXTREME_MIN_SHORT_SIDE = 512;
// Edit transforms are persisted and evaluated by every renderer. Keep them
// proportional to the largest supported logical map so one request cannot
// create unbounded matrices, bounds, or GPU stroke geometry.
export const CAD_ELEMENT_MAX_TRANSLATION = CAD_MAP_MAX_LONG_SIDE;
export const CAD_ELEMENT_MIN_SCALE = 0.01;
export const CAD_ELEMENT_MAX_SCALE = 100;
export const CAD_ELEMENT_MAX_ABS_ROTATION = 360;
export const CAD_ELEMENT_MAX_STROKE_WIDTH = CAD_SCENE_TILE_SIZE;

export const CAD_SCENE_MAX_TILE_PART_COUNT = CAD_SCENE_MAX_TILES_PER_AXIS
  * CAD_SCENE_MAX_TILES_PER_AXIS
  * 3;
const CAD_SCENE_TRANSFORM_TOLERANCE = 1e-6;
const CAD_SCENE_CORNER_TOLERANCE = 0.01;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const colorSchema = z.string().regex(/^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/i);
const finiteNumberSchema = z.number().finite();
const nonnegativeIntegerSchema = z.number().int().nonnegative().max(POSTGRES_INT_MAX);
function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function trimmedSceneStringSchema(maximumLength: number) {
  return z.string().trim().min(1).max(maximumLength).refine(isWellFormedUnicode, {
    message: "string must contain well-formed UTF-16 Unicode"
  });
}

function sceneStringSchema(maximumLength: number) {
  return z.string().max(maximumLength).refine(isWellFormedUnicode, {
    message: "string must contain well-formed UTF-16 Unicode"
  });
}
const cadBoundsShape = {
  minX: finiteNumberSchema,
  minY: finiteNumberSchema,
  maxX: finiteNumberSchema,
  maxY: finiteNumberSchema
};

export const cadPointSchema = z.object({
  x: finiteNumberSchema,
  y: finiteNumberSchema
}).strict();

export const cadBoundsSchema = z.object(cadBoundsShape).strict().superRefine((value, context) => {
  const width = value.maxX - value.minX;
  const height = value.maxY - value.minY;
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "bounds must have finite spans"
    });
    return;
  }
  if (value.maxX <= value.minX) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxX"],
      message: "maxX must be greater than minX"
    });
  }
  if (value.maxY <= value.minY) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxY"],
      message: "maxY must be greater than minY"
    });
  }
});

export const cadPrimitiveBoundsSchema = z.object(cadBoundsShape).strict().superRefine((value, context) => {
  const width = value.maxX - value.minX;
  const height = value.maxY - value.minY;
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "primitive bounds must have finite spans"
    });
    return;
  }
  if (width < 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxX"],
      message: "maxX must be greater than or equal to minX"
    });
  }
  if (height < 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxY"],
      message: "maxY must be greater than or equal to minY"
    });
  }
  if (width === 0 && height === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "primitive bounds must span at least one axis"
    });
  }
});

export const cadPrimitiveStyleSchema = z.object({
  strokeColor: colorSchema.nullable(),
  fillColor: colorSchema.nullable(),
  strokeWidth: finiteNumberSchema.nonnegative(),
  opacity: finiteNumberSchema.min(0).max(1)
}).strict();

const cadPrimitiveBaseShape = {
  elementId: trimmedSceneStringSchema(512),
  groupId: trimmedSceneStringSchema(512).nullable(),
  layerName: trimmedSceneStringSchema(512),
  sourceType: trimmedSceneStringSchema(128),
  bounds: cadPrimitiveBoundsSchema,
  clipBounds: cadBoundsSchema.nullable(),
  style: cadPrimitiveStyleSchema
};

const linePrimitiveSchema = z.object({
  ...cadPrimitiveBaseShape,
  type: z.literal("line"),
  geometry: z.object({
    start: cadPointSchema,
    end: cadPointSchema
  }).strict()
}).strict();

const polylinePrimitiveSchema = z.object({
  ...cadPrimitiveBaseShape,
  type: z.literal("polyline"),
  geometry: z.object({
    points: z.array(cadPointSchema).min(2).max(CAD_SCENE_MAX_POINTS_PER_PRIMITIVE),
    closed: z.boolean()
  }).strict()
}).strict();

const rectanglePrimitiveSchema = z.object({
  ...cadPrimitiveBaseShape,
  type: z.literal("rectangle"),
  geometry: z.object({
    origin: cadPointSchema,
    width: finiteNumberSchema.positive(),
    height: finiteNumberSchema.positive(),
    rotation: finiteNumberSchema
  }).strict()
}).strict();

const trianglePrimitiveSchema = z.object({
  ...cadPrimitiveBaseShape,
  type: z.literal("triangle"),
  geometry: z.object({
    points: z.tuple([cadPointSchema, cadPointSchema, cadPointSchema])
  }).strict()
}).strict();

const ellipsePrimitiveSchema = z.object({
  ...cadPrimitiveBaseShape,
  type: z.literal("ellipse"),
  geometry: z.object({
    center: cadPointSchema,
    radiusX: finiteNumberSchema.positive(),
    radiusY: finiteNumberSchema.positive(),
    rotation: finiteNumberSchema
  }).strict()
}).strict();

const arcPrimitiveSchema = z.object({
  ...cadPrimitiveBaseShape,
  type: z.literal("arc"),
  geometry: z.object({
    center: cadPointSchema,
    radius: finiteNumberSchema.positive(),
    startAngle: finiteNumberSchema,
    endAngle: finiteNumberSchema,
    counterClockwise: z.boolean()
  }).strict()
}).strict();

const textPrimitiveSchema = z.object({
  ...cadPrimitiveBaseShape,
  type: z.literal("text"),
  geometry: z.object({
    position: cadPointSchema,
    text: sceneStringSchema(65_536),
    width: finiteNumberSchema.nonnegative(),
    height: finiteNumberSchema.nonnegative(),
    rotation: finiteNumberSchema,
    fontSize: finiteNumberSchema.positive()
  }).strict()
}).strict();

export const cadScenePrimitiveSchema = z.discriminatedUnion("type", [
  linePrimitiveSchema,
  polylinePrimitiveSchema,
  rectanglePrimitiveSchema,
  trianglePrimitiveSchema,
  ellipsePrimitiveSchema,
  arcPrimitiveSchema,
  textPrimitiveSchema
]).superRefine((primitive, context) => {
  const clip = primitive.clipBounds;
  if (clip === null) return;
  const bounds = primitive.bounds;
  if (bounds.minX < clip.minX || bounds.minY < clip.minY ||
      bounds.maxX > clip.maxX || bounds.maxY > clip.maxY) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["clipBounds"],
      message: "primitive bounds must be contained by clip bounds"
    });
  }
});

export const cadSceneTransformSchema = z.object({
  scaleX: finiteNumberSchema.positive(),
  scaleY: finiteNumberSchema.refine((value) => value !== 0, {
    message: "scaleY must be non-zero"
  }),
  translateX: finiteNumberSchema,
  translateY: finiteNumberSchema
}).strict();

export const cadSceneTileSchema = z.object({
  version: z.literal(CAD_SCENE_VERSION),
  sceneId: z.string().uuid(),
  tileX: z.number().int().min(0).max(CAD_SCENE_MAX_TILES_PER_AXIS - 1),
  tileY: z.number().int().min(0).max(CAD_SCENE_MAX_TILES_PER_AXIS - 1),
  lod: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  part: z.number().int().min(0).max(CAD_SCENE_MAX_PARTS_PER_TILE - 1),
  assetId: z.string().uuid(),
  primitiveCount: nonnegativeIntegerSchema.positive().max(CAD_SCENE_MAX_SELECTED_PRIMITIVES),
  byteSize: z.number().int().positive().max(CAD_SCENE_MAX_TILE_BYTE_SIZE),
  sha256: sha256Schema,
  bounds: cadBoundsSchema
}).strict();

export const cadSceneManifestSchema = z.object({
  version: z.literal(CAD_SCENE_VERSION),
  sceneId: z.string().uuid(),
  regionId: z.string().trim().min(1).max(512),
  manifestAssetId: z.string().uuid(),
  width: z.number().int().min(CAD_MAP_EXTREME_MIN_SHORT_SIDE).max(CAD_MAP_MAX_LONG_SIDE),
  height: z.number().int().min(CAD_MAP_EXTREME_MIN_SHORT_SIDE).max(CAD_MAP_MAX_LONG_SIDE),
  padding: z.number().int().nonnegative().max(CAD_MAP_MAX_LONG_SIDE),
  gridSize: z.number().int().min(10).max(100).refine((value) => value % 5 === 0),
  tileSize: z.literal(CAD_SCENE_TILE_SIZE),
  lodMode: z.literal("additive"),
  primitiveCount: nonnegativeIntegerSchema.max(CAD_SCENE_MAX_SELECTED_PRIMITIVES),
  tileCount: nonnegativeIntegerSchema.max(CAD_SCENE_MAX_TILE_PART_COUNT),
  byteSize: z.number().int().positive().max(CAD_SCENE_MAX_MANIFEST_BYTES),
  sha256: sha256Schema,
  sourceBounds: cadBoundsSchema,
  transform: cadSceneTransformSchema,
  tiles: z.array(cadSceneTileSchema).max(CAD_SCENE_MAX_TILE_PART_COUNT)
}).strict().superRefine((manifest, context) => {
  let normalizedSize: CadMapSize;
  try {
    normalizedSize = normalizeCadMapSize(manifest.sourceBounds);
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceBounds"],
      message: "sourceBounds cannot be normalized into the supported logical map"
    });
    return;
  }
  for (const field of ["width", "height", "padding", "gridSize"] as const) {
    if (manifest[field] !== normalizedSize[field]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} must match the normalized source bounds`
      });
    }
  }

  const expectedTransform = calculateCadSceneTransform(manifest.sourceBounds, normalizedSize);
  for (const field of ["scaleX", "scaleY"] as const) {
    if (!nearlyEqualRelative(manifest.transform[field], expectedTransform[field])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["transform", field],
        message: `${field} must map source bounds into the normalized padded map`
      });
    }
  }

  const sourceCorners = [
    { x: manifest.sourceBounds.minX, y: manifest.sourceBounds.minY },
    { x: manifest.sourceBounds.minX, y: manifest.sourceBounds.maxY },
    { x: manifest.sourceBounds.maxX, y: manifest.sourceBounds.minY },
    { x: manifest.sourceBounds.maxX, y: manifest.sourceBounds.maxY }
  ];
  const cornerMismatch = sourceCorners.some((corner) => {
    const actualX = corner.x * manifest.transform.scaleX + manifest.transform.translateX;
    const actualY = corner.y * manifest.transform.scaleY + manifest.transform.translateY;
    const expectedX = corner.x * expectedTransform.scaleX + expectedTransform.translateX;
    const expectedY = corner.y * expectedTransform.scaleY + expectedTransform.translateY;
    return Math.abs(actualX - expectedX) > CAD_SCENE_CORNER_TOLERANCE
      || Math.abs(actualY - expectedY) > CAD_SCENE_CORNER_TOLERANCE;
  });
  if (cornerMismatch) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["transform"],
      message: "transform must project source corners within 0.01 logical map units"
    });
  }

  if (manifest.tileCount !== manifest.tiles.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tileCount"],
      message: "tileCount must match the number of tile descriptors"
    });
  }
  if ((manifest.primitiveCount === 0) !== (manifest.tileCount === 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tileCount"],
      message: "primitiveCount and tileCount must describe the same empty scene state"
    });
  }

  const maximumTileX = Math.ceil(manifest.width / manifest.tileSize) - 1;
  const maximumTileY = Math.ceil(manifest.height / manifest.tileSize) - 1;
  const tileKeys = new Set<string>();
  const tileAssetIds = new Set<string>();
  const partsByTile = new Map<string, number[]>();
  let tileOccurrenceCount = 0;
  let totalTileBytes = 0;
  manifest.tiles.forEach((tile, index) => {
    tileOccurrenceCount += tile.primitiveCount;
    totalTileBytes += tile.byteSize;
    if (tile.sceneId !== manifest.sceneId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tiles", index, "sceneId"],
        message: "tile sceneId must match the manifest sceneId"
      });
    }
    if (tile.tileX > maximumTileX || tile.tileY > maximumTileY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tiles", index],
        message: "tile coordinates must fit within the logical map"
      });
    }

    const expectedBounds = {
      minX: tile.tileX * manifest.tileSize,
      minY: tile.tileY * manifest.tileSize,
      maxX: Math.min(manifest.width, (tile.tileX + 1) * manifest.tileSize),
      maxY: Math.min(manifest.height, (tile.tileY + 1) * manifest.tileSize)
    };
    if (Object.entries(expectedBounds).some(([field, value]) =>
      tile.bounds[field as keyof typeof expectedBounds] !== value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tiles", index, "bounds"],
        message: "tile bounds must match its logical map cell"
      });
    }

    const cellKey = `${tile.lod}:${tile.tileX}:${tile.tileY}`;
    const tileKey = `${cellKey}:${tile.part}`;
    if (tileKeys.has(tileKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tiles", index],
        message: "tile part must be unique within each LOD cell"
      });
    }
    tileKeys.add(tileKey);
    if (tileAssetIds.has(tile.assetId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tiles", index, "assetId"],
        message: "tile assetId must be unique within the manifest"
      });
    }
    if (tile.assetId === manifest.manifestAssetId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tiles", index, "assetId"],
        message: "tile assetId must differ from the manifest assetId"
      });
    }
    tileAssetIds.add(tile.assetId);
    const parts = partsByTile.get(cellKey) ?? [];
    parts.push(tile.part);
    partsByTile.set(cellKey, parts);
  });

  if (tileOccurrenceCount < manifest.primitiveCount) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tiles"],
      message: "tile primitive occurrences must cover every manifest primitive"
    });
  }
  if (totalTileBytes > CAD_SCENE_MAX_TOTAL_TILE_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tiles"],
      message: "total tile payload bytes exceed the scene limit"
    });
  }

  for (const parts of partsByTile.values()) {
    parts.sort((left, right) => left - right);
    if (parts.some((part, index) => part !== index)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tiles"],
        message: "tile parts must be contiguous and start at zero"
      });
    }
  }
});

const cadRegionPreviewSchema = z.object({
  assetId: z.string().uuid(),
  width: z.number().int().positive().max(CAD_REGION_PREVIEW_MAX_WIDTH),
  height: z.number().int().positive().max(CAD_REGION_PREVIEW_MAX_HEIGHT),
  byteSize: z.number().int().positive().max(CAD_REGION_PREVIEW_MAX_BYTE_SIZE),
  sha256: sha256Schema
}).strict();

export const cadRegionSchema = z.object({
  regionId: z.string().trim().min(1).max(512),
  bounds: cadBoundsSchema,
  primitiveCount: nonnegativeIntegerSchema.max(CAD_SCENE_MAX_SELECTED_PRIMITIVES),
  textCount: nonnegativeIntegerSchema.max(CAD_SCENE_MAX_SELECTED_PRIMITIVES),
  lightCandidateCount: nonnegativeIntegerSchema.max(CAD_SCENE_MAX_SELECTED_PRIMITIVES),
  area: finiteNumberSchema.positive(),
  preview: cadRegionPreviewSchema
}).strict().superRefine((region, context) => {
  for (const field of ["textCount", "lightCandidateCount"] as const) {
    if (region[field] > region.primitiveCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} must not exceed primitiveCount`
      });
    }
  }
});

const cadElementTranslationSchema = finiteNumberSchema
  .min(-CAD_ELEMENT_MAX_TRANSLATION)
  .max(CAD_ELEMENT_MAX_TRANSLATION);
const cadElementScaleSchema = finiteNumberSchema
  .min(CAD_ELEMENT_MIN_SCALE)
  .max(CAD_ELEMENT_MAX_SCALE);
const cadElementRotationSchema = finiteNumberSchema
  .min(-CAD_ELEMENT_MAX_ABS_ROTATION)
  .max(CAD_ELEMENT_MAX_ABS_ROTATION)
  .transform((value) => {
    const normalized = ((value + 180) % 360 + 360) % 360 - 180;
    return Object.is(normalized, -0) ? 0 : normalized;
  });

export const cadSceneElementLocatorSchema = z.object({
  tileX: z.number().int().min(0).max(CAD_SCENE_MAX_TILES_PER_AXIS - 1),
  tileY: z.number().int().min(0).max(CAD_SCENE_MAX_TILES_PER_AXIS - 1),
  lod: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  part: z.number().int().min(0).max(CAD_SCENE_MAX_PARTS_PER_TILE - 1)
}).strict();

export const cadElementTransformSchema = z.object({
  translateX: cadElementTranslationSchema,
  translateY: cadElementTranslationSchema,
  scaleX: cadElementScaleSchema,
  scaleY: cadElementScaleSchema,
  rotation: cadElementRotationSchema
}).strict();

const cadElementOverrideValueShape = {
  hidden: z.boolean(),
  transform: cadElementTransformSchema.nullable(),
  strokeColor: colorSchema.nullable(),
  fillColor: colorSchema.nullable(),
  strokeWidth: finiteNumberSchema.min(0).max(CAD_ELEMENT_MAX_STROKE_WIDTH).nullable(),
  text: z.string().max(65_536).nullable()
};

export const cadElementOverrideSchema = z.object({
  elementId: z.string().trim().min(1).max(512),
  // Rows created before locator persistence remain readable, but every new
  // mutation stores evidence so clients can preload only the source tile.
  locator: cadSceneElementLocatorSchema.nullable().optional(),
  ...cadElementOverrideValueShape
}).strict();

const cadElementOverridePatchObjectSchema = z.object({
  elementId: z.string().trim().min(1).max(512),
  hidden: cadElementOverrideValueShape.hidden.optional(),
  transform: cadElementOverrideValueShape.transform.optional(),
  strokeColor: cadElementOverrideValueShape.strokeColor.optional(),
  fillColor: cadElementOverrideValueShape.fillColor.optional(),
  strokeWidth: cadElementOverrideValueShape.strokeWidth.optional(),
  text: cadElementOverrideValueShape.text.optional()
}).strict();

function requireCadOverrideChange(
  override: z.infer<typeof cadElementOverridePatchObjectSchema>,
  context: z.RefinementCtx
) {
  const hasChange = Object.keys(cadElementOverrideValueShape)
    .some((field) => override[field as keyof typeof cadElementOverrideValueShape] !== undefined);
  if (!hasChange) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "an override patch must contain at least one change"
    });
  }
}

export const cadElementOverridePatchSchema = cadElementOverridePatchObjectSchema
  .superRefine(requireCadOverrideChange);

export const cadLayerStateSchema = z.object({
  layerName: z.string().trim().min(1).max(512),
  visible: z.boolean(),
  locked: z.boolean()
}).strict();

const cadElementIdSchema = z.string().regex(/^cad-element-[a-f0-9]{32}$/);
const cadSceneOverrideMutationSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("upsert"),
    locator: cadSceneElementLocatorSchema,
    value: cadElementOverridePatchObjectSchema.extend({ elementId: cadElementIdSchema })
      .superRefine(requireCadOverrideChange)
  }).strict(),
  z.object({
    operation: z.literal("delete"),
    locator: cadSceneElementLocatorSchema,
    elementId: cadElementIdSchema
  }).strict()
]);

export const cadSceneLayerMutationSchema = cadLayerStateSchema.extend({
  locator: cadSceneElementLocatorSchema
}).strict();

export const cadSceneEditInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative().max(POSTGRES_INT_MAX - 1),
  leaseToken: z.string().trim().min(1).max(256),
  leaseFence: z.number().int().positive().max(POSTGRES_INT_MAX),
  overrideMutations: z.array(cadSceneOverrideMutationSchema)
    .max(CAD_SCENE_MAX_OVERRIDE_MUTATIONS).default([]),
  layerMutations: z.array(cadSceneLayerMutationSchema)
    .max(CAD_SCENE_MAX_LAYER_MUTATIONS).default([])
}).strict().superRefine((value, context) => {
  if (value.overrideMutations.length === 0 && value.layerMutations.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "CAD scene edit must contain at least one mutation" });
  }

  const overrideIds = new Set<string>();
  value.overrideMutations.forEach((mutation, index) => {
    const elementId = mutation.operation === "upsert" ? mutation.value.elementId : mutation.elementId;
    if (overrideIds.has(elementId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["overrideMutations", index],
        message: "CAD element IDs must be unique within an edit batch"
      });
    }
    overrideIds.add(elementId);
  });

  const layerNames = new Set<string>();
  value.layerMutations.forEach((mutation, index) => {
    if (layerNames.has(mutation.layerName)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["layerMutations", index, "layerName"],
        message: "CAD layer names must be unique within an edit batch"
      });
    }
    layerNames.add(mutation.layerName);
  });

  const evidenceTiles = new Set([
    ...value.overrideMutations.map(({ locator }) => cadSceneLocatorKey(locator)),
    ...value.layerMutations.map(({ locator }) => cadSceneLocatorKey(locator))
  ]);
  if (evidenceTiles.size > CAD_SCENE_MAX_EVIDENCE_TILES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["overrideMutations"],
      message: `CAD edit evidence must not span more than ${CAD_SCENE_MAX_EVIDENCE_TILES} tiles`
    });
  }
});

const apiContentPathSchema = z.string().min(1).max(2_048).refine(
  value => value.startsWith("/") && !value.includes("?") && !value.includes("#"),
  "content path must be an absolute API path without a query or fragment"
);

export const cadSceneDescriptorSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive().max(POSTGRES_INT_MAX),
  sourceImportJobId: z.string().uuid(),
  width: z.number().int().min(CAD_MAP_EXTREME_MIN_SHORT_SIDE).max(CAD_MAP_MAX_LONG_SIDE),
  height: z.number().int().min(CAD_MAP_EXTREME_MIN_SHORT_SIDE).max(CAD_MAP_MAX_LONG_SIDE),
  tileSize: z.literal(CAD_SCENE_TILE_SIZE),
  primitiveCount: nonnegativeIntegerSchema.max(CAD_SCENE_MAX_SELECTED_PRIMITIVES),
  tileCount: nonnegativeIntegerSchema.max(CAD_SCENE_MAX_TILE_PART_COUNT),
  manifestAssetId: z.string().uuid(),
  manifestContentPath: apiContentPathSchema,
  tileContentPathTemplate: apiContentPathSchema.refine(value =>
    ["{lod}", "{tileX}", "{tileY}", "{part}"].every(token => value.split(token).length === 2),
  "tile content path must contain each coordinate placeholder exactly once"),
  statePath: apiContentPathSchema
}).strict();

export const cadSceneStateSchema = z.object({
  revision: nonnegativeIntegerSchema,
  scene: cadSceneDescriptorSchema,
  overrides: z.array(cadElementOverrideSchema).max(CAD_SCENE_MAX_PERSISTED_OVERRIDES),
  layers: z.array(cadLayerStateSchema).max(CAD_SCENE_MAX_PERSISTED_LAYER_STATES)
}).strict();

export function buildCadSceneDescriptor(
  siteId: string,
  floorId: string,
  scene: {
    id: string;
    version: number;
    sourceImportJobId: string;
    width: number;
    height: number;
    tileSize: number;
    primitiveCount: number;
    tileCount: number;
    manifestAssetId: string;
  }
): CadSceneDescriptor {
  const importBase = `/floors/${floorId}/import-jobs/${scene.sourceImportJobId}/scene`;
  return cadSceneDescriptorSchema.parse({
    id: scene.id,
    version: scene.version,
    sourceImportJobId: scene.sourceImportJobId,
    width: scene.width,
    height: scene.height,
    tileSize: scene.tileSize,
    primitiveCount: scene.primitiveCount,
    tileCount: scene.tileCount,
    manifestAssetId: scene.manifestAssetId,
    manifestContentPath: `${importBase}/manifest/content`,
    tileContentPathTemplate: `${importBase}/tiles/{lod}/{tileX}/{tileY}/{part}/content`,
    statePath: `/sites/${siteId}/floors/${floorId}/cad-scene`
  });
}

export function cadSceneLocatorKey(locator: z.infer<typeof cadSceneElementLocatorSchema>): string {
  return `${locator.lod}:${locator.tileX}:${locator.tileY}:${locator.part}`;
}

export interface CadMapSize {
  width: number;
  height: number;
  padding: number;
  gridSize: number;
}

export function normalizeCadMapSize(bounds: CadBounds): CadMapSize {
  const parsedBounds = cadBoundsSchema.parse(bounds);
  const sourceWidth = parsedBounds.maxX - parsedBounds.minX;
  const sourceHeight = parsedBounds.maxY - parsedBounds.minY;
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight)) {
    throw new RangeError("CAD bounds must have finite spans");
  }
  const landscape = sourceWidth >= sourceHeight;
  const aspectRatio = Math.max(sourceWidth, sourceHeight) / Math.min(sourceWidth, sourceHeight);

  let longSide = CAD_MAP_DEFAULT_LONG_SIDE;
  let shortSide = longSide / aspectRatio;
  if (shortSide < CAD_MAP_MIN_SHORT_SIDE) {
    longSide = Math.min(CAD_MAP_MAX_LONG_SIDE, aspectRatio * CAD_MAP_MIN_SHORT_SIDE);
    shortSide = longSide / aspectRatio;
  }
  if (shortSide < CAD_MAP_EXTREME_MIN_SHORT_SIDE) {
    throw new RangeError(
      `CAD bounds aspect ratio exceeds the supported ${CAD_MAP_MAX_LONG_SIDE}:${CAD_MAP_EXTREME_MIN_SHORT_SIDE} range`
    );
  }

  const normalizedLongSide = Math.round(longSide);
  const normalizedShortSide = Math.round(shortSide);
  const requestedPadding = Math.max(64, Math.round(normalizedLongSide * 0.02));
  const maximumPadding = Math.floor(normalizedShortSide / 4);
  const gridSize = Math.min(100, Math.max(
    10,
    Math.round((normalizedLongSide / 200) / 5) * 5
  ));

  return {
    width: landscape ? normalizedLongSide : normalizedShortSide,
    height: landscape ? normalizedShortSide : normalizedLongSide,
    padding: Math.min(requestedPadding, maximumPadding),
    gridSize
  };
}

function calculateCadSceneTransform(bounds: CadBounds, mapSize: CadMapSize): CadSceneTransform {
  const sourceWidth = bounds.maxX - bounds.minX;
  const sourceHeight = bounds.maxY - bounds.minY;
  const scale = Math.min(
    (mapSize.width - 2 * mapSize.padding) / sourceWidth,
    (mapSize.height - 2 * mapSize.padding) / sourceHeight
  );
  const offsetX = (mapSize.width - sourceWidth * scale) / 2;
  const offsetY = (mapSize.height - sourceHeight * scale) / 2;

  return {
    scaleX: scale,
    scaleY: -scale,
    translateX: offsetX - bounds.minX * scale,
    translateY: offsetY + bounds.maxY * scale
  };
}

function nearlyEqualRelative(actual: number, expected: number) {
  return Math.abs(actual - expected)
    <= CAD_SCENE_TRANSFORM_TOLERANCE * Math.max(1, Math.abs(expected));
}

export type CadPoint = z.infer<typeof cadPointSchema>;
export type CadBounds = z.infer<typeof cadBoundsSchema>;
export type CadPrimitiveBounds = z.infer<typeof cadPrimitiveBoundsSchema>;
export type CadScenePrimitive = z.infer<typeof cadScenePrimitiveSchema>;
export type CadSceneTransform = z.infer<typeof cadSceneTransformSchema>;
export type CadSceneTile = z.infer<typeof cadSceneTileSchema>;
export type CadSceneManifest = z.infer<typeof cadSceneManifestSchema>;
export type CadRegion = z.infer<typeof cadRegionSchema>;
export type CadElementTransform = z.infer<typeof cadElementTransformSchema>;
export type CadElementOverride = z.infer<typeof cadElementOverrideSchema>;
export type CadElementOverridePatch = z.infer<typeof cadElementOverridePatchSchema>;
export type CadLayerState = z.infer<typeof cadLayerStateSchema>;
export type CadSceneElementLocator = z.infer<typeof cadSceneElementLocatorSchema>;
export type CadSceneEditInput = z.infer<typeof cadSceneEditInputSchema>;
export type CadSceneDescriptor = z.infer<typeof cadSceneDescriptorSchema>;
export type CadSceneState = z.infer<typeof cadSceneStateSchema>;
