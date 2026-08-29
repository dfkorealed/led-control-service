import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { getNextOccurrence, schedulesOverlap } from "@led-control/automation-engine";
import { type LightingScheduleSnapshotV1, lightingScheduleSnapshotV1Schema } from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { SiteAccessService } from "../access/site-access.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { AutomationClock } from "./automation-clock";
import {
  AutomationSnapshotService,
  compareAutomationIds,
  normalizeAutomationAction,
  toLightingScheduleSnapshot
} from "./automation-snapshot.service";
import {
  type CreateScheduleInput,
  parseCreateScheduleInput,
  parseUpdateScheduleInput,
  type ScheduleListQuery,
  type UpdateScheduleInput
} from "./dto/schedule.dto";
import { TargetSnapshotService } from "./target-snapshot.service";

const responseInclude = {
  fixtures: { select: { fixtureId: true }, orderBy: { fixtureId: "asc" as const } },
  gateway: {
    select: {
      automationConfiguration: {
        select: { desiredRevision: true, appliedRevision: true, syncStatus: true }
      }
    }
  },
  executions: {
    orderBy: [{ occurredAt: "desc" as const }, { sequence: "desc" as const }],
    take: 1,
    select: {
      id: true,
      eventId: true,
      sequence: true,
      revision: true,
      occurrenceKey: true,
      kind: true,
      occurredAt: true,
      payload: true
    }
  }
} satisfies Prisma.LightingScheduleInclude;

const overlapInclude = {
  fixtures: { select: { fixtureId: true } }
} satisfies Prisma.LightingScheduleInclude;

type ScheduleResponseRow = Prisma.LightingScheduleGetPayload<{ include: typeof responseInclude }>;
type ScheduleOverlapRow = Prisma.LightingScheduleGetPayload<{ include: typeof overlapInclude }>;

