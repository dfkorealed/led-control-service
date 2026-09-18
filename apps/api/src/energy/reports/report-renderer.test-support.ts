import { energyReportDocumentSchema, type EnergyReportDocument } from "@led-control/shared";
import { EnergyReportDocumentBuilder } from "./energy-report-document.builder";

export const expectedVisualIds = ["daily-chart", "comparison-chart/energyKwh", "comparison-chart/cost", "fixture-ranking-chart", "floor-ranking-chart", "group-ranking-chart", "energy-heatmap-chart", "brightness-heatmap-chart"];

export function visualReportFixture(): EnergyReportDocument {
  const siteId = "20000000-0000-4000-8000-000000000001";
  return new EnergyReportDocumentBuilder().build("10000000-0000-4000-8000-000000000001",
    { scope: "site", identityId: siteId, format: "pdf", from: "2026-09-01", to: "2026-09-10" },
    { schemaVersion: 2, capturedAt: "2026-09-11T00:00:00.000Z", site: { id: siteId, name: "서울 공장", timeZone: "UTC", tariffKwhRate: "160" },
      comparisonRange: { from: "2026-08-22", to: "2026-08-31" }, fixtures: Array.from({ length: 12 }, (_, index) => ({
        id: `fixture-${index}`, from: "2026-08-01T00:00:00.000Z", to: null,
        dimensions: [{ name: `한글 조명 ${index}`, floorId: "floor", floorName: "생산층", ratedWatt: "30", from: "2026-08-01T00:00:00.000Z", to: null }],
        groups: [{ id: "group", name: "생산 그룹", from: "2026-08-01T00:00:00.000Z", to: null }],
        daily: [{ localDate: "2026-09-01", energyKwh: String((index + 1) / 100), cost: "12", durationSeconds: 3600 }],
        hourly: [{ localDate: "2026-09-01", localHour: 0, bucketStartUtc: "2026-09-01T00:00:00.000Z", energyKwh: "0.01", durationSeconds: 3600, brightnessWeightedSeconds: "180000" }]
      })) });
}

export const longName = "서울 생산동 긴 이름 조명 ".repeat(35);
export function reportFixture(): EnergyReportDocument {
  return energyReportDocumentSchema.parse({
    schemaVersion: 1, reportId: "10000000-0000-4000-8000-000000000001", title: "조명 에너지 보고서",
    metadata: [{ label: "현장", value: longName, displayValue: longName },
      { label: "기간", value: "2026-09-01 ~ 2026-09-07", displayValue: "2026-09-01 ~ 2026-09-07" },
      { label: "확인", value: false, displayValue: "아니오" }],
    sections: [
      { kind: "summary", title: "요약", rows: [{ label: "사용 전력량", value: 12.3456, displayValue: "12.3456 kWh" }] },
      { kind: "table", id: "fixture-ranking", title: "조명 순위", columns: [{ id: "name", label: "이름" }, { id: "energy", label: "사용 전력량" }],
        rows: [[{ value: longName, displayValue: longName }, { value: 0, displayValue: "0.0000 kWh" }],
          [{ value: "=HYPERLINK(\"https://example.com\")", displayValue: "수식 모양 이름" }, { value: null, displayValue: "데이터 없음" }],
          ...Array.from({ length: 45 }, (_, index) => [{ value: `조명 ${index}`, displayValue: `조명 ${index}` }, { value: index + 0.25, displayValue: `${index + 0.25} kWh` }])] },
      { kind: "table", id: "empty", title: "빈 그룹 순위", columns: [{ id: "name", label: "이름" }], rows: [] },
      { kind: "heatmap", id: "energy-heatmap", title: "요일·시간별 전력량", metric: "energy",
        cells: Array.from({ length: 168 }, (_, index) => ({ weekday: Math.floor(index / 24), hour: index % 24,
          value: index === 0 ? null : index / 1000, displayValue: index === 0 ? "데이터 없음" : `${(index / 1000).toFixed(4)} kWh` })) },
      { kind: "notes", title: "계산 정보", rows: ["저장된 일별·시간별 집계만 사용합니다.", "첫째 줄\n둘째 줄", "완료."] }
    ], contentFingerprint: "a".repeat(64)
  });
}

/** Independent schema leaf walk: expectations never call the production traversal. */
export function expectedManifest(value: unknown, path = ""): Array<{ path: string; value: unknown }> {
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => expectedManifest(child, path ? `${path}.${key}` : key));
  }
  return [{ path, value }];
}
export const forbiddenReportText = /상태 기반 추정|예상|추정|coverage|known|unknown|forecast|baseline/i;
