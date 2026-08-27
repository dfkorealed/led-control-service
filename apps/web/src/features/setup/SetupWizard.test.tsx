import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dashboard } from "../../api/queries";
import { createInitialSiteSetup } from "../../api/setup";
import { InstallationPending, SetupWizard } from "./SetupWizard";

vi.mock("../../api/setup", () => ({ createInitialSiteSetup: vi.fn() }));
const createInitialSiteSetupMock = vi.mocked(createInitialSiteSetup);

const dashboard: Dashboard = {
  site: {
    id: "site-1",
    name: "A 주차장",
    customerName: "고객사 A",
    installationStatus: "installed",
    address: "서울시 강남구",
    tariffKwhRate: 160,
    timeZone: "Asia/Seoul"
  },
  summary: { totalFixtures: 0, onlineFixtures: 0, faultFixtures: 0, averageBrightness: 0 },
  floors: [], groups: [], gateways: []
};

function renderWizard(onComplete = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SetupWizard siteId="site-1" customerName="고객사 A" siteName="A 주차장" onComplete={onComplete} />
    </QueryClientProvider>
  );
  return { queryClient, onComplete };
}

describe("SetupWizard", () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it("지하와 지상 층을 0층 없이 자동 생성한다", () => {
    renderWizard();
    fireEvent.change(screen.getByLabelText("지하 층수"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("지상 층수"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "층 자동 생성" }));
    expect(screen.getByDisplayValue("B2")).toBeInTheDocument();
    expect(screen.getByDisplayValue("B1")).toBeInTheDocument();
    expect(screen.getByDisplayValue("1F")).toBeInTheDocument();
    expect(screen.getByDisplayValue("2F")).toBeInTheDocument();
  });

  it("renders installation pending instead of a setup form for a customer user", () => {
    render(<InstallationPending />);

    expect(screen.getByText("설치 담당자가 현장을 준비 중입니다")).toBeInTheDocument();
    expect(screen.queryByLabelText("고객사명")).not.toBeInTheDocument();
  });

  it("assigned pending site를 고객사명·현장명 입력 없이 완료한다", async () => {
    createInitialSiteSetupMock.mockResolvedValue(dashboard);
    const { onComplete, queryClient } = renderWizard();
    expect(screen.getByText("고객사 A")).toBeInTheDocument();
    expect(screen.getByText("A 주차장")).toBeInTheDocument();
    expect(screen.queryByLabelText("고객사명")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("현장명")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("주소"), { target: { value: "서울시 강남구" } });
    fireEvent.change(screen.getByLabelText("시간대"), { target: { value: "UTC" } });
    fireEvent.click(screen.getByRole("button", { name: "초기 설정 완료" }));
    await waitFor(() => expect(createInitialSiteSetupMock).toHaveBeenCalledTimes(1));
    expect(createInitialSiteSetupMock).toHaveBeenCalledWith({
      siteId: "site-1", address: "서울시 강남구", tariffKwhRate: 160,
      timeZone: "UTC",
      floors: [{ name: "B2", level: -2 }, { name: "B1", level: -1 }]
    });
    expect(screen.queryByLabelText("게이트웨이 시리얼")).not.toBeInTheDocument();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(["dashboard", "site-1"])).toEqual(dashboard);
    expect(queryClient.getQueryData(["dashboard", "default"])).toEqual(dashboard);
  });

  it("주소가 없으면 제출을 막고 미입력 값을 선택할 수 있다", () => {
    renderWizard();
    expect(screen.getByRole("button", { name: "초기 설정 완료" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "주소 미입력" }));
    expect(screen.getByLabelText("주소")).toHaveValue("미입력");
  });

  it("중복 층 이름을 거부한다", () => {
    renderWizard();
    fireEvent.change(screen.getByLabelText("주소"), { target: { value: "서울" } });
    fireEvent.change(screen.getByLabelText("층 이름 2"), { target: { value: "B2" } });
    expect(screen.getByText("층 이름은 중복될 수 없습니다.")).toHaveAttribute("role", "alert");
  });

  it("과도한 단가와 층수를 거부한다", () => {
    renderWizard();
    fireEvent.change(screen.getByLabelText("주소"), { target: { value: "서울" } });
    fireEvent.change(screen.getByLabelText("kWh 단가"), { target: { value: "Infinity" } });
    expect(screen.getByText("kWh 단가는 0보다 큰 100000 이하의 숫자여야 합니다.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("kWh 단가"), { target: { value: "160" } });
    fireEvent.change(screen.getByLabelText("지하 층수"), { target: { value: "21" } });
    expect(screen.getByText("층수는 지하와 지상 각각 20층 이하의 숫자여야 합니다.")).toBeInTheDocument();
  });
});
