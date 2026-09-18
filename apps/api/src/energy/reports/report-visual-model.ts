import { energyReportDocumentSchema, type EnergyReportDocument } from "@led-control/shared";

/** Semantic colors are internal constants, never document-supplied SVG values. */
export const REPORT_PALETTE = {
  actual: "#2563eb", baseline: "#94a3b8", previous: "#64748b", text: "#172033",
  background: "#ffffff", grid: "#dbe2ea", noData: "#e2e8f0", noDataStroke: "#64748b",
  heat: ["#eff6ff", "#bfdbfe", "#60a5fa", "#2563eb", "#1e40af"]
} as const;
export type VisualSeries = { label: string; style: "line" | "bar"; color: string; values: Array<number | null>; displayValues: string[] };
export type VisualBarRow = { label: string; value: number | null; displayValue: string };
export type VisualHeatmapCell = { weekday: number; hour: number; value: number | null; displayValue: string };
type VisualMetadata = {
  id: string; title: string; altText: string; axes: { x: string; y: string };
  legend: Array<{ label: string; color: string }>;
  noData: { label: string; pattern: "diagonal" };
};
export type ReportVisual = VisualMetadata & (
  | { kind: "line"; x: string[]; series: VisualSeries[] }
  | { kind: "bar"; categories: string[]; series: VisualSeries[] }
  | { kind: "horizontal-bar"; rows: VisualBarRow[] }
  | { kind: "heatmap"; metric: "energy" | "brightness"; cells: VisualHeatmapCell[] }
);

const noData = { label: "데이터 없음", pattern: "diagonal" as const };
function metricLabel(column: { id: string; label: string }): string {
  const unit = column.id === "cost" ? "원" : ["energyKwh", "baselineKwh"].includes(column.id) ? "kWh" : null;
  return unit && !column.label.includes(`(${unit})`) ? `${column.label} (${unit})` : column.label;
}
function metadata(id: string, title: string, x: string, y: string, legend: VisualMetadata["legend"], details: string): VisualMetadata {
  return { id, title, axes: { x, y }, legend, noData: { ...noData },
    altText: `${title}. ${x} · ${y}. ${details} 데이터 없음은 공백 또는 사선 무늬로 표시하며 0과 구분합니다. 전체 값은 원본 표를 참조하세요.` };
}

/** Parse at the boundary so stale or hand-constructed snapshots cannot skip reference validation. */
export function buildReportVisuals(input: EnergyReportDocument): ReportVisual[] {
  const document = energyReportDocumentSchema.parse(input);
  if (document.schemaVersion === 1) return [];
  const visuals: ReportVisual[] = [];
  for (const section of document.sections) {
    if (!("visualization" in section) || !section.visualization) continue;
    const descriptor = section.visualization;
    if (descriptor.type === "heatmap") {
      if (section.kind !== "heatmap") throw new Error("Invalid heatmap reference");
      const unit = section.metric === "energy" ? "전력량 (kWh)" : "밝기 (%)";
      visuals.push({ ...metadata(descriptor.id, section.title, "시간 (0–23시)", "요일 (일–토)",
        [{ label: `${unit}: 낮음 → 높음`, color: REPORT_PALETTE.heat[4] }], "7요일 × 24시간."),
        kind: "heatmap", metric: section.metric, cells: section.cells.map(cell => ({ ...cell })) });
      continue;
    }
    const table = document.sections.find(candidate => candidate.kind === "table" && candidate.id === descriptor.tableId);
    if (!table || table.kind !== "table") throw new Error("Invalid table reference");
    const categoryIndex = table.columns.findIndex(column => column.id === descriptor.categoryColumnId);
    const rows = descriptor.rowIds.map(id => ({ cells: table.rows[table.rowIds.indexOf(id)], order: table.rowIds.indexOf(id) }));
    const categories = rows.map(row => row.cells[categoryIndex].displayValue);
    const series: VisualSeries[] = descriptor.valueColumnIds.map((id, index) => {
      const columnIndex = table.columns.findIndex(column => column.id === id);
      return { label: metricLabel(table.columns[columnIndex]),
        style: descriptor.type === "daily_actual_vs_baseline" && index === 0 ? "line" : "bar",
        color: index === 0 ? REPORT_PALETTE.actual : REPORT_PALETTE.baseline,
        values: rows.map(row => row.cells[columnIndex].value as number | null),
        displayValues: rows.map(row => row.cells[columnIndex].displayValue) };
    });
    const x = table.columns[categoryIndex].label;
    if (descriptor.type === "horizontal_ranking") {
      const ranked = rows.map((row, index) => ({ order: row.order, label: categories[index], value: series[0].values[index], displayValue: series[0].displayValues[index] }));
      // Missing values sort after every number, including negative values. A tie
      // uses document row order, which need not equal descriptor reference order.
      ranked.sort((a, b) => a.value === b.value ? a.order - b.order : a.value === null ? 1 : b.value === null ? -1 : b.value - a.value);
      visuals.push({ ...metadata(descriptor.id, section.title, series[0].label, x, [{ label: series[0].label, color: REPORT_PALETTE.actual }], "상위 10개, 동률은 원본 표 순서."),
        kind: "horizontal-bar", rows: ranked.slice(0, descriptor.limit).map(({ order: _order, ...row }) => row) });
    } else if (descriptor.type === "period_comparison") {
      // Energy and currency cannot share an axis: split the descriptor into two
      // images, retaining only its referenced cells and collision-safe IDs.
      series.forEach((entry, index) => {
        const title = `${section.title} · ${entry.label}`;
        visuals.push({ ...metadata(`${descriptor.id}/${descriptor.valueColumnIds[index]}`, title, x, entry.label,
          [{ label: entry.label, color: entry.color }], categories.join(" / ")), kind: "bar", categories: [...categories], series: [entry] });
      });
    } else {
      visuals.push({ ...metadata(descriptor.id, section.title, x, series[0].label, series.map(entry => ({ label: entry.label, color: entry.color })),
        "실제값은 선, 생성 당시 설정 기준값은 막대. 결측 날짜의 선은 연결하지 않습니다."), kind: "line", x: categories, series });
    }
  }
  if (new Set(visuals.map(visual => visual.id)).size !== visuals.length) throw new Error("Duplicate rendered visual ID");
  return visuals;
}
