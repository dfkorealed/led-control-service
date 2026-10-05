import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

const type = z.enum(["gateway_offline", "fixture_stale", "fixture_fault", "command_failed"]);
const status = z.enum(["open", "acknowledged", "resolved", "all"]);
const expectedUpdatedAt = z.string().datetime();
const readBodySchema = z.object({}).strict();
const dismissAllSchema = z.object({ clientRequestId: z.string().uuid() }).strict();
export type DismissIncidentResponse = { incidentId: string; isDismissed: true; dismissedAt: string };
export type DismissAllIncidentsResponse = { siteId: string; clientRequestId: string; snapshotAt: string; dismissedCount: number };
const readTargetSchema = z.object({ siteId: z.string().uuid(), incidentId: z.string().uuid() }).strict();
export const incidentReadStateSchema = z.object({ isRead: z.boolean(), readAt: z.string().datetime().nullable() }).strict();
export const incidentReadReceiptResponseSchema = z.object({ incidentId: z.string().uuid(), isRead: z.literal(true), readAt: z.string().datetime() }).strict();
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
  view: z.enum(["all", "personal"]).default("all"),
  status: status.default("all"), type: type.optional(),
  limit: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().min(1).max(100)).default(25),
  cursor: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/).optional()
}).strict();
const legacyCursorSchema = z.object({
  v: z.literal(1), siteId: z.string().uuid(), status, type: type.optional(),
  active: z.boolean(), openedAt: z.string().datetime(), id: z.string().uuid()
}).strict();
const cursorSchema = z.union([legacyCursorSchema, legacyCursorSchema.extend({
  v: z.literal(2), userId: z.string().uuid(), view: z.enum(["all", "personal"])
}).strict()]);
export type IncidentCursor = Omit<z.infer<typeof legacyCursorSchema>, "v" | "openedAt"> & {
  openedAt: Date; userId?: string; view?: "all" | "personal"
};

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new BadRequestException({ code: "INVALID_MONITORING_INPUT", message: "invalid monitoring input" });
  return parsed.data;
}

export const parseMonitoringPolicy = (input: unknown) => parse(policySchema, input);
export const parseIncidentMutation = (input: unknown) => parse(mutationSchema, input);
export const parseIncidentReadBody = (input: unknown) => parse(readBodySchema, input === undefined ? {} : input);
export const parseIncidentReadTarget = (siteId: string, incidentId: string) => parse(readTargetSchema, { siteId, incidentId });
export const parseDismissIncidentBody = (input: unknown) => parse(readBodySchema, input === undefined ? {} : input);
export function parseDismissAllIncidents(siteId: string, input: unknown) {
  parse(z.string().uuid(), siteId);
  return parse(dismissAllSchema, input);
}

export function encodeIncidentCursor(cursor: IncidentCursor) {
  return Buffer.from(JSON.stringify({ v: cursor.userId ? 2 : 1, ...cursor, openedAt: cursor.openedAt.toISOString() }), "utf8").toString("base64url");
}

export function parseIncidentQuery(input: unknown, siteId: string, userId?: string) {
  const { cursor: encoded, ...query } = parse(querySchema, input);
  if (!encoded) return { ...query, cursor: undefined };
  try {
    const { v: version, ...decoded } = parse(cursorSchema, JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    const cursor: IncidentCursor = { ...decoded, openedAt: new Date(decoded.openedAt) };
    if (version === 1 ? query.view !== "all" : cursor.userId !== userId || cursor.view !== query.view) throw new Error("cursor actor/view mismatch");
    if (cursor.siteId !== siteId || cursor.status !== query.status || cursor.type !== query.type || encodeIncidentCursor(cursor) !== encoded) throw new Error("cursor scope mismatch");
    return { ...query, cursor };
  } catch {
    throw new BadRequestException({ code: "INVALID_INCIDENT_CURSOR", message: "invalid incident cursor" });
  }
}
