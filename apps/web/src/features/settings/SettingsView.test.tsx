import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDashboard } from "../../api/queries";
import { mockDashboard } from "../../test/fixtures";
import { SettingsView } from "./SettingsView";

vi.mock("../../api/queries", () => ({ useDashboard: vi.fn() }));
vi.mock("./TestDataToolsPanel", () => ({ TestDataToolsPanel: () => null }));

function renderSettings(gatewayCount: number, fixtureCount: number, role: "admin" | "viewer" = "admin", entry?: string) {
  const dashboard = structuredClone(mockDashboard);
  dashboard.gateways = dashboard.gateways.slice(0, gatewayCount);
  dashboard.summary.totalFixtures = fixtureCount;
  vi.mocked(useDashboard).mockReturnValue({ data: dashboard } as ReturnType<typeof useDashboard>);
  render(<MemoryRouter initialEntries={[entry ?? `/settings?siteId=${dashboard.site.id}`]}>
    <SettingsView userRole={role} siteId={dashboard.site.id} />
  </MemoryRouter>);
  return dashboard.site.id;
}

describe("SettingsView 설치 이어가기", () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it("게이트웨이가 없으면 기존 등록 경로로 연결한다", () => {
    const siteId = renderSettings(0, 0);
    expect(screen.getByRole("link", { name: "게이트웨이 연결하기" })).toHaveAttribute("href", `/settings/registration?siteId=${siteId}`);
  });

  it("게이트웨이 연결 후 조명이 없으면 조명 등록으로 연결한다", () => {
    const siteId = renderSettings(1, 0);
    expect(screen.getByRole("link", { name: "조명 등록하기" })).toHaveAttribute("href", `/settings/registration?siteId=${siteId}`);
  });

  it("조명이 있으면 층별 맵 배치로 연결한다", () => {
    const siteId = renderSettings(1, 1);
    expect(screen.getByRole("link", { name: "조명 위치 배치하기" })).toHaveAttribute("href", `/settings/floor-plans?siteId=${siteId}`);
  });

  it("viewer에게 설치 변경 행동을 제공하지 않는다", () => {
    renderSettings(0, 0, "viewer");
    expect(screen.queryByRole("link", { name: "게이트웨이 연결하기" })).not.toBeInTheDocument();
  });

  it("오래된 URL의 현장 ID 대신 조회된 현장 ID로 이동한다", () => {
    const siteId = renderSettings(0, 0, "admin", "/settings?siteId=old-site");
    expect(screen.getByRole("link", { name: "게이트웨이 연결하기" })).toHaveAttribute("href", `/settings/registration?siteId=${siteId}`);
  });
});
