import { BadRequestException } from "@nestjs/common";
import {
  automationActionV1Schema,
  type DimmingTarget,
  dimmingTargetSchema,
  type LightingScheduleSnapshotV1,
  scheduleRecurrenceV1Schema
} from "@led-control/shared";
import { z } from "zod";
import {
  type AutomationListCursor,
  type AutomationListQuery,
  encodeAutomationListCursor,
  parseAutomationListQuery
} from "./automation-list.dto";

export type CreateScheduleInput = Omit<LightingScheduleSnapshotV1, "id" | "fixtureIds"> & {
  target: DimmingTarget;
};

export type UpdateScheduleInput = Partial<CreateScheduleInput>;
export type ScheduleListCursor = AutomationListCursor;
export type ScheduleListQuery = AutomationListQuery;

const createScheduleSchema = z.object({
  name: z.string().trim().min(1),
  status: z.enum(["enabled", "disabled"]),
  activeFrom: z.string().datetime(),
  activeUntil: z.string().datetime(),
  localStartTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  localEndTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  recurrence: scheduleRecurrenceV1Schema,
  action: automationActionV1Schema,
  target: dimmingTargetSchema
}).strict().superRefine((schedule, context) => {
  if (Date.parse(schedule.activeFrom) > Date.parse(schedule.activeUntil)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["activeUntil"],
      message: "activeUntil must not precede activeFrom"
    });
  }
  if (schedule.localStartTime === schedule.localEndTime) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["localEndTime"],
      message: "localEndTime must differ from localStartTime"
    });
  }
});

const updateScheduleSchema = createScheduleSchema.innerType().partial().refine(
  (input) => Object.keys(input).length > 0,
  "schedule update must contain at least one field"
);

export function parseCreateScheduleInput(rawInput: unknown): CreateScheduleInput {
  const parsed = createScheduleSchema.safeParse(rawInput);
  if (!parsed.success) throw new BadRequestException("invalid automation schedule");
  return parsed.data;
}

export function parseUpdateScheduleInput(rawInput: unknown): UpdateScheduleInput {
  const parsed = updateScheduleSchema.safeParse(rawInput);
  if (!parsed.success) throw new BadRequestException("invalid automation schedule update");
  return parsed.data;
}

export function parseScheduleListQuery(rawQuery: unknown, siteId: string): ScheduleListQuery {
  return parseAutomationListQuery(rawQuery, siteId, "schedule");
}

export function encodeScheduleListCursor(cursor: ScheduleListCursor) {
  return encodeAutomationListCursor(cursor);
}
