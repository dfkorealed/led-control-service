import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnergyHeatmap } from "./EnergyHeatmap";

describe("EnergyHeatmap", () => {
  afterEach(cleanup);
  it("renders an independently operable 7 by 24 button group and distinguishes actual zero from unavailable data", () => {
    render(<EnergyHeatmap data={heatmapResponse} metric="energy" onMetricChange={vi.fn()} />);

    expect(screen.getByRole("group", { name: "시간대별 에너지 사용량" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /요일 .*시/ })).toHaveLength(168);
    expect(screen.getByRole("button", { name: /일요일 00시.*0 kWh/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /일요일 01시.*수집 데이터 없음/ })).toBeInTheDocument();
  });

  it("changes metric and exposes keyboard-selected cell detail", () => {
    const onMetricChange = vi.fn();
    render(<EnergyHeatmap data={heatmapResponse} metric="energy" onMetricChange={onMetricChange} />);

    fireEvent.click(screen.getByRole("button", { name: "밝기" }));
    fireEvent.keyDown(screen.getByRole("button", { name: /월요일 02시.*1.25 kWh/ }), { key: "Enter" });

    expect(onMetricChange).toHaveBeenCalledWith("brightness");
    expect(screen.getByRole("button", { name: "에너지" })).toHaveClass("statistics-heatmap-metric-button");
    expect(screen.getByRole("button", { name: "밝기" })).toHaveClass("statistics-heatmap-metric-button");
    expect(screen.getByRole("status")).toHaveTextContent("월요일 02시");
    expect(screen.getByRole("status")).toHaveTextContent("1.25 kWh");
  });

  it("uses shared feedback states while loading, unavailable, and retryable error", () => {
    const onRetry = vi.fn();
    const { rerender } = render(<EnergyHeatmap isLoading metric="energy" onMetricChange={vi.fn()} />);
    expect(screen.getByText("시간대별 사용량을 계산하는 중")).toBeInTheDocument();

    rerender(<EnergyHeatmap data={{ ...heatmapResponse, cells: heatmapResponse.cells.map((cell) => ({ ...cell, value: null })) }} metric="energy" onMetricChange={vi.fn()} />);
    expect(screen.getByText("표시할 수집 데이터가 없습니다.")).toBeInTheDocument();

    rerender(<EnergyHeatmap isError metric="energy" onMetricChange={vi.fn()} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

const heatmapResponse = {
  siteId: "30000000-0000-4000-8000-000000000001",
  timeZone: "Asia/Seoul",
  generatedAt: "2026-09-11T03:00:00.000Z",
  metric: "energy" as const,
  scope: "floor" as const,
  identityId: "30000000-0000-4000-8000-000000000020",
  range: { from: "2026-08-14", to: "2026-09-10" },
  cells: Array.from({ length: 168 }, (_, index) => ({
    weekday: Math.floor(index / 24), hour: index % 24,
    value: index === 0 ? 0 : index === 1 ? null : index === 26 ? 1.25 : 1
  }))
};
