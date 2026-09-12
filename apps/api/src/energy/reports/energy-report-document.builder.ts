import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { energyReportDocumentSchema, energyReportDocumentFingerprintInputSchema,
  type EnergyReportDocument, type EnergyReportRequest, type EnergyReportSection, type ReportCell } from "@led-control/shared";
import { aggregateHeatmapCells, coversInterval, overlapsInterval } from "../energy-heatmap.service";
import { addCalendarDays, parseCalendarDate, startOfLocalDate } from "../energy-periods";
import { reportBlocks } from "./report-renderer";

export type ReportEffectiveRange = { from: string; to: string | null };
export type ReportFixtureSnapshot = ReportEffectiveRange & {
  id: string;
  dimensions: Array<ReportEffectiveRange & { name: string; floorId: string; floorName: string }>;
  groups: Array<ReportEffectiveRange & { id: string; name: string }>;
  daily: Array<{ localDate: string; energyKwh: string; cost: string | null; durationSeconds: number }>;
  hourly: Array<{
    localDate: string; localHour: number; bucketStartUtc: string; energyKwh: string;
    durationSeconds: number; brightnessWeightedSeconds: string;
  }>;
};
export type EnergyReportDataSnapshot = {
  schemaVersion: 1;
  capturedAt: string;
  site: { id: string; name: string; timeZone: string };
  comparisonRange: { from: string; to: string };
  fixtures: ReportFixtureSnapshot[];
};

