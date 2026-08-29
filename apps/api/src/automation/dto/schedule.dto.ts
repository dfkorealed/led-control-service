import { BadRequestException } from "@nestjs/common";
import {
  automationActionV1Schema,
  type DimmingTarget,
  dimmingTargetSchema,
  type LightingScheduleSnapshotV1,
  scheduleRecurrenceV1Schema
} from "@led-control/shared";
import { z } from "zod";

export type CreateScheduleInput = Omit<LightingScheduleSnapshotV1, "id" | "fixtureIds"> & {
  target: DimmingTarget;
};

export type UpdateScheduleInput = Partial<CreateScheduleInput>;
export interface ScheduleListCursor {
  siteId: string;
  createdAt: Date;
  id: string;
}
export interface ScheduleListQuery {
  cursor?: ScheduleListCursor;
  limit: number;
}

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

const scheduleListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25)
}).strict();

const scheduleListCursorV1Schema = z.object({
  v: z.literal(1),
  siteId: z.string().uuid(),
  createdAt: z.string().datetime(),
  id: z.string().uuid()
}).strict();

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
  const parsed = scheduleListQuerySchema.safeParse(rawQuery);
  if (!parsed.success) throw new BadRequestException("invalid schedule list query");
  if (!parsed.data.cursor) return { limit: parsed.data.limit };

  const cursor = decodeScheduleListCursor(parsed.data.cursor);
  if (cursor.siteId !== siteId) throw new BadRequestException("invalid schedule list cursor");
  return { limit: parsed.data.limit, cursor };
}

export function encodeScheduleListCursor(cursor: ScheduleListCursor) {
  return Buffer.from(JSON.stringify({
    v: 1,
    siteId: cursor.siteId,
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id
  }), "utf8").toString("base64url");
}

function decodeScheduleListCursor(rawCursor: string): ScheduleListCursor {
  if (!/^[A-Za-z0-9_-]+$/.test(rawCursor)) {
    throw new BadRequestException("invalid schedule list cursor");
  }
  try {
    const decoded = JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8"));
    const parsed = scheduleListCursorV1Schema.safeParse(decoded);
    if (!parsed.success) throw new Error("invalid cursor shape");
    const cursor = {
      siteId: parsed.data.siteId,
      createdAt: new Date(parsed.data.createdAt),
      id: parsed.data.id
    };
    if (encodeScheduleListCursor(cursor) !== rawCursor) throw new Error("non-canonical cursor");
    return cursor;
  } catch {
    throw new BadRequestException("invalid schedule list cursor");
  }
}
