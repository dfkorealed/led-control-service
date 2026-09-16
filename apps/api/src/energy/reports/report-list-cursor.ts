import { createHash } from "node:crypto";
import { z } from "zod";
import type { NormalizedReportFilters, ReportCursorPosition } from "./report-list-filters";

const cursorPayloadSchema = z.object({
  version: z.literal(1), createdAt: z.string().datetime(), id: z.string().uuid(),
  filterFingerprint: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

function fingerprint(filters: NormalizedReportFilters) {
  // Construct a fixed key order; cursor and page size never change the result set.
  return createHash("sha256").update(JSON.stringify({
    query: filters.query, status: filters.status, format: filters.format, scope: filters.scope,
    requestedFrom: filters.requestedFrom, requestedTo: filters.requestedTo
  })).digest("hex");
}

export function encodeReportCursor(position: ReportCursorPosition, filters: NormalizedReportFilters) {
  return Buffer.from(JSON.stringify({ version: 1, createdAt: position.createdAt.toISOString(),
    id: position.id, filterFingerprint: fingerprint(filters) }), "utf8").toString("base64url");
}

export function decodeReportCursor(cursor: string, filters: NormalizedReportFilters): ReportCursorPosition {
  try {
    if (!cursor.length || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(json, "utf8").toString("base64url") !== cursor) throw new Error();
    const payload = cursorPayloadSchema.parse(JSON.parse(json));
    const createdAt = new Date(payload.createdAt);
    if (createdAt.toISOString() !== payload.createdAt || payload.filterFingerprint !== fingerprint(filters)
      || JSON.stringify(payload) !== json) throw new Error();
    return { createdAt, id: payload.id };
  } catch {
    // Neither JSON/Zod diagnostics nor supplied cursor content is public error text.
    throw new Error("invalid report cursor");
  }
}
