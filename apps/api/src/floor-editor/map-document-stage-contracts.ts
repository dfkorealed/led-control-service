import { saveEditorStateSchema } from "@led-control/shared";
import { z } from "zod";

export const MAP_STAGE_PART_BYTES = 512 * 1024;
export const MAP_STAGE_TOTAL_BYTES = 512 * 1024 * 1024;
export const MAP_STAGE_MAX_PARTS = 1024;
export const MAP_STAGE_LIFETIME_MS = 60 * 60 * 1000;
export const stageLeaseSchema = z.object({ leaseToken: z.string().trim().min(1).max(256),
  leaseFence: z.number().int().positive().max(2147483647) }).strict();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const stageCreateSchema = saveEditorStateSchema.refine(input =>
  input.documentChanges !== undefined && input.documentChanges.operations.length === 0,
"staging requires documentChanges with empty operations").refine(input =>
  input.floorPlan !== null && (!input.floorPlan || input.floorPlan.sourceType === "none"),
"staged maps require map-only dimensions");

export const stagePartSchema = stageLeaseSchema.extend({ sha256,
  data: z.string().min(4).max(Math.ceil(MAP_STAGE_PART_BYTES / 3) * 4).superRefine((value, context) => {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length < 1 || bytes.length > MAP_STAGE_PART_BYTES || bytes.toString("base64") !== value) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "part must be canonical base64 within 512 KiB" });
    }
  })
}).strict();

export const stageCommitSchema = stageLeaseSchema.extend({
  partCount: z.number().int().min(1).max(MAP_STAGE_MAX_PARTS),
  decodedBytes: z.number().int().min(1).max(MAP_STAGE_TOTAL_BYTES), sha256
}).strict().refine(input => input.decodedBytes <= input.partCount * MAP_STAGE_PART_BYTES,
"stream cannot exceed its part capacity");

export const stagePartIndex = z.string().regex(/^(0|[1-9][0-9]{0,3})$/).transform(Number)
  .pipe(z.number().int().min(0).max(MAP_STAGE_MAX_PARTS - 1));
export type StageCreateInput = z.infer<typeof stageCreateSchema>;
export type StageLeaseInput = z.infer<typeof stageLeaseSchema>;
export type StageCommitInput = z.infer<typeof stageCommitSchema>;
