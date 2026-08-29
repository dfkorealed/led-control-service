import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type AutomationExecutionKind } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { SiteAccessService } from "../access/site-access.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import {
  AutomationSnapshotService,
  compareAutomationIds,
  normalizeAutomationAction,
  toVehicleEventRuleSnapshot
} from "./automation-snapshot.service";
import {
  encodeScheduleListCursor,
  parseScheduleListQuery
} from "./dto/schedule.dto";
import {
  type CreateVehicleEventRuleInput,
  parseCreateVehicleEventRuleInput,
  parseUpdateVehicleEventRuleInput,
  type UpdateVehicleEventRuleInput
} from "./dto/vehicle-event-rule.dto";
import { TargetSnapshotService } from "./target-snapshot.service";

const responseInclude = {
  sources: { select: { fixtureId: true }, orderBy: { fixtureId: "asc" as const } },
  targets: { select: { fixtureId: true }, orderBy: { fixtureId: "asc" as const } },
  gateway: {
    select: {
      automationConfiguration: {
        select: { desiredRevision: true, appliedRevision: true, syncStatus: true }
      }
    }
  }
} satisfies Prisma.VehicleEventRuleInclude;

const membershipInclude = {
  sources: { select: { fixtureId: true }, orderBy: { fixtureId: "asc" as const } },
  targets: { select: { fixtureId: true }, orderBy: { fixtureId: "asc" as const } }
} satisfies Prisma.VehicleEventRuleInclude;

const executionSelect = {
  id: true,
  vehicleEventRuleId: true,
  eventId: true,
  sequence: true,
  revision: true,
  occurrenceKey: true,
  kind: true,
  occurredAt: true,
  payload: true
} satisfies Prisma.AutomationExecutionSelect;

type VehicleEventRuleResponseRow = Prisma.VehicleEventRuleGetPayload<{ include: typeof responseInclude }>;
type ExecutionRow = Prisma.AutomationExecutionGetPayload<{ select: typeof executionSelect }>;

interface ExecutionSummary {
  latestByRuleId: Map<string, ExecutionRow>;
  detectionByRuleId: Map<string, ExecutionRow>;
}