@Injectable()
export class EnergyReportDocumentBuilder {
  build(reportId: string, request: EnergyReportRequest, data: EnergyReportDataSnapshot): EnergyReportDocument {
    const intervals = new Map<string, ReturnType<typeof dayInterval>>();
    const intervalFor = (date: string) => {
      if (!intervals.has(date)) intervals.set(date, dayInterval(date, data.site.timeZone));
      return intervals.get(date)!;
    };
    const facts = data.fixtures.flatMap((fixture) => fixture.daily
      .filter((row) => row.durationSeconds > 0 && inScope(fixture, request, intervalFor(row.localDate)))
      .map((row) => ({ fixture, ...row })));
    const current = facts.filter((row) => inRange(row.localDate, request));
    const previous = facts.filter((row) => inRange(row.localDate, data.comparisonRange));
    const currentTotal = sum(current);
    const previousTotal = sum(previous);
    const currentCost = sumCost(current);
    const previousCost = sumCost(previous);
    const daily = new Map<string, typeof facts>();
    for (const row of current) daily.set(row.localDate, [...(daily.get(row.localDate) ?? []), row]);

    const sections: EnergyReportSection[] = [
      { kind: "summary", title: "요약", rows: [{ label: "사용 전력량", ...energyCell(currentTotal) }, { label: "저장 비용", ...costCell(currentCost) }] },
      makeTable("daily", "일별 전력량·비용", [["localDate", "날짜"], ["energyKwh", "사용 전력량"], ["cost", "저장 비용"]],
        dates(request).map((date) => [textCell(date), energyCell(sum(daily.get(date) ?? [])), costCell(sumCost(daily.get(date) ?? []))])),
      makeTable("comparison", "기간 비교", [["period", "구분"], ["range", "기간"], ["energyKwh", "사용 전력량"], ["cost", "저장 비용"]], [
        [textCell("현재 기간"), textCell(`${request.from} ~ ${request.to}`), energyCell(currentTotal), costCell(currentCost)],
        [textCell("직전 동일 일수"), textCell(`${data.comparisonRange.from} ~ ${data.comparisonRange.to}`), energyCell(previousTotal), costCell(previousCost)],
        [textCell("차이"), { value: null, displayValue: "—" }, energyCell(difference(currentTotal, previousTotal)), costCell(difference(currentCost, previousCost))],
        [textCell("변화율"), { value: null, displayValue: "—" }, percentCell(currentTotal, previousTotal), percentCell(currentCost, previousCost)]
      ])
    ];
    for (const kind of ["fixture", "floor", "group"] as const) {
      const totals = new Map<string, { id: string; name: string; nameDate: string; energy: Prisma.Decimal; cost: Prisma.Decimal | null }>();
      for (const row of current) {
        const interval = intervalFor(row.localDate);
        if (!activeDay(row.fixture, interval)) continue;
        const dimension = dailyDimension(row.fixture, interval);
        const identities = kind === "fixture" ? (dimension ? [{ id: row.fixture.id, name: dimension.name }] : [])
          : kind === "floor" ? (dimension ? [{ id: dimension.floorId, name: dimension.floorName }] : [])
          : row.fixture.groups.filter((group) => activeDay(group, interval));
        // A fixture may belong to several groups; each receives its full persisted amount.
        // Overlapping history rows for the same group never count that fixture twice.
        for (const identity of new Map(identities.map((identity) => [identity.id, identity])).values()) {
          const existing = totals.get(identity.id);
          totals.set(identity.id, {
            id: identity.id,
            name: existing && existing.nameDate > row.localDate ? existing.name : identity.name,
            nameDate: existing && existing.nameDate > row.localDate ? existing.nameDate : row.localDate,
            energy: (existing?.energy ?? new Prisma.Decimal(0)).add(row.energyKwh),
            cost: row.cost == null || existing?.cost === null ? null : (existing?.cost ?? new Prisma.Decimal(0)).add(row.cost)
          });
        }
      }
      sections.push(makeTable(`${kind}-ranking`, `${{ fixture: "조명", floor: "층", group: "그룹" }[kind]} 순위`,
        [["rank", "순위"], ["identityId", "식별자"], ["name", "이름"], ["energyKwh", "사용 전력량"], ["cost", "저장 비용"]],
        [...totals.values()].sort((a, b) => b.energy.comparedTo(a.energy) || a.id.localeCompare(b.id))
          .map((row, index) => [{ value: index + 1, displayValue: String(index + 1) }, textCell(row.id), textCell(row.name), energyCell(row.energy), costCell(row.cost)])));
    }

    // Keep UTC bucket identity separate from local fold labels, including repeated DST hours.
    const identities = data.fixtures.map((fixture) => ({
      id: fixture.id, trackingStartedAt: dateValue(fixture.from), retiredAt: optionalDate(fixture.to),
      dimensionVersions: fixture.dimensions.map((version) => ({ floorId: version.floorId, ...effectiveDates(version) })),
      groupMemberships: fixture.groups.map((group) => ({
        energyGroupId: group.id, ...effectiveDates(group),
        energyGroup: { trackingStartedAt: dateValue(group.from), retiredAt: optionalDate(group.to), dimensionVersions: [effectiveDates(group)] }
      })),
      hourlyAggregates: fixture.hourly.filter((row) => inRange(row.localDate, request)).map((row) => ({
        bucketStartUtc: new Date(row.bucketStartUtc),
        localDate: dateValue(row.localDate), localHour: row.localHour, estimatedKwh: new Prisma.Decimal(row.energyKwh),
        knownSeconds: row.durationSeconds, brightnessWeightedSeconds: new Prisma.Decimal(row.brightnessWeightedSeconds)
      }))
    }));
    for (const metric of ["energy", "brightness"] as const) {
      sections.push({ kind: "heatmap", id: `${metric}-heatmap`, title: metric === "energy" ? "요일·시간별 전력량" : "요일·시간별 밝기", metric,
        cells: aggregateHeatmapCells(identities, request.scope, request.identityId, metric, data.site.timeZone)
          .map((cell) => ({ ...cell, displayValue: cell.value === null ? "데이터 없음" : metric === "energy" ? `${cell.value.toFixed(4)} kWh` : `${cell.value.toFixed(2)} %` })) });
    }
    sections.push({ kind: "notes", title: "계산 정보", rows: [
      "현장 시간대에서 완료된 날짜의 저장된 일별·시간별 집계만 사용합니다.",
      "전력량·비용 출처: 조명별 일별 집계에 저장된 전력량과 비용의 합계입니다. 일부 시간의 값만 있으면 해당 합계를 그대로 표시합니다.",
      "현장 합계는 이력 수집 시작 전과 조명 종료 날짜의 저장된 일별 값도 보존합니다.",
      "요일·시간별 전력량은 해당 셀의 저장된 시간별 전력량 합계이며, 밝기는 저장된 시간으로 가중한 평균입니다.",
      "시간 변경으로 같은 현지 시간이 반복되면 두 시간의 값을 같은 셀에 합산합니다.",
      "기간 비교: 현재 합계 − 직전 동일 일수 합계. 변화율: 차이 ÷ 직전 합계 × 100. 직전 값이 0이거나 값이 없으면 변화율은 데이터 없음입니다.",
      "순위와 층·그룹 일별 값은 해당 현지 날짜 전체의 이력이 확인되는 경우만 포함합니다. 시간별 값은 UTC 한 시간 전체가 같은 소속일 때만 포함하며 경계를 나누지 않습니다.",
      "여러 그룹에 속한 조명의 값은 각 그룹에 포함됩니다. 이력으로 배분할 수 없는 값 때문에 순위 합계가 현장 합계와 다를 수 있습니다.",
      "적용 요금 단가: 데이터 없음. 일별 집계에는 적용 단가 이력이 연결되어 있지 않으므로 현재 단가를 과거에 적용하지 않습니다.",
      "원천 전력량·비용 산출식: 데이터 없음. 보고서는 저장된 집계 합산식만 사용하며 원천 산출 과정을 재구성하지 않습니다.",
      "전력량은 소수점 4자리, 비용·밝기·변화율은 소수점 2자리로 반올림하여 표시합니다."
    ] });
    const input = energyReportDocumentFingerprintInputSchema.parse({ schemaVersion: 1, reportId, title: "조명 에너지 보고서",
      metadata: [
        { label: "현장", ...textCell(data.site.name) },
        { label: "시간대", ...textCell(data.site.timeZone) },
        { label: "기간", ...textCell(`${request.from} ~ ${request.to}`) },
        { label: "범위", ...textCell(`${{ site: "현장", fixture: "조명", floor: "층", group: "그룹" }[request.scope]}: ${request.identityId}`) },
        { label: "기준 시각", ...textCell(data.capturedAt) }
      ], sections });
    // Validate only text retained in this selected, completed-period document.
    // Unrelated historical names in the input snapshot are not export content.
    const document = energyReportDocumentSchema.parse({ ...input, contentFingerprint: createHash("sha256").update(canonicalJson(input)).digest("hex") });
    reportBlocks(document);
    return document;
  }
}

