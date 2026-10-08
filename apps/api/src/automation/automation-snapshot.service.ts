import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import {
  automationSnapshotSchema,
  type LightingScheduleSnapshotV1,
  mqttTopics,
  type VehicleEventRuleSnapshotV1
} from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { AutomationClock } from "./automation-clock";
import { canonicalPayloadHash } from "./automation-payload-hash";

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
        assignmentVersion: true,
        inventory: { select: { id: true, claimedAt: true, disabledAt: true } },
        certificates: { where: { purpose: "mqtt", status: "active", revokedAt: null }, select: { inventoryId: true } },
        automationProtocolDeclarations: { orderBy: [{ assignmentVersion: "desc" }, { declarationRevision: "desc" }],
          take: 1, select: { assignmentVersion: true, maxSnapshotVersion: true } },
        site: { select: { timeZone: true } },
        automationConfiguration: { select: { desiredRevision: true, appliedRevision: true } }
      }
    });
    if (!gateway) throw new NotFoundException("gateway not found");
    const declaration = gateway.automationProtocolDeclarations?.[0];
    const version = declaration?.assignmentVersion === gateway.assignmentVersion
      && declaration?.maxSnapshotVersion === 2 && gateway.inventory?.claimedAt
      && !gateway.inventory.disabledAt && gateway.certificates?.some(certificate =>
        certificate.inventoryId === gateway.inventory?.id) ? 2 : 1;
    const desiredRevision = (gateway.automationConfiguration?.desiredRevision ?? 0) + 1;
    if (!Number.isSafeInteger(desiredRevision)) {
      throw new InternalServerErrorException("automation revision exhausted");
    }

    await tx.lightingSchedule.updateMany({ where: { gatewayId }, data: { desiredRevision } });
    await tx.vehicleEventRule.updateMany({ where: { gatewayId }, data: { desiredRevision } });
    if (version === 1) {
      // Losing declaration authority cannot turn BIO into BlueZ, even for a
      // legacy enabled row. Keep its draft pending while publishing V1 peers.
      await tx.vehicleEventRule.updateMany({ where: { gatewayId, sensorProtocol: "bio_usb_pulse" },
        data: { status: "disabled", appliedRevision: 0 } });
    }

    const schedules = await tx.lightingSchedule.findMany({
      where: { gatewayId },
      include: snapshotScheduleInclude,
      orderBy: { id: "asc" }
    });
    const eventRules = await tx.vehicleEventRule.findMany({
      where: { gatewayId },
      include: {
        sources: { select: { fixtureId: true, fixture: { select: { meshNodeId: true } } }, orderBy: { fixtureId: "asc" } },
        targets: { select: { fixtureId: true }, orderBy: { fixtureId: "asc" } }
      },
      orderBy: { id: "asc" }
    });
    // Targets are the canonical resolved memberships, read under the caller's
    // automation mutation lock. Match product Gateway active-only reservations:
    // disabled drafts reserve nothing, and legacy BlueZ/BlueZ remains unchanged.
    // Throw before configuration/outbox writes so the caller rolls back the
    // proposed rule and revision too; never publish an un-installable snapshot.
    const enabledTargetBio = new Map<string, boolean>();
    for (const rule of eventRules) {
      if (rule.status !== "enabled") continue;
      const isBio = rule.sensorProtocol === "bio_usb_pulse";
      for (const { fixtureId } of rule.targets) {
        if (enabledTargetBio.has(fixtureId) && (isBio || enabledTargetBio.get(fixtureId))) {
          throw new BadRequestException({ code: "bio_target_activation_conflict",
            message: "An enabled BIO rule cannot share targets with another enabled event rule. Disable the other rule or select different targets." });
        }
        enabledTargetBio.set(fixtureId, isBio);
      }
    }
    const snapshotWithoutHash = {
      schemaVersion: version,
      siteId: gateway.siteId,
      gatewayId,
      revision: desiredRevision,
      timeZone: gateway.site.timeZone,
      schedules: schedules
        .map(toLightingScheduleSnapshot)
        .sort((left, right) => compareAutomationIds(left.id, right.id)),
      vehicleEventRules: eventRules
        .filter(rule => version === 2 || rule.sensorProtocol !== "bio_usb_pulse")
        .map(rule => version === 1 ? toVehicleEventRuleSnapshot(rule) : {
          ...toVehicleEventRuleSnapshot(rule),
          sensorProtocol: rule.sensorProtocol === "bio_usb_pulse" ? "bio-usb-pulse" : "bluez-stateful"
        })
        .sort((left, right) => compareAutomationIds(left.id, right.id)),
      generatedAt: this.clock.now().toISOString()
    };
    const payloadHash = canonicalPayloadHash(snapshotWithoutHash);
    const payload = automationSnapshotSchema.parse({ ...snapshotWithoutHash, payloadHash });

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
        automationAssignmentVersion: version === 2 ? gateway.assignmentVersion : null,
        // Capture under the caller's membership lock with the snapshot. Never
        // rebuild this historical attribution from a Fixture at ingest time.
        automationSourceBindings: version === 2 ? Object.fromEntries(eventRules
          .filter(rule => rule.sensorProtocol === "bio_usb_pulse")
          .flatMap(rule => rule.sources.map(source => [source.fixtureId, source.fixture.meshNodeId]))) : Prisma.DbNull,
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

export function toVehicleEventRuleSnapshot(rule: {
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

export function compareAutomationIds(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