@Injectable()
export class SchedulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService,
    private readonly targetSnapshot: TargetSnapshotService,
    private readonly clock: AutomationClock,
    private readonly automationSnapshot: AutomationSnapshotService
  ) {}

  async list(siteId: string, actor: AuthenticatedUser, query: ScheduleListQuery) {
    await this.siteAccess.assert(actor, siteId, "read");
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { timeZone: true }
    });
    if (!site) throw new NotFoundException("site not found");

    const [total, rows] = await Promise.all([
      this.prisma.lightingSchedule.count({ where: { siteId } }),
      this.prisma.lightingSchedule.findMany({
        where: { siteId },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        include: responseInclude,
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {})
      })
    ]);
    const hasNextPage = rows.length > query.limit;
    const schedules = rows.slice(0, query.limit);
    const now = this.clock.now();
    return {
      items: schedules.map((schedule) => this.toResponse(schedule, site.timeZone, now)),
      total,
      nextCursor: hasNextPage ? schedules[schedules.length - 1]?.id ?? null : null
    };
  }

  async create(siteId: string, actor: AuthenticatedUser, rawInput: unknown) {
    await this.siteAccess.assert(actor, siteId, "manage");
    const input = normalizeCreateInput(parseCreateScheduleInput(rawInput));

    return this.prisma.$transaction(async (tx) => {
      await this.automationSnapshot.lockMutation(tx);
      await this.siteAccess.assertManageInTransaction(tx, actor, siteId);
      const site = await this.requireSiteTimeZone(tx, siteId);
      const fixtureIds = await this.targetSnapshot.resolve(tx, siteId, input.target);
      const gatewayId = await this.targetSnapshot.assertSingleGateway(tx, fixtureIds);
      const scheduleId = randomUUID();
      const candidate = toCandidate(scheduleId, input, fixtureIds);
      await this.assertNoOverlap(tx, siteId, gatewayId, fixtureIds, candidate);

      await tx.lightingSchedule.create({
        data: {
          id: scheduleId,
          siteId,
          gatewayId,
          ...scheduleData(candidate),
          desiredRevision: 0,
          appliedRevision: 0,
          createdById: actor.id,
          updatedById: actor.id
        }
      });
      await tx.lightingScheduleFixture.createMany({
        data: fixtureIds.map((fixtureId) => ({ scheduleId, fixtureId, siteId, gatewayId }))
      });
      await this.automationSnapshot.incrementDesiredRevision(tx, gatewayId);

      const created = await this.findResponseRow(tx, siteId, scheduleId);
      return this.toResponse(created, site.timeZone, this.clock.now());
    });
  }

  async update(siteId: string, scheduleId: string, actor: AuthenticatedUser, rawInput: unknown) {
    await this.siteAccess.assert(actor, siteId, "manage");
    const input = normalizeUpdateInput(parseUpdateScheduleInput(rawInput));

    return this.prisma.$transaction(async (tx) => {
      await this.automationSnapshot.lockMutation(tx);
      await this.siteAccess.assertManageInTransaction(tx, actor, siteId);
      const site = await this.requireSiteTimeZone(tx, siteId);
      const existing = await tx.lightingSchedule.findFirst({
        where: { id: scheduleId, siteId },
        include: overlapInclude
      });
      if (!existing) throw new NotFoundException("schedule not found");

      const fixtureIds = input.target
        ? await this.targetSnapshot.resolve(tx, siteId, input.target)
        : existing.fixtures.map((fixture) => fixture.fixtureId).sort(compareAutomationIds);
      const gatewayId = input.target
        ? await this.targetSnapshot.assertSingleGateway(tx, fixtureIds)
        : existing.gatewayId;
      const candidate = validateCandidate(mergeCandidate(existing, input, fixtureIds));
      await this.assertNoOverlap(tx, siteId, gatewayId, fixtureIds, candidate, scheduleId);

      if (input.target) {
        await tx.lightingScheduleFixture.deleteMany({ where: { scheduleId } });
      }
      await tx.lightingSchedule.update({
        where: { id: scheduleId },
        data: {
          gatewayId,
          ...scheduleData(candidate),
          ...(gatewayId === existing.gatewayId ? {} : { appliedRevision: 0 }),
          updatedById: actor.id
        }
      });
      if (input.target) {
        await tx.lightingScheduleFixture.createMany({
          data: fixtureIds.map((fixtureId) => ({ scheduleId, fixtureId, siteId, gatewayId }))
        });
      }

      for (const affectedGatewayId of [...new Set([existing.gatewayId, gatewayId])].sort(compareAutomationIds)) {
        await this.automationSnapshot.incrementDesiredRevision(tx, affectedGatewayId);
      }

      const updated = await this.findResponseRow(tx, siteId, scheduleId);
      return this.toResponse(updated, site.timeZone, this.clock.now());
    });
  }

  async remove(siteId: string, scheduleId: string, actor: AuthenticatedUser) {
    await this.siteAccess.assert(actor, siteId, "manage");

    return this.prisma.$transaction(async (tx) => {
      await this.automationSnapshot.lockMutation(tx);
      await this.siteAccess.assertManageInTransaction(tx, actor, siteId);
      const schedule = await tx.lightingSchedule.findFirst({
        where: { id: scheduleId, siteId },
        select: { id: true, gatewayId: true }
      });
      if (!schedule) throw new NotFoundException("schedule not found");

      await tx.lightingSchedule.delete({ where: { id: schedule.id } });
      const revision = await this.automationSnapshot.incrementDesiredRevision(tx, schedule.gatewayId);
      return { id: schedule.id, deleted: true, ...revision };
    });
  }

  private async assertNoOverlap(
    tx: Prisma.TransactionClient,
    siteId: string,
    gatewayId: string,
    fixtureIds: string[],
    candidate: LightingScheduleSnapshotV1,
    excludedScheduleId?: string
  ) {
    if (candidate.status === "disabled") return;
    const site = await this.requireSiteTimeZone(tx, siteId);
    const schedules = await tx.lightingSchedule.findMany({
      where: {
        siteId,
        gatewayId,
        status: "enabled",
        ...(excludedScheduleId ? { id: { not: excludedScheduleId } } : {}),
        fixtures: { some: { fixtureId: { in: fixtureIds } } }
      },
      include: overlapInclude
    });
    if (schedules.some((schedule) => schedulesOverlap(candidate, toLightingScheduleSnapshot(schedule), site.timeZone))) {
      throw new ConflictException({ code: "schedule_overlap" });
    }
  }

  private async requireSiteTimeZone(tx: Prisma.TransactionClient, siteId: string) {
    const site = await tx.site.findUnique({ where: { id: siteId }, select: { timeZone: true } });
    if (!site) throw new NotFoundException("site not found");
    return site;
  }

  private async findResponseRow(tx: Prisma.TransactionClient, siteId: string, scheduleId: string) {
    const schedule = await tx.lightingSchedule.findFirst({
      where: { id: scheduleId, siteId },
      include: responseInclude
    });
    if (!schedule) throw new NotFoundException("schedule not found");
    return schedule;
  }

  private toResponse(schedule: ScheduleResponseRow, timeZone: string, now: Date) {
    const snapshot = toLightingScheduleSnapshot(schedule);
    const occurrence = getNextOccurrence(snapshot, now.getTime(), timeZone);
    const configuration = schedule.gateway.automationConfiguration;
    const execution = schedule.executions[0] ?? null;
    return {
      ...snapshot,
      gatewayId: schedule.gatewayId,
      targets: schedule.fixtures.map(({ fixtureId }) => ({ fixtureId })),
      targetCount: schedule.fixtures.length,
      desiredRevision: schedule.desiredRevision,
      appliedRevision: schedule.appliedRevision,
      syncStatus: configuration?.syncStatus ?? "PENDING",
      nextOccurrence: occurrence
        ? {
          key: occurrence.key,
          localDate: occurrence.localDate,
          startsAt: new Date(occurrence.startsAtEpochMs).toISOString(),
          endsAt: new Date(occurrence.endsAtEpochMs).toISOString()
        }
        : null,
      lastExecution: execution
        ? {
          ...execution,
          sequence: execution.sequence.toString(),
          occurredAt: execution.occurredAt.toISOString()
        }
        : null,
      createdById: schedule.createdById,
      updatedById: schedule.updatedById,
      createdAt: schedule.createdAt.toISOString(),
      updatedAt: schedule.updatedAt.toISOString()
    };
  }
}

