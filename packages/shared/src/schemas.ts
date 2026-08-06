import { z } from "zod";

export const POSTGRES_INT_MIN = -2_147_483_648;
export const POSTGRES_INT_MAX = 2_147_483_647;
export const EDITOR_MAX_EXPECTED_REVISION = POSTGRES_INT_MAX - 1;
export const EDITOR_MAX_FIXTURE_UPDATES = 1_000;
export const EDITOR_MAX_MAP_OBJECT_MUTATIONS = 2_000;
export const EDITOR_MAX_POINTS = 128;
export const EDITOR_MAX_ID_LENGTH = 128;
export const EDITOR_MAX_NAME_LENGTH = 200;
export const EDITOR_MAX_TEXT_LENGTH = 10_000;
export const EDITOR_MAX_URL_LENGTH = 2_048;
export const EDITOR_MAX_COLOR_LENGTH = 64;
export const EDITOR_MAX_RATED_WATT = 999_999.99;
export const EDITOR_REVISION_DEFAULT_LIMIT = 20;
export const EDITOR_REVISION_MAX_LIMIT = 100;

const finiteNumberSchema = z.number().finite();
const nullableFiniteNumberSchema = finiteNumberSchema.nullable();
const int4Schema = z.number().int().min(POSTGRES_INT_MIN).max(POSTGRES_INT_MAX);
const nonnegativeInt4Schema = int4Schema.nonnegative();
const expectedRevisionSchema = nonnegativeInt4Schema.max(EDITOR_MAX_EXPECTED_REVISION);
const positiveInt4Schema = int4Schema.positive();
const editorIdSchema = z.string().trim().min(1).max(EDITOR_MAX_ID_LENGTH);
const editorUrlSchema = z.string().trim().min(1).max(EDITOR_MAX_URL_LENGTH);
const editorColorSchema = z.string().trim().min(1).max(EDITOR_MAX_COLOR_LENGTH);
const editorPointSchema = z.object({ x: finiteNumberSchema, y: finiteNumberSchema }).strict();
const editorPointsSchema = z.array(editorPointSchema).min(2).max(EDITOR_MAX_POINTS);
const trianglePointsSchema = z.array(editorPointSchema).length(3);
const ratedWattSchema = z.union([
  z.number().finite().nonnegative(),
  z.string().trim().min(1).max(32).regex(/^\d+(?:\.\d+)?$/)
]).transform((value) => Number(value)).refine((value) => value <= EDITOR_MAX_RATED_WATT);

const floorPlanFields = {
  imageUrl: editorUrlSchema,
  originalFileUrl: editorUrlSchema,
  renderedImageUrl: editorUrlSchema,
  width: positiveInt4Schema,
  height: positiveInt4Schema
};

export const floorPlanUpdateSchema = z.discriminatedUnion("sourceType", [
  z.object({ sourceType: z.literal("image"), ...floorPlanFields }).strict(),
  z.object({ sourceType: z.literal("pdf"), ...floorPlanFields }).strict()
]);

export const fixtureLayoutUpdateSchema = z.object({
  id: editorIdSchema,
  name: z.string().trim().min(1).max(EDITOR_MAX_NAME_LENGTH).optional(),
  ratedWatt: ratedWattSchema.optional(),
  x: finiteNumberSchema.optional(),
  y: finiteNumberSchema.optional(),
  size: finiteNumberSchema.positive().optional()
}).strict().refine((value) => Object.keys(value).some((key) => key !== "id"), "fixture update must not be empty");

const floorMapObjectFields = {
  type: z.enum(["rectangle", "triangle", "line", "text"]),
  x: finiteNumberSchema,
  y: finiteNumberSchema,
  width: nullableFiniteNumberSchema,
  height: nullableFiniteNumberSchema,
  rotation: finiteNumberSchema,
  points: editorPointsSchema.nullable(),
  text: z.string().trim().max(EDITOR_MAX_TEXT_LENGTH).nullable(),
  strokeColor: editorColorSchema,
  fillColor: z.string().trim().min(1).max(EDITOR_MAX_COLOR_LENGTH).nullable(),
  strokeWidth: finiteNumberSchema.nonnegative(),
  fontSize: finiteNumberSchema.positive().nullable(),
  zIndex: int4Schema,
  locked: z.boolean(),
  visible: z.boolean()
};

