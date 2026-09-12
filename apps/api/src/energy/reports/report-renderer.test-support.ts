import { energyReportDocumentSchema, type EnergyReportDocument } from "@led-control/shared";

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
