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
  brightness: z.number().int().min(0).max(100)
};

export const createDimmingCommandSchema = z.object({
  ...createDimmingCommandFields,
  target: dimmingTargetSchema
}).strict();

const legacyTimedCreateDimmingCommandSchema = z.object({
  ...createDimmingCommandFields,
  target: dimmingTargetSchema,
  overrideUntil: z.string().datetime()
}).strict().transform(({ overrideUntil: _ignored, ...input }) => input);

const legacyTargetCreateDimmingCommandSchema = z.object({
  ...createDimmingCommandFields,
  targetType: z.enum(["fixture", "group"]),
  targetId: z.string().uuid(),
  overrideUntil: z.string().datetime().optional()
}).strict().transform(({ targetType, targetId, overrideUntil: _ignored, ...input }) => ({
  ...input,
  target: targetType === "fixture"
    ? { type: "fixture" as const, fixtureId: targetId }
    : { type: "group" as const, groupId: targetId }
}));

export const createDimmingCommandRequestSchema = z.union([
  createDimmingCommandSchema,
  legacyTimedCreateDimmingCommandSchema,
  legacyTargetCreateDimmingCommandSchema
]);

export type DimmingTarget = z.infer<typeof dimmingTargetSchema>;
export type CreateDimmingCommandInput = z.infer<typeof createDimmingCommandSchema>;
