import { BadRequestException, GoneException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { monitoringActivityResponseSchema } from "@led-control/shared";
import { z } from "zod";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { threeCalendarMonthsBefore } from "../retention/calendar-month-window";

const cursorSchema = z.object({
  version: z.literal(1), principalId: z.string().uuid(), siteId: z.string().uuid(), floorId: z.string().uuid(),
  recordedAt: z.string().datetime(), id: z.string().uuid()
}).strict();
type ActivityCursor = z.infer<typeof cursorSchema>;

const activitySelect = {
  id: true, kind: true, recordedAt: true, observedAt: true, fixtureId: true,
  displayName: true, status: true, brightnessPercent: true, commandOutcome: true, refreshStatus: true
} satisfies Prisma.MonitoringActivitySelect;

@Injectable()
export class MonitoringActivityService {
  constructor(private readonly prisma: PrismaService, private readonly siteAccess: SiteAccessService) {}

  async list(user: AuthenticatedUser, siteId: string, floorId: string,
    input: { limit?: number; cursor?: string }, now = new Date()) {
    await this.siteAccess.assert(user, siteId, "read");
    const floor = await this.prisma.floor.findUnique({ where: { id: floorId }, select: { siteId: true } });
    if (!floor || floor.siteId !== siteId) throw new NotFoundException("floor not found");

    const limit = input.limit ?? 5;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new BadRequestException("invalid monitoring activity query");
    const retainedFrom = threeCalendarMonthsBefore(now);
    const cursor = input.cursor ? parseCursor(input.cursor, user.id, siteId, floorId) : null;
    if (cursor && new Date(cursor.recordedAt) < retainedFrom) {
      throw new GoneException({ code: "monitoring_activity_cursor_expired" });
    }
    const where: Prisma.MonitoringActivityWhereInput = {
      siteId, floorId, recordedAt: { gte: retainedFrom },
      ...(cursor ? { OR: [
        { recordedAt: { lt: new Date(cursor.recordedAt) } },
        { recordedAt: new Date(cursor.recordedAt), id: { lt: cursor.id } }
      ] } : {})
    };
    const rows = await this.prisma.monitoringActivity.findMany({
      where, orderBy: [{ recordedAt: "desc" }, { id: "desc" }], take: limit + 1, select: activitySelect
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return monitoringActivityResponseSchema.parse({
      generatedAt: now.toISOString(), retainedFrom: retainedFrom.toISOString(),
      items: page.map((row) => ({
        id: row.id, kind: row.kind, recordedAt: row.recordedAt.toISOString(),
        ...(row.observedAt ? { observedAt: row.observedAt.toISOString() } : {}),
        ...(row.fixtureId ? { fixtureId: row.fixtureId } : {}),
        ...(row.displayName ? { displayName: row.displayName } : {}),
        ...(row.status ? { status: row.status } : {}),
        ...(row.brightnessPercent !== null ? { brightnessPercent: row.brightnessPercent } : {}),
        ...(row.commandOutcome ? { commandOutcome: row.commandOutcome } : {}),
        ...(row.refreshStatus ? { refreshStatus: row.refreshStatus } : {})
      })),
      nextCursor: rows.length > limit && last ? encodeCursor({
        version: 1, principalId: user.id, siteId, floorId, recordedAt: last.recordedAt.toISOString(), id: last.id
      }) : null
    });
  }
}

function encodeCursor(cursor: ActivityCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function parseCursor(encoded: string, principalId: string, siteId: string, floorId: string): ActivityCursor {
  try {
    if (encoded.length > 512 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("invalid encoding");
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    if (encodeCursor(cursor) !== encoded || cursor.principalId !== principalId || cursor.siteId !== siteId
      || cursor.floorId !== floorId || new Date(cursor.recordedAt).toISOString() !== cursor.recordedAt) {
      throw new Error("invalid scope");
    }
    return cursor;
  } catch {
    throw new BadRequestException("invalid monitoring activity cursor");
  }
}
