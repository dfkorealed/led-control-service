import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnergyHeatmap } from "./EnergyHeatmap";

describe("EnergyHeatmap", () => {
  afterEach(cleanup);
  it("renders an independently operable 7 by 24 button group and distinguishes actual zero from unavailable data", () => {
    render(<EnergyHeatmap data={heatmapResponse} metric="energy" onMetricChange={vi.fn()} />);

    expect(screen.getByRole("group", { name: "시간대별 에너지 사용량" })).toBeInTheDocument();
    const cells = screen.getAllByRole("button", { name: /요일 .*시/ });
    expect(cells).toHaveLength(168);
    expect(cells.filter((cell) => cell.tabIndex === 0)).toEqual([cells[0]]);
    expect(cells.slice(1).every((cell) => cell.tabIndex === -1)).toBe(true);
    expect(screen.getByRole("button", { name: /일요일 00시.*0 kWh/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /일요일 01시.*수집 데이터 없음/ })).toBeInTheDocument();
  });

  it("moves one roving focus through the 7 by 24 grid with clamped arrow, Home and End keys", () => {
    render(<EnergyHeatmap data={heatmapResponse} metric="energy" onMetricChange={vi.fn()} />);
    const sunday00 = screen.getByRole("button", { name: /일요일 00시/ });
    sunday00.focus();

    fireEvent.keyDown(sunday00, { key: "ArrowUp" });
    expect(sunday00).toHaveFocus();
    fireEvent.keyDown(sunday00, { key: "ArrowLeft" });
    expect(sunday00).toHaveFocus();
    fireEvent.keyDown(sunday00, { key: "End" });
    const sunday23 = screen.getByRole("button", { name: /일요일 23시/ });
    expect(sunday23).toHaveFocus();
    expect(sunday23).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent("일요일 23시");
    fireEvent.keyDown(sunday23, { key: "ArrowRight" });
    expect(sunday23).toHaveFocus();

    fireEvent.keyDown(sunday23, { key: "ArrowDown" });
    const monday23 = screen.getByRole("button", { name: /월요일 23시/ });
    expect(monday23).toHaveFocus();
    fireEvent.keyDown(monday23, { key: "Home" });
    const monday00 = screen.getByRole("button", { name: /월요일 00시/ });
    expect(monday00).toHaveFocus();
    fireEvent.keyDown(monday00, { key: "ArrowLeft" });
    expect(monday00).toHaveFocus();
    fireEvent.keyDown(monday00, { key: "ArrowUp" });
    expect(sunday00).toHaveFocus();

    const saturday23 = screen.getByRole("button", { name: /토요일 23시/ });
    saturday23.focus();
    fireEvent.keyDown(saturday23, { key: "ArrowDown" });
    expect(saturday23).toHaveFocus();
  });

  it("keeps the selected roving cell valid across metric changes", () => {
    const onMetricChange = vi.fn();
    const { rerender } = render(<EnergyHeatmap data={heatmapResponse} metric="energy" onMetricChange={onMetricChange} />);

    const sunday01 = screen.getByRole("button", { name: /일요일 01시/ });
    fireEvent.click(sunday01);
    expect(sunday01).toHaveAttribute("aria-pressed", "true");
    const sunday02 = screen.getByRole("button", { name: /일요일 02시/ });
    sunday02.focus();
    fireEvent.keyDown(sunday02, { key: " " });
    expect(sunday02).toHaveAttribute("aria-pressed", "true");

    const monday02 = screen.getByRole("button", { name: /월요일 02시.*1.25 kWh/ });
    monday02.focus();
    fireEvent.keyDown(monday02, { key: "Enter" });
    expect(monday02).toHaveAttribute("aria-pressed", "true");
    expect(monday02).toHaveAttribute("tabindex", "0");
    fireEvent.click(screen.getByRole("button", { name: "밝기" }));
    rerender(<EnergyHeatmap data={{ ...heatmapResponse, metric: "brightness" }} metric="brightness" onMetricChange={onMetricChange} />);

    expect(onMetricChange).toHaveBeenCalledWith("brightness");
    expect(onMetricChange).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: /월요일 02시.*1.25%/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /월요일 02시.*1.25%/ })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("status")).toHaveTextContent("월요일 02시");
    expect(screen.getByRole("status")).toHaveTextContent("1.25%");
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