const floorMapObjectDraftCommon = {
  x: floorMapObjectFields.x,
  y: floorMapObjectFields.y,
  rotation: floorMapObjectFields.rotation,
  text: floorMapObjectFields.text.optional(),
  strokeColor: floorMapObjectFields.strokeColor,
  fillColor: floorMapObjectFields.fillColor.optional(),
  strokeWidth: floorMapObjectFields.strokeWidth,
  fontSize: floorMapObjectFields.fontSize.optional(),
  zIndex: floorMapObjectFields.zIndex.optional(),
  locked: floorMapObjectFields.locked,
  visible: floorMapObjectFields.visible
};

export const floorMapObjectDraftSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("rectangle"), ...floorMapObjectDraftCommon,
    width: finiteNumberSchema.positive(), height: finiteNumberSchema.positive(), points: z.null().optional()
  }).strict(),
  z.object({
    type: z.literal("triangle"), ...floorMapObjectDraftCommon,
    width: finiteNumberSchema.positive(), height: finiteNumberSchema.positive(), points: trianglePointsSchema
  }).strict(),
  z.object({
    type: z.literal("line"), ...floorMapObjectDraftCommon,
    width: finiteNumberSchema.positive(), height: z.literal(0), points: z.null().optional()
  }).strict(),
  z.object({
    type: z.literal("text"), ...floorMapObjectDraftCommon,
    width: finiteNumberSchema.positive(), height: finiteNumberSchema.positive(), points: z.null().optional()
  }).strict()
]);

const floorMapObjectSnapshotCommon = {
  id: editorIdSchema,
  x: floorMapObjectFields.x,
  y: floorMapObjectFields.y,
  rotation: floorMapObjectFields.rotation,
  text: floorMapObjectFields.text,
  strokeColor: floorMapObjectFields.strokeColor,
  fillColor: floorMapObjectFields.fillColor,
  strokeWidth: floorMapObjectFields.strokeWidth,
  fontSize: floorMapObjectFields.fontSize,
  zIndex: floorMapObjectFields.zIndex,
  locked: floorMapObjectFields.locked,
  visible: floorMapObjectFields.visible
};

const floorMapObjectSnapshotSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("rectangle"), ...floorMapObjectSnapshotCommon,
    width: finiteNumberSchema.positive(), height: finiteNumberSchema.positive(), points: z.null()
  }).strict(),
  z.object({
    type: z.literal("triangle"), ...floorMapObjectSnapshotCommon,
    width: finiteNumberSchema.positive(), height: finiteNumberSchema.positive(), points: trianglePointsSchema
  }).strict(),
  z.object({
    type: z.literal("line"), ...floorMapObjectSnapshotCommon,
    width: finiteNumberSchema.positive(), height: z.literal(0), points: z.null()
  }).strict(),
  z.object({
    type: z.literal("text"), ...floorMapObjectSnapshotCommon,
    width: finiteNumberSchema.positive(), height: finiteNumberSchema.positive(), points: z.null()
  }).strict()
]);

export const floorMapObjectPatchSchema = z.object({
  type: floorMapObjectFields.type.optional(),
  x: floorMapObjectFields.x.optional(),
  y: floorMapObjectFields.y.optional(),
  width: floorMapObjectFields.width.optional(),
  height: floorMapObjectFields.height.optional(),
  rotation: floorMapObjectFields.rotation.optional(),
  points: editorPointsSchema.nullable().optional(),
  text: floorMapObjectFields.text.optional(),
  strokeColor: floorMapObjectFields.strokeColor.optional(),
  fillColor: floorMapObjectFields.fillColor.optional(),
  strokeWidth: floorMapObjectFields.strokeWidth.optional(),
  fontSize: floorMapObjectFields.fontSize.optional(),
  zIndex: floorMapObjectFields.zIndex.optional(),
  locked: floorMapObjectFields.locked.optional(),
  visible: floorMapObjectFields.visible.optional()
}).strict()
  .refine((value) => Object.keys(value).length > 0, "object patch must not be empty")
  .superRefine((value, context) => {
    if (value.type === "triangle" && value.points !== undefined && value.points?.length !== 3) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["points"], message: "triangle requires exactly 3 points" });
    }
    if (value.type && value.type !== "triangle" && Array.isArray(value.points)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["points"], message: `${value.type} does not accept points` });
    }
  });