function normalizeCreateInput(input: CreateScheduleInput): CreateScheduleInput {
  return {
    ...input,
    action: normalizeAutomationAction(input.action)
  };
}

function normalizeUpdateInput(input: UpdateScheduleInput): UpdateScheduleInput {
  return input.action ? { ...input, action: normalizeAutomationAction(input.action) } : input;
}

function toCandidate(
  id: string,
  input: CreateScheduleInput,
  fixtureIds: string[]
): LightingScheduleSnapshotV1 {
  const { target: _target, ...schedule } = input;
  return { id, ...schedule, fixtureIds };
}

function mergeCandidate(
  existing: ScheduleOverlapRow,
  input: UpdateScheduleInput,
  fixtureIds: string[]
): LightingScheduleSnapshotV1 {
  const current = toLightingScheduleSnapshot(existing);
  return {
    ...current,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.activeFrom === undefined ? {} : { activeFrom: input.activeFrom }),
    ...(input.activeUntil === undefined ? {} : { activeUntil: input.activeUntil }),
    ...(input.localStartTime === undefined ? {} : { localStartTime: input.localStartTime }),
    ...(input.localEndTime === undefined ? {} : { localEndTime: input.localEndTime }),
    ...(input.recurrence === undefined ? {} : { recurrence: input.recurrence }),
    ...(input.action === undefined ? {} : { action: input.action }),
    fixtureIds
  };
}

function validateCandidate(candidate: LightingScheduleSnapshotV1) {
  const parsed = lightingScheduleSnapshotV1Schema.safeParse(candidate);
  if (!parsed.success) throw new BadRequestException("invalid automation schedule update");
  return parsed.data;
}

function scheduleData(schedule: LightingScheduleSnapshotV1) {
  return {
    name: schedule.name,
    status: schedule.status,
    activeFrom: new Date(schedule.activeFrom),
    activeUntil: new Date(schedule.activeUntil),
    localStartTime: schedule.localStartTime,
    localEndTime: schedule.localEndTime,
    recurrenceKind: schedule.recurrence.kind,
    weeklyDays: [...schedule.recurrence.weeklyDays].sort((left, right) => left - right),
    monthlyDay: schedule.recurrence.monthlyDay,
    yearlyMonth: schedule.recurrence.yearlyMonth,
    yearlyDay: schedule.recurrence.yearlyDay,
    dimmingEnabled: schedule.action.dimmingEnabled,
    brightnessPercent: schedule.action.brightnessPercent
  };
}
