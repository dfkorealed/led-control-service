import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDashboard } from "../../../api/queries";
import { mockDashboard } from "../../../test/fixtures";
import { RegistrationSettingsView } from "./RegistrationSettingsView";

vi.mock("../../../api/queries", () => ({ useDashboard: vi.fn() }));
vi.mock("../../registration/RegistrationPanel", () => ({ RegistrationPanel: ({ onRefreshGatewayStatus }: { onRefreshGatewayStatus?: () => void }) => <div data-testid="registration-panel-stub">등록 패널<button onClick={onRefreshGatewayStatus}>게이트웨이 상태 다시 확인</button></div> }));
vi.mock("../../setup/GatewayClaimPanel", () => ({ GatewayClaimPanel: () => <div>게이트웨이 등록 패널</div> }));

describe("RegistrationSettingsView 다음 단계", () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it("등록된 조명이 생기면 같은 현장의 맵 관리로 이어진다", () => {
    const dashboard = structuredClone(mockDashboard);
    dashboard.summary.totalFixtures = 1;
    vi.mocked(useDashboard).mockReturnValue({ data: dashboard } as ReturnType<typeof useDashboard>);
    render(<MemoryRouter initialEntries={["/settings/registration?siteId=old-site"]}>
      <RegistrationSettingsView siteId={dashboard.site.id} />
    </MemoryRouter>);

    expect(screen.getByText("등록 패널")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "맵에서 조명 배치하기" })).toHaveAttribute("href", `/settings/floor-plans?siteId=${dashboard.site.id}`);
  });

  it("오프라인 게이트웨이의 연결 상태를 바로 다시 확인할 수 있다", () => {
    const dashboard = structuredClone(mockDashboard);
    dashboard.gateways[0].connectionStatus = "offline";
    const refetch = vi.fn();
    vi.mocked(useDashboard).mockReturnValue({ data: dashboard, refetch } as unknown as ReturnType<typeof useDashboard>);
    render(<MemoryRouter initialEntries={[`/settings/registration?siteId=${dashboard.site.id}`]}>
      <RegistrationSettingsView siteId={dashboard.site.id} />
    </MemoryRouter>);

    expect(screen.queryByText("게이트웨이가 오프라인으로 표시되면 연결 상태를 다시 확인하세요.")).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId("registration-panel-stub")).getByRole("button", { name: "게이트웨이 상태 다시 확인" }));
    expect(refetch).toHaveBeenCalledOnce();
  });
});
