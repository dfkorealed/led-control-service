import { BadRequestException, ConflictException, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import {
  automationSnapshotSchema,
  type HolidayDatasetSnapshot,
  type LightingScheduleSnapshotV1,
  type LightingScheduleSnapshotV3,
  mqttTopics,
  type VehicleEventRuleSnapshotV1
} from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { projectScheduleCalendar } from "@led-control/automation-engine";
import { AutomationClock } from "./automation-clock";
import { canonicalPayloadHash } from "./automation-payload-hash";
import { declaredAutomationVersion } from "./automation-protocol-support";

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
  excludeWeekends?: boolean;
  excludeHolidays?: boolean;
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

  /** The dataset pointer and every affected desired revision commit together.
   * The caller already holds the mutation lock; no I/O or nested transaction. */
  async onPromoted(tx: Prisma.TransactionClient, dataset: HolidayDatasetSnapshot): Promise<void> {
    const gateways = await tx.gateway.findMany({ where: { lightingSchedules: { some: { excludeHolidays: true,
      activeFrom: { lte: new Date(`${dataset.year}-12-31T23:59:59.999Z`) }, activeUntil: { gte: new Date(`${dataset.year}-01-01T00:00:00Z`) } } } },
      select: { id: true, assignmentVersion: true, automationProtocolDeclarations: { orderBy: [{ assignmentVersion: "desc" }, { declarationRevision: "desc" }], take: 1 } } });
    for (const gateway of gateways) {
      const declaration = gateway.automationProtocolDeclarations[0];
      if (declaration?.assignmentVersion === gateway.assignmentVersion && declaredAutomationVersion(declaration) === 3) {
        await this.incrementDesiredRevision(tx, gateway.id);
      }
    }
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
          take: 1, select: { assignmentVersion: true, maxSnapshotVersion: true, temporaryControlVersion: true, bioConfigurationReadback: true, durableFixtureLease: true } },
        site: { select: { timeZone: true } },
        automationConfiguration: { select: { desiredRevision: true, appliedRevision: true } }
      }
    });
    if (!gateway) throw new NotFoundException("gateway not found");
    const declaration = gateway.automationProtocolDeclarations?.[0];
    const version = declaration?.assignmentVersion === gateway.assignmentVersion
      && gateway.inventory?.claimedAt
      && !gateway.inventory.disabledAt && gateway.certificates?.some(certificate =>
        certificate.inventoryId === gateway.inventory?.id) ? declaredAutomationVersion(declaration) : 1;
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
    // Losing V3 declaration authority must never silently enable excluded dates
    // through a downgraded V1/V2 snapshot. The mutation rolls back instead.
    if (version !== 3 && schedules.some(schedule => schedule.excludeWeekends || schedule.excludeHolidays)) {
      throw new ConflictException({ code: "schedule_exclusions_unsupported" });
    }
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
    const holidayDatasets = version === 3
      ? await loadScheduleHolidayDatasets(tx, schedules.map(schedule => toLightingScheduleSnapshot(schedule)), gateway.site.timeZone)
      : [];
    const snapshotWithoutHash = {
      schemaVersion: version,
      siteId: gateway.siteId,
      gatewayId,
      revision: desiredRevision,
      timeZone: gateway.site.timeZone,
      schedules: schedules
        .map(schedule => version === 3 ? toLightingScheduleSnapshot(schedule) : toLightingScheduleSnapshot(schedule, false))
        .sort((left, right) => compareAutomationIds(left.id, right.id)),
      vehicleEventRules: eventRules
        .filter(rule => version !== 1 || rule.sensorProtocol !== "bio_usb_pulse")
        .map(rule => version === 1 ? toVehicleEventRuleSnapshot(rule) : {
          ...toVehicleEventRuleSnapshot(rule),
          sensorProtocol: rule.sensorProtocol === "bio_usb_pulse" ? "bio-usb-pulse" : "bluez-stateful"
        })
        .sort((left, right) => compareAutomationIds(left.id, right.id)),
      generatedAt: this.clock.now().toISOString(),
      ...(version === 3 ? { holidayDatasets } : {})
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
        automationAssignmentVersion: version !== 1 ? gateway.assignmentVersion : null,
        // Capture under the caller's membership lock with the snapshot. Never
        // rebuild this historical attribution from a Fixture at ingest time.
        automationSourceBindings: version !== 1 ? Object.fromEntries(eventRules
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

export function toLightingScheduleSnapshot(schedule: LightingScheduleSnapshotRow): LightingScheduleSnapshotV3;
export function toLightingScheduleSnapshot(schedule: LightingScheduleSnapshotRow, includeExclusions: false): LightingScheduleSnapshotV1;
export function toLightingScheduleSnapshot(
  schedule: LightingScheduleSnapshotRow, includeExclusions = true
): LightingScheduleSnapshotV1 | LightingScheduleSnapshotV3 {
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
    fixtureIds: schedule.fixtures.map(({ fixtureId }) => fixtureId).sort(compareAutomationIds),
    ...(includeExclusions ? { excludeWeekends: schedule.excludeWeekends ?? false, excludeHolidays: schedule.excludeHolidays ?? false } : {})
  };
}

/** Active bounds are instants whose site civil dates are inclusive in the engine.
 * UTC slicing misses Seoul Jan1 when its bound is still Dec31 UTC. */
export function scheduleActiveDateRange(rule: LightingScheduleSnapshotV1, timeZone: string): { from: string; to: string } {
  const formatter = new Intl.DateTimeFormat("en", { timeZone, calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit" });
  const localDate = (instant: string) => {
    const parts = formatter.formatToParts(new Date(instant));
    const part = (type: string) => parts.find(value => value.type === type)!.value;
    return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
  };
  return { from: localDate(rule.activeFrom), to: localDate(rule.activeUntil) };
}

/** One verified Task3 reader, same caller transaction, no provider or reverse DI.
 * A calendar needs coverage for start dates in its range, never overnight ends.
 * Save/snapshot consumers omit range to require the full active period. */
export async function loadScheduleHolidayDatasets(
  tx: Prisma.TransactionClient, rules: readonly LightingScheduleSnapshotV3[], timeZone: string,
  range?: { from: string; to: string }
): Promise<HolidayDatasetSnapshot[]> {
  const years = new Set<number>();
  for (const rule of rules) {
    if (!rule.excludeHolidays || (range && rule.status !== "enabled")) continue;
    if (range) {
      // Ask the existing engine for possible starts before holiday filtering.
      // A once outside this range (or a weekend already excluded) needs no
      // holiday coverage; active-period intersection alone cannot prove that.
      const starts = projectScheduleCalendar({ rules: [{ ...rule, excludeHolidays: false }], ...range, timeZone, datasets: [] });
      if (starts.length === 0) continue;
      if (timeZone !== "Asia/Seoul") throw new ConflictException({ code: "schedule_holiday_timezone_unsupported" });
      for (const occurrence of starts) years.add(Number(occurrence.localDate.slice(0, 4)));
      continue;
    }
    const active = scheduleActiveDateRange(rule, timeZone);
    if (timeZone !== "Asia/Seoul") throw new ConflictException({ code: "schedule_holiday_timezone_unsupported" });
    for (let year = Number(active.from.slice(0, 4)); year <= Number(active.to.slice(0, 4)); year++) years.add(year);
  }
  if (years.size === 0) return [];
  // HolidayDatasetService consumes this class. Loading its pure reader lazily
  // prevents a static reverse import from corrupting Nest constructor metadata.
  const { loadHolidayCoverage } = await import("./holiday-dataset.service");
  const datasets: HolidayDatasetSnapshot[] = [];
  for (const year of [...years].sort((a, b) => a - b)) {
    const prefix = String(year).padStart(4, "0");
    datasets.push(...await loadHolidayCoverage(tx, `${prefix}-01-01`, `${prefix}-12-31`));
  }
  return datasets;
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
