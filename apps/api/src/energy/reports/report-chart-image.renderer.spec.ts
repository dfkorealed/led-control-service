import { createHash } from "node:crypto";
import sharp from "sharp";
import { renderReportVisual, renderReportVisualSvg, validateReportVisualPng, REPORT_CHART_SIZE, REPORT_CHART_MAX_BYTES } from "./report-chart-image.renderer";
import { buildReportVisuals, REPORT_PALETTE, type ReportVisual } from "./report-visual-model";

const common = { id: "chart", title: "조명 <script>&\"'", altText: "한글 데이터 <&\"'>", axes: { x: "날짜", y: "사용량 (kWh)" }, legend: [{ label: "실제", color: REPORT_PALETTE.actual }], noData: { label: "데이터 없음", pattern: "diagonal" as const } };
const line = (): ReportVisual => ({ ...common, kind: "line", x: ["1", "2", "3"], series: [{ label: "실제", style: "line", color: REPORT_PALETTE.actual, values: [2, null, 0], displayValues: ["2", "데이터 없음", "0"] }] });
const heat = (): ReportVisual => ({ ...common, kind: "heatmap", metric: "energy", cells: Array.from({ length: 168 }, (_, i) => ({ weekday: Math.floor(i / 24), hour: i % 24, value: i === 0 ? null : i === 1 ? 0 : 1, displayValue: i === 0 ? "데이터 없음" : String(i === 1 ? 0 : 1) })) });

describe("deterministic report chart image renderer", () => {
  it("renders a document-built heatmap including its generated axis punctuation", async () => {
    const visual = buildReportVisuals({ schemaVersion: 2, reportId: "10000000-0000-4000-8000-000000000001", title: "보고서", metadata: [], contentFingerprint: "a".repeat(64),
      calculationBasis: { capturedAt: "2026-09-01T00:00:00Z", actualSource: "persisted_actual", configurationSource: "captured_current_configuration", tariffKwhRate: null, expectedSeconds: null, knownSeconds: null, fixtureCount: 0, baselineReason: null, coverageReason: null },
      sections: [{ kind: "heatmap", id: "heat", title: "에너지 히트맵", metric: "energy", cells: (heat() as Extract<ReportVisual, { kind: "heatmap" }>).cells,
        visualization: { id: "heat-chart", type: "heatmap", sectionId: "heat", colorScale: "sequential", noData: "gap", weekdays: 7, hours: 24 } }]
    })[0];
    const first = await renderReportVisual(visual);
    expect(first.sha256).toBe((await renderReportVisual(visual)).sha256);
    expect(first.altText).toContain("일–토");
  });

  it("produces identical PNG bytes, verified dimensions and SHA256 for the same visual", async () => {
    const a = await renderReportVisual(line());
    const b = await renderReportVisual(line());
    expect(a.png.equals(b.png)).toBe(true);
    expect(a.sha256).toBe(createHash("sha256").update(a.png).digest("hex"));
    expect(a).toMatchObject({ id: "chart", width: REPORT_CHART_SIZE.width, height: REPORT_CHART_SIZE.height, altText: common.altText });
    const decoded = await sharp(a.png).raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info).toMatchObject(REPORT_CHART_SIZE);
    expect(a.png.length).toBeLessThanOrEqual(REPORT_CHART_MAX_BYTES);
  });

  it("escapes every untrusted title, label and attribute without embedding external resources", () => {
    const svg = renderReportVisualSvg(line());
    expect(svg).toContain("&lt;script&gt;&amp;&quot;&apos;");
    expect(svg).not.toContain("<script>");
    expect(svg).not.toMatch(/<image|<foreignObject|(?:href|src)=|@import|<text\b/);
    expect(svg).toContain('role="img"');
    expect(svg).toContain("<title>");
    expect(svg).toContain("<desc>");
  });

  it("breaks line segments at null, keeping an isolated zero point", () => {
    const svg = renderReportVisualSvg(line());
    expect(svg.match(/data-series-point="0:/g)).toHaveLength(2);
    expect(svg).not.toContain('data-line-segment=');
    const consecutive = line();
    if (consecutive.kind !== "line") throw new Error("Expected line");
    consecutive.series[0].values = [2, 1, 0];
    expect(renderReportVisualSvg(consecutive).match(/data-line-segment=/g)).toHaveLength(1);
  });

  it("draws a true 7 by 24 grid with distinct null and zero appearances", async () => {
    const svg = renderReportVisualSvg(heat());
    const cells = [...svg.matchAll(/<rect data-heatmap-cell="(\d+):(\d+)" x="([\d.]+)" y="([\d.]+)"[^>]*fill="([^"]+)"/g)];
    expect(cells).toHaveLength(168);
    expect(new Set(cells.map(cell => cell[3])).size).toBe(24);
    expect(new Set(cells.map(cell => cell[4])).size).toBe(7);
    expect(cells[0][5]).not.toBe(cells[1][5]);
    expect(cells[0][5]).toBe("url(#no-data)");
    expect(svg).toContain('aria-label="일 0시: 데이터 없음"');
    expect(svg).toContain('aria-label="토 23시: 1"');
    const decoded = await sharp((await renderReportVisual(heat())).png).raw().toBuffer({ resolveWithObject: true });
    const pixel = (cell: RegExpMatchArray) => { const offset = (Math.floor(Number(cell[4]) + 5) * decoded.info.width + Math.floor(Number(cell[3]) + 5)) * decoded.info.channels; return [...decoded.data.subarray(offset, offset + 3)]; };
    expect(pixel(cells[0])).not.toEqual(pixel(cells[1]));
  });

  it("renders bars, negative values, empty rankings and all-null heatmaps without nonfinite geometry", async () => {
    const visuals: ReportVisual[] = [
      { ...common, kind: "bar", categories: ["현재", "직전"], series: [{ label: "비교", style: "bar", color: REPORT_PALETTE.actual, values: [-2, null], displayValues: ["-2", "데이터 없음"] }] },
      { ...common, kind: "horizontal-bar", rows: [] },
      { ...heat(), cells: (heat() as Extract<ReportVisual, { kind: "heatmap" }>).cells.map(cell => ({ ...cell, value: null })) } as ReportVisual
    ];
    for (const visual of visuals) {
      expect(renderReportVisualSvg(visual)).not.toMatch(/NaN|Infinity/);
      expect((await renderReportVisual(visual)).png.length).toBeGreaterThan(100);
    }
  });

  it("rejects oversized, corrupted or wrongly sized PNG outputs", async () => {
    await expect(validateReportVisualPng(Buffer.alloc(REPORT_CHART_MAX_BYTES + 1))).rejects.toThrow();
    await expect(validateReportVisualPng(Buffer.from("not png"))).rejects.toThrow();
    const wrongSize = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer();
    await expect(validateReportVisualPng(wrongSize)).rejects.toThrow();
  });
});
