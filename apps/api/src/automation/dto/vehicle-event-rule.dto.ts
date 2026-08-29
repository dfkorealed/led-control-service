import { BadRequestException } from "@nestjs/common";
import {
  automationActionV1Schema,
  type VehicleEventRuleSnapshotV1
} from "@led-control/shared";
import { z } from "zod";

export type CreateVehicleEventRuleInput = Omit<VehicleEventRuleSnapshotV1, "id">;
export type UpdateVehicleEventRuleInput = Partial<CreateVehicleEventRuleInput>;

const fixtureIdsSchema = z.array(z.string().uuid()).min(1).superRefine((fixtureIds, context) => {
  if (new Set(fixtureIds).size !== fixtureIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "fixture IDs must be distinct" });
  }
});

const vehicleEventRuleFields = {
  name: z.string().trim().min(1),
  status: z.enum(["enabled", "disabled"]),
  sourceFixtureIds: fixtureIdsSchema,
  targetFixtureIds: fixtureIdsSchema,
  action: automationActionV1Schema,
  holdSeconds: z.number().int().min(5).max(1_800)
};

const createVehicleEventRuleSchema = z.object({
  ...vehicleEventRuleFields,
  holdSeconds: vehicleEventRuleFields.holdSeconds.default(60)
}).strict();

const updateVehicleEventRuleSchema = z.object(vehicleEventRuleFields).strict().partial().refine(
  (input) => Object.keys(input).length > 0,
  "vehicle event rule update must contain at least one field"
);

export function parseCreateVehicleEventRuleInput(rawInput: unknown): CreateVehicleEventRuleInput {
  const parsed = createVehicleEventRuleSchema.safeParse(rawInput);
  if (!parsed.success) throw new BadRequestException("invalid vehicle event rule");
  return parsed.data;
}

export function parseUpdateVehicleEventRuleInput(rawInput: unknown): UpdateVehicleEventRuleInput {
  const parsed = updateVehicleEventRuleSchema.safeParse(rawInput);
  if (!parsed.success) throw new BadRequestException("invalid vehicle event rule update");
  return parsed.data;
}
