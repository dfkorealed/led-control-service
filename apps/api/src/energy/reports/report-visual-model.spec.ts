import { energyReportDocumentSchema, type EnergyReportDocument } from "@led-control/shared";
import { buildReportVisuals } from "./report-visual-model";

const cell = (value: string | number | null) => ({ value, displayValue: value === null ? "데이터 없음" : String(value) });
function fixture(): EnergyReportDocument {
  return energyReportDocumentSchema.parse({
    schemaVersion: 2, reportId: "10000000-0000-4000-8000-000000000001", title: "보고서", metadata: [], contentFingerprint: "a".repeat(64),
    calculationBasis: { capturedAt: "2026-09-01T00:00:00Z", actualSource: "persisted_actual", configurationSource: "captured_current_configuration",
      tariffKwhRate: null, expectedSeconds: null, knownSeconds: null, fixtureCount: 0, baselineReason: null, coverageReason: null },
    sections: [
      { kind: "table", id: "daily", title: "일별", columns: [{ id: "day", label: "날짜" }, { id: "actual", label: "실제 (kWh)" }, { id: "base", label: "기준 (kWh)" }],
        rowIds: ["a", "b", "c"], rows: [[cell("09-01"), cell(2), cell(4)], [cell("09-02"), cell(null), cell(4)], [cell("09-03"), cell(0), cell(4)]],
        visualization: { id: "daily-chart", type: "daily_actual_vs_baseline", tableId: "daily", categoryColumnId: "day", valueColumnIds: ["actual", "base"], rowIds: ["a", "b", "c"] } },
      { kind: "table", id: "compare", title: "기간 비교", columns: [{ id: "period", label: "기간" }, { id: "energy", label: "전력 (kWh)" }, { id: "cost", label: "비용 (원)" }],
        rowIds: ["now", "before"], rows: [[cell("현재"), cell(2), cell(900)], [cell("직전"), cell(1), cell(null)]],
        visualization: { id: "comparison", type: "period_comparison", tableId: "compare", categoryColumnId: "period", valueColumnIds: ["energy", "cost"], rowIds: ["now", "before"] } },
      { kind: "table", id: "ranking", title: "순위", columns: [{ id: "name", label: "조명" }, { id: "energy", label: "전력 (kWh)" }],
        rowIds: Array.from({ length: 12 }, (_, i) => `r${i}`), rows: Array.from({ length: 12 }, (_, i) => [cell(`조명 ${i}`), cell(i === 11 ? 9 : 5)]),
        visualization: { id: "ranking-chart", type: "horizontal_ranking", tableId: "ranking", categoryColumnId: "name", valueColumnIds: ["energy"], rowIds: Array.from({ length: 12 }, (_, i) => `r${11 - i}`), limit: 10 } },
      { kind: "heatmap", id: "heat", title: "히트맵", metric: "energy", cells: Array.from({ length: 168 }, (_, i) => ({ weekday: Math.floor(i / 24), hour: i % 24, ...cell(i === 0 ? null : 0) })),
        visualization: { id: "heat-chart", type: "heatmap", sectionId: "heat", colorScale: "sequential", noData: "gap", weekdays: 7, hours: 24 } }
    ]
  });
}

describe("buildReportVisuals", () => {
  it("resolves numeric cells and preserves actual null gaps and zero", () => {
    const document = fixture();
    const before = JSON.stringify(document);
    const visual = buildReportVisuals(document)[0];
    expect(visual.kind).toBe("line");
    if (visual.kind !== "line") throw new Error("Expected line");
    expect(visual.x).toEqual(["09-01", "09-02", "09-03"]);
    expect(visual.series.map(series => [series.style, series.values])).toEqual([["line", [2, null, 0]], ["bar", [4, 4, 4]]]);
    const daily = document.sections[0];
    if (daily.kind !== "table") throw new Error("Expected table");
    daily.rows[0][1] = cell(7);
    const updated = buildReportVisuals(document)[0];
    if (updated.kind !== "line") throw new Error("Expected line");
    expect(updated.series[0].values).toEqual([7, null, 0]);
    daily.rows[0][1] = cell(2);
    expect(JSON.stringify(document)).toBe(before);
  });

  it("separates comparison units into independently labelled bar charts", () => {
    const visuals = buildReportVisuals(fixture()).filter(visual => visual.kind === "bar");
    expect(visuals).toHaveLength(2);
    expect(visuals.map(visual => [visual.axes.y, visual.series[0].values])).toEqual([["전력 (kWh)", [2, 1]], ["비용 (원)", [900, null]]]);
    expect(new Set(buildReportVisuals(fixture()).map(visual => visual.id)).size).toBe(5);
  });

  it("takes only the top ten and breaks ties in document order even when references are reversed", () => {
    const visual = buildReportVisuals(fixture()).find(visual => visual.kind === "horizontal-bar")!;
    if (visual.kind !== "horizontal-bar") throw new Error("Expected ranking");
    expect(visual.rows.map(row => row.label)).toEqual(["조명 11", "조명 0", "조명 1", "조명 2", "조명 3", "조명 4", "조명 5", "조명 6", "조명 7", "조명 8"]);
    expect(visual.rows.map(row => row.value)).toEqual([9, 5, 5, 5, 5, 5, 5, 5, 5, 5]);
  });

  it("adds known metric units when builder column labels omit them", () => {
    const document = fixture();
    const comparison = document.sections[1];
    if (comparison.kind !== "table") throw new Error("Expected table");
    comparison.columns[2].label = "저장 비용";
    const costs = buildReportVisuals(document).find(visual => visual.id === "comparison/cost")!;
    expect(costs.axes.y).toBe("저장 비용 (원)");
  });

  it("retains all 168 heatmap cells and supplies deterministic accessible metadata", () => {
    const first = buildReportVisuals(fixture());
    expect(first).toEqual(buildReportVisuals(fixture()));
    const heat = first.find(visual => visual.kind === "heatmap")!;
    if (heat.kind !== "heatmap") throw new Error("Expected heatmap");
    expect(heat.cells).toHaveLength(168);
    expect(heat.cells[0].value).toBeNull();
    expect(heat.cells[1].value).toBe(0);
    expect(heat.axes.y).toBe("요일 (일–토)");
    for (const visual of first) {
      expect(visual.altText).toContain(visual.title);
      expect(visual.noData.label).toBe("데이터 없음");
      expect(visual.axes.x).toBeTruthy();
      expect(visual.axes.y).toBeTruthy();
      expect(visual.legend.length).toBeGreaterThan(0);
    }
  });

  it("rejects broken references and nonnumeric values at its document boundary", () => {
    const document = fixture();
    const daily = document.sections[0];
    if (daily.kind !== "table") throw new Error("Expected table");
    daily.rows[0][1] = cell("not a number");
    expect(() => buildReportVisuals(document)).toThrow();
    daily.rows[0][1] = cell(2);
    if (!("visualization" in daily) || !daily.visualization || daily.visualization.type === "heatmap") throw new Error("Expected visualization");
    daily.visualization.rowIds[0] = "missing";
    expect(() => buildReportVisuals(document)).toThrow();
  });

  it("leaves legacy v1 documents without newly invented visuals", () => {
    expect(buildReportVisuals(energyReportDocumentSchema.parse({ schemaVersion: 1, reportId: "10000000-0000-4000-8000-000000000001", title: "v1", metadata: [], sections: [], contentFingerprint: "a".repeat(64) }))).toEqual([]);
  });
});
