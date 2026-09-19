import { z } from "zod";
import { cadSceneDescriptorSchema } from "./cad-scene-contracts.js";
import { POSTGRES_INT_MAX, POSTGRES_INT_MIN } from "./postgres-contracts.js";

export { POSTGRES_INT_MAX, POSTGRES_INT_MIN } from "./postgres-contracts.js";
export {
  mapPointSchema, mapBoundsSchema, mapTransformSchema, mapStyleSchema, mapElementSchema,
  mapElementOpSchema, mapGroupSchema, mapLayerSchema, mapStructureOpSchema, mapOpSchema,
  mapOperationsSchema, mapAssetRefSchema, mapDocumentRefSchema, mapMutationSchema,
  mapMutationResultSchema, mapDocumentStateSchema
} from "./map-document-contracts.js";
export const EDITOR_MAX_EXPECTED_REVISION = POSTGRES_INT_MAX - 1;
export const EDITOR_MAX_FIXTURE_UPDATES = 1_000;
export const EDITOR_MAX_MAP_OBJECT_MUTATIONS = 2_000;
export const EDITOR_MAX_SLOT_ASSIGNMENT_MUTATIONS = 2_000;
export const EDITOR_MAX_BODY_BYTES = 1_048_576;
export const EDITOR_MAX_POINTS = 128;
export const EDITOR_MAX_ID_LENGTH = 128;
export const EDITOR_MAX_NAME_LENGTH = 200;
export const EDITOR_MAX_TEXT_LENGTH = 10_000;
export const EDITOR_MAX_URL_LENGTH = 2_048;
export const EDITOR_MAX_COLOR_LENGTH = 64;
export const EDITOR_MAX_OBJECT_TYPE_LENGTH = 64;
export const EDITOR_MAX_RATED_WATT = 999_999.99;
export const EDITOR_REVISION_DEFAULT_LIMIT = 20;
export const EDITOR_REVISION_MAX_LIMIT = 100;
export const EDITOR_DEFAULT_GRID_SIZE = 10;
export const EDITOR_MIN_GRID_SIZE = 5;
export const EDITOR_MAX_GRID_SIZE = 200;

const finiteNumberSchema = z.number().finite();
const nullableFiniteNumberSchema = finiteNumberSchema.nullable();
const int4Schema = z.number().int().min(POSTGRES_INT_MIN).max(POSTGRES_INT_MAX);
const nonnegativeInt4Schema = int4Schema.nonnegative();
export const nonnegativePostgresIntSchema = nonnegativeInt4Schema;
const expectedRevisionSchema = nonnegativeInt4Schema.max(EDITOR_MAX_EXPECTED_REVISION);
const positiveInt4Schema = int4Schema.positive();
const editorGridSizeSchema = int4Schema
  .min(EDITOR_MIN_GRID_SIZE)
  .max(EDITOR_MAX_GRID_SIZE)
  .default(EDITOR_DEFAULT_GRID_SIZE);
export const positivePostgresIntSchema = z.union([
  z.number(),
  z.string().regex(/^\d+$/)
]).transform((value) => Number(value)).pipe(positiveInt4Schema);
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
  height: positiveInt4Schema,
  gridSize: editorGridSizeSchema
};

const pdfFloorPlanFields = {
  imageUrl: z.union([editorUrlSchema, z.literal("")]),
  originalFileUrl: editorUrlSchema,
  renderedImageUrl: editorUrlSchema.nullable(),
  width: positiveInt4Schema,
  height: positiveInt4Schema,
  gridSize: editorGridSizeSchema
};

export const floorPlanUpdateSchema = z.discriminatedUnion("sourceType", [
  z.object({
    sourceType: z.literal("none"),
    imageUrl: z.literal(""),
    originalFileUrl: z.null(),
    renderedImageUrl: z.null(),
    width: positiveInt4Schema,
    height: positiveInt4Schema,
    gridSize: editorGridSizeSchema
  }).strict(),
  z.object({ sourceType: z.literal("image"), ...floorPlanFields }).strict(),
  z.object({ sourceType: z.literal("pdf"), ...pdfFloorPlanFields }).strict()
]);

