import type { EnergyRankingItem } from "@led-control/shared/energy-analytics-contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnergyRankingList } from "./EnergyRankingList";
import { EnergyRankingDetailPanel } from "./EnergyRankingDetailPanel";

const item: EnergyRankingItem = {
  identityId: "fixture-1", name: "수집된 조명", rank: 1, fixtureCount: 1,
  operationalId: null, perFixtureAverageKwh: 0, knownSeconds: 3600, unknownSeconds: 0,
  estimatedKwh: 0, estimatedCost: 0, contributionRate: 0, metricValue: 0,
  coverageRate: 1, dataStatus: "available", historyQuality: "observed", unrankedReason: null,
  previousPeriod: null, dailyPoints: [], fixtures: []
};

describe("ranking data meaning", () => {
  afterEach(cleanup);
  it("draws collected zero as zero width and does not draw an unknown metric", () => {
    render(<EnergyRankingList items={[item, { ...item, identityId: "unknown", name: "산정 불가", metricValue: null }]}
      unranked={[]} metric="usage" selectedId={null} onSelect={vi.fn()} />);
    const zero = screen.getByRole("button", { name: /수집된 조명/ });
    const unknown = screen.getByRole("button", { name: /산정 불가/ });
    expect(zero.querySelector("[aria-hidden=true] > span")).toHaveStyle({ width: "0%" });
    expect(unknown.querySelector("[aria-hidden=true] > span")).toBeNull();
    expect(unknown).toHaveTextContent("—");
  });

  it("compares small collected values on the same scale without treating one kWh as the maximum", () => {
    render(<EnergyRankingList items={[{ ...item, metricValue: 0.25 }, { ...item, identityId: "second", name: "두 번째 조명", metricValue: 0.125 }]}
      unranked={[]} metric="usage" selectedId={null} onSelect={vi.fn()} />);
    expect(screen.getByRole("button", { name: /수집된 조명/ }).querySelector("[aria-hidden=true] > span")).toHaveStyle({ width: "100%" });
    expect(screen.getByRole("button", { name: /두 번째 조명/ }).querySelector("[aria-hidden=true] > span")).toHaveStyle({ width: "50%" });
  });

  it.each([
    [null, "text-content-primary"], [0, "text-content-primary"],
    [12.5, "text-status-danger-foreground"], [-12.5, "text-status-success-foreground"]
  ] as const)("keeps a %s previous change in its real semantic tone", (change, tone) => {
    render(<EnergyRankingDetailPanel item={{ ...item, previousPeriod: change === null ? null
      : { estimatedKwh: 1, changeRatePercent: change, rank: 1 } }} />);
    expect(screen.getByText(/이전 동일 기간 대비/)).toHaveClass(tone);
    expect(screen.getByText("수집률").closest("dt")?.nextElementSibling).toHaveTextContent("100%");
  });
});
