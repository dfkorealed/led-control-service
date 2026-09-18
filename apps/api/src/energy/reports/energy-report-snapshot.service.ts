import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { energyReportRequestSchema, type EnergyReportDocument, type EnergyReportRequest } from "@led-control/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { EnergyReportDocumentBuilder, type EnergyReportDataSnapshot, type ReportEffectiveRange } from "./energy-report-document.builder";
import { assertReportTextSupported } from "./report-text";
import { addCalendarDays, parseCalendarDate, startOfLocalDate } from "../energy-periods";

export type EnergyReportSnapshots = {
  requestSnapshot: EnergyReportRequest;
  dataSnapshot: EnergyReportDataSnapshot;
  documentSnapshot: EnergyReportDocument;
};

@Injectable()
export class EnergyReportSnapshotService {
  constructor(private readonly prisma: PrismaService, private readonly builder: EnergyReportDocumentBuilder) {}

  async captureTargetLabel(tx: Prisma.TransactionClient, siteId: string, request: EnergyReportRequest): Promise<string> {
    const { scope, identityId } = request;
    let label: string | undefined;
    if (scope === "site" && identityId === siteId) {
      label = (await tx.site.findUniqueOrThrow({ where: { id: siteId }, select: { name: true } })).name;
    } else if (scope === "fixture" || scope === "group") {
      const query = { where: { id: identityId, siteId }, select: { id: true,
        dimensionVersions: { orderBy: [{ effectiveFrom: "desc" as const }, { id: "asc" as const }], take: 1, select: { name: true } } } };
      const identity = scope === "fixture" ? await tx.energyFixtureIdentity.findFirst(query) : await tx.energyGroupIdentity.findFirst(query);
      if (identity) label = identity.dimensionVersions[0]?.name ?? identity.id;
    } else if (scope === "floor") {
      const floor = await tx.floor.findFirst({ where: { id: identityId, siteId }, select: { name: true } });
      // Deleted floors remain addressable through retained analytics dimensions.
      label = floor?.name ?? (await tx.energyFixtureDimensionVersion.findFirst({
        where: { floorId: identityId, energyFixture: { siteId } }, orderBy: [{ effectiveFrom: "desc" }, { id: "asc" }],
        select: { floorName: true }
      }))?.floorName;
    }
    if (label === undefined) throw new NotFoundException("energy scope not found");
    // Recheck the short label under the enqueue transaction: a rename may have
    // happened since the full read-only document preflight outside the Site lock.
    assertReportTextSupported(label);
    return label;
  }

