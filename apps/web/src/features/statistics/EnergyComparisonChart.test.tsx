import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnergyComparisonChart, comparisonChartData, forecastLineStyle } from "./EnergyComparisonChart";
import { makeEnergyComparison } from "./statistics-test-fixtures";
import { CustomerThemeProvider } from "../../components/ui/theme/CustomerThemeProvider";
import { ThemeToggle } from "../../components/ui/theme/ThemeToggle";

describe("EnergyComparisonChart", () => {
  afterEach(cleanup);

  it("renders the real baseline as a line and the observed usage as an area without losing gap descriptions", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    try {
      const { container } = render(<EnergyComparisonChart comparison={makeEnergyComparison()} />);
      expect(container.querySelectorAll(".recharts-line")).toHaveLength(3);
      expect(container.querySelector(".recharts-area")).not.toBeNull();
      expect(container.querySelector(".recharts-bar")).toBeNull();
      expect(screen.getByText("2026년 9월 4일: 기준 100 kWh, 사용량 산정 불가, 수집률 산정 불가")).toBeInTheDocument();
    } finally { vi.unstubAllGlobals(); }
  });

  it("repaints chart axes, grid and series without replacing the chart or gap data", async () => {
    localStorage.removeItem("led-control.customer-theme.v1");
    // Isolate palette repaint from Recharts' animated dash clipping using a real supported system preference.
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)",
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    const style = document.createElement("style");
    // JSDOM cannot resolve CSS aliases; publish literal computed roles through the real provider.
    style.textContent = ':root[data-customer-theme="light"] { --color-content-secondary: #526477; --color-chart-grid: #D8E1EC; --color-chart-usage: #245FE8; --color-chart-forecast: #946000; } :root[data-customer-theme="dark"] { --color-content-secondary: #B0BDCE; --color-chart-grid: #33465D; --color-chart-usage: #94B9FF; --color-chart-forecast: #F2C46D; }';
    document.head.append(style);
    try {
      const { container } = render(<CustomerThemeProvider><ThemeToggle /><EnergyComparisonChart comparison={makeEnergyComparison()} /></CustomerThemeProvider>);
      const chart = container.querySelector("svg.recharts-surface");
      expect(chart).not.toBeNull();
      await waitFor(() => expect(container.querySelector("text.recharts-cartesian-axis-tick-value")).toHaveAttribute("fill", "#526477"));
      fireEvent.click(screen.getByRole("button", { name: "다크 모드로 변경" }));
      expect(container.querySelector("svg.recharts-surface")).toBe(chart);
      await waitFor(() => expect(container.querySelector("text.recharts-cartesian-axis-tick-value")).toHaveAttribute("fill", "#B0BDCE"));
      expect(container.querySelector(".recharts-cartesian-grid-horizontal line")).toHaveAttribute("stroke", "#33465D");
      expect(container.querySelector("text.recharts-cartesian-axis-tick-value")).toHaveAttribute("font-size", "var(--text-caption)");
      expect(container.querySelector('path.recharts-line-curve[stroke="#94B9FF"]')).not.toBeNull();
      expect(container.querySelector('path.recharts-line-curve[stroke="#F2C46D"]')).toHaveAttribute("stroke-dasharray", "4 4");
      expect(screen.getByText(/2026년 9월 4일: 기준 100 kWh, 사용량 산정 불가/)).toBeInTheDocument();
    } finally { cleanup(); style.remove(); vi.unstubAllGlobals(); localStorage.removeItem("led-control.customer-theme.v1"); }
  });

  it("keeps observed, forecast and unavailable values as separate series", () => {
    const data = comparisonChartData(makeEnergyComparison().points);

    expect(data).toEqual([
      expect.objectContaining({ observedKwh: 60, forecastKwh: null }),
      expect.objectContaining({ observedKwh: null, forecastKwh: 65 }),
      expect.objectContaining({ observedKwh: null, forecastKwh: 62 }),
      expect.objectContaining({ observedKwh: null, forecastKwh: null })
    ]);
  });

  it("renders forecast as a dashed series without connecting missing values", () => {
    render(<EnergyComparisonChart comparison={makeEnergyComparison()} />);

    expect(screen.getByRole("img", { name: "기준 대비 에너지 사용량 비교 차트" })).toBeInTheDocument();
    expect(forecastLineStyle).toEqual({ strokeDasharray: "4 4", connectNulls: false });
    expect(screen.getByText("24시간 100% · 현재 등록 조명 기준")).toBeInTheDocument();
  });

  it("labels observed periods as state-based estimates, not measured electricity", () => {
    render(<EnergyComparisonChart comparison={makeEnergyComparison()} />);

    expect(screen.getByText("완료 기간 추정 사용량")).toBeInTheDocument();
    expect(screen.queryByText("실제 사용량")).not.toBeInTheDocument();
    expect(screen.getByText(/2026년 9월 1일: 기준 100 kWh, 완료 기간 추정 60 kWh/)).toBeInTheDocument();
  });

  it("provides baseline, estimate, difference and coverage to screen readers", () => {
    render(<EnergyComparisonChart comparison={makeEnergyComparison()} />);

    expect(screen.getByText("2026년 9월 2일: 기준 100 kWh, 예상 65 kWh, 절감 35 kWh, 절감률 35%, 수집률 산정 불가"))
      .toBeInTheDocument();
    expect(screen.getByText("2026년 9월 4일: 기준 100 kWh, 사용량 산정 불가, 수집률 산정 불가"))
      .toBeInTheDocument();
  });

  it("explains unavailable periods from a compact chart context instead of a separate warning row", async () => {
    render(<EnergyComparisonChart comparison={makeEnergyComparison()} />);

    expect(screen.queryByText("선이 없는 기간은 사용량을 산정할 수 없으며 기준 사용량만 표시합니다.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "산정 불가 기간 안내" }));
    expect(await screen.findByRole("dialog", { name: "산정 불가 기간 안내" })).toHaveTextContent("기준 사용량만 표시합니다.");
    expect(screen.getByText("2026년 9월 4일: 기준 100 kWh, 사용량 산정 불가, 수집률 산정 불가")).toBeInTheDocument();
  });
});
