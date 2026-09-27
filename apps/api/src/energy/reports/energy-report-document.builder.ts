import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { energyReportDocumentSchema, energyReportDocumentFingerprintInputSchema,
  type EnergyReportDocument, type EnergyReportRequest, type EnergyReportSection, type ReportCell, type ReportCalculationBasis } from "@led-control/shared";
import { aggregateHeatmapCells, coversInterval, overlapsInterval } from "../energy-heatmap.service";
import { addCalendarDays, parseCalendarDate, startOfLocalDate } from "../energy-periods";
import { reportBlocks } from "./report-renderer";

export type ReportEffectiveRange = { from: string; to: string | null };
export type ReportFixtureSnapshot = ReportEffectiveRange & {
  id: string;
  dimensions: Array<ReportEffectiveRange & { name: string; floorId: string; floorName: string; ratedWatt?: string }>;
  groups: Array<ReportEffectiveRange & { id: string; name: string }>;
  /** V2 preserves scope membership independently of group display-name gaps. */
  memberships?: Array<ReportEffectiveRange & { id: string }>;
  daily: Array<{ localDate: string; energyKwh: string; cost: string | null; durationSeconds: number }>;
  hourly: Array<{
    localDate: string; localHour: number; bucketStartUtc: string; energyKwh: string;
    durationSeconds: number; brightnessWeightedSeconds: string;
  }>;
};
export type EnergyReportDataSnapshot = {
  schemaVersion: 1 | 2;
  capturedAt: string;
  site: { id: string; name: string; timeZone: string; tariffKwhRate?: string | null };
  comparisonRange: { from: string; to: string };
  targetLabelSnapshot?: string;
  completedDays?: Array<{ localDate: string; from: string; to: string; seconds: number }>;
  fixtures: ReportFixtureSnapshot[];
};

