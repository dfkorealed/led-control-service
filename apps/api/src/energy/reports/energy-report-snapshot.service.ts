import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { energyReportRequestSchema, type EnergyReportDocument, type EnergyReportRequest } from "@led-control/shared";
import { PrismaService } from "../../prisma/prisma.service";
import { EnergyReportDocumentBuilder, type EnergyReportDataSnapshot, type ReportEffectiveRange } from "./energy-report-document.builder";

export type EnergyReportSnapshots = {
  requestSnapshot: EnergyReportRequest;
  dataSnapshot: EnergyReportDataSnapshot;
  documentSnapshot: EnergyReportDocument;
};

@Injectable()
export class EnergyReportSnapshotService {
  constructor(private readonly prisma: PrismaService, private readonly builder: EnergyReportDocumentBuilder) {}

  async capture(reportId: string, siteId: string, rawRequest: unknown, now = new Date()): Promise<EnergyReportSnapshots> {
    const parsed = energyReportRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new BadRequestException("invalid energy report request");
    const requestSnapshot = parsed.data;
    return this.prisma.$transaction(async (tx) => {
      const site = await tx.site.findUniqueOrThrow({ where: { id: siteId }, select: { id: true, name: true, timeZone: true } });
      const localKey = localDateFormatter(site.timeZone);
      if (requestSnapshot.to >= localKey(now)) throw new BadRequestException("report dates must be completed site-local dates");
      const days = (dateValue(requestSnapshot.to).getTime() - dateValue(requestSnapshot.from).getTime()) / 86_400_000 + 1;
      const comparisonRange = { from: shiftDate(requestSnapshot.from, -days), to: shiftDate(requestSnapshot.from, -1) };
      const fixtures = await tx.energyFixtureIdentity.findMany({
        where: { siteId }, select: {
          id: true, trackingStartedAt: true, retiredAt: true,
          dimensionVersions: { select: { name: true, floorId: true, floorName: true, effectiveFrom: true, effectiveTo: true } },
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
      if (!scopeExists) throw new NotFoundException("energy scope not found");
      const range = (from: Date, to: Date | null): ReportEffectiveRange => ({ from: from.toISOString(), to: to?.toISOString() ?? null });
      const dataSnapshot: EnergyReportDataSnapshot = {
        schemaVersion: 1, capturedAt: now.toISOString(), site, comparisonRange,
        fixtures: fixtures.map((fixture) => ({
          id: fixture.id, ...range(fixture.trackingStartedAt, fixture.retiredAt),
          dimensions: fixture.dimensionVersions.map((version) => ({ name: version.name, floorId: version.floorId, floorName: version.floorName,
            ...range(version.effectiveFrom, version.effectiveTo) })).sort(compareRanges),
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
