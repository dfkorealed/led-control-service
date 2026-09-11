import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useOutletContext } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  StatisticsIndexRedirect,
  StatisticsShell,
  type StatisticsOutletContext
} from "./StatisticsShell";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</output>;
}

function OverviewProbe() {
  const context = useOutletContext<StatisticsOutletContext>();
  return <output data-testid="site-context">{context.siteId}</output>;
}

describe("StatisticsShell", () => {
  it("shows the released submenus, preserves location state, and marks only the current route", () => {
    render(
      <MemoryRouter initialEntries={["/statistics/overview?siteId=site-2#summary"]}>
        <Routes>
          <Route path="/statistics" element={<StatisticsShell siteId="site-2" />}>
            <Route path="overview" element={<OverviewProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    const navigation = screen.getByRole("navigation", { name: "통계 메뉴" });
    const overviewLink = within(navigation).getByRole("link", { name: "개요" });
    const analysisLink = within(navigation).getByRole("link", { name: "사용량 분석" });

    expect(within(navigation).getAllByRole("link")).toHaveLength(2);
    expect(overviewLink).toHaveAttribute("href", "/statistics/overview?siteId=site-2#summary");
    expect(analysisLink).toHaveAttribute("href", "/statistics/analysis?siteId=site-2#summary");
    expect(overviewLink).toHaveAttribute("aria-current", "page");
    expect(analysisLink).not.toHaveAttribute("aria-current");
    expect(navigation.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(navigation).not.toHaveTextContent("최적화");
    expect(navigation).not.toHaveTextContent("보고서");
    expect(screen.getByTestId("site-context")).toHaveTextContent("site-2");
  });

  it("preserves query and hash when redirecting the legacy statistics URL", async () => {
    render(
      <MemoryRouter initialEntries={["/statistics?siteId=site-2#summary"]}>
        <Routes>
          <Route path="/statistics" element={<StatisticsIndexRedirect />} />
          <Route path="/statistics/overview" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByTestId("location")).toHaveTextContent("/statistics/overview?siteId=site-2#summary");
  });
});
