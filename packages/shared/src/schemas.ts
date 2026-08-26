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
export const EDITOR_MAX_OBJECT_TYPE_LENGTH = 64;
export const EDITOR_MAX_RATED_WATT = 999_999.99;
export const EDITOR_REVISION_DEFAULT_LIMIT = 20;
export const EDITOR_REVISION_MAX_LIMIT = 100;

const finiteNumberSchema = z.number().finite();
const nullableFiniteNumberSchema = finiteNumberSchema.nullable();
const int4Schema = z.number().int().min(POSTGRES_INT_MIN).max(POSTGRES_INT_MAX);
const nonnegativeInt4Schema = int4Schema.nonnegative();
const expectedRevisionSchema = nonnegativeInt4Schema.max(EDITOR_MAX_EXPECTED_REVISION);
const positiveInt4Schema = int4Schema.positive();
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
  height: positiveInt4Schema
};

export const floorPlanUpdateSchema = z.discriminatedUnion("sourceType", [
  z.object({ sourceType: z.literal("image"), ...floorPlanFields }).strict(),
  z.object({ sourceType: z.literal("pdf"), ...floorPlanFields }).strict()
]);

export const legacyFloorPlanEffectiveSchema = z.discriminatedUnion("sourceType", [
  z.object({
    sourceType: z.literal("none"),
    imageUrl: z.literal(""),
    originalFileUrl: z.union([z.literal(""), z.null()]),
    renderedImageUrl: z.union([z.literal(""), z.null()]),
    width: positiveInt4Schema,
    height: positiveInt4Schema
  }).strict(),
  z.object({ sourceType: z.literal("image"), ...floorPlanFields }).strict(),
  z.object({ sourceType: z.literal("pdf"), ...floorPlanFields }).strict()
]);

export const legacyFloorPlanPatchSchema = z.object({
  imageUrl: z.string().trim().max(EDITOR_MAX_URL_LENGTH).optional(),
  sourceType: z.enum(["none", "image", "pdf"]).optional(),
  originalFileUrl: z.string().trim().max(EDITOR_MAX_URL_LENGTH).nullable().optional(),
  renderedImageUrl: z.string().trim().max(EDITOR_MAX_URL_LENGTH).nullable().optional(),
  width: positiveInt4Schema.optional(),
  height: positiveInt4Schema.optional()
}).refine((value) => Object.keys(value).length > 0, "floor plan patch must not be empty");

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

export const floorMapPlanSnapshotSchema = z.object({
  imageUrl: editorUrlSchema,
  sourceType: z.enum(["image", "pdf"]),
  originalFileUrl: editorUrlSchema.nullable(),
  renderedImageUrl: editorUrlSchema.nullable(),
  width: positiveInt4Schema,
  height: positiveInt4Schema
}).strict();

export const floorMapSnapshotSchema = z.object({
  floorId: z.string().uuid(),
  revision: nonnegativeInt4Schema,
  width: positiveInt4Schema,
  height: positiveInt4Schema,
  floorPlan: floorMapPlanSnapshotSchema.nullable(),
  objects: z.array(floorMapObjectStateSchema)
}).strict();

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

export const FLOOR_EDITOR_SNAPSHOT_VERSION = 1;

export const floorEditorSnapshotV1Schema = z.object({
  floorPlan: z.object({
    imageUrl: legacySnapshotUrlSchema,
    sourceType: z.enum(["none", "image", "pdf"]),
    originalFileUrl: legacySnapshotUrlSchema.nullable(),
    renderedImageUrl: legacySnapshotUrlSchema.nullable(),
    width: positiveInt4Schema,
    height: positiveInt4Schema
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

export const floorEditorSnapshotSchema = floorEditorSnapshotV1Schema;

export function parseFloorEditorSnapshot(value: unknown) {
  return floorEditorSnapshotV1Schema.parse(value);
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
  placement: registrationPlacementSchema
}).strict();
const registrationIndividualNodeSchema = z.object({
  nodeId: z.string().uuid(),
  fixtureName: z.string().trim().max(EDITOR_MAX_NAME_LENGTH),
  ratedWatt: registrationRatedWattSchema,
  size: registrationSizeSchema,
  placement: registrationPlacementSchema
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
const energyPeriodValueSchema = z.object({
  estimatedKwh: z.number(),
  estimatedCost: z.number(),
  knownSeconds: nonnegativeInt4Schema,
  unknownSeconds: nonnegativeInt4Schema,
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
    observedKnownSeconds: nonnegativeInt4Schema,
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
  knownSeconds: nonnegativeInt4Schema,
  unknownSeconds: nonnegativeInt4Schema,
  dataStatus: energyDataStatusSchema
}).strict();
export type EnergyPeriod = z.infer<typeof energyPeriodSchema>;
export type EnergySummary = z.infer<typeof energySummarySchema>;
export type EnergySeriesPoint = z.infer<typeof energySeriesPointSchema>;

const fixtureIdSchema = z.string().uuid();
const multipleFixturesTargetSchema = z.object({
  type: z.literal("fixtures"),
  fixtureIds: z.array(fixtureIdSchema).min(1).max(1_000)
}).strict().superRefine((target, context) => {
  const seen = new Set<string>();
  target.fixtureIds.forEach((fixtureId, index) => {
    if (seen.has(fixtureId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "fixtureIds must be unique",
        path: ["fixtureIds", index]
      });
    }
    seen.add(fixtureId);
  });
});

export const dimmingTargetSchema = z.union([
  z.object({ type: z.literal("fixture"), fixtureId: fixtureIdSchema }).strict(),
  multipleFixturesTargetSchema,
  z.object({ type: z.literal("floor"), floorId: z.string().uuid() }).strict(),
  z.object({ type: z.literal("group"), groupId: z.string().uuid() }).strict()
]);

const createDimmingCommandFields = {
  siteId: z.string().uuid(),
  clientRequestId: z.string().uuid(),
  brightness: z.number().int().min(0).max(100)
};

export const createDimmingCommandSchema = z.object({
  ...createDimmingCommandFields,
  target: dimmingTargetSchema
}).strict();

const legacyCreateDimmingCommandSchema = z.object({
  ...createDimmingCommandFields,
  targetType: z.enum(["fixture", "group"]),
  targetId: z.string().uuid()
}).strict().transform((input) => ({
  siteId: input.siteId,
  clientRequestId: input.clientRequestId,
  target: input.targetType === "fixture"
    ? { type: "fixture" as const, fixtureId: input.targetId }
    : { type: "group" as const, groupId: input.targetId },
  brightness: input.brightness
}));

// Task 14 전까지 현재 웹 요청만 controller 경계에서 신규 target 계약으로 변환한다.
export const createDimmingCommandRequestSchema = z.union([
  createDimmingCommandSchema,
  legacyCreateDimmingCommandSchema
]);

export type DimmingTarget = z.infer<typeof dimmingTargetSchema>;
export type CreateDimmingCommandInput = z.infer<typeof createDimmingCommandSchema>;
