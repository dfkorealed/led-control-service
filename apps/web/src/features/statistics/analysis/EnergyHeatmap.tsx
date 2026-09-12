import type { EnergyHeatmapMetric, EnergyHeatmapResponse } from "@led-control/shared/energy-p2-contracts";
import { Activity, Grid3X3, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Button, Card, FeedbackState } from "../../../components/ui";

const weekdays = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];

export function EnergyHeatmap({
  data,
  metric,
  onMetricChange,
  isLoading = false,
  isError = false,
  onRetry
}: {
  data?: EnergyHeatmapResponse;
  metric: EnergyHeatmapMetric;
  onMetricChange: (metric: EnergyHeatmapMetric) => void;
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  if (isLoading) {
    return <Card className="statistics-heatmap"><FeedbackState icon={Activity} title="시간대별 사용량을 계산하는 중" /></Card>;
  }
  if (isError || !data) {
    return <Card className="statistics-heatmap"><FeedbackState tone="danger" icon={TriangleAlert} title="시간대별 사용량을 불러오지 못했습니다."
      action={onRetry ? <Button variant="secondary" onClick={onRetry}>다시 시도</Button> : undefined} /></Card>;
  }
  if (data.cells.every((cell) => cell.value === null)) {
    return <Card className="statistics-heatmap"><FeedbackState icon={Grid3X3} title="표시할 수집 데이터가 없습니다." /></Card>;
  }

  const selected = data.cells[selectedIndex] ?? data.cells[0];
  const maximum = Math.max(...data.cells.flatMap((cell) => cell.value === null ? [] : [cell.value]), 0);
  return (
    <Card className="statistics-heatmap">
      <header className="statistics-heatmap-heading">
        <div><span className="eyebrow">시간대 패턴</span><h3>선택 항목 시간대별 사용량</h3><p>{data.range.from} ~ {data.range.to} · {data.timeZone}</p></div>
        <div className="segmented-control" aria-label="히트맵 지표">
          <button type="button" aria-pressed={metric === "energy"} className={`statistics-heatmap-metric-button${metric === "energy" ? " active" : ""}`} onClick={() => onMetricChange("energy")}>에너지</button>
          <button type="button" aria-pressed={metric === "brightness"} className={`statistics-heatmap-metric-button${metric === "brightness" ? " active" : ""}`} onClick={() => onMetricChange("brightness")}>밝기</button>
        </div>
      </header>
      <div className="statistics-heatmap-legend" aria-label="히트맵 범례">
        <span>낮음</span><span className="statistics-heatmap-legend-scale" aria-hidden="true"><i /><i /><i /><i /><i /></span><span>높음</span><span className="statistics-heatmap-missing">수집 데이터 없음</span>
      </div>
      <div className="statistics-heatmap-scroll" tabIndex={0} aria-label="시간대별 사용량 표를 가로로 스크롤">
        <div className="statistics-heatmap-grid" role="group" aria-label={`시간대별 ${metric === "energy" ? "에너지 사용량" : "밝기"}`}>
          {data.cells.map((cell, index) => {
            const label = cellLabel(cell, metric);
            return <button key={`${cell.weekday}-${cell.hour}`} type="button" aria-label={label}
              aria-pressed={index === selectedIndex} data-level={levelFor(cell.value, maximum)} data-missing={cell.value === null ? true : undefined}
              onClick={() => setSelectedIndex(index)} onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedIndex(index); }
              }}>
              <span className="sr-only">{label}</span>
            </button>;
          })}
        </div>
      </div>
      <p className="statistics-heatmap-detail" role="status">{selected ? cellLabel(selected, metric) : "선택한 시간대가 없습니다."}</p>
    </Card>
  );
}

function cellLabel(cell: EnergyHeatmapResponse["cells"][number], metric: EnergyHeatmapMetric) {
  const time = `${weekdays[cell.weekday]} ${String(cell.hour).padStart(2, "0")}시`;
  if (cell.value === null) return `${time}, 수집 데이터 없음`;
  const value = metric === "energy"
    ? `${cell.value.toLocaleString("ko-KR", { maximumFractionDigits: 4 })} kWh`
    : `${cell.value.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}%`;
  return `${time}, ${value}`;
}

function levelFor(value: number | null, maximum: number) {
  if (value === null) return "missing";
  if (value === 0 || maximum === 0) return "0";
  return String(Math.min(4, Math.ceil((value / maximum) * 4)));
}