  async capture(reportId: string, siteId: string, rawRequest: unknown, now = new Date(), targetLabelSnapshot?: string | null): Promise<EnergyReportSnapshots> {
    const parsed = energyReportRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new BadRequestException("invalid energy report request");
    const requestSnapshot = parsed.data;
    return this.prisma.$transaction(async (tx) => {
      const site = await tx.site.findUniqueOrThrow({ where: { id: siteId }, select: { id: true, name: true, timeZone: true, tariffKwhRate: true } });
      const localKey = localDateFormatter(site.timeZone);
      if (requestSnapshot.to >= localKey(now)) throw new BadRequestException("report dates must be completed site-local dates");
      const days = (dateValue(requestSnapshot.to).getTime() - dateValue(requestSnapshot.from).getTime()) / 86_400_000 + 1;
      const comparisonRange = { from: shiftDate(requestSnapshot.from, -days), to: shiftDate(requestSnapshot.from, -1) };
      const fixtures = await tx.energyFixtureIdentity.findMany({
        where: { siteId }, select: {
          id: true, trackingStartedAt: true, retiredAt: true,
          dimensionVersions: { select: { name: true, floorId: true, floorName: true, ratedWatt: true, effectiveFrom: true, effectiveTo: true } },
          groupMemberships: { select: { energyGroupId: true, effectiveFrom: true, effectiveTo: true, energyGroup: { select: {
            trackingStartedAt: true, retiredAt: true, dimensionVersions: { select: { name: true, effectiveFrom: true, effectiveTo: true } }
          } } } },
          dailyAggregates: { where: { localDate: { gte: dateValue(comparisonRange.from), lte: dateValue(requestSnapshot.to) } },
            select: { localDate: true, estimatedKwh: true, estimatedCost: true, knownSeconds: true } },
          hourlyAggregates: { where: { localDate: { gte: dateValue(requestSnapshot.from), lte: dateValue(requestSnapshot.to) } },
            select: { bucketStartUtc: true, localDate: true, localHour: true, estimatedKwh: true, knownSeconds: true, brightnessWeightedSeconds: true } }
        }
      });
      const { scope, identityId } = requestSnapshot;
      const scopeExists = scope === "site" ? identityId === siteId
        : scope === "fixture" ? fixtures.some((fixture) => fixture.id === identityId)
        : scope === "floor" ? fixtures.some((fixture) => fixture.dimensionVersions.some((version) => version.floorId === identityId)) ||
          !!await tx.floor.findFirst({ where: { id: identityId, siteId }, select: { id: true } })
        : !!await tx.energyGroupIdentity.findFirst({ where: { id: identityId, siteId }, select: { id: true } });
      // An accepted job already proved its immutable target belongs to this site.
      // Operational deletion before the first worker attempt must not erase it.
      if (!scopeExists && targetLabelSnapshot == null) throw new NotFoundException("energy scope not found");
      const range = (from: Date, to: Date | null): ReportEffectiveRange => ({ from: from.toISOString(), to: to?.toISOString() ?? null });
      const dataSnapshot: EnergyReportDataSnapshot = {
        schemaVersion: 2, capturedAt: now.toISOString(), site: { ...site, tariffKwhRate: site.tariffKwhRate?.toString() ?? null }, comparisonRange,
        completedDays: Array.from({ length: days }, (_, index) => {
          const localDate = shiftDate(requestSnapshot.from, index), date = parseCalendarDate(localDate);
          const from = startOfLocalDate(date, site.timeZone), to = startOfLocalDate(addCalendarDays(date, 1), site.timeZone);
          return { localDate, from: from.toISOString(), to: to.toISOString(), seconds: (to.getTime() - from.getTime()) / 1000 };
        }),
        ...(targetLabelSnapshot == null ? {} : { targetLabelSnapshot }),
        fixtures: fixtures.map((fixture) => ({
          id: fixture.id, ...range(fixture.trackingStartedAt, fixture.retiredAt),
          dimensions: fixture.dimensionVersions.map((version) => ({ name: version.name, floorId: version.floorId, floorName: version.floorName,
            ratedWatt: version.ratedWatt?.toString(), ...range(version.effectiveFrom, version.effectiveTo) })).sort(compareRanges),
          memberships: fixture.groupMemberships.flatMap(membership => {
            const intersection = intersectRanges([range(membership.effectiveFrom, membership.effectiveTo),
              range(membership.energyGroup.trackingStartedAt, membership.energyGroup.retiredAt)]);
            return intersection ? [{ id: membership.energyGroupId, ...intersection }] : [];
          }).sort((a, b) => a.id.localeCompare(b.id) || compareRanges(a, b)),
          groups: fixture.groupMemberships.flatMap((membership) => membership.energyGroup.dimensionVersions.flatMap((version) => {
            const intersection = intersectRanges([range(membership.effectiveFrom, membership.effectiveTo),
              range(membership.energyGroup.trackingStartedAt, membership.energyGroup.retiredAt), range(version.effectiveFrom, version.effectiveTo)]);
            return intersection ? [{ id: membership.energyGroupId, name: version.name, ...intersection }] : [];
          })).sort((a, b) => a.id.localeCompare(b.id) || compareRanges(a, b)),
          // These legacy columns contain persisted aggregate values. The report domain
          // gives them neutral names and never reads a state cursor or extends the interval.
          daily: fixture.dailyAggregates.map((row) => ({ localDate: row.localDate.toISOString().slice(0, 10),
            energyKwh: row.estimatedKwh.toString(), cost: row.estimatedCost.toString(), durationSeconds: row.knownSeconds })).sort((a, b) => a.localDate.localeCompare(b.localDate)),
          hourly: fixture.hourlyAggregates.map((row) => ({ bucketStartUtc: row.bucketStartUtc.toISOString(), localDate: row.localDate.toISOString().slice(0, 10), localHour: row.localHour,
            energyKwh: row.estimatedKwh.toString(), durationSeconds: row.knownSeconds, brightnessWeightedSeconds: row.brightnessWeightedSeconds.toString() }))
            .sort((a, b) => a.bucketStartUtc.localeCompare(b.bucketStartUtc))
        })).sort((a, b) => a.id.localeCompare(b.id))
      };
      return { requestSnapshot, dataSnapshot, documentSnapshot: this.builder.build(reportId, requestSnapshot, dataSnapshot) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}

function localDateFormatter(timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return (date: Date) => {
    const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
}
function dateValue(value: string) { return new Date(`${value}T00:00:00.000Z`); }
function shiftDate(value: string, days: number) { return new Date(dateValue(value).getTime() + days * 86_400_000).toISOString().slice(0, 10); }
function compareRanges(a: ReportEffectiveRange, b: ReportEffectiveRange) { return a.from.localeCompare(b.from) || (a.to ?? "").localeCompare(b.to ?? ""); }
function intersectRanges(ranges: ReportEffectiveRange[]): ReportEffectiveRange | null {
  const from = ranges.map((range) => range.from).sort().at(-1)!;
  const to = ranges.flatMap((range) => range.to === null ? [] : [range.to]).sort()[0] ?? null;
  return to !== null && from >= to ? null : { from, to };
}