export const legacyFloorPlanEffectiveSchema = z.discriminatedUnion("sourceType", [
  z.object({
    sourceType: z.literal("none"),
    imageUrl: z.literal(""),
    originalFileUrl: z.union([z.literal(""), z.null()]),
    renderedImageUrl: z.union([z.literal(""), z.null()]),
    width: positiveInt4Schema,
    height: positiveInt4Schema,
    gridSize: editorGridSizeSchema
  }).strict(),
  z.object({ sourceType: z.literal("image"), ...floorPlanFields }).strict(),
  z.object({ sourceType: z.literal("pdf"), ...pdfFloorPlanFields }).strict()
]);

export const legacyFloorPlanPatchSchema = z.object({
  imageUrl: z.string().trim().max(EDITOR_MAX_URL_LENGTH).optional(),
  sourceType: z.enum(["none", "image", "pdf"]).optional(),
  originalFileUrl: z.string().trim().max(EDITOR_MAX_URL_LENGTH).nullable().optional(),
  renderedImageUrl: z.string().trim().max(EDITOR_MAX_URL_LENGTH).nullable().optional(),
  width: positiveInt4Schema.optional(),
  height: positiveInt4Schema.optional(),
  gridSize: editorGridSizeSchema.optional()
}).refine((value) => Object.keys(value).length > 0, "floor plan patch must not be empty");

export const fixturePlacementStatusSchema = z.enum(["unplaced", "placed"]);
export type FixturePlacementStatus = z.infer<typeof fixturePlacementStatusSchema>;

export const floorLightSlotSchema = z.object({
  id: z.string().uuid(),
  x: finiteNumberSchema,
  y: finiteNumberSchema,
  rotation: finiteNumberSchema,
  assignedFixtureId: z.string().uuid().nullable()
}).strict();
export type FloorLightSlotDto = z.infer<typeof floorLightSlotSchema>;

export const fixtureLayoutUpdateSchema = z.object({
  id: editorIdSchema,
  name: z.string().trim().min(1).max(EDITOR_MAX_NAME_LENGTH).optional(),
  ratedWatt: ratedWattSchema.optional(),
  x: finiteNumberSchema.optional(),
  y: finiteNumberSchema.optional(),
  size: finiteNumberSchema.positive().optional(),
  placementStatus: fixturePlacementStatusSchema.optional(),
  positionVerified: z.boolean().optional()
}).strict().refine((value) => Object.keys(value).some((key) => key !== "id"), "fixture update must not be empty")
  .refine((value) => value.placementStatus !== "unplaced" || value.positionVerified !== true,
    "unplaced fixtures cannot have a verified position");

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

export const floorMapObjectGeometrySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("rectangle"), width: finiteNumberSchema.positive(),
    height: finiteNumberSchema.positive(), points: z.null()
  }).strict(),
  z.object({
    type: z.literal("triangle"), width: finiteNumberSchema.positive(),
    height: finiteNumberSchema.positive(), points: trianglePointsSchema
  }).strict(),
  z.object({
    type: z.literal("line"), width: finiteNumberSchema.positive(), height: z.literal(0), points: z.null()
  }).strict(),
  z.object({
    type: z.literal("text"), width: finiteNumberSchema.positive(),
    height: finiteNumberSchema.positive(), points: z.null()
  }).strict()
]);

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

export const floorMapObjectStateSchema = z.discriminatedUnion("type", [
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

const floorMapReadPlanFields = {
  imageUrl: editorUrlSchema,
  originalFileUrl: editorUrlSchema.nullable(),
  renderedImageUrl: editorUrlSchema.nullable(),
  width: positiveInt4Schema,
  height: positiveInt4Schema,
  gridSize: editorGridSizeSchema
};

// The read model keeps nullable legacy asset variants, while atomic editor
// writes continue to require a complete source-specific floor plan payload.
export const floorMapPlanSnapshotSchema = z.object({
  sourceType: z.enum(["none", "image", "pdf", "cad"]),
  ...floorMapReadPlanFields,
  imageUrl: z.union([editorUrlSchema, z.literal("")])
}).strict().superRefine((plan, context) => {
  if (plan.sourceType === "none" && (
    plan.imageUrl !== "" || plan.originalFileUrl !== null || plan.renderedImageUrl !== null
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "empty floor plans cannot reference assets"
    });
  }
  if (plan.sourceType === "image" && plan.imageUrl === "") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["imageUrl"],
      message: "image floor plans require an image URL"
    });
  }
  if (plan.sourceType === "cad" && plan.imageUrl !== "") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["imageUrl"],
      message: "CAD floor plans are rendered from their scene descriptor"
    });
  }
});