@Injectable()
export class EnergyReportDocumentBuilder {
  build(reportId: string, request: EnergyReportRequest, data: EnergyReportDataSnapshot): EnergyReportDocument {
    const intervals = new Map<string, ReturnType<typeof dayInterval>>();
    const intervalFor = (date: string) => {
      if (!intervals.has(date)) intervals.set(date, snapshotDayInterval(date, data));
      return intervals.get(date)!;
    };
    const facts = data.fixtures.flatMap((fixture) => fixture.daily
      .filter((row) => row.durationSeconds > 0 && (data.schemaVersion === 2
        ? attributableDay(fixture, request, intervalFor(row.localDate)) : inScope(fixture, request, intervalFor(row.localDate))))
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
    const calculation = data.schemaVersion === 2 ? enrichV2(sections, request, data, currentTotal, current.reduce((total, row) => total + row.durationSeconds, 0)) : undefined;
    if (data.schemaVersion === 2) {
      // Renderer-only source rows retain exact persisted decimals and per-day
      // collection time. Summary/table display cells are already rounded and
      // cannot prove that a missing fixture-day was a measured zero.
      const sourceRows = [...dates(data.comparisonRange).map(date => ({ date, period: "previous" })),
        ...dates(request).map(date => ({ date, period: "current" }))];
      const sourceFacts = [...previous.map(row => ({ ...row, period: "previous" })),
        ...current.map(row => ({ ...row, period: "current" }))];
      const factsByDay = new Map<string, typeof sourceFacts>();
      for (const row of sourceFacts) {
        const key = `${row.period}:${row.localDate}`;
        const rows = factsByDay.get(key);
        if (rows) rows.push(row);
        else factsByDay.set(key, [row]);
      }
      const sourceCell = (value: string | null): ReportCell => value === null
        ? { value: null, displayValue: "데이터 없음" } : textCell(value);
      const coverageRows = sourceRows.map(({ date, period }) => {
        const interval = intervalFor(date);
        const dayFacts = factsByDay.get(`${period}:${date}`) ?? [];
        const recordedFixtureIds = new Set(dayFacts.map(row => row.fixture.id));
        let expectedSeconds = 0, uncertain = false;
        for (const fixture of data.fixtures) {
          const day = configurationDay(fixture, request, interval);
          expectedSeconds += day.seconds;
          uncertain ||= day.scopeMissing || ((request.scope === "floor" || request.scope === "group") && day.partial);
          // A persisted legacy day can predate lifecycle capture; its active
          // time cannot be inferred from a later tracking-start timestamp.
          uncertain ||= recordedFixtureIds.has(fixture.id) &&
            dateValue(fixture.from).getTime() > interval.from.getTime();
        }
        const knownSeconds = dayFacts.reduce((total, row) => total + row.durationSeconds, 0);
        const status = uncertain || knownSeconds > expectedSeconds ? "unknown"
          : expectedSeconds === 0 || dayFacts.length === 0 ? "missing"
          : knownSeconds === expectedSeconds ? "complete" : "partial";
        return [textCell(period), textCell(date), sourceCell(sum(dayFacts)?.toString() ?? null),
          sourceCell(sumCost(dayFacts)?.toString() ?? null), sourceCell(uncertain ? null : String(expectedSeconds)),
          textCell(String(knownSeconds)), textCell(status)];
      });
      const allocations = new Map<string, { fixtureId: string; fixtureName: string | null;
        floorId: string | null; floorName: string | null; nameDate: string; energy: Prisma.Decimal;
        cost: Prisma.Decimal | null; knownSeconds: number }>();
      for (const row of current) {
        const dimension = dailyDimension(row.fixture, intervalFor(row.localDate));
        const key = `${row.fixture.id}\0${dimension?.floorId ?? ""}`;
        const prior = allocations.get(key);
        allocations.set(key, { fixtureId: row.fixture.id,
          fixtureName: prior && prior.nameDate > row.localDate ? prior.fixtureName : dimension?.name ?? null,
          floorId: dimension?.floorId ?? null,
          floorName: prior && prior.nameDate > row.localDate ? prior.floorName : dimension?.floorName ?? null,
          nameDate: prior && prior.nameDate > row.localDate ? prior.nameDate : row.localDate,
          energy: (prior?.energy ?? new Prisma.Decimal(0)).add(row.energyKwh),
          cost: row.cost === null || prior?.cost === null ? null : (prior?.cost ?? new Prisma.Decimal(0)).add(row.cost),
          knownSeconds: (prior?.knownSeconds ?? 0) + row.durationSeconds });
      }
      const factRows = [...allocations.values()].map(row => [textCell("current"), textCell(row.nameDate), textCell(row.fixtureId),
        sourceCell(row.fixtureName), sourceCell(row.floorId), sourceCell(row.floorName), textCell(row.energy.toString()),
        sourceCell(row.cost?.toString() ?? null), textCell(String(row.knownSeconds))]);
      const sourceTable = (id: string, columns: string[], rows: ReportCell[][]): EnergyReportSection => ({
        kind: "table", id, title: "PDF 원본 검증 자료", columns: columns.map(column => ({ id: column, label: column })),
        rows, rowIds: rows.map((_, index) => String(index))
      });
      const hourFormatter = new Intl.DateTimeFormat("en-US", { timeZone: data.site.timeZone, hour: "2-digit", hourCycle: "h23" });
      const hourCells = Array.from({ length: 168 }, () => ({ energy: new Prisma.Decimal(0), knownSeconds: 0, expectedSeconds: 0, uncertain: false }));
      for (const date of dates(request)) {
        const interval = intervalFor(date);
        const weekday = dateValue(date).getUTCDay();
        for (let start = Math.floor(interval.from.getTime() / 3_600_000) * 3_600_000;
          start < interval.to.getTime(); start += 3_600_000) {
          const from = new Date(Math.max(start, interval.from.getTime()));
          const to = new Date(Math.min(start + 3_600_000, interval.to.getTime()));
          const hour = Number(hourFormatter.formatToParts(from).find(part => part.type === "hour")?.value);
          const cell = hourCells[weekday * 24 + hour];
          // UTC-hour aggregates are labeled by the bucket start, so a bucket
          // crossing local midnight can be stored under the adjacent local
          // date. A current-period-only hourly snapshot cannot prove coverage
          // for this split bucket in half-hour-offset time zones.
          cell.uncertain ||= from.getTime() !== start || to.getTime() !== start + 3_600_000;
          for (const fixture of data.fixtures) {
            const selected = hourlySelection(fixture, request, { from, to });
            cell.expectedSeconds += selected.seconds;
            cell.uncertain ||= selected.scopeMissing ||
              ((request.scope === "floor" || request.scope === "group") && selected.partial);
          }
        }
      }
      for (const fixture of data.fixtures) for (const row of fixture.hourly) {
        if (!inRange(row.localDate, request)) continue;
        const from = new Date(row.bucketStartUtc), to = new Date(from.getTime() + 3_600_000);
        const selected = hourlySelection(fixture, request, { from, to });
        const inSelectedScope = request.scope === "site" || (request.scope === "fixture" && fixture.id === request.identityId)
          || (selected.seconds === 3600 && !selected.scopeMissing && (request.scope === "floor" ||
            fixture.groups.some(group => group.id === request.identityId && coversInterval(effectiveDates(group), from, to))));
        if (!inSelectedScope) continue;
        const cell = hourCells[dateValue(row.localDate).getUTCDay() * 24 + row.localHour];
        cell.energy = cell.energy.add(row.energyKwh);
        cell.knownSeconds += row.durationSeconds;
      }
      const hourRows = hourCells.map((cell, index) => {
        const status = cell.uncertain || cell.knownSeconds > cell.expectedSeconds ? "unknown"
          : cell.expectedSeconds === 0 ? "not_applicable"
          : cell.knownSeconds === 0 ? "missing"
          : cell.knownSeconds === cell.expectedSeconds ? "complete" : "partial";
        return [textCell(String(Math.floor(index / 24))), textCell(String(index % 24)),
          sourceCell(cell.knownSeconds === 0 ? null : cell.energy.toString()),
          textCell(String(cell.expectedSeconds)), textCell(String(cell.knownSeconds)), textCell(status)];
      });
      sections.push(sourceTable("pdf-source-coverage", ["period", "date", "energy", "cost", "expect", "known", "status"], coverageRows));
      sections.push(sourceTable("pdf-source-facts", ["period", "date", "fid", "fname", "floorId", "floor", "energy", "cost", "known"], factRows));
      sections.push(sourceTable("pdf-source-hourly", ["weekday", "hour", "energy", "expect", "known", "status"], hourRows));
    }
    const input = energyReportDocumentFingerprintInputSchema.parse({ schemaVersion: data.schemaVersion, reportId, title: "조명 에너지 보고서",
      ...(calculation ? { calculationBasis: calculation } : {}),
      metadata: [
        { label: "현장", ...textCell(request.scope === "site" ? data.targetLabelSnapshot ?? data.site.name : data.site.name) },
        { label: "시간대", ...textCell(data.site.timeZone) },
        { label: "기간", ...textCell(`${request.from} ~ ${request.to}`) },
        { label: "범위", ...textCell(`${{ site: "현장", fixture: "조명", floor: "층", group: "그룹" }[request.scope]}: ${request.identityId}`) },
        ...(data.targetLabelSnapshot == null ? [] : [{ label: "대상", ...textCell(data.targetLabelSnapshot) }]),
        { label: "기준 시각", ...textCell(data.capturedAt) }
      ], sections });
    // Validate only text retained in this selected, completed-period document.
    // Unrelated historical names in the input snapshot are not export content.
    const document = energyReportDocumentSchema.parse({ ...input, contentFingerprint: createHash("sha256").update(canonicalJson(input)).digest("hex") });
    reportBlocks(document);
    return document;
  }
}

function hourlySelection(fixture: ReportFixtureSnapshot, request: EnergyReportRequest, interval: ReturnType<typeof dayInterval>) {
  if (request.scope === "site" || request.scope === "fixture") {
    const active = request.scope === "site" || fixture.id === request.identityId;
    const seconds = active ? Math.max(0, Math.min(interval.to.getTime(), fixture.to === null ? Infinity : dateValue(fixture.to).getTime())
      - Math.max(interval.from.getTime(), dateValue(fixture.from).getTime())) / 1000 : 0;
    return { seconds, scopeMissing: false, partial: seconds > 0 && seconds < (interval.to.getTime() - interval.from.getTime()) / 1000 };
  }
  return configurationDay(fixture, request, interval);
}

/** Partition only configuration intervals. Persisted daily facts are never split
 * or prorated: their known time cannot be located inside an intra-day change. */
function configurationDay(fixture: ReportFixtureSnapshot, request: EnergyReportRequest, interval: ReturnType<typeof dayInterval>) {
  const start = interval.from.getTime(), end = interval.to.getTime();
  const memberships = fixture.memberships ?? fixture.groups;
  const ranges = [fixture, ...fixture.dimensions, ...memberships];
  const boundaries = [...new Set([start, end, ...ranges.flatMap(range => [dateValue(range.from).getTime(), range.to === null ? end : dateValue(range.to).getTime()])])]
    .filter(time => time >= start && time <= end).sort((a, b) => a - b);
  const contains = (range: ReportEffectiveRange, time: number) => dateValue(range.from).getTime() <= time && (range.to === null || time < dateValue(range.to).getTime());
  let seconds = 0, baselineMissing = false, scopeMissing = false, energy = new Prisma.Decimal(0);
  for (let index = 0; index < boundaries.length - 1; index++) {
    const from = boundaries[index], duration = (boundaries[index + 1] - from) / 1000;
    if (!contains(fixture, from) || (request.scope === "fixture" && fixture.id !== request.identityId)) continue;
    const dimensions = fixture.dimensions.filter(dimension => contains(dimension, from));
    const groups = memberships.filter(group => contains(group, from));
    if (request.scope === "group" && !groups.some(group => group.id === request.identityId)) continue;
    if (request.scope === "floor" && dimensions.length === 1 && dimensions[0].floorId !== request.identityId) continue;
    if (dimensions.length !== 1) {
      baselineMissing = true;
      // Site/fixture/group membership is still known when watt history is absent.
      // Floor membership itself cannot be inferred across a dimension gap.
      if (request.scope !== "floor") seconds += duration;
      else scopeMissing = true;
      continue;
    }
    seconds += duration;
    const watts = dimensions[0].ratedWatt;
    if (watts === undefined) baselineMissing = true;
    else energy = energy.add(new Prisma.Decimal(watts).mul(duration).div(3_600_000));
  }
  return { seconds, energy, baselineMissing, scopeMissing, partial: seconds > 0 && seconds < (end - start) / 1000 };
}
function attributableDay(fixture: ReportFixtureSnapshot, request: EnergyReportRequest, interval: ReturnType<typeof dayInterval>) {
  if (request.scope === "site") return true;
  if (request.scope === "fixture") return fixture.id === request.identityId;
  const day = configurationDay(fixture, request, interval);
  return day.seconds === (interval.to.getTime() - interval.from.getTime()) / 1000 && !day.scopeMissing;
}

function enrichV2(sections: EnergyReportSection[], request: EnergyReportRequest, data: EnergyReportDataSnapshot,
  actual: Prisma.Decimal | null, persistedKnown: number): ReportCalculationBasis {
  const selectedFixtures = new Set<string>();
  let expectedSeconds = 0, baselineMissing = false, expectedUnknown = false, attributionUnavailable = false;
  const dailyBaselines = dates(request).map(date => {
    let energy = new Prisma.Decimal(0), dayMissing = false;
    for (const fixture of data.fixtures) {
      const interval = snapshotDayInterval(date, data);
      const day = configurationDay(fixture, request, interval);
      // A migration-day daily fact can include both pre-tracking and post-tracking
      // time. Preserve its actuals, but never compare it to a post-start-only
      // baseline/denominator, even when knownSeconds fits that shorter interval.
      const legacyFact = (request.scope === "site" || (request.scope === "fixture" && fixture.id === request.identityId))
        && fixture.daily.some(row => row.localDate === date && row.durationSeconds > 0)
        && dateValue(fixture.from).getTime() > interval.from.getTime();
      if (legacyFact) { day.baselineMissing = true; expectedUnknown = true; }
      if (day.seconds > 0 || day.baselineMissing) selectedFixtures.add(fixture.id);
      expectedUnknown ||= day.scopeMissing;
      expectedSeconds += day.seconds; dayMissing ||= day.baselineMissing;
      attributionUnavailable ||= (request.scope === "floor" || request.scope === "group") && day.partial;
      energy = energy.add(day.energy);
    }
    baselineMissing ||= dayMissing;
    return dayMissing ? null : energy;
  });
  const baseline = baselineMissing ? null : dailyBaselines.reduce<Prisma.Decimal>((total, value) => total.add(value!), new Prisma.Decimal(0));
  const savings = difference(baseline, actual);
  const over = savings !== null && savings.isNegative();
  const tariff = data.site.tariffKwhRate == null ? null : new Prisma.Decimal(data.site.tariffKwhRate);
  // Watt/name history gaps do not invalidate independently proven membership or
  // persisted known time. Only scope/lifecycle uncertainty suppresses coverage.
  const coverageReason = attributionUnavailable ? "scope_attribution_unavailable" : expectedUnknown ? "dimension_history_missing" : null;
  const knownSeconds = coverageReason ? null : Math.min(persistedKnown, expectedSeconds);
  const summary = sections[0];
  if (summary.kind !== "summary") throw new Error("Missing summary");
  summary.rows = [
    ...summary.rows.map(row => ({ ...row, source: "persisted_actual" as const })),
    ...[
      { label: "24시간 기준 전력량", ...energyCell(baseline) },
      { label: over ? "기준 초과 전력량" : "절감 전력량", ...energyCell(savings) },
      { label: over ? "기준 초과율" : "절감률", ...decimalCell(baseline !== null && !baseline.isZero() && savings !== null ? savings.div(baseline).mul(100) : null, "%") },
      { label: "현재 단가 기준 비용", ...costCell(baseline !== null && tariff !== null ? baseline.mul(tariff) : null) },
      { label: over ? "예상 기준 초과 비용" : "예상 절감 비용", ...costCell(savings !== null && tariff !== null ? savings.mul(tariff) : null) },
      { label: "데이터 수집률", ...decimalCell(knownSeconds !== null && expectedSeconds > 0 ? new Prisma.Decimal(knownSeconds).div(expectedSeconds).mul(100) : null, "%") }
    ].map(row => ({ ...row, source: "captured_current_configuration" as const }))
  ];
  for (const [index, section] of sections.entries()) {
    if (section.kind === "table") {
      const rowIds = section.rows.map((row, index) => section.id === "daily" ? String(row[0].value)
        : section.id === "comparison" ? ["current", "previous", "difference", "change"][index] : String(row[1].value));
      const common = { id: `${section.id}-chart`, tableId: section.id, rowIds };
      if (section.id === "daily") {
        section.columns.push({ id: "baselineKwh", label: "24시간 기준 전력량" });
        section.rows.forEach((row, index) => row.push(energyCell(dailyBaselines[index])));
        sections[index] = { ...section, rowIds, visualization: { ...common, type: "daily_actual_vs_baseline", categoryColumnId: "localDate", valueColumnIds: ["energyKwh", "baselineKwh"] } };
      } else if (section.id === "comparison") {
        sections[index] = { ...section, rowIds, visualization: { ...common, rowIds: rowIds.slice(0, 2), type: "period_comparison", categoryColumnId: "period", valueColumnIds: ["energyKwh", "cost"] } };
      } else {
        sections[index] = { ...section, rowIds, visualization: { ...common, type: "horizontal_ranking", categoryColumnId: "name", valueColumnIds: ["energyKwh"], limit: 10 } };
      }
    } else if (section.kind === "heatmap") {
      sections[index] = { ...section, visualization: { id: `${section.id}-chart`, type: "heatmap", sectionId: section.id, colorScale: "sequential", noData: "gap", weekdays: 7, hours: 24 } };
    } else if (section.kind === "notes") {
      section.rows.push("생성 당시 설정 기준: 정격 W 이력 × 선택 범위 유효 초 ÷ 3,600,000. DST 날짜는 실제 UTC 구간의 초를 사용합니다.",
        `생성 당시 현재 요금 단가: ${tariff === null ? "데이터 없음 (요금 단가 없음)" : `${tariff.toFixed(2)} 원/kWh`}. 저장 비용은 소급 변경하지 않습니다.`,
        "절감량 = 기준량 − 저장 사용량. 음수는 기준 초과이며 예상 비용은 같은 현재 단가로 환산합니다.",
        "수집률 = 귀속 가능한 일별 known seconds ÷ 기대 초 × 100 (최대 100%). 기준값과 수집률은 생성 당시 설정 기준입니다.",
        ...(baselineMissing ? ["데이터 없음: 정격 또는 범위 이력 공백 (dimension_history_missing)."] : []),
        ...(attributionUnavailable ? ["데이터 없음: 하루 중 소속 변경으로 일별 수집 시간을 배분할 수 없음 (scope_attribution_unavailable)."] : []));
    }
  }
  return { capturedAt: data.capturedAt, actualSource: "persisted_actual", configurationSource: "captured_current_configuration",
    tariffKwhRate: data.site.tariffKwhRate ?? null, expectedSeconds: expectedUnknown ? null : expectedSeconds,
    knownSeconds, fixtureCount: selectedFixtures.size, baselineReason: baselineMissing ? "dimension_history_missing" : null, coverageReason };
}

function dayInterval(date: string, timeZone: string) {
  const day = parseCalendarDate(date);
  return { from: startOfLocalDate(day, timeZone), to: startOfLocalDate(addCalendarDays(day, 1), timeZone) };
}
function snapshotDayInterval(date: string, data: EnergyReportDataSnapshot) {
  const captured = data.completedDays?.find(day => day.localDate === date);
  return captured ? { from: new Date(captured.from), to: new Date(captured.to) } : dayInterval(date, data.site.timeZone);
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
