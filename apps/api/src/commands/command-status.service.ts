import { BadRequestException, GoneException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { threeCalendarMonthsBefore } from "../retention/calendar-month-window";
import { commandHistoryRetentionReady } from "./command-history-rollout";

type ResultStatus = "pending" | "succeeded" | "failed" | "timed_out";

const commandStages = ["queued", "published", "accepted", "completed", "partial_failed", "failed", "timed_out",
  "verification_required", "verified_applied", "verified_not_applied", "verified_partial"] as const;
export const commandHistoryQuerySchema = z.object({
  siteId: z.string().uuid(),
  query: z.string().trim().max(100).optional(),
  stage: z.enum(commandStages).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.union([z.string().regex(/^\d+$/).transform(Number), z.number()]).pipe(z.number().int().min(1).max(100)).default(20)
}).strict();
type HistoryInput = { siteId: string; query?: string; stage?: typeof commandStages[number]; cursor?: string; limit?: number };

const historyInclude = {
  dispatches: { select: { kind: true, verificationAttempt: true, status: true, errorCode: true,
    fixtureResults: { select: { fixtureId: true, status: true } } } }
} satisfies Prisma.CommandInclude;
type SummaryCommand = Prisma.CommandGetPayload<{ include: typeof historyInclude }>;

@Injectable()
export class CommandStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService
  ) {}

  async listCommands(user: AuthenticatedUser, input: HistoryInput, now = new Date()) {
    await this.siteAccess.assert(user, input.siteId, "read");
    const retentionEnabled = await commandHistoryRetentionReady(this.prisma, input.siteId, now);
    const retainedFrom = threeCalendarMonthsBefore(now);
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (input.query?.length ?? 0) > 100) {
      throw new BadRequestException("invalid command history query");
    }
    const filters: Prisma.CommandWhereInput[] = retentionEnabled ? [{ createdAt: { gte: retainedFrom } }] : [];
    const query = input.query?.trim();
    if (query) filters.push({ OR: [
      { id: { startsWith: query, mode: "insensitive" } },
      { dispatches: { some: { fixtureResults: { some: { fixture: { name: { contains: query, mode: "insensitive" } } } } } } }
    ] });
    if (input.stage) filters.push(stageFilter(input.stage));
    if (input.cursor) {
      const cursor = parseHistoryCursor(input.cursor);
      if (retentionEnabled && cursor.createdAt < retainedFrom) {
        throw new BadRequestException({ code: "command_history_cursor_expired" });
      }
      filters.push({ OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } }
      ] });
    }
    const commands = await this.prisma.command.findMany({
      // Keep siteId outside all search/cursor OR predicates to prevent scope escape.
      where: { siteId: input.siteId, AND: filters },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      include: historyInclude
    });
    const page = commands.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(summarizeCommand),
      ...(retentionEnabled ? { generatedAt: now.toISOString(), retainedFrom: retainedFrom.toISOString() } : {}),
      nextCursor: commands.length > limit && last ? Buffer.from(JSON.stringify({
        id: last.id, createdAt: last.createdAt.toISOString()
      })).toString("base64url") : null
    };
  }

  async getCommand(user: AuthenticatedUser, commandId: string, now = new Date()) {
    const scopedCommand = await this.prisma.command.findUnique({
      where: { id: commandId },
      select: { siteId: true, createdAt: true }
    });
    if (!scopedCommand) {
      // Once the Command row is physically gone, only a minimal unresolved
      // recovery case may establish an authorized payload-free expiry answer.
      const hold = await this.prisma.unresolvedCommandHold.findUnique({
        where: { originalCommandId: commandId }, select: { siteId: true }
      });
      if (!hold) throw commandNotFound();
      try {
        await this.siteAccess.assert(user, hold.siteId, "read");
      } catch (error) {
        if (error instanceof NotFoundException) throw commandNotFound();
        throw error;
      }
      throw new GoneException({ code: "command_expired" });
    }
    try {
      await this.siteAccess.assert(user, scopedCommand.siteId, "read");
    } catch (error) {
      if (error instanceof NotFoundException) throw commandNotFound();
      throw error;
    }
    // A delayed physical sweep must never extend the customer-visible history window.
    if (await commandHistoryRetentionReady(this.prisma, scopedCommand.siteId, now)
      && scopedCommand.createdAt < threeCalendarMonthsBefore(now)) {
      throw new GoneException({ code: "command_expired" });
    }

    const command = await this.prisma.command.findUnique({
      where: { id: commandId },
      include: {
        dispatches: {
          orderBy: { createdAt: "asc" },
          include: {
            gateway: { select: { id: true, name: true } },
            fixtureResults: {
              orderBy: { fixture: { name: "asc" } },
              include: { fixture: { select: { name: true } } }
            }
          }
        }
      }
    });
    if (!command) {
      const hold = await this.prisma.unresolvedCommandHold.findUnique({
        where: { originalCommandId: commandId }, select: { siteId: true }
      });
      if (hold?.siteId === scopedCommand.siteId) throw new GoneException({ code: "command_expired" });
      throw commandNotFound();
    }

    return {
      ...summarizeCommand(command),
      dispatches: command.dispatches.map((dispatch) => ({
        id: dispatch.id,
        kind: dispatch.kind,
        verificationAttempt: dispatch.verificationAttempt,
        deliveryMode: dispatch.deliveryMode,
        destinationAddress: dispatch.destinationAddress,
        meshControlGroupId: dispatch.meshControlGroupId,
        meshControlGroupVersion: dispatch.meshControlGroupVersion,
        status: dispatch.status,
        gateway: dispatch.gateway,
        publishedAt: toIso(dispatch.publishedAt),
        acceptedAt: toIso(dispatch.acceptedAt),
        completedAt: toIso(dispatch.completedAt),
        errorCode: dispatch.errorCode,
        errorMessage: dispatch.errorMessage,
        results: dispatch.fixtureResults.map((result) => ({
          fixtureId: result.fixtureId,
          fixtureName: result.fixture.name,
          status: result.status,
          brightness: result.brightness,
          faultCode: result.faultCode,
          errorMessage: result.errorMessage,
          occurredAt: toIso(result.occurredAt)
        }))
      }))
    };
  }
}