export const floorMapSnapshotSchema = z.object({
  floorId: z.string().uuid(),
  revision: nonnegativeInt4Schema,
  width: positiveInt4Schema,
  height: positiveInt4Schema,
  floorPlan: floorMapPlanSnapshotSchema.nullable(),
  cadScene: cadSceneDescriptorSchema.nullable().optional(),
  objects: z.array(floorMapObjectStateSchema),
  fixtures: z.array(z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(EDITOR_MAX_NAME_LENGTH),
    x: finiteNumberSchema,
    y: finiteNumberSchema,
    size: finiteNumberSchema.positive()
  }).strict()).optional()
}).strict().superRefine((snapshot, context) => {
  const isCadPlan = snapshot.floorPlan?.sourceType === "cad";
  if (isCadPlan && !snapshot.cadScene) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cadScene"],
      message: "CAD floor map snapshots require a scene descriptor"
    });
  }
  if (!isCadPlan && snapshot.cadScene) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cadScene"],
      message: "a scene descriptor is only valid for CAD floor plans"
    });
  }
  if (isCadPlan && snapshot.cadScene && (
    snapshot.cadScene.width !== snapshot.width || snapshot.cadScene.height !== snapshot.height ||
    snapshot.floorPlan!.width !== snapshot.width || snapshot.floorPlan!.height !== snapshot.height
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cadScene"],
      message: "CAD scene dimensions must match the floor map"
    });
  }
});

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
  leaseToken: z.string().trim().min(1).max(256),
  leaseFence: positiveInt4Schema,
  floorPlan: floorPlanUpdateSchema.nullable().optional(),
  fixtureUpdates: z.array(fixtureLayoutUpdateSchema).max(EDITOR_MAX_FIXTURE_UPDATES),
  slotAssignments: z.array(z.object({
    slotId: z.string().uuid(),
    assignedFixtureId: z.string().uuid().nullable()
  }).strict()).max(EDITOR_MAX_SLOT_ASSIGNMENT_MUTATIONS).default([]),
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
  const slotIds = new Set<string>();
  const assignedFixtureIds = new Set<string>();
  value.slotAssignments.forEach((assignment, index) => {
    if (slotIds.has(assignment.slotId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slotAssignments", index, "slotId"],
        message: "slot assignment IDs must be unique"
      });
    }
    slotIds.add(assignment.slotId);
    if (assignment.assignedFixtureId === null) return;
    if (assignedFixtureIds.has(assignment.assignedFixtureId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slotAssignments", index, "assignedFixtureId"],
        message: "assigned fixture IDs must be unique"
      });
    }
    assignedFixtureIds.add(assignment.assignedFixtureId);
  });
});

export const restoreFloorEditorRevisionSchema = z.object({
  expectedRevision: expectedRevisionSchema,
  leaseToken: z.string().trim().min(1).max(256),
  leaseFence: positiveInt4Schema
}).strict();

export const editorRevisionListQuerySchema = z.object({
  cursor: z.coerce.number().int().nonnegative().max(POSTGRES_INT_MAX).optional(),
  limit: z.coerce.number().int().positive().max(EDITOR_REVISION_MAX_LIMIT).default(EDITOR_REVISION_DEFAULT_LIMIT)
}).strict();

const legacySnapshotUrlSchema = z.string().trim().max(EDITOR_MAX_URL_LENGTH);
const legacySnapshotPointsSchema = z.array(editorPointSchema).max(EDITOR_MAX_POINTS).nullable();

export const FLOOR_EDITOR_SNAPSHOT_VERSION = 2;

const floorCadSceneSnapshotSchema = z.object({
  id: z.string().uuid(),
  width: positiveInt4Schema,
  height: positiveInt4Schema
}).strict();

