import { z } from "zod";

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
  brightness: z.number().int().min(0).max(100),
  overrideUntil: z.string().datetime().optional()
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
  brightness: input.brightness,
  ...(input.overrideUntil ? { overrideUntil: input.overrideUntil } : {})
}));

export const createDimmingCommandRequestSchema = z.union([
  createDimmingCommandSchema,
  legacyCreateDimmingCommandSchema
]);

export type DimmingTarget = z.infer<typeof dimmingTargetSchema>;
export type CreateDimmingCommandInput = z.infer<typeof createDimmingCommandSchema>;