function commandNotFound() {
  return new NotFoundException({ code: "command_not_found", message: "command not found" });
}

function summarizeCommand(command: SummaryCommand) {
  const verificationAttemptCount = Math.max(0, ...command.dispatches
    .filter((dispatch) => dispatch.kind === "status_check").map((dispatch) => dispatch.verificationAttempt ?? 0));
  // Verification creates another result per fixture; the original Set counts must
  // not multiply every time an operator asks to read its current physical state.
  const dimming = command.dispatches.filter((dispatch) => dispatch.kind !== "status_check");
  const statuses = dimming.flatMap((dispatch) => dispatch.fixtureResults.map((result) => result.status));
  const outcome = command.outcome ?? null;
  const verified = verificationAttemptCount > 0;
  const stage = outcome === "unknown" ? "verification_required"
    : outcome === "applied" ? (verified ? "verified_applied" : "completed")
    : outcome === "not_applied" ? (verified ? "verified_not_applied" : "failed")
    : outcome === "partially_applied" ? (verified ? "verified_partial" : "partial_failed")
    : deriveCommandStage(command.status, dimming.map((dispatch) => dispatch.status), statuses);
  const targetIds = Array.isArray(command.targetFixtureIds) ? command.targetFixtureIds : [];
  const clockRefusal = outcome === "not_applied" && dimming.length === 1
    && dimming[0].status === "failed" && dimming[0].errorCode === "GATEWAY_CLOCK_UNTRUSTED"
    && targetIds.length > 0 && targetIds.every((id) => typeof id === "string")
    && new Set(targetIds).size === targetIds.length
    && dimming[0].fixtureResults.length === targetIds.length
    && dimming[0].fixtureResults.every((result) => result.status === "failed"
      && targetIds.includes(result.fixtureId))
    && new Set(dimming[0].fixtureResults.map((result) => result.fixtureId)).size === targetIds.length;
  return {
    id: command.id, siteId: command.siteId, targetType: command.targetType, targetId: command.targetId,
    targetFixtureIds: command.targetFixtureIds, brightness: command.brightness, status: command.status,
    outcome, stage, ...(clockRefusal ? { errorCode: "GATEWAY_CLOCK_UNTRUSTED" as const } : {}),
    verificationAttemptCount, errorMessage: command.errorMessage, dispatchCount: command.dispatches.length,
    completedFixtureCount: statuses.filter((status) => status !== "pending").length, totalFixtureCount: statuses.length,
    createdAt: command.createdAt.toISOString(), updatedAt: command.updatedAt.toISOString()
  };
}