export const floorEditorSnapshotV1Schema = z.object({
  floorPlan: z.object({
    imageUrl: legacySnapshotUrlSchema,
    sourceType: z.enum(["none", "image", "pdf"]),
    originalFileUrl: legacySnapshotUrlSchema.nullable(),
    renderedImageUrl: legacySnapshotUrlSchema.nullable(),
    width: positiveInt4Schema,
    height: positiveInt4Schema,
    gridSize: editorGridSizeSchema
  }).strict().nullable(),
  fixtures: z.array(z.object({
    id: editorIdSchema,
    name: z.string().trim().min(1).max(EDITOR_MAX_NAME_LENGTH),
    ratedWatt: z.string().min(1).max(32),
    x: finiteNumberSchema,
    y: finiteNumberSchema,
    size: finiteNumberSchema
  }).strict()),
  objects: z.array(z.object({
    id: editorIdSchema,
    type: z.string().trim().min(1).max(EDITOR_MAX_OBJECT_TYPE_LENGTH),
    x: finiteNumberSchema,
    y: finiteNumberSchema,
    width: nullableFiniteNumberSchema,
    height: nullableFiniteNumberSchema,
    rotation: finiteNumberSchema,
    points: legacySnapshotPointsSchema,
    text: z.string().trim().max(EDITOR_MAX_TEXT_LENGTH).nullable(),
    strokeColor: editorColorSchema,
    fillColor: z.string().trim().max(EDITOR_MAX_COLOR_LENGTH).nullable(),
    strokeWidth: finiteNumberSchema,
    fontSize: nullableFiniteNumberSchema,
    zIndex: int4Schema,
    locked: z.boolean(),
    visible: z.boolean()
  }).strict())
}).strict();

const floorEditorSnapshotV2FloorPlanSchema = floorEditorSnapshotV1Schema.shape.floorPlan
  .unwrap()
  .extend({ sourceType: z.enum(["none", "image", "pdf", "cad"]) })
  .nullable();

export const floorEditorSnapshotV2Schema = floorEditorSnapshotV1Schema.extend({
  version: z.literal(FLOOR_EDITOR_SNAPSHOT_VERSION),
  floorPlan: floorEditorSnapshotV2FloorPlanSchema,
  cadScene: floorCadSceneSnapshotSchema.optional(),
  // Existing V2 revisions predate CAD slots; new snapshots include this array.
  lightSlots: z.array(floorLightSlotSchema.extend({
    // Older V2 snapshots only stored public slot geometry. New revisions retain
    // the immutable CAD source references needed to recreate a historical set.
    sourceImportJobId: z.string().uuid().optional(),
    sourceCandidateId: z.string().uuid().optional()
  }).refine(
    (slot) => Boolean(slot.sourceImportJobId) === Boolean(slot.sourceCandidateId),
    "light slot source references must be both present or both absent"
  )).max(2_000).optional(),
  fixtures: z.array(floorEditorSnapshotV1Schema.shape.fixtures.element.extend({
    placementStatus: fixturePlacementStatusSchema,
    positionVerifiedAt: z.string().datetime().nullable()
  }).refine((fixture) => fixture.placementStatus !== "unplaced" || fixture.positionVerifiedAt === null,
    "unplaced fixtures cannot have a verified position"))
}).superRefine((snapshot, context) => {
  const floorPlan = snapshot.floorPlan;
  const isCadPlan = floorPlan?.sourceType === "cad";
  if (isCadPlan && !snapshot.cadScene) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["cadScene"],
      message: "CAD floor plan snapshots require a scene identity" });
  }
  if (!isCadPlan && snapshot.cadScene) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["cadScene"],
      message: "scene identity is only valid for CAD floor plans" });
  }
  if (isCadPlan && snapshot.cadScene && (
    snapshot.cadScene.width !== floorPlan!.width ||
    snapshot.cadScene.height !== floorPlan!.height
  )) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["cadScene"],
      message: "CAD scene dimensions must match the floor plan" });
  }
});

// Legacy revisions remain immutable; normalize their missing placement metadata only on read.
export const floorEditorSnapshotSchema = z.union([
  floorEditorSnapshotV2Schema,
  floorEditorSnapshotV1Schema.transform((snapshot) => ({
    ...snapshot,
    version: FLOOR_EDITOR_SNAPSHOT_VERSION as 2,
    fixtures: snapshot.fixtures.map((fixture) => ({
      ...fixture, placementStatus: "placed" as const, positionVerifiedAt: null
    }))
  }))
]);

export function parseFloorEditorSnapshot(value: unknown) {
  return floorEditorSnapshotSchema.parse(value);
}

export type SaveEditorStateInput = z.infer<typeof saveEditorStateSchema>;
export type RestoreFloorEditorRevisionInput = z.infer<typeof restoreFloorEditorRevisionSchema>;
export type FloorEditorSnapshot = z.infer<typeof floorEditorSnapshotSchema>;
export type FloorMapSnapshot = z.infer<typeof floorMapSnapshotSchema>;
export type EditorRevisionListQuery = z.infer<typeof editorRevisionListQuerySchema>;

