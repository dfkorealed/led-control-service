import type { EnergyHeatmapMetric, EnergyHeatmapResponse } from "@led-control/shared/energy-p2-contracts";
import { Activity, Grid3X3, TriangleAlert } from "lucide-react";
import { Fragment, useRef, useState } from "react";
import { Button, Card, FeedbackState, Heading, Text } from "../../../components/ui";

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
  const cellRefs = useRef<Array<HTMLButtonElement | null>>([]);

  if (isLoading) {
    return <Card className="p-4"><FeedbackState icon={Activity} title="시간대별 사용량을 계산하는 중" /></Card>;
  }
  if (isError || !data) {
    return <Card className="p-4"><FeedbackState tone="danger" icon={TriangleAlert} title="시간대별 사용량을 불러오지 못했습니다."
      action={onRetry ? <Button variant="secondary" onClick={onRetry}>다시 시도</Button> : undefined} /></Card>;
  }
  if (data.cells.every((cell) => cell.value === null)) {
    return <Card className="p-4"><FeedbackState icon={Grid3X3} title="표시할 수집 데이터가 없습니다." /></Card>;
  }

  const selected = data.cells[selectedIndex] ?? data.cells[0];
  const maximum = Math.max(...data.cells.flatMap((cell) => cell.value === null ? [] : [cell.value]), 0);
  return (
    <Card className="grid min-w-0 max-w-full gap-4 overflow-hidden p-4 compact:p-6" aria-label="시간대별 사용량">
      <header className="flex items-start justify-between gap-4 max-compact:flex-col max-compact:items-stretch">
        <div className="grid gap-1"><Text variant="overline" tone="muted">시간대 패턴</Text><Heading as="h3" variant="card-title">선택 항목 시간대별 사용량</Heading><Text variant="body-sm" tone="secondary">완료된 28일 {data.range.from} ~ {data.range.to} · 현장 시간대 {data.timeZone}</Text></div>
        <div className="flex gap-2" aria-label="히트맵 지표">
          <Button size="sm" variant={metric === "energy" ? "primary" : "secondary"} aria-pressed={metric === "energy"} className="h-14 min-h-14 min-w-14 max-compact:flex-1" onClick={() => onMetricChange("energy")}>에너지</Button>
          <Button size="sm" variant={metric === "brightness" ? "primary" : "secondary"} aria-pressed={metric === "brightness"} className="h-14 min-h-14 min-w-14 max-compact:flex-1" onClick={() => onMetricChange("brightness")}>밝기</Button>
        </div>
      </header>
      <div className="flex flex-wrap items-center gap-2 text-caption font-bold text-content-muted" aria-label="히트맵 범례">
        <span className="rounded-control border border-chart-heatmap-1 bg-chart-heatmap-empty px-2 py-1">{metric === "energy" ? "0 kWh" : "0%"}</span>
        <span>낮음</span><span className="inline-grid grid-cols-5 gap-1" aria-hidden="true">
          <i className="h-3 w-5 rounded-control bg-chart-heatmap-1" /><i className="h-3 w-5 rounded-control bg-chart-heatmap-2" />
          <i className="h-3 w-5 rounded-control bg-chart-heatmap-3" /><i className="h-3 w-5 rounded-control bg-chart-heatmap-4" />
          <i className="h-3 w-5 rounded-control bg-chart-heatmap-5" />
        </span><span>높음 · 1~5단계</span><span className="ml-2 rounded-control border border-dashed border-border-default px-2 py-1">수집 데이터 없음</span>
      </div>
      <Text variant="caption" tone="secondary">가로축 시간 (00~23시) · 세로축 요일 (일~토)</Text>
      <div className="min-w-0 max-w-full overflow-x-auto rounded-panel border border-border-default outline-none focus-visible:shadow-focus" tabIndex={0} aria-label="시간대별 사용량 표를 가로로 스크롤">
        <div className="grid w-max grid-cols-[3.5rem_repeat(24,3.5rem)] gap-1 p-2" role="group" aria-label={`시간대별 ${metric === "energy" ? "에너지 사용량" : "밝기"}`}>
          <span aria-hidden="true" />
          {Array.from({ length: 24 }, (_, hour) => <span key={hour} aria-hidden="true" className="text-center text-caption font-bold text-content-muted">{String(hour).padStart(2, "0")}</span>)}
          {data.cells.map((cell, index) => {
            const label = cellLabel(cell, metric);
            const level = levelFor(cell.value, maximum);
            return <Fragment key={`${cell.weekday}-${cell.hour}`}>
              {index % 24 === 0 ? <span aria-hidden="true" className="flex items-center justify-center text-caption font-bold text-content-muted">{weekdays[cell.weekday].slice(0, 1)}</span> : null}
              <Button type="button" variant="ghost" size="sm" aria-label={label}
              ref={(element) => { cellRefs.current[index] = element; }}
              className={`relative h-14 min-h-14 w-14 min-w-14 rounded-control p-0 ${heatmapLevelClass[level]} ${index === selectedIndex ? "outline-2 outline-offset-2 outline-chart-heatmap-5" : ""}`}
              aria-pressed={index === selectedIndex} tabIndex={index === selectedIndex ? 0 : -1}
              data-level={level} data-missing={cell.value === null ? true : undefined}
              onClick={() => setSelectedIndex(index)} onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelectedIndex(index);
                  return;
                }
                const nextIndex = keyboardCellIndex(index, event.key, data.cells.length);
                if (nextIndex === null) return;
                event.preventDefault();
                setSelectedIndex(nextIndex);
                cellRefs.current[nextIndex]?.focus();
              }}>
              <span className="sr-only">{label}</span>
              </Button>
            </Fragment>;
          })}
        </div>
      </div>
      <Text variant="body-sm" weight="bold" role="status" className="tabular-nums">{selected ? cellLabel(selected, metric) : "선택한 시간대가 없습니다."}</Text>
    </Card>
  );
}

function keyboardCellIndex(index: number, key: string, cellCount: number) {
  const rowStart = Math.floor(index / 24) * 24;
  const rowEnd = Math.min(rowStart + 23, cellCount - 1);
  switch (key) {
    case "ArrowLeft": return Math.max(rowStart, index - 1);
    case "ArrowRight": return Math.min(rowEnd, index + 1);
    case "ArrowUp": return index >= 24 ? index - 24 : index;
    case "ArrowDown": return index + 24 < cellCount ? index + 24 : index;
    case "Home": return rowStart;
    case "End": return rowEnd;
    default: return null;
  }
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
  return String(Math.min(5, Math.ceil((value / maximum) * 5)));
}

const heatmapLevelClass: Record<string, string> = {
  missing: "border-dashed border-border-strong bg-chart-heatmap-empty",
  "0": "border-chart-heatmap-1 bg-chart-heatmap-empty",
  "1": "border-chart-heatmap-1 bg-chart-heatmap-1",
  "2": "border-chart-heatmap-2 bg-chart-heatmap-2",
  "3": "border-chart-heatmap-3 bg-chart-heatmap-3",
  "4": "border-chart-heatmap-4 bg-chart-heatmap-4",
  "5": "border-chart-heatmap-5 bg-chart-heatmap-5"
};