@Injectable()
export class VehicleEventRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly siteAccess: SiteAccessService,
    private readonly targetSnapshot: TargetSnapshotService,
    private readonly automationSnapshot: AutomationSnapshotService
  ) {}

  async list(siteId: string, actor: AuthenticatedUser, rawQuery: unknown) {
    return this.prisma.$transaction(async (tx) => {
      await this.siteAccess.assertReadInTransaction(tx, actor, siteId);
      const query = parseScheduleListQuery(rawQuery, siteId);
      const pageWhere: Prisma.VehicleEventRuleWhereInput = query.cursor
        ? {
          siteId,
          OR: [
            { createdAt: { lt: query.cursor.createdAt } },
            { createdAt: query.cursor.createdAt, id: { gt: query.cursor.id } }
          ]
        }
        : { siteId };
      const total = await tx.vehicleEventRule.count({ where: { siteId } });
      const rows = await tx.vehicleEventRule.findMany({
        where: pageWhere,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        include: responseInclude,
        take: query.limit + 1
      });
      const hasNextPage = rows.length > query.limit;
      const rules = rows.slice(0, query.limit);
      const executions = await this.loadExecutionSummary(tx, rules.map(({ id }) => id));
      const lastRule = rules[rules.length - 1];
      return {
        items: rules.map((rule) => this.toResponse(rule, executions)),
        total,
        nextCursor: hasNextPage && lastRule
          ? encodeScheduleListCursor({ siteId, createdAt: lastRule.createdAt, id: lastRule.id })
          : null
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async create(siteId: string, actor: AuthenticatedUser, rawInput: unknown) {
    await this.siteAccess.assert(actor, siteId, "manage");
    const input = normalizeCreateInput(parseCreateVehicleEventRuleInput(rawInput));

    return this.prisma.$transaction(async (tx) => {
      await this.automationSnapshot.lockMutation(tx);
      await this.siteAccess.assertManageInTransaction(tx, actor, siteId);
      const membership = await this.resolveMembership(tx, siteId, input);
      const ruleId = randomUUID();
      await tx.vehicleEventRule.create({
        data: {
          id: ruleId,
          siteId,
          gatewayId: membership.gatewayId,
          ...vehicleEventRuleData(input),
          desiredRevision: 0,
          appliedRevision: 0,
          createdById: actor.id,
          updatedById: actor.id
        }
      });
      await tx.vehicleEventSource.createMany({
        data: membership.sourceFixtureIds.map((fixtureId) => ({
          ruleId,
          fixtureId,
          siteId,
          gatewayId: membership.gatewayId
        }))
      });
      await tx.vehicleEventTarget.createMany({
        data: membership.targetFixtureIds.map((fixtureId) => ({
          ruleId,
          fixtureId,
          siteId,
          gatewayId: membership.gatewayId
        }))
      });
      await this.automationSnapshot.incrementDesiredRevision(tx, membership.gatewayId);
      return this.findResponse(tx, siteId, ruleId);
    });
  }

  async update(siteId: string, ruleId: string, actor: AuthenticatedUser, rawInput: unknown) {
    await this.siteAccess.assert(actor, siteId, "manage");
    const input = normalizeUpdateInput(parseUpdateVehicleEventRuleInput(rawInput));

    return this.prisma.$transaction(async (tx) => {
      await this.automationSnapshot.lockMutation(tx);
      await this.siteAccess.assertManageInTransaction(tx, actor, siteId);
      const existing = await tx.vehicleEventRule.findFirst({
        where: { id: ruleId, siteId },
        include: membershipInclude
      });
      if (!existing) throw new NotFoundException("vehicle event rule not found");

      const sourceFixtureIds = input.sourceFixtureIds
        ?? existing.sources.map(({ fixtureId }) => fixtureId).sort(compareAutomationIds);
      const targetFixtureIds = input.targetFixtureIds
        ?? existing.targets.map(({ fixtureId }) => fixtureId).sort(compareAutomationIds);
      const membership = await this.resolveMembership(tx, siteId, { sourceFixtureIds, targetFixtureIds });
      const replacesMembership = input.sourceFixtureIds !== undefined || input.targetFixtureIds !== undefined;
      if (replacesMembership) {
        await tx.vehicleEventSource.deleteMany({ where: { ruleId } });
        await tx.vehicleEventTarget.deleteMany({ where: { ruleId } });
      }
      await tx.vehicleEventRule.update({
        where: { id: ruleId },
        data: {
          gatewayId: membership.gatewayId,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.action === undefined ? {} : {
            dimmingEnabled: input.action.dimmingEnabled,
            brightnessPercent: input.action.brightnessPercent
          }),
          ...(input.holdSeconds === undefined ? {} : { holdSeconds: input.holdSeconds }),
          ...(membership.gatewayId === existing.gatewayId ? {} : { appliedRevision: 0 }),
          updatedById: actor.id
        }
      });
      if (replacesMembership) {
        await tx.vehicleEventSource.createMany({
          data: sourceFixtureIds.map((fixtureId) => ({
            ruleId,
            fixtureId,
            siteId,
            gatewayId: membership.gatewayId
          }))
        });
        await tx.vehicleEventTarget.createMany({
          data: targetFixtureIds.map((fixtureId) => ({
            ruleId,
            fixtureId,
            siteId,
            gatewayId: membership.gatewayId
          }))
        });
      }

      for (const gatewayId of [...new Set([existing.gatewayId, membership.gatewayId])].sort(compareAutomationIds)) {
        await this.automationSnapshot.incrementDesiredRevision(tx, gatewayId);
      }
      return this.findResponse(tx, siteId, ruleId);
    });
  }

  async remove(siteId: string, ruleId: string, actor: AuthenticatedUser) {
    await this.siteAccess.assert(actor, siteId, "manage");

    return this.prisma.$transaction(async (tx) => {
      await this.automationSnapshot.lockMutation(tx);
      await this.siteAccess.assertManageInTransaction(tx, actor, siteId);
      const rule = await tx.vehicleEventRule.findFirst({
        where: { id: ruleId, siteId },
        select: { id: true, gatewayId: true }
      });
      if (!rule) throw new NotFoundException("vehicle event rule not found");

      await tx.vehicleEventRule.delete({ where: { id: rule.id } });
      const revision = await this.automationSnapshot.incrementDesiredRevision(tx, rule.gatewayId);
      return { id: rule.id, deleted: true, ...revision };
    });
  }

  private async resolveMembership(
    tx: Prisma.TransactionClient,
    siteId: string,
    input: Pick<CreateVehicleEventRuleInput, "sourceFixtureIds" | "targetFixtureIds">
  ) {
    const sourceFixtureIds = await this.targetSnapshot.resolve(tx, siteId, {
      type: "fixtures",
      fixtureIds: input.sourceFixtureIds
    });
    const targetFixtureIds = await this.targetSnapshot.resolve(tx, siteId, {
      type: "fixtures",
      fixtureIds: input.targetFixtureIds
    });
    const allFixtureIds = [...new Set([...sourceFixtureIds, ...targetFixtureIds])].sort(compareAutomationIds);
    const gatewayId = await this.targetSnapshot.assertSingleGateway(tx, allFixtureIds);
    return { sourceFixtureIds, targetFixtureIds, gatewayId };
  }

  private async findResponse(tx: Prisma.TransactionClient, siteId: string, ruleId: string) {
    const rule = await tx.vehicleEventRule.findFirst({
      where: { id: ruleId, siteId },
      include: responseInclude
    });
    if (!rule) throw new NotFoundException("vehicle event rule not found");
    const executions = await this.loadExecutionSummary(tx, [rule.id]);
    return this.toResponse(rule, executions);
  }

  private async loadExecutionSummary(
    tx: Prisma.TransactionClient,
    ruleIds: string[]
  ): Promise<ExecutionSummary> {
    if (ruleIds.length === 0) {
      return { latestByRuleId: new Map(), detectionByRuleId: new Map() };
    }
    const ruleIdSql = Prisma.join(ruleIds);
    const [latest, detections] = await Promise.all([
      tx.$queryRaw<ExecutionRow[]>(Prisma.sql`
        SELECT DISTINCT ON ("vehicleEventRuleId")
          "id", "vehicleEventRuleId", "eventId", "sequence", "revision", "occurrenceKey", "kind", "occurredAt", "payload"
        FROM "AutomationExecution"
        WHERE "vehicleEventRuleId" IN (${ruleIdSql})
        ORDER BY "vehicleEventRuleId" ASC, "occurredAt" DESC, "sequence" DESC
      `),
      tx.$queryRaw<ExecutionRow[]>(Prisma.sql`
        SELECT DISTINCT ON ("vehicleEventRuleId")
          "id", "vehicleEventRuleId", "eventId", "sequence", "revision", "occurrenceKey", "kind", "occurredAt", "payload"
        FROM "AutomationExecution"
        WHERE "vehicleEventRuleId" IN (${ruleIdSql})
          AND "kind" = 'vehicle_detected'::"AutomationExecutionKind"
        ORDER BY "vehicleEventRuleId" ASC, "occurredAt" DESC, "sequence" DESC
      `)
    ]);
    return {
      latestByRuleId: indexExecutions(latest),
      detectionByRuleId: indexExecutions(detections)
    };
  }

  private toResponse(rule: VehicleEventRuleResponseRow, executions: ExecutionSummary) {
    const snapshot = toVehicleEventRuleSnapshot(rule);
    const configuration = rule.gateway.automationConfiguration;
    return {
      ...snapshot,
      gatewayId: rule.gatewayId,
      sources: rule.sources.map(({ fixtureId }) => ({ fixtureId })),
      targets: rule.targets.map(({ fixtureId }) => ({ fixtureId })),
      sourceCount: rule.sources.length,
      targetCount: rule.targets.length,
      desiredRevision: rule.desiredRevision,
      appliedRevision: rule.appliedRevision,
      syncStatus: configuration?.syncStatus ?? "PENDING",
      lastDetection: toExecutionResponse(executions.detectionByRuleId.get(rule.id)),
      lastExecution: toExecutionResponse(executions.latestByRuleId.get(rule.id)),
      createdById: rule.createdById,
      updatedById: rule.updatedById,
      createdAt: rule.createdAt.toISOString(),
      updatedAt: rule.updatedAt.toISOString()
    };
  }
}

function normalizeCreateInput(input: CreateVehicleEventRuleInput): CreateVehicleEventRuleInput {
  return { ...input, action: normalizeAutomationAction(input.action) };
}

function normalizeUpdateInput(input: UpdateVehicleEventRuleInput): UpdateVehicleEventRuleInput {
  return input.action ? { ...input, action: normalizeAutomationAction(input.action) } : input;
}

function vehicleEventRuleData(input: CreateVehicleEventRuleInput) {
  return {
    name: input.name,
    status: input.status,
    dimmingEnabled: input.action.dimmingEnabled,
    brightnessPercent: input.action.brightnessPercent,
    holdSeconds: input.holdSeconds
  };
}

function indexExecutions(executions: ExecutionRow[]) {
  return new Map(executions.flatMap((execution) =>
    execution.vehicleEventRuleId ? [[execution.vehicleEventRuleId, execution] as const] : []
  ));
}

function toExecutionResponse(execution: ExecutionRow | undefined) {
  return execution
    ? {
      id: execution.id,
      eventId: execution.eventId,
      sequence: execution.sequence.toString(),
      revision: execution.revision,
      occurrenceKey: execution.occurrenceKey,
      kind: execution.kind as AutomationExecutionKind,
      occurredAt: execution.occurredAt.toISOString(),
      payload: execution.payload
    }
    : null;
}