export const createRegistrationSessionSchema = z.object({
  siteId: z.string().uuid(),
  floorId: z.string().uuid(),
  gatewayId: z.string().uuid()
}).strict();

export type CreateRegistrationSessionInput = z.infer<typeof createRegistrationSessionSchema>;

// Registration identify is deliberately parameter-free. The Gateway owns the
// BIO vendor packet, fixed force-on interval, and sensor-mode restoration; a
// browser must never be able to supply timing or raw transport instructions.
export const identifyRegistrationNodeInputSchema = z.object({}).strict();

const registrationRatedWattSchema = z.union([
  z.number().finite().nonnegative().transform(String),
  z.string().trim().min(1).max(32).regex(/^\d+(?:\.\d+)?$/)
]).refine((value) => Number(value) <= EDITOR_MAX_RATED_WATT, "ratedWatt is too large");
const registrationSizeSchema = z.number().finite().positive().max(1_000);
const registrationPlacementSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("auto") }).strict(),
  z.object({ mode: z.literal("manual"), x: finiteNumberSchema, y: finiteNumberSchema }).strict()
]);
const registrationNumberDefaults = {
  namePrefix: z.string().trim().min(1).max(100),
  startNumber: positiveInt4Schema,
  digits: z.number().int().min(1).max(9)
};
const registrationBatchNodeSchema = z.object({
  nodeId: z.string().uuid(),
  placement: registrationPlacementSchema.optional()
}).strict();
const registrationIndividualNodeSchema = z.object({
  nodeId: z.string().uuid(),
  fixtureName: z.string().trim().max(EDITOR_MAX_NAME_LENGTH),
  ratedWatt: registrationRatedWattSchema,
  size: registrationSizeSchema,
  placement: registrationPlacementSchema.optional()
}).strict();

export const registerFixtureBatchSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("batch"),
    defaults: z.object({
      ...registrationNumberDefaults,
      ratedWatt: registrationRatedWattSchema,
      size: registrationSizeSchema
    }).strict(),
    nodes: z.array(registrationBatchNodeSchema).min(1).max(1_000)
  }).strict(),
  z.object({
    mode: z.literal("individual"),
    defaults: z.object(registrationNumberDefaults).strict(),
    nodes: z.array(registrationIndividualNodeSchema).min(1).max(1_000)
  }).strict()
]).superRefine((input, context) => {
  const seen = new Set<string>();
  input.nodes.forEach((node, index) => {
    if (seen.has(node.nodeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "nodeId must be unique within a registration batch",
        path: ["nodes", index, "nodeId"]
      });
    }
    seen.add(node.nodeId);
  });
});

export type RegisterFixtureBatchInput = z.infer<typeof registerFixtureBatchSchema>;

export const provisioningScanStartSchema = z.object({
  sessionId: z.string().uuid(),
  scanCorrelationId: z.string().uuid(),
  scanAttempt: positiveInt4Schema,
  siteId: z.string().uuid(),
  gatewayId: z.string().uuid(),
  floorId: z.string().uuid(),
  requestedAt: z.string().datetime()
}).strict();
export type ProvisioningScanStartPayload = z.infer<typeof provisioningScanStartSchema>;

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

const provisioningUnicastAddressSchema = z.string().regex(/^0x[0-7][0-9a-f]{3}$/i).refine(
  (value) => Number.parseInt(value.slice(2), 16) > 0,
  "meshAddress must be a BLE Mesh unicast address"
);

const provisioningDeviceCommonIdentityFields = {
  commandId: z.string().uuid(),
  sessionId: z.string().uuid(),
  siteId: z.string().uuid(),
  gatewayId: z.string().uuid(),
  nodeId: z.string().uuid(),
  deviceUuid: z.string().trim().min(1)
};

const provisioningCommandTime = { requestedAt: z.string().datetime() };
const provisioningDeviceProvisionIdentityFields = {
  ...provisioningDeviceCommonIdentityFields,
  operation: z.literal("provision").optional(),
  meshAddress: provisioningUnicastAddressSchema
};
const provisioningDeviceIdentifyIdentityFields = {
  ...provisioningDeviceCommonIdentityFields,
  operation: z.literal("identify")
};

