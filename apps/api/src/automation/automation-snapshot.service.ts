import { Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import {
  automationSnapshotV1Schema,
  type LightingScheduleSnapshotV1,
  mqttTopics,
  type VehicleEventRuleSnapshotV1
} from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { AutomationClock } from "./automation-clock";

interface LightingScheduleSnapshotRow {
  id: string;
  name: string;
  status: "enabled" | "disabled";
  activeFrom: Date;
  activeUntil: Date;
  localStartTime: string;
  localEndTime: string;
  recurrenceKind: "once" | "daily" | "weekly" | "monthly" | "yearly";
  weeklyDays: number[];
  monthlyDay: number | null;
  yearlyMonth: number | null;
  yearlyDay: number | null;
  dimmingEnabled: boolean;
  brightnessPercent: number;
  fixtures: Array<{ fixtureId: string }>;
}

const snapshotScheduleInclude = {
  fixtures: { select: { fixtureId: true } }
} satisfies Prisma.LightingScheduleInclude;

@Injectable()
export class AutomationSnapshotService {
  constructor(private readonly clock: AutomationClock) {}

  async lockMutation(tx: Prisma.TransactionClient) {
    await tx.$executeRaw(Prisma.sql`SELECT "lock_automation_membership_mutation"()`);
  }

  async incrementDesiredRevision(tx: Prisma.TransactionClient, gatewayId: string) {
    const gateway = await tx.gateway.findUnique({
      where: { id: gatewayId },
      select: {
        id: true,
        siteId: true,
        site: { select: { timeZone: true } },
        automationConfiguration: { select: { desiredRevision: true, appliedRevision: true } }
      }
    });
    if (!gateway) throw new NotFoundException("gateway not found");
    const desiredRevision = (gateway.automationConfiguration?.desiredRevision ?? 0) + 1;
    if (!Number.isSafeInteger(desiredRevision)) {
      throw new InternalServerErrorException("automation revision exhausted");
    }

    await tx.lightingSchedule.updateMany({ where: { gatewayId }, data: { desiredRevision } });
    await tx.vehicleEventRule.updateMany({ where: { gatewayId }, data: { desiredRevision } });

    const schedules = await tx.lightingSchedule.findMany({
      where: { gatewayId },
      include: snapshotScheduleInclude,
      orderBy: { id: "asc" }
    });
    const eventRules = await tx.vehicleEventRule.findMany({
      where: { gatewayId },
      include: {
        sources: { select: { fixtureId: true }, orderBy: { fixtureId: "asc" } },
        targets: { select: { fixtureId: true }, orderBy: { fixtureId: "asc" } }
      },
      orderBy: { id: "asc" }
    });
    const snapshotWithoutHash = {
      schemaVersion: 1 as const,
      siteId: gateway.siteId,
      gatewayId,
      revision: desiredRevision,
      timeZone: gateway.site.timeZone,
      schedules: schedules
        .map(toLightingScheduleSnapshot)
        .sort((left, right) => compareAutomationIds(left.id, right.id)),
      vehicleEventRules: eventRules
        .map(toVehicleEventRuleSnapshot)
        .sort((left, right) => compareAutomationIds(left.id, right.id)),
      generatedAt: this.clock.now().toISOString()
    };
    const payloadHash = `sha256:${createHash("sha256")
      .update(canonicalAutomationJson(snapshotWithoutHash))
      .digest("hex")}` as const;
    const payload = automationSnapshotV1Schema.parse({ ...snapshotWithoutHash, payloadHash });

    const configuration = await tx.gatewayAutomationConfiguration.upsert({
      where: { gatewayId },
      create: {
        gatewayId,
        siteId: gateway.siteId,
        desiredRevision,
        appliedRevision: 0,
        syncStatus: "PENDING",
        payloadHash
      },
      update: {
        desiredRevision,
        syncStatus: "PENDING",
        payloadHash,
        lastErrorCode: null
      },
      select: { desiredRevision: true, appliedRevision: true, syncStatus: true }
    });
    await tx.mqttOutbox.create({
      data: {
        gatewayId,
        revision: desiredRevision,
        payloadHash,
        topic: mqttTopics.automationConfig(gateway.siteId, gatewayId),
        payload: payload as unknown as Prisma.InputJsonValue
      }
    });
    return configuration;
  }
}

export function normalizeAutomationAction(action: LightingScheduleSnapshotV1["action"]) {
  return action.dimmingEnabled ? action : { dimmingEnabled: false, brightnessPercent: 100 };
}

export function toLightingScheduleSnapshot(
  schedule: LightingScheduleSnapshotRow
): LightingScheduleSnapshotV1 {
  return {
    id: schedule.id,
    name: schedule.name,
    status: schedule.status,
    activeFrom: schedule.activeFrom.toISOString(),
    activeUntil: schedule.activeUntil.toISOString(),
    localStartTime: schedule.localStartTime,
    localEndTime: schedule.localEndTime,
    recurrence: {
      kind: schedule.recurrenceKind,
      weeklyDays: [...schedule.weeklyDays].sort((left, right) => left - right),
      monthlyDay: schedule.monthlyDay,
      yearlyMonth: schedule.yearlyMonth,
      yearlyDay: schedule.yearlyDay
    },
    action: normalizeAutomationAction({
      dimmingEnabled: schedule.dimmingEnabled,
      brightnessPercent: schedule.brightnessPercent
    }),
    fixtureIds: schedule.fixtures.map(({ fixtureId }) => fixtureId).sort(compareAutomationIds)
  };
}

function toVehicleEventRuleSnapshot(rule: {
  id: string;
  name: string;
  status: "enabled" | "disabled";
  dimmingEnabled: boolean;
  brightnessPercent: number;
  holdSeconds: number;
  sources: Array<{ fixtureId: string }>;
  targets: Array<{ fixtureId: string }>;
}): VehicleEventRuleSnapshotV1 {
  return {
    id: rule.id,
    name: rule.name,
    status: rule.status,
    sourceFixtureIds: rule.sources.map(({ fixtureId }) => fixtureId).sort(compareAutomationIds),
    targetFixtureIds: rule.targets.map(({ fixtureId }) => fixtureId).sort(compareAutomationIds),
    action: normalizeAutomationAction({
      dimmingEnabled: rule.dimmingEnabled,
      brightnessPercent: rule.brightnessPercent
    }),
    holdSeconds: rule.holdSeconds
  };
}

function canonicalAutomationJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareAutomationIds(left, right))
      .map(([key, child]) => [key, sortJson(child)])
  );
}

export function compareAutomationIds(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
