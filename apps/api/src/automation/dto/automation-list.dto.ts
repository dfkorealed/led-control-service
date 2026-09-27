import { BadRequestException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { z } from "zod";

export interface AutomationListCursor {
  siteId: string;
  createdAt: Date;
  id: string;
}

export interface AutomationListQuery {
  cursor?: AutomationListCursor;
  limit: number;
  query?: string;
  status?: "enabled" | "disabled";
  syncStatus?: "PENDING" | "APPLIED" | "REJECTED";
  hasFilters?: true;
  filterSignature?: string;
}

export type AutomationListResource = "schedule" | "vehicle_event_rule";
type AutomationListCursorV2 = AutomationListCursor & {
  principalId: string;
  resource: AutomationListResource;
  filterSignature: string;
};

const automationListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  query: z.string().trim().max(100).optional(),
  status: z.enum(["enabled", "disabled"]).optional(),
  syncStatus: z.enum(["PENDING", "APPLIED", "REJECTED"]).optional()
}).strict();

const automationListCursorV1Schema = z.object({
  v: z.literal(1),
  siteId: z.string().uuid(),
  createdAt: z.string().datetime(),
  id: z.string().uuid()
}).strict();
const automationListCursorV2Schema = automationListCursorV1Schema.omit({ v: true }).extend({
  v: z.literal(2),
  principalId: z.string().uuid(),
  resource: z.enum(["schedule", "vehicle_event_rule"]),
  filterSignature: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
}).strict();

export function parseAutomationListQuery(
  rawQuery: unknown,
  siteId: string,
  resourceLabel: string,
  principalId?: string,
  resource?: AutomationListResource
): AutomationListQuery {
  const parsed = automationListQuerySchema.safeParse(rawQuery);
  if (!parsed.success) throw new BadRequestException(`invalid ${resourceLabel} list query`);
  const query = parsed.data.query || undefined;
  const { status, syncStatus } = parsed.data;
  const hasFilters = query !== undefined || status !== undefined || syncStatus !== undefined;
  const filters = hasFilters ? { query, status, syncStatus } : undefined;
  const filterSignature = filters ? createHash("sha256").update(JSON.stringify(filters)).digest("base64url") : undefined;
  const result: AutomationListQuery = { limit: parsed.data.limit,
    ...(filters ? { ...filters, hasFilters: true as const, filterSignature } : {}) };
  if (!parsed.data.cursor) return result;

  const cursor = decodeAutomationListCursor(parsed.data.cursor, resourceLabel);
  if (cursor.siteId !== siteId) {
    throw new BadRequestException(`invalid ${resourceLabel} list cursor`);
  }
  if ("principalId" in cursor) {
    if (!hasFilters || cursor.principalId !== principalId || cursor.resource !== resource ||
      cursor.filterSignature !== filterSignature) {
      throw new BadRequestException(`invalid ${resourceLabel} list cursor`);
    }
  } else if (hasFilters) {
    throw new BadRequestException(`invalid ${resourceLabel} list cursor`);
  }
  return { ...result, cursor: { siteId: cursor.siteId, createdAt: cursor.createdAt, id: cursor.id } };
}

export function encodeAutomationListCursor(cursor: AutomationListCursor | AutomationListCursorV2) {
  return Buffer.from(JSON.stringify({
    v: "principalId" in cursor ? 2 : 1,
    siteId: cursor.siteId,
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id,
    ...("principalId" in cursor ? { principalId: cursor.principalId,
      resource: cursor.resource, filterSignature: cursor.filterSignature } : {})
  }), "utf8").toString("base64url");
}

function decodeAutomationListCursor(rawCursor: string, resourceLabel: string): AutomationListCursor | AutomationListCursorV2 {
  if (rawCursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(rawCursor)) {
    throw new BadRequestException(`invalid ${resourceLabel} list cursor`);
  }
  try {
    const decoded = JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8"));
    const parsed = z.union([automationListCursorV1Schema, automationListCursorV2Schema]).safeParse(decoded);
    if (!parsed.success) throw new Error("invalid cursor shape");
    const cursor = {
      siteId: parsed.data.siteId,
      createdAt: new Date(parsed.data.createdAt),
      id: parsed.data.id,
      ...(parsed.data.v === 2 ? { principalId: parsed.data.principalId,
        resource: parsed.data.resource, filterSignature: parsed.data.filterSignature } : {})
    };
    if (encodeAutomationListCursor(cursor) !== rawCursor) throw new Error("non-canonical cursor");
    return cursor;
  } catch {
    throw new BadRequestException(`invalid ${resourceLabel} list cursor`);
  }
}