// `operation` remains optional only for the already-deployed provision v2 wire.
// Every identify command is explicit and has no address or caller-controlled
// duration/packet fields, so it cannot enter the address allocator path.
export const provisioningDeviceCommandV2Schema = z.union([
  z.object({ ...provisioningDeviceIdentifyIdentityFields, ...provisioningCommandTime }).strict(),
  z.object({ ...provisioningDeviceProvisionIdentityFields, ...provisioningCommandTime }).strict()
]);

const provisioningDeviceTerminalCommonEnvelope = {
  ...provisioningDeviceCommonIdentityFields,
  eventId: z.string().uuid(),
  sequence: nonnegativeInt4Schema,
  occurredAt: z.string().datetime()
};

const provisioningTerminalFailure = {
  status: z.literal("failed"),
  errorCode: z.string().trim().min(1),
  errorMessage: z.string().trim().min(1)
};

export const provisioningDeviceTerminalV2Schema = z.union([
  z.object({
    ...provisioningDeviceTerminalCommonEnvelope,
    operation: z.literal("identify"),
    status: z.literal("completed"),
    // A BIO identify is successful only after the fixed force-on interval and
    // the subsequent sensor-mode read-back. `false` must use a failed terminal.
    restoreConfirmed: z.literal(true)
  }).strict(),
  z.object({
    ...provisioningDeviceTerminalCommonEnvelope,
    operation: z.literal("identify"),
    ...provisioningTerminalFailure
  }).strict(),
  z.object({
    ...provisioningDeviceTerminalCommonEnvelope,
    operation: z.literal("provision").optional(),
    meshAddress: provisioningUnicastAddressSchema,
    status: z.literal("completed"),
    firmwareVersion: z.string().trim().min(1).optional(),
    rssi: z.number().max(0).nullable().optional(),
    hopCount: z.number().int().nonnegative().nullable().optional()
  }).strict(),
  z.object({
    ...provisioningDeviceTerminalCommonEnvelope,
    operation: z.literal("provision").optional(),
    meshAddress: provisioningUnicastAddressSchema,
    ...provisioningTerminalFailure
  }).strict()
]);

const provisioningDeviceAckEnvelope = {
  ...provisioningDeviceCommonIdentityFields,
  eventId: z.string().uuid(),
  sequence: nonnegativeInt4Schema,
  ingestedAt: z.string().datetime()
};
export const applicationProvisioningDeviceTerminalIngestedAckV2Schema = z.union([
  z.object({ ...provisioningDeviceAckEnvelope, operation: z.literal("identify") }).strict(),
  z.object({ ...provisioningDeviceAckEnvelope, operation: z.literal("provision").optional(), meshAddress: provisioningUnicastAddressSchema }).strict()
]);

export type ProvisioningDeviceCommandV2 = z.infer<typeof provisioningDeviceCommandV2Schema>;
export type ProvisioningDeviceTerminalV2 = z.infer<typeof provisioningDeviceTerminalV2Schema>;
export type ApplicationProvisioningDeviceTerminalIngestedAckV2 = z.infer<
  typeof applicationProvisioningDeviceTerminalIngestedAckV2Schema
>;

const provisioningScanFoundDeviceSchema = z.object({
  deviceUuid: z.string().min(1),
  serialNumber: z.string().min(1),
  rssi: z.number().max(0),
  oobCapability: z.enum(["none", "static-oob", "output-oob", "input-oob"]),
  firmwareVersion: z.string().min(1)
}).strict();

export const provisioningScanFoundSchema = z.object({
  sessionId: z.string().uuid(),
  scanCorrelationId: z.string().uuid(),
  scanAttempt: positiveInt4Schema,
  siteId: z.string().uuid(),
  gatewayId: z.string().uuid(),
  eventId: z.string().uuid(),
  sequence: nonnegativeInt4Schema,
  occurredAt: z.string().datetime(),
  ...provisioningScanFoundDeviceSchema.shape
}).strict();
export type ProvisioningScanFoundPayload = z.infer<typeof provisioningScanFoundSchema>;
export type ProvisioningScanFoundDevice = z.infer<typeof provisioningScanFoundDeviceSchema>;

const provisioningScanTerminalFields = {
  siteId: z.string().uuid(),
  gatewayId: z.string().uuid(),
  eventId: z.string().uuid(),
  sequence: nonnegativeInt4Schema,
  occurredAt: z.string().datetime(),
  sessionId: z.string().uuid(),
  scanCorrelationId: z.string().uuid(),
  scanAttempt: positiveInt4Schema
};

export const provisioningScanCompletedSchema = z.object({
  ...provisioningScanTerminalFields,
  acceptedNodeCount: nonnegativeInt4Schema
}).strict();