export const saveEditorStateSchema = z.object({
  expectedRevision: expectedRevisionSchema,
  floorPlan: floorPlanUpdateSchema.nullable().optional(),
  fixtureUpdates: z.array(fixtureLayoutUpdateSchema).max(EDITOR_MAX_FIXTURE_UPDATES),
  objectCreates: z.array(floorMapObjectDraftSchema),
  objectUpdates: z.array(z.object({ id: editorIdSchema, patch: floorMapObjectPatchSchema }).strict()),
  objectDeletes: z.array(editorIdSchema)
}).strict().superRefine((value, context) => {
  const total = value.objectCreates.length + value.objectUpdates.length + value.objectDeletes.length;
  if (total > EDITOR_MAX_MAP_OBJECT_MUTATIONS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["objectCreates"],
      message: `map object mutations must not exceed ${EDITOR_MAX_MAP_OBJECT_MUTATIONS}`
    });
  }
});

export const restoreFloorEditorRevisionSchema = z.object({
  expectedRevision: expectedRevisionSchema
}).strict();

export const editorRevisionListQuerySchema = z.object({
  cursor: z.coerce.number().int().nonnegative().max(POSTGRES_INT_MAX).optional(),
  limit: z.coerce.number().int().positive().max(EDITOR_REVISION_MAX_LIMIT).default(EDITOR_REVISION_DEFAULT_LIMIT)
}).strict();

export const floorEditorSnapshotSchema = z.object({
  floorPlan: floorPlanUpdateSchema.nullable(),
  fixtures: z.array(z.object({
    id: editorIdSchema,
    name: z.string().trim().min(1).max(EDITOR_MAX_NAME_LENGTH),
    ratedWatt: z.string().min(1).max(32),
    x: finiteNumberSchema,
    y: finiteNumberSchema,
    size: finiteNumberSchema.positive()
  }).strict()),
  objects: z.array(floorMapObjectSnapshotSchema)
}).strict();

export type SaveEditorStateInput = z.infer<typeof saveEditorStateSchema>;
export type RestoreFloorEditorRevisionInput = z.infer<typeof restoreFloorEditorRevisionSchema>;
export type FloorEditorSnapshot = z.infer<typeof floorEditorSnapshotSchema>;
export type EditorRevisionListQuery = z.infer<typeof editorRevisionListQuerySchema>;

export const provisioningScanStartSchema = z.object({
  sessionId: z.string().uuid(),
  siteId: z.string().uuid(),
  gatewayId: z.string().uuid(),
  floorId: z.string().uuid(),
  requestedBy: z.string().uuid(),
  requestedAt: z.string().datetime()
});

export const identifyDeviceSchema = z.object({
  sessionId: z.string().uuid(),
  siteId: z.string().uuid(),
  gatewayId: z.string().uuid(),
  nodeId: z.string().uuid(),
  deviceUuid: z.string().min(1),
  requestedAt: z.string().datetime()
});

export const provisionDeviceSchema = z.object({
  sessionId: z.string().uuid(),
  siteId: z.string().uuid(),
  gatewayId: z.string().uuid(),
  nodeId: z.string().uuid(),
  deviceUuid: z.string().min(1),
  meshAddress: z.string().min(1),
  requestedAt: z.string().datetime()
});

export const unprovisionedDeviceFoundSchema = z.object({
  sessionId: z.string().uuid(),
  deviceUuid: z.string().min(1),
  serialNumber: z.string().min(1),
  rssi: z.number().max(0),
  oobCapability: z.enum(["none", "static-oob", "output-oob", "input-oob"]),
  firmwareVersion: z.string().min(1),
  discoveredAt: z.string().datetime()
});

export const provisioningCompletedSchema = z.object({
  sessionId: z.string().uuid(),
  nodeId: z.string().uuid(),
  deviceUuid: z.string().min(1),
  meshAddress: z.string().min(1),
  firmwareVersion: z.string().min(1).optional(),
  rssi: z.number().max(0).nullable().optional(),
  hopCount: z.number().int().nonnegative().nullable().optional(),
  completedAt: z.string().datetime()
});

export const provisioningFailedSchema = z.object({
  sessionId: z.string().uuid(),
  nodeId: z.string().uuid(),
  deviceUuid: z.string().min(1),
  errorMessage: z.string().min(1),
  failedAt: z.string().datetime()
});
