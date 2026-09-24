import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dashboard } from "../../api/queries";
import { createInitialSiteSetup } from "../../api/setup";
import { InstallationPending, SetupWizard } from "./SetupWizard";

vi.mock("../../api/setup", () => ({ createInitialSiteSetup: vi.fn() }));
const createInitialSiteSetupMock = vi.mocked(createInitialSiteSetup);

const dashboard: Dashboard = {
  generatedAt: "2026-09-12T00:00:00.000Z",
  monitoringPolicy: { gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 180 },
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

    expect(screen.getByRole("region", { name: "Viewer 설치 대기" })).toHaveTextContent("설치 담당자가 현장을 준비 중입니다");
    expect(screen.getByText("설치 담당자가 현장을 준비 중입니다")).toBeInTheDocument();
    expect(screen.getByText("현장 관리자가 설치와 조명 등록을 완료하면 조회할 수 있습니다.")).toBeInTheDocument();
    expect(screen.queryByLabelText("고객사명")).not.toBeInTheDocument();
  });

  it("현장 정보부터 운영 시작까지 설치 진행 단계를 표시한다", () => {
    renderWizard();

    expect(screen.getByRole("list", { name: "현장 설치 진행" })).toHaveTextContent("현장 정보");
    expect(screen.getByRole("list", { name: "현장 설치 진행" })).toHaveTextContent("Gateway 연결");
    expect(screen.getByRole("heading", { name: "현장 기본 정보를 입력하세요" })).toBeInTheDocument();
    expect(screen.getByLabelText("kWh 단가").closest("[data-field]")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "시간대" })).toBeInTheDocument();
  });

  it("assigned pending site를 고객사명·현장명 입력 없이 완료한다", async () => {
    createInitialSiteSetupMock.mockResolvedValue(dashboard);
    const { onComplete, queryClient } = renderWizard();
    expect(screen.getByText("고객사 A")).toBeInTheDocument();
    expect(screen.getByText("A 주차장")).toBeInTheDocument();
    expect(screen.queryByLabelText("고객사명")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("현장명")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("주소"), { target: { value: "서울시 강남구" } });
    fireEvent.click(screen.getByRole("button", { name: "시간대" }));
    fireEvent.click(screen.getByRole("option", { name: "UTC" }));
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

  it("층수와 실제 층 목록이 다르면 설치 저장을 막는다", () => {
    renderWizard();
    fireEvent.change(screen.getByLabelText("주소"), { target: { value: "서울" } });
    fireEvent.change(screen.getByLabelText("지상 층수"), { target: { value: "1" } });

    expect(screen.getByRole("button", { name: "초기 설정 완료" })).toBeDisabled();
    expect(screen.getByText("층수와 층 목록이 일치하지 않습니다. 층을 다시 생성하세요.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "초기 설정 완료" }));
    expect(createInitialSiteSetupMock).not.toHaveBeenCalled();
  });

  it.each(["-1", "1.5", "", "21"])("유효하지 않은 층수 %s를 거부한다", (value) => {
    renderWizard();
    fireEvent.change(screen.getByLabelText("주소"), { target: { value: "서울" } });
    fireEvent.change(screen.getByLabelText("지하 층수"), { target: { value } });

    expect(screen.getByRole("button", { name: "초기 설정 완료" })).toBeDisabled();
  });

  it("수정한 층 이름은 재생성 확인을 취소하면 유지한다", () => {
    renderWizard();
    fireEvent.change(screen.getByLabelText("층 이름 1"), { target: { value: "지하 주차 2층" } });
    fireEvent.change(screen.getByLabelText("지상 층수"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "층 자동 생성" }));

    expect(screen.getByRole("alertdialog", { name: "층 목록 다시 생성" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.getByLabelText("층 이름 1")).toHaveValue("지하 주차 2층");
    expect(screen.queryByDisplayValue("1F")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "층 자동 생성" }));
    fireEvent.click(screen.getByRole("button", { name: "다시 생성" }));
    expect(screen.getByDisplayValue("1F")).toBeInTheDocument();
  });
});