export const provisioningScanFailedSchema = z.object({
  ...provisioningScanTerminalFields,
  code: z.enum([
    "bluetooth_unavailable",
    "mesh_unavailable",
    "scan_start_failed",
    "scan_runtime_failed",
    "scan_timeout"
  ]),
  message: z.string().trim().min(1)
}).strict();

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

const meshAddressSchema = z.string().regex(/^0x[0-9a-f]{4}$/i);

export const meshGroupDesiredMemberSchema = z.object({
  meshNodeId: z.string().uuid(),
  meshAddress: meshAddressSchema
}).strict();

function assertUniqueMeshNodeIds(
  members: Array<{ meshNodeId: string }>,
  context: z.RefinementCtx,
  fieldName: string
) {
  const seen = new Set<string>();
  members.forEach((member, index) => {
    if (seen.has(member.meshNodeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [fieldName, index, "meshNodeId"],
        message: `${fieldName} must be unique by meshNodeId`
      });
    }
    seen.add(member.meshNodeId);
  });
}

function assertUniqueOperations(
  operations: Array<{ operationId: string; action: "add" | "delete"; meshNodeId: string; meshAddress: string }>,
  context: z.RefinementCtx,
  fieldName: string
) {
  const seen = new Set<string>();
  const seenTuples = new Set<string>();
  operations.forEach((operation, index) => {
    if (seen.has(operation.operationId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [fieldName, index, "operationId"],
        message: "operationId must be unique"
      });
    }
    seen.add(operation.operationId);

    const tuple = `${operation.action}:${operation.meshNodeId}:${operation.meshAddress.toLowerCase()}`;
    if (seenTuples.has(tuple)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [fieldName, index],
        message: `${fieldName} must be unique by action, meshNodeId, and meshAddress`
      });
    }
    seenTuples.add(tuple);
  });
}

export const meshGroupSubscriptionOperationSchema = z.object({
  operationId: z.string().uuid(),
  action: z.enum(["add", "delete"]),
  meshNodeId: z.string().uuid(),
  meshAddress: meshAddressSchema
}).strict();

export const meshGroupSubscriptionSyncSchema = z.object({
  siteId: z.string().uuid(),
  gatewayId: z.string().uuid(),
  groupId: z.string().uuid(),
  version: positiveInt4Schema,
  groupAddress: meshAddressSchema,
  reconciliationMode: z.enum(["incremental", "full_state"]).optional(),
  desiredMembers: z.array(meshGroupDesiredMemberSchema).max(100),
  expectedOperations: z.array(meshGroupSubscriptionOperationSchema).max(200),
  requestedAt: z.string().datetime()
}).strict().superRefine((input, context) => {
  assertUniqueMeshNodeIds(input.desiredMembers, context, "desiredMembers");
  assertUniqueOperations(input.expectedOperations, context, "expectedOperations");
});

export const meshGroupSubscriptionResultOperationSchema = meshGroupSubscriptionOperationSchema.extend({
  status: z.enum(["ready", "failed"]),
  error: z.string().min(1).optional()
}).strict();

export const meshGroupSubscriptionResultSchema = z.object({
  siteId: z.string().uuid(),
  gatewayId: z.string().uuid(),
  groupId: z.string().uuid(),
  version: positiveInt4Schema,
  groupAddress: meshAddressSchema,
  // A full desired set has at most 100 members, but every address replacement emits delete and add.
  operations: z.array(meshGroupSubscriptionResultOperationSchema).max(200),
  occurredAt: z.string().datetime()
}).strict().superRefine((input, context) => {
  assertUniqueOperations(input.operations, context, "operations");
});

export type MeshGroupSubscriptionSyncPayload = z.infer<typeof meshGroupSubscriptionSyncSchema>;
export type MeshGroupSubscriptionResultPayload = z.infer<typeof meshGroupSubscriptionResultSchema>;

