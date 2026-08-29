import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

export interface AutomationListCursor {
  siteId: string;
  createdAt: Date;
  id: string;
}

export interface AutomationListQuery {
  cursor?: AutomationListCursor;
  limit: number;
}

const automationListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25)
}).strict();

const automationListCursorV1Schema = z.object({
  v: z.literal(1),
  siteId: z.string().uuid(),
  createdAt: z.string().datetime(),
  id: z.string().uuid()
}).strict();

export function parseAutomationListQuery(
  rawQuery: unknown,
  siteId: string,
  resourceLabel: string
): AutomationListQuery {
  const parsed = automationListQuerySchema.safeParse(rawQuery);
  if (!parsed.success) throw new BadRequestException(`invalid ${resourceLabel} list query`);
  if (!parsed.data.cursor) return { limit: parsed.data.limit };

  const cursor = decodeAutomationListCursor(parsed.data.cursor, resourceLabel);
  if (cursor.siteId !== siteId) {
    throw new BadRequestException(`invalid ${resourceLabel} list cursor`);
  }
  return { limit: parsed.data.limit, cursor };
}

export function encodeAutomationListCursor(cursor: AutomationListCursor) {
  return Buffer.from(JSON.stringify({
    v: 1,
    siteId: cursor.siteId,
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id
  }), "utf8").toString("base64url");
}

function decodeAutomationListCursor(rawCursor: string, resourceLabel: string): AutomationListCursor {
  if (rawCursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(rawCursor)) {
    throw new BadRequestException(`invalid ${resourceLabel} list cursor`);
  }
  try {
    const decoded = JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8"));
    const parsed = automationListCursorV1Schema.safeParse(decoded);
    if (!parsed.success) throw new Error("invalid cursor shape");
    const cursor = {
      siteId: parsed.data.siteId,
      createdAt: new Date(parsed.data.createdAt),
      id: parsed.data.id
    };
    if (encodeAutomationListCursor(cursor) !== rawCursor) throw new Error("non-canonical cursor");
    return cursor;
  } catch {
    throw new BadRequestException(`invalid ${resourceLabel} list cursor`);
  }
}
