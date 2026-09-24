import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { DashboardFixture } from "../../api/queries";
import { MonitoringFixtureFinder } from "./MonitoringFixtureFinder";

const baseFixture: DashboardFixture = {
  id: "fixture-1", name: "B2-L001", x: 0, y: 0, ratedWatt: 40, brightness: 70,
  status: "online", statusReason: "reported", health: null, rssi: null, hopCount: null,
  commandSuccessRate: null, lastSeenAt: "2026-09-24T01:00:00.000Z", gateway: null,
  controllable: true, controlBlockReason: null, placementStatus: "placed"
};

afterEach(cleanup);

function renderFinder(options: Partial<ComponentProps<typeof MonitoringFixtureFinder>> = {}) {
  const onSelectFixture = vi.fn();
  render(<MemoryRouter><MonitoringFixtureFinder
    fixtures={[baseFixture, { ...baseFixture, id: "fixture-2", name: "B2-L002", placementStatus: "unplaced" }]}
    selectedFixtureId="fixture-1" onSelectFixture={onSelectFixture} hasNextPage={false}
    isFetchingNextPage={false} onLoadMore={vi.fn()} userRole="admin" siteId="site-1" floorId="floor-1"
    {...options}
  /></MemoryRouter>);
  return onSelectFixture;
}

describe("MonitoringFixtureFinder", () => {
  it("finds a fixture by its numeric name fragment and selects the same fixture as the map", () => {
    const onSelectFixture = renderFinder();
    fireEvent.change(screen.getByRole("searchbox", { name: "조명 이름 또는 번호 검색" }), { target: { value: "002" } });

    const list = screen.getByRole("list", { name: "조명 목록" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(within(list).getByRole("button", { name: /B2-L002/ }));
    expect(onSelectFixture).toHaveBeenCalledWith("fixture-2");
  });

  it("exposes an unplaced fixture and admin-only placement route without inventing a marker", async () => {
    renderFinder();
    fireEvent.click(screen.getByRole("button", { name: "조명 목록 보기" }));
    fireEvent.click(screen.getByRole("button", { name: "상태 필터" }));
    fireEvent.click(await screen.findByRole("option", { name: "미배치" }));

    const list = screen.getByRole("list", { name: "조명 목록" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("미배치")).toBeVisible();
    expect(screen.getByRole("link", { name: "설정에서 조명 배치" })).toHaveAttribute("href", "/settings/floor-plans/floor-1/edit?siteId=site-1");
  });

  it("does not call a partial page set a final empty search result", () => {
    renderFinder({ fixtures: [], hasNextPage: true, isFetchingNextPage: true });
    fireEvent.change(screen.getByRole("searchbox", { name: "조명 이름 또는 번호 검색" }), { target: { value: "L099" } });
    expect(screen.getByText("다음 조명을 불러오는 중입니다.")).toBeVisible();
    expect(screen.queryByText("검색 결과가 없습니다.")).not.toBeInTheDocument();
  });

  it("does not offer an admin placement route to viewers", async () => {
    renderFinder({ userRole: "viewer" });
    fireEvent.click(screen.getByRole("button", { name: "조명 목록 보기" }));
    fireEvent.click(screen.getByRole("button", { name: "상태 필터" }));
    fireEvent.click(await screen.findByRole("option", { name: "미배치" }));
    expect(screen.queryByRole("link", { name: "설정에서 조명 배치" })).not.toBeInTheDocument();
  });

  it("keeps a Health-reported fault in the inspection filter even before status catches up", async () => {
    renderFinder({ fixtures: [{ ...baseFixture, health: { faultCodes: [4], observedAt: "2026-09-24T01:00:00.000Z" } }] });
    fireEvent.click(screen.getByRole("button", { name: "조명 목록 보기" }));
    fireEvent.click(screen.getByRole("button", { name: "상태 필터" }));
    fireEvent.click(await screen.findByRole("option", { name: "점검 필요" }));
    expect(within(screen.getByRole("list", { name: "조명 목록" })).getByRole("button", { name: /B2-L001/ })).toBeVisible();
  });
});