export const fixtureGroupLifecycleStatusSchema = z.enum(["active", "retiring", "retired", "invalid"]);
const fixtureGroupInputFields = {
  name: z.string().trim().min(1).max(200),
  floorId: z.string().uuid(),
  gatewayId: z.string().uuid(),
  fixtureIds: z.array(z.string().uuid()).min(1).max(100)
};
export const createFixtureGroupSchema = z.object(fixtureGroupInputFields).strict().superRefine((input, context) =>
  assertUniqueMeshNodeIds(input.fixtureIds.map((meshNodeId) => ({ meshNodeId })), context, "fixtureIds")
);
export const updateFixtureGroupSchema = createFixtureGroupSchema;
export const fixtureGroupMetadataSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  floorId: z.string().uuid().nullable(),
  gatewayId: z.string().uuid().nullable(),
  lifecycleStatus: fixtureGroupLifecycleStatusSchema,
  fixtureCount: nonnegativeInt4Schema,
  meshControlGroup: z.object({
    status: z.enum(["configuring", "ready", "failed", "retiring", "retired"]),
    version: nonnegativeInt4Schema,
    error: z.string().nullable()
  }).nullable()
}).strict();
export type CreateFixtureGroupInput = z.infer<typeof createFixtureGroupSchema>;
export type UpdateFixtureGroupInput = z.infer<typeof updateFixtureGroupSchema>;
export type FixtureGroupMetadata = z.infer<typeof fixtureGroupMetadataSchema>;

export const energyPeriodSchema = z.enum(["day", "month", "year"]);
export const energyDataStatusSchema = z.enum(["no_data", "partial", "available"]);
export const energySourceSchema = z.literal("state_based_estimate");
const energyDurationSecondsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const energyPeriodValueSchema = z.object({
  estimatedKwh: z.number(),
  estimatedCost: z.number(),
  knownSeconds: energyDurationSecondsSchema,
  unknownSeconds: energyDurationSecondsSchema,
  dataStatus: energyDataStatusSchema
}).strict();
export const energySummarySchema = z.object({
  siteId: z.string().uuid(),
  timeZone: z.string().min(1),
  source: energySourceSchema,
  generatedAt: z.string().datetime(),
  today: energyPeriodValueSchema,
  monthToDate: energyPeriodValueSchema,
  yearToDate: energyPeriodValueSchema,
  monthForecast: z.object({
    estimatedKwh: z.number().nullable(),
    estimatedCost: z.number().nullable(),
    observedKnownSeconds: energyDurationSecondsSchema,
    reason: z.enum(["available", "insufficient_state", "no_registered_fixture"])
  }).strict(),
  baseline24Hours: z.object({
    estimatedKwh: z.number(),
    estimatedCost: z.number(),
    fixtureCount: nonnegativeInt4Schema,
    daysInMonth: positiveInt4Schema
  }).strict(),
  estimatedSavings: z.object({
    kwh: z.number().nullable(),
    cost: z.number().nullable()
  }).strict(),
  lastAggregatedAt: z.string().datetime().nullable()
}).strict();
export const energySeriesPointSchema = z.object({
  source: energySourceSchema,
  period: z.string().min(1),
  estimatedKwh: z.number().nullable(),
  estimatedCost: z.number().nullable(),
  knownSeconds: energyDurationSecondsSchema,
  unknownSeconds: energyDurationSecondsSchema,
  dataStatus: energyDataStatusSchema
}).strict();
const energyDayPeriodSchema = z.string().date();
const energyMonthPeriodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export const energySeriesResponseSchema = z.object({
  siteId: z.string().uuid(),
  timeZone: z.string().min(1),
  source: energySourceSchema,
  generatedAt: z.string().datetime(),
  granularity: z.enum(["day", "month"]),
  from: z.string().date(),
  to: z.string().date(),
  points: z.array(energySeriesPointSchema)
}).strict().superRefine((response, context) => {
  response.points.forEach((point, index) => {
    const periodIsValid = response.granularity === "day"
      ? energyDayPeriodSchema.safeParse(point.period).success
      : energyMonthPeriodSchema.safeParse(point.period).success;
    if (!periodIsValid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["points", index, "period"],
        message: response.granularity === "day"
          ? "day period must use YYYY-MM-DD"
          : "month period must use YYYY-MM"
      });
    }
  });
});
export type EnergyPeriod = z.infer<typeof energyPeriodSchema>;
export type EnergySummary = z.infer<typeof energySummarySchema>;
export type EnergySeriesPoint = z.infer<typeof energySeriesPointSchema>;
export type EnergySeriesResponse = z.infer<typeof energySeriesResponseSchema>;

export {
  createDimmingCommandRequestSchema,
  createDimmingCommandSchema,
  dimmingTargetSchema
} from "./dimming-command.js";
export type { CreateDimmingCommandInput, DimmingTarget } from "./dimming-command.js";
