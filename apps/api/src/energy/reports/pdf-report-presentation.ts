import { Prisma } from "@prisma/client";
import { energyReportDocumentSchema, type EnergyReportDocument } from "@led-control/shared";

export type PdfMeasure = { raw: string | null; text: string };
export type PdfCompleteness = "complete" | "partial" | "missing" | "unknown";
export type PdfDailyRow = { date: string; energy: PdfMeasure; cost: PdfMeasure;
  completeness: PdfCompleteness; expectedSeconds: number | null; knownSeconds: number };
export type PdfReportPresentation = {
  site: string; target: string; scope: string; period: { from: string; to: string };
  timeZone: string; capturedAt: string; precision: number;
  summary: { current: PdfMeasure; previous: PdfMeasure; difference: PdfMeasure;
    storedCost: PdfMeasure; comparisonAvailable: boolean; comparisonReason: string | null };
  daily: PdfDailyRow[];
  monthly: Array<{ month: string; energy: PdfMeasure; cost: PdfMeasure; days: PdfDailyRow[] }>;
  peakDay: { date: string; energy: PdfMeasure } | null;
  floors: { rows: Array<{ name: string; energy: PdfMeasure }>; unassigned: PdfMeasure };
  fixtures: { topFive: Array<{ name: string; energy: PdfMeasure }>; other: PdfMeasure; unassigned: PdfMeasure };
  heatmap: Array<{ weekday: number; hour: number; energy: PdfMeasure;
    expectedSeconds: number; knownSeconds: number; completeness: PdfCompleteness | "not_applicable" }>;
  heatmapCoverage: PdfCompleteness;
  peakCell: { weekday: number; hour: number; energy: PdfMeasure } | null;
  dominantHours: Array<{ hour: number; energy: PdfMeasure }>;
  quality: { current: { completeDays: number; totalDays: number }; previous: { completeDays: number; totalDays: number };
    notes: string[] };
  notes: string[];
};

type SourceRow = Record<string, string | null>;
const ZERO = new Prisma.Decimal(0);

function sourceRows(document: EnergyReportDocument, id: string): SourceRow[] {
  const table = document.sections.find(section => section.kind === "table" && section.id === id);
  if (!table || table.kind !== "table") throw new Error(`PDF source section missing: ${id}`);
  return table.rows.map(row => Object.fromEntries(table.columns.map((column, index) =>
    [column.id, row[index].value === null ? null : String(row[index].value)])));
}
function decimal(value: string | null): Prisma.Decimal | null { return value === null ? null : new Prisma.Decimal(value); }
function add(values: Array<string | null>): string | null {
  if (!values.length || values.some(value => value === null)) return null;
  return values.reduce<Prisma.Decimal>((sum, value) => sum.add(value!), ZERO).toString();
}
function measure(value: string | null, unit: "kWh" | "원", precision: number, missing = "데이터 없음"): PdfMeasure {
  return { raw: value, text: value === null ? missing : `${new Prisma.Decimal(value).toFixed(unit === "kWh" ? precision : 2)} ${unit}` };
}
function sortedTotals(rows: SourceRow[], id: string, label: string) {
  const totals = new Map<string, { name: string; date: string; energy: Prisma.Decimal }>();
  let unassigned = ZERO;
  for (const row of rows) {
    if (row[id] === null || row[label] === null) { unassigned = unassigned.add(row.energy!); continue; }
    const key = row[id]!;
    const previous = totals.get(key);
    totals.set(key, { name: previous && previous.date > row.date! ? previous.name : row[label]!,
      date: previous && previous.date > row.date! ? previous.date : row.date!,
      energy: (previous?.energy ?? ZERO).add(row.energy!) });
  }
  return { rows: [...totals.entries()].sort((a, b) => b[1].energy.comparedTo(a[1].energy) || a[0].localeCompare(b[0])),
    unassigned: unassigned.toString() };
}
function range(value: string): { from: string; to: string } {
  const [from, to] = value.split(" ~ ");
  if (!from || !to) throw new Error("PDF report period missing");
  return { from, to };
}

