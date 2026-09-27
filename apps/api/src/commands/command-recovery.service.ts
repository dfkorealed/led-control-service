import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { CommandSafetyDigest, CommandSafetyKeyUnavailableError, VersionedCommandDigest } from "./command-safety-digest";
import { threeCalendarMonthsBefore } from "../retention/calendar-month-window";

const querySchema = z.object({ siteId: z.string().uuid(), originalCommandId: z.string().uuid().optional(),
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.union([z.string().regex(/^\d+$/).transform(Number), z.number()]).pipe(z.number().int().min(1).max(100)).default(20)
}).strict();
const cursorSchema = z.object({ version: z.literal(1), principalId: z.string().uuid(), siteId: z.string().uuid(),
  originalCommandId: z.string().uuid().nullable(), createdAt: z.string().datetime(), id: z.string().uuid(),
  keyVersion: z.number().int().positive(), signature: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/)
}).strict();
type Cursor = z.infer<typeof cursorSchema>;

const listSelect = { id: true, siteId: true, originalCommandId: true, reasonCode: true,
  verificationAttemptCount: true, lastCheckedAt: true, createdAt: true,
  _count: { select: { targets: true } },
  recoveryDispatches: { where: { status: { in: ["pending", "published", "accepted"] } }, select: { id: true }, take: 1 }
} satisfies Prisma.UnresolvedCommandHoldSelect;
type CaseRow = Prisma.UnresolvedCommandHoldGetPayload<{ select: typeof listSelect }>;

@Injectable()
export class CommandRecoveryService {
  constructor(private readonly prisma: PrismaService, private readonly siteAccess: SiteAccessService,
    private readonly digest: CommandSafetyDigest) {}

  async listCases(user: AuthenticatedUser, raw: unknown, now = new Date()) {
    const siteId = extractSiteId(raw);
    // Do not reveal filter/cursor validity at an inaccessible site.
    await this.siteAccess.assert(user, siteId, "read");
    const parsed = querySchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("invalid verification case query");
    const { originalCommandId, cursor: encoded, limit } = parsed.data;
    const cursor = encoded ? this.decodeCursor(encoded, user.id, siteId, originalCommandId ?? null) : null;
    const rows = await this.prisma.unresolvedCommandHold.findMany({
      where: { siteId, ...(originalCommandId ? { originalCommandId } : {}),
        ...(cursor ? { OR: [{ createdAt: { lt: new Date(cursor.createdAt) } },
          { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } }] } : {}) },
      select: listSelect, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { items: page.map(publicCase),
      nextCursor: rows.length > limit && last ? this.encodeCursor(user.id, siteId, originalCommandId ?? null, last) : null,
      generatedAt: now.toISOString() };
  }

  async getCase(user: AuthenticatedUser, caseId: string, now = new Date()) {
    const row = await this.prisma.unresolvedCommandHold.findUnique({ where: { id: caseId },
      select: { ...listSelect, targets: { select: { fixtureId: true }, orderBy: { fixtureId: "asc" } } } });
    const terminal = row ? null : await this.prisma.resolvedCommandRecovery.findUnique({ where: { id: caseId } });
    if (!row && !terminal) throw caseNotFound();
    try {
      await this.siteAccess.assert(user, (row ?? terminal)!.siteId, "read");
    } catch (error) {
      if (error instanceof NotFoundException) throw caseNotFound();
      throw error;
    }
    if (row) return { ...publicCase(row), targetFixtureIds: row.targets.map(({ fixtureId }) => fixtureId) };
    if (!terminal || terminal.resolvedAt < threeCalendarMonthsBefore(now)) throw caseNotFound();
    if (!["verified_applied", "verified_not_applied", "verified_partial"].includes(terminal.classification)) {
      throw new Error("invalid recovery classification");
    }
    return { caseId: terminal.id, siteId: terminal.siteId,
      status: terminal.classification as "verified_applied" | "verified_not_applied" | "verified_partial",
      targetCount: terminal.targetCount, resolvedAt: terminal.resolvedAt.toISOString() };
  }

  private encodeCursor(principalId: string, siteId: string, originalCommandId: string | null,
    row: Pick<CaseRow, "id" | "createdAt">): string {
    const body = { version: 1 as const, principalId, siteId, originalCommandId,
      createdAt: row.createdAt.toISOString(), id: row.id };
    let signed: VersionedCommandDigest;
    try {
      signed = this.digest.sign("recovery-cursor", cursorParts(body));
    } catch (error) {
      if (error instanceof CommandSafetyKeyUnavailableError) throw cursorUnavailable();
      throw error;
    }
    return Buffer.from(JSON.stringify({ ...body, keyVersion: signed.keyVersion, signature: signed.value })).toString("base64url");
  }

  private decodeCursor(encoded: string, principalId: string, siteId: string, originalCommandId: string | null) {
    try {
      if (encoded.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
      const cursor = cursorSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
      if (Buffer.from(JSON.stringify(cursor)).toString("base64url") !== encoded || cursor.principalId !== principalId
        || cursor.siteId !== siteId || cursor.originalCommandId !== originalCommandId
        || new Date(cursor.createdAt).toISOString() !== cursor.createdAt) throw new Error();
      const expected: VersionedCommandDigest = { keyVersion: cursor.keyVersion, value: cursor.signature };
      if (!this.digest.verify("recovery-cursor", cursorParts(cursor), expected)) throw new Error();
      return cursor;
    } catch (error) {
      if (error instanceof CommandSafetyKeyUnavailableError) throw cursorUnavailable();
      throw new BadRequestException("invalid verification case cursor");
    }
  }
}

function extractSiteId(raw: unknown) {
  const siteId = raw && typeof raw === "object" && "siteId" in raw ? (raw as { siteId: unknown }).siteId : undefined;
  if (typeof siteId !== "string" || !z.string().uuid().safeParse(siteId).success) {
    throw new BadRequestException("invalid verification case siteId");
  }
  return siteId;
}

function cursorParts(value: Pick<Cursor, "principalId" | "siteId" | "originalCommandId" | "createdAt" | "id">) {
  return [value.principalId, value.siteId, value.originalCommandId ?? "", value.createdAt, value.id];
}

function publicCase(row: CaseRow) {
  const inProgress = row.recoveryDispatches.length > 0;
  if (!["outcome_unknown", "attempts_exhausted", "gateway_unavailable"].includes(row.reasonCode)) {
    throw new Error("invalid verification case reason");
  }
  return { caseId: row.id, originalCommandId: row.originalCommandId, siteId: row.siteId,
    targetCount: row._count.targets, verificationAttemptCount: row.verificationAttemptCount,
    status: inProgress ? "verification_in_progress" as const : "verification_required" as const,
    canRequestStatusCheck: !inProgress && row.verificationAttemptCount < 3,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    reasonCode: row.reasonCode as "outcome_unknown" | "attempts_exhausted" | "gateway_unavailable" };
}

function caseNotFound() {
  return new NotFoundException({ code: "verification_case_not_found", message: "verification case not found" });
}

function cursorUnavailable() {
  return new ServiceUnavailableException({ code: "verification_case_cursor_unavailable" });
}
