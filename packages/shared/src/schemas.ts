import { z } from "zod";

const finiteNumberSchema = z.number().finite();
const nullableFiniteNumberSchema = finiteNumberSchema.nullable();

export const floorPlanUpdateSchema = z.object({
  imageUrl: z.string().optional(),
  sourceType: z.enum(["none", "image", "pdf"]).optional(),
  originalFileUrl: z.string().nullable().optional(),
  renderedImageUrl: z.string().nullable().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "floorPlan update must not be empty");

export const fixtureLayoutUpdateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  ratedWatt: z.union([z.number().nonnegative().finite(), z.string().min(1)]).optional(),
  x: finiteNumberSchema.optional(),
  y: finiteNumberSchema.optional(),
  size: finiteNumberSchema.optional()
}).strict().refine((value) => Object.keys(value).some((key) => key !== "id"), "fixture update must not be empty");

const floorMapObjectFields = {
  type: z.string().min(1),
  x: finiteNumberSchema,
  y: finiteNumberSchema,
  width: nullableFiniteNumberSchema,
  height: nullableFiniteNumberSchema,
  rotation: finiteNumberSchema,
  points: z.unknown().nullable(),
  text: z.string().nullable(),
  strokeColor: z.string().min(1),
  fillColor: z.string().nullable(),
  strokeWidth: finiteNumberSchema,
  fontSize: nullableFiniteNumberSchema,
  zIndex: z.number().int(),
  locked: z.boolean(),
  visible: z.boolean()
};

export const floorMapObjectDraftSchema = z.object({
  ...floorMapObjectFields,
  points: floorMapObjectFields.points.optional(),
  text: floorMapObjectFields.text.optional(),
  fillColor: floorMapObjectFields.fillColor.optional(),
  fontSize: floorMapObjectFields.fontSize.optional(),
  zIndex: floorMapObjectFields.zIndex.optional()
}).strict();

export const floorMapObjectPatchSchema = z.object({
  type: floorMapObjectFields.type.optional(),
  x: floorMapObjectFields.x.optional(),
  y: floorMapObjectFields.y.optional(),
  width: floorMapObjectFields.width.optional(),
  height: floorMapObjectFields.height.optional(),
  rotation: floorMapObjectFields.rotation.optional(),
  points: floorMapObjectFields.points.optional(),
  text: floorMapObjectFields.text.optional(),
  strokeColor: floorMapObjectFields.strokeColor.optional(),
  fillColor: floorMapObjectFields.fillColor.optional(),
  strokeWidth: floorMapObjectFields.strokeWidth.optional(),
  fontSize: floorMapObjectFields.fontSize.optional(),
  zIndex: floorMapObjectFields.zIndex.optional(),
  locked: floorMapObjectFields.locked.optional(),
  visible: floorMapObjectFields.visible.optional()
}).strict().refine((value) => Object.keys(value).length > 0, "object patch must not be empty");

export const saveEditorStateSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  floorPlan: floorPlanUpdateSchema.nullable().optional(),
  fixtureUpdates: z.array(fixtureLayoutUpdateSchema),
  objectCreates: z.array(floorMapObjectDraftSchema),
  objectUpdates: z.array(z.object({ id: z.string().min(1), patch: floorMapObjectPatchSchema }).strict()),
  objectDeletes: z.array(z.string().min(1))
}).strict();

export const restoreFloorEditorRevisionSchema = z.object({
  expectedRevision: z.number().int().nonnegative()
}).strict();

export const floorEditorSnapshotSchema = z.object({
  floorPlan: z.object({
    imageUrl: z.string(),
    sourceType: z.enum(["none", "image", "pdf"]),
    originalFileUrl: z.string().nullable(),
    renderedImageUrl: z.string().nullable(),
    width: z.number().int().positive(),
    height: z.number().int().positive()
  }).strict().nullable(),
  fixtures: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    ratedWatt: z.string().min(1),
    x: finiteNumberSchema,
    y: finiteNumberSchema,
    size: finiteNumberSchema
  }).strict()),
  objects: z.array(z.object({ id: z.string().min(1), ...floorMapObjectFields }).strict())
}).strict();

export type SaveEditorStateInput = z.infer<typeof saveEditorStateSchema>;
export type RestoreFloorEditorRevisionInput = z.infer<typeof restoreFloorEditorRevisionSchema>;
export type FloorEditorSnapshot = z.infer<typeof floorEditorSnapshotSchema>;

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
