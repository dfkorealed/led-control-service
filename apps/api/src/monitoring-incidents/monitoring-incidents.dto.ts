import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

const type = z.enum(["gateway_offline", "fixture_stale", "fixture_fault", "command_failed"]);
const status = z.enum(["open", "acknowledged", "resolved", "all"]);
const expectedUpdatedAt = z.string().datetime();
const policySchema = z.object({
  gatewayOfflineAfterSeconds: z.number().int().min(30).max(900),
  fixtureStaleAfterSeconds: z.number().int().min(60).max(3600),
  expectedUpdatedAt
}).strict();
const mutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("acknowledge"), expectedUpdatedAt }).strict(),
  z.object({ action: z.literal("assign"), userId: z.string().uuid().nullable(), expectedUpdatedAt }).strict(),
  z.object({ action: z.literal("resolve"), note: z.string().trim().min(1).max(2000), expectedUpdatedAt }).strict()
]);
const querySchema = z.object({
  status: status.default("all"), type: type.optional(),
  limit: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().min(1).max(100)).default(25),
  cursor: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/).optional()
}).strict();
const cursorSchema = z.object({
  v: z.literal(1), siteId: z.string().uuid(), status, type: type.optional(),
  active: z.boolean(), openedAt: z.string().datetime(), id: z.string().uuid()
}).strict();
export type IncidentCursor = Omit<z.infer<typeof cursorSchema>, "v" | "openedAt"> & { openedAt: Date };

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new BadRequestException({ code: "INVALID_MONITORING_INPUT", message: "invalid monitoring input" });
  return parsed.data;
}

export const parseMonitoringPolicy = (input: unknown) => parse(policySchema, input);
export const parseIncidentMutation = (input: unknown) => parse(mutationSchema, input);

export function encodeIncidentCursor(cursor: IncidentCursor) {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor, openedAt: cursor.openedAt.toISOString() }), "utf8").toString("base64url");
}

export function parseIncidentQuery(input: unknown, siteId: string) {
  const { cursor: encoded, ...query } = parse(querySchema, input);
  if (!encoded) return { ...query, cursor: undefined };
  try {
    const { v: _version, ...decoded } = parse(cursorSchema, JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    const cursor: IncidentCursor = { ...decoded, openedAt: new Date(decoded.openedAt) };
    if (cursor.siteId !== siteId || cursor.status !== query.status || cursor.type !== query.type || encodeIncidentCursor(cursor) !== encoded) throw new Error("cursor scope mismatch");
    return { ...query, cursor };
  } catch {
    throw new BadRequestException({ code: "INVALID_INCIDENT_CURSOR", message: "invalid incident cursor" });
  }
}