function dayInterval(date: string, timeZone: string) {
  const day = parseCalendarDate(date);
  return { from: startOfLocalDate(day, timeZone), to: startOfLocalDate(addCalendarDays(day, 1), timeZone) };
}
function activeDay(range: ReportEffectiveRange, { from, to }: ReturnType<typeof dayInterval>) {
  return coversInterval(effectiveDates(range), from, to);
}
function dailyDimension(fixture: ReportFixtureSnapshot, { from, to }: ReturnType<typeof dayInterval>) {
  const versions = fixture.dimensions.filter(version => overlapsInterval(effectiveDates(version), from, to));
  return versions.length === 1 && coversInterval(effectiveDates(versions[0]), from, to) ? versions[0] : undefined;
}
function inRange(date: string, range: { from: string; to: string }) { return date >= range.from && date <= range.to; }
function inScope(fixture: ReportFixtureSnapshot, request: EnergyReportRequest, interval: ReturnType<typeof dayInterval>) {
  if (request.scope === "site") return true;
  if (request.scope === "fixture") return fixture.id === request.identityId;
  if (!activeDay(fixture, interval)) return false;
  if (request.scope === "floor") return dailyDimension(fixture, interval)?.floorId === request.identityId;
  return fixture.groups.some((group) => group.id === request.identityId && activeDay(group, interval));
}
function sum(rows: Array<{ energyKwh: string }>) {
  return rows.length ? rows.reduce((total, row) => total.add(row.energyKwh), new Prisma.Decimal(0)) : null;
}
function energyCell(value: Prisma.Decimal | null): ReportCell {
  const rounded = value?.toDecimalPlaces(4);
  return { value: rounded?.toNumber() ?? null, displayValue: rounded ? `${rounded.toFixed(4)} kWh` : "데이터 없음" };
}
function sumCost(rows: Array<{ cost: string | null }>) {
  return rows.length && rows.every(row => row.cost != null)
    ? rows.reduce((total, row) => total.add(row.cost!), new Prisma.Decimal(0)) : null;
}
function difference(current: Prisma.Decimal | null, previous: Prisma.Decimal | null) {
  return current !== null && previous !== null ? current.sub(previous) : null;
}
function costCell(value: Prisma.Decimal | null): ReportCell { return decimalCell(value, "원"); }
function percentCell(current: Prisma.Decimal | null, previous: Prisma.Decimal | null): ReportCell {
  return decimalCell(current !== null && previous !== null && !previous.isZero() ? current.sub(previous).div(previous).mul(100) : null, "%");
}
function decimalCell(value: Prisma.Decimal | null, unit: string): ReportCell {
  const rounded = value?.toDecimalPlaces(2);
  return { value: rounded?.toNumber() ?? null, displayValue: rounded ? `${rounded.toFixed(2)} ${unit}` : "데이터 없음" };
}
function textCell(value: string): ReportCell { return { value, displayValue: value }; }
function makeTable(id: string, title: string, columns: Array<[string, string]>, rows: ReportCell[][]): EnergyReportSection {
  return { kind: "table", id, title, columns: columns.map(([id, label]) => ({ id, label })), rows };
}
function dates(range: { from: string; to: string }) {
  const result: string[] = [];
  for (let value = dateValue(range.from); value <= dateValue(range.to); value = new Date(value.getTime() + 86_400_000)) result.push(value.toISOString().slice(0, 10));
  return result;
}
function dateValue(value: string) { return new Date(value.includes("T") ? value : `${value}T00:00:00.000Z`); }
function optionalDate(value: string | null) { return value === null ? null : dateValue(value); }
function effectiveDates(value: ReportEffectiveRange) { return { effectiveFrom: dateValue(value.from), effectiveTo: optionalDate(value.to) }; }

/** Canonical object keys; array order remains the renderer's ordered document contract. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