function parseHistoryCursor(cursor: string) {
  try {
    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("invalid encoding");
    const parsed = z.object({ id: z.string().uuid(), createdAt: z.string().datetime() }).strict()
      .parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return { id: parsed.id, createdAt: new Date(parsed.createdAt) };
  } catch {
    throw new BadRequestException("invalid command history cursor");
  }
}

function stageFilter(stage: typeof commandStages[number]): Prisma.CommandWhereInput {
  if (stage === "verification_required") return { outcome: "unknown" };
  const checks: Prisma.CommandWhereInput = { dispatches: { some: { kind: "status_check", verificationAttempt: { gt: 0 } } } };
  const verifiedOutcomes = { verified_applied: "applied", verified_not_applied: "not_applied", verified_partial: "partially_applied" } as const;
  if (stage in verifiedOutcomes) return { AND: [{ outcome: verifiedOutcomes[stage as keyof typeof verifiedOutcomes] }, checks] };

  const result = (status: Prisma.CommandFixtureResultWhereInput["status"]): Prisma.CommandWhereInput => ({
    dispatches: { some: { kind: "dimming", fixtureResults: { some: { status } } } }
  });
  const dispatch = (status: Prisma.CommandDispatchWhereInput["status"]): Prisma.CommandWhereInput => ({ dispatches: { some: { kind: "dimming", status } } });
  const succeeded = result("succeeded");
  const failed = result({ in: ["failed", "timed_out"] });
  // The ordered conditions mirror legacy stage precedence, including mixed results.
  const legacyConditions: Array<{ stage: string; where: Prisma.CommandWhereInput }> = [
    { stage: "partial_failed", where: { AND: [succeeded, failed] } },
    { stage: "completed", where: { AND: [succeeded, { NOT: result({ not: "succeeded" }) }] } },
    { stage: "timed_out", where: { OR: [result("timed_out"), dispatch("timed_out")] } },
    { stage: "failed", where: { OR: [{ status: "failed" }, dispatch("failed"), failed] } },
    { stage: "accepted", where: dispatch("accepted") },
    { stage: "published", where: dispatch("published") },
    { stage: "queued", where: {} }
  ];
  const index = legacyConditions.findIndex((condition) => condition.stage === stage);
  if (index < 0) throw new BadRequestException("invalid command history stage");
  const legacy: Prisma.CommandWhereInput = { AND: [
    { OR: [{ outcome: null }, { outcome: "pending" }] }, legacyConditions[index].where,
    ...legacyConditions.slice(0, index).map(({ where }) => ({ NOT: where }))
  ] };
  const outcomes = { completed: "applied", failed: "not_applied", partial_failed: "partially_applied" } as const;
  return stage in outcomes ? { OR: [
    { AND: [{ outcome: outcomes[stage as keyof typeof outcomes] }, { NOT: checks }] }, legacy
  ] } : legacy;
}

function deriveCommandStage(commandStatus: string, dispatchStatuses: string[], resultStatuses: ResultStatus[]) {
  const succeeded = resultStatuses.filter((status) => status === "succeeded").length;
  const failed = resultStatuses.filter((status) => status === "failed" || status === "timed_out").length;
  if (succeeded > 0 && failed > 0) return "partial_failed" as const;
  if (resultStatuses.length > 0 && succeeded === resultStatuses.length) return "completed" as const;
  if (resultStatuses.includes("timed_out") || dispatchStatuses.includes("timed_out")) return "timed_out" as const;
  if (commandStatus === "failed" || dispatchStatuses.includes("failed") || failed > 0) return "failed" as const;
  if (dispatchStatuses.includes("accepted")) return "accepted" as const;
  if (dispatchStatuses.includes("published")) return "published" as const;
  return "queued" as const;
}

function toIso(value: Date | null | undefined) {
  return value?.toISOString() ?? null;
}