/** Select only publishable facts from the immutable, fingerprinted snapshot. */
export function buildPdfReportPresentation(input: EnergyReportDocument): PdfReportPresentation {
  const document = energyReportDocumentSchema.parse(input);
  if (document.schemaVersion !== 2) throw new Error("PDF presentation requires a v2 report document");
  const coverage = sourceRows(document, "pdf-source-coverage");
  const facts = sourceRows(document, "pdf-source-facts").filter(row => row.period === "current");
  const hourly = sourceRows(document, "pdf-source-hourly");
  const current = coverage.filter(row => row.period === "current");
  const previous = coverage.filter(row => row.period === "previous");
  const precision = Math.max(2, Math.min(4, Math.max(0, ...[...coverage, ...hourly].flatMap(row => row.energy === null ? [] : [
    row.energy.split(".")[1]?.length ?? 0]))));
  const energy = (raw: string | null, missing?: string) => measure(raw, "kWh", precision, missing);
  const cost = (raw: string | null) => measure(raw, "원", precision);
  const meta = (label: string) => document.metadata.find(row => row.label === label)?.value;
  const period = range(String(meta("기간") ?? ""));
  const summaryCurrent = add(current.map(row => row.energy));
  const summaryPrevious = add(previous.map(row => row.energy));
  const complete = (rows: SourceRow[]) => rows.length > 0 && rows.every(row => row.status === "complete");
  const comparisonAvailable = complete(current) && complete(previous) && current.length === previous.length;
  const comparisonReason = comparisonAvailable ? null : "현재 또는 직전 동일 일수의 수집 기록이 완전하지 않습니다.";
  const difference = comparisonAvailable && summaryCurrent !== null && summaryPrevious !== null
    ? new Prisma.Decimal(summaryCurrent).sub(summaryPrevious).toString() : null;
  const daily = current.map(row => ({ date: row.date!, energy: energy(row.energy), cost: cost(row.cost),
    completeness: row.status as PdfCompleteness, expectedSeconds: row.expect === null ? null : Number(row.expect),
    knownSeconds: Number(row.known) }));
  const months = new Map<string, SourceRow[]>();
  for (const row of current) months.set(row.date!.slice(0, 7), [...(months.get(row.date!.slice(0, 7)) ?? []), row]);
  const monthly = [...months].map(([month, rows]) => ({ month,
    energy: energy(rows.every(row => row.status === "complete") ? add(rows.map(row => row.energy)) : null),
    cost: cost(rows.every(row => row.status === "complete") ? add(rows.map(row => row.cost)) : null),
    days: daily.filter(day => day.date.startsWith(`${month}-`)) }));
  const peak = current.filter(row => row.energy !== null).sort((a, b) =>
    decimal(b.energy)!.comparedTo(decimal(a.energy)!) || a.date!.localeCompare(b.date!))[0];
  const floorTotals = sortedTotals(facts, "floorId", "floor");
  const fixtureTotals = sortedTotals(facts, "fid", "fname");
  const fixtureTop = fixtureTotals.rows.slice(0, 5);
  if (hourly.length !== 168) throw new Error("PDF hourly source must contain 168 cells");
  const heatmap = hourly.map(row => ({ weekday: Number(row.weekday), hour: Number(row.hour),
    energy: energy(row.energy), expectedSeconds: Number(row.expect), knownSeconds: Number(row.known),
    completeness: row.status as PdfCompleteness | "not_applicable" }));
  const expectedHourCells = hourly.filter(row => Number(row.expect) > 0);
  const hourlySum = add(hourly.filter(row => row.energy !== null).map(row => row.energy));
  const hourlyMatchesDaily = summaryCurrent !== null && hourlySum !== null &&
    new Prisma.Decimal(hourlySum).equals(summaryCurrent);
  const heatmapCoverage: PdfCompleteness = expectedHourCells.length === 0 ? "unknown"
    : expectedHourCells.some(row => row.status === "unknown") ||
      (complete(current) && expectedHourCells.every(row => row.status === "complete") && !hourlyMatchesDaily) ? "unknown"
      : expectedHourCells.every(row => row.status === "missing") ? "missing"
      : complete(current) && expectedHourCells.every(row => row.status === "complete") && hourlyMatchesDaily ? "complete" : "partial";
  const peakCell = heatmap.filter(cell => cell.energy.raw !== null).sort((a, b) =>
    decimal(b.energy.raw)!.comparedTo(decimal(a.energy.raw)!))[0] ?? null;
  const hourTotals = new Map<number, Prisma.Decimal>();
  for (const cell of heatmap) if (cell.energy.raw !== null)
    hourTotals.set(cell.hour, (hourTotals.get(cell.hour) ?? ZERO).add(cell.energy.raw));
  const dominantHours = [...hourTotals].sort((a, b) => b[1].comparedTo(a[1]) || a[0] - b[0]).slice(0, 3)
    .map(([hour, total]) => ({ hour, energy: energy(total.toString()) }));
  const quality = { current: { completeDays: current.filter(row => row.status === "complete").length, totalDays: current.length },
    previous: { completeDays: previous.filter(row => row.status === "complete").length, totalDays: previous.length },
    notes: [...new Set(coverage.filter(row => row.status !== "complete").map(row =>
      `${row.period === "current" ? "이번" : "직전"} 기간 ${row.date}: ${row.status === "missing" ? "기록 없음" : row.status === "partial" ? "일부 시간만 기록" : "수집 범위 확인 불가"}`)),
      ...(heatmapCoverage === "complete" ? [] : [`요일·시간별 전력량: ${heatmapCoverage === "missing" ? "시간별 기록 없음" :
        heatmapCoverage === "unknown" ? "일별 합계와 시간별 합계 또는 귀속 범위를 확인할 수 없음" : "시간별 일부 기록만 있음"}`]) ] };
  return {
    site: String(meta("현장") ?? ""), target: String(meta("대상") ?? meta("현장") ?? ""),
    scope: String(meta("범위") ?? "").split(":")[0], period, timeZone: String(meta("시간대") ?? ""),
    capturedAt: document.calculationBasis.capturedAt, precision,
    summary: { current: energy(summaryCurrent), previous: energy(summaryPrevious), difference: energy(difference, "비교 불가"),
      storedCost: cost(add(current.map(row => row.cost))), comparisonAvailable, comparisonReason },
    daily, monthly, peakDay: peak ? { date: peak.date!, energy: energy(peak.energy) } : null,
    floors: { rows: floorTotals.rows.map(([, row]) => ({ name: row.name, energy: energy(row.energy.toString()) })),
      unassigned: energy(floorTotals.unassigned) },
    fixtures: { topFive: fixtureTop.map(([, row]) => ({ name: row.name, energy: energy(row.energy.toString()) })),
      other: energy(fixtureTotals.rows.slice(5).reduce((sum, [, row]) => sum.add(row.energy), ZERO).toString()),
      unassigned: energy(fixtureTotals.unassigned) },
    heatmap, heatmapCoverage, peakCell, dominantHours, quality,
    notes: ["전력량은 저장된 조명 상태 기반 집계이며 별도 계량기 검증값이 아닙니다.",
      "비용은 생성 당시 저장된 비용 합계입니다. 청구액이나 요금 절감액을 뜻하지 않습니다.",
      "비교 차이 = 이번 기간 저장 전력량 − 직전 동일 일수 저장 전력량.",
      ...(new Prisma.Decimal(floorTotals.unassigned).isZero() ? [] : ["층 이력이 불완전한 전력량은 귀속 불가로 표시합니다."]),
      ...quality.notes]
  };
}
