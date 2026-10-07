import type { EnergySummary } from "@led-control/shared";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatisticsOperationalInfo } from "./StatisticsOperationalInfo";

const period = { estimatedKwh: 0, estimatedCost: 0, knownSeconds: 0, unknownSeconds: 0, dataStatus: "available" as const };
const summary: EnergySummary = {
  siteId: "00000000-0000-4000-8000-000000000003", timeZone: "Asia/Seoul", source: "state_based_estimate",
  generatedAt: "2026-10-06T00:00:00.000Z", lastAggregatedAt: null,
  today: period, monthToDate: { ...period, knownSeconds: 7200, unknownSeconds: 60, dataStatus: "partial" },
  yearToDate: { ...period, knownSeconds: 86400, unknownSeconds: 3600, dataStatus: "partial" },
  monthForecast: { estimatedKwh: null, estimatedCost: null, observedKnownSeconds: 0, reason: "insufficient_state" },
  baseline24Hours: { estimatedKwh: 0, estimatedCost: 0, fixtureCount: 0, daysInMonth: 31 },
  estimatedSavings: { kwh: null, cost: null }
};
describe("StatisticsOperationalInfo", () => {
  afterEach(cleanup);
  it("separates real period quality and unknown aggregate time from generated time", () => {
    render(<StatisticsOperationalInfo summary={summary} />);
    const info = screen.getByRole("region", { name: "운영 인사이트" });
    for (const [label, known, unknown] of [["오늘", "0초", "0초"], ["이번 달 누적", "7,200초", "60초"], ["올해 누적", "86,400초", "3,600초"]]) {
      const group = within(info).getByRole("group", { name: `${label} 수집 품질` });
      expect(within(group).getByText(/알려진 상태시간/).closest("dt")?.nextElementSibling).toHaveTextContent(known);
      expect(within(group).getByText("수집 공백").closest("dt")?.nextElementSibling).toHaveTextContent(unknown);
    }
    expect(within(info).getByText("최근 집계").closest("dt")?.nextElementSibling).toHaveTextContent("—");
    expect(within(info).getByText("기준 조명 수").closest("dt")?.nextElementSibling).toHaveTextContent("0개");
    expect(info).not.toHaveTextContent("2026-10-06");
    expect(info).not.toHaveTextContent("표본");
  });
  it("formats the actual aggregate timestamp in the site timezone, preserving the original instant", () => {
    render(<StatisticsOperationalInfo summary={{ ...summary, lastAggregatedAt: "2026-10-05T20:00:00.123Z" }} />);
    const time = screen.getByText("최근 집계").closest("dt")?.nextElementSibling?.querySelector("time");
    expect(time).toHaveAttribute("dateTime", "2026-10-05T20:00:00.123Z");
    expect(time).toHaveTextContent("2026-10-06 05:00:00");
  });
});
