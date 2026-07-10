import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dashboard } from "../../api/queries";
import type { InitialSiteSetupRequest } from "../../api/setup";
import { createInitialSiteSetup } from "../../api/setup";
import { SetupWizard } from "./SetupWizard";

vi.mock("../../api/setup", () => ({
  createInitialSiteSetup: vi.fn()
}));

const createInitialSiteSetupMock = vi.mocked(createInitialSiteSetup);

function renderWizard(onComplete = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });

  render(
    <QueryClientProvider client={queryClient}>
      <SetupWizard onComplete={onComplete} />
    </QueryClientProvider>
  );

  return { onComplete, queryClient };
}

const setupDashboard: Dashboard = {
  site: { id: "site-1", name: "A 주차장" },
  summary: { totalFixtures: 0, onlineFixtures: 0, faultFixtures: 0, averageBrightness: 0 },
  floors: [],
  groups: [],
  gateways: []
};

describe("SetupWizard", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("지하와 지상 층 범위에서 0층 없이 층 목록을 자동 생성한다", () => {
    renderWizard();

    fireEvent.change(screen.getByLabelText("지하 층수"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("지상 층수"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "층 자동 생성" }));

    expect(screen.getByDisplayValue("B2")).toBeInTheDocument();
    expect(screen.getByDisplayValue("B1")).toBeInTheDocument();
    expect(screen.getByDisplayValue("1F")).toBeInTheDocument();
    expect(screen.getByDisplayValue("2F")).toBeInTheDocument();
    expect(screen.getByDisplayValue("3F")).toBeInTheDocument();
    expect(screen.getByLabelText("층 level 1")).toHaveValue(-2);
    expect(screen.getByLabelText("층 level 2")).toHaveValue(-1);
    expect(screen.getByLabelText("층 level 3")).toHaveValue(1);
    expect(screen.queryByDisplayValue("0")).not.toBeInTheDocument();
  });

  it("현장, 층, 게이트웨이 정보를 입력하고 제출하면 성공 상태를 표시한다", async () => {
    const onComplete = vi.fn();
    createInitialSiteSetupMock.mockResolvedValue(setupDashboard);
    renderWizard(onComplete);

    fireEvent.change(screen.getByLabelText("현장명"), { target: { value: "A 주차장" } });
    fireEvent.change(screen.getByLabelText("주소"), { target: { value: "서울시 강남구" } });
    fireEvent.change(screen.getByLabelText("kWh 단가"), { target: { value: "160" } });
    fireEvent.change(screen.getByLabelText("지하 층수"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("지상 층수"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "층 자동 생성" }));
    fireEvent.change(screen.getByLabelText("게이트웨이 이름"), { target: { value: "메인 게이트웨이" } });
    fireEvent.change(screen.getByLabelText("게이트웨이 시리얼"), { target: { value: "GW-001" } });
    expect(screen.queryByLabelText("펌웨어 버전")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "초기 설정 완료" }));

    expect(await screen.findByText("초기 설정을 저장했습니다.")).toBeInTheDocument();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(createInitialSiteSetupMock).toHaveBeenCalledWith({
      siteName: "A 주차장",
      address: "서울시 강남구",
      tariffKwhRate: 160,
      floors: [
        { name: "B2", level: -2 },
        { name: "B1", level: -1 },
        { name: "1F", level: 1 }
      ],
      gateway: {
        name: "메인 게이트웨이",
        serialNumber: "GW-001"
      }
    } satisfies InitialSiteSetupRequest);
  });

  it("게이트웨이 시리얼이 비어 있으면 제출을 막고 오류를 알린다", () => {
    createInitialSiteSetupMock.mockResolvedValue(setupDashboard);
    renderWizard();

    fireEvent.change(screen.getByLabelText("현장명"), { target: { value: "시리얼 없는 현장" } });
    fireEvent.change(screen.getByLabelText("주소"), { target: { value: "부산시 해운대구" } });
    fireEvent.change(screen.getByLabelText("kWh 단가"), { target: { value: "180" } });
    fireEvent.change(screen.getByLabelText("지하 층수"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("지상 층수"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "층 자동 생성" }));

    fireEvent.click(screen.getByRole("button", { name: "초기 설정 완료" }));

    expect(screen.getByText("게이트웨이 시리얼을 입력하세요.")).toHaveAttribute("role", "alert");
    expect(screen.getByRole("button", { name: "초기 설정 완료" })).toBeDisabled();
    expect(createInitialSiteSetupMock).not.toHaveBeenCalled();
  });

  it("게이트웨이 이름이 비어 있으면 기본 이름으로 gateway를 제출한다", async () => {
    createInitialSiteSetupMock.mockResolvedValue(setupDashboard);
    renderWizard();

    fireEvent.change(screen.getByLabelText("현장명"), { target: { value: "기본 게이트웨이 현장" } });
    fireEvent.change(screen.getByLabelText("주소"), { target: { value: "서울시 중구" } });
    fireEvent.change(screen.getByLabelText("게이트웨이 이름"), { target: { value: " " } });
    fireEvent.change(screen.getByLabelText("게이트웨이 시리얼"), { target: { value: "GW-DEFAULT-NAME" } });
    fireEvent.click(screen.getByRole("button", { name: "초기 설정 완료" }));

    await waitFor(() => expect(createInitialSiteSetupMock).toHaveBeenCalledTimes(1));
    expect(createInitialSiteSetupMock.mock.calls[0][0]).toMatchObject({
      gateway: {
        name: "메인 게이트웨이",
        serialNumber: "GW-DEFAULT-NAME"
      }
    });
  });

  it("주소가 비어 있으면 제출을 막고 미입력 버튼으로 빠르게 채운다", async () => {
    createInitialSiteSetupMock.mockResolvedValue(setupDashboard);
    renderWizard();

    fireEvent.change(screen.getByLabelText("현장명"), { target: { value: "주소 미정 현장" } });

    expect(screen.getByText("주소를 입력하세요.")).toHaveAttribute("role", "alert");
    expect(screen.getByRole("button", { name: "초기 설정 완료" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "주소 미입력" }));
    fireEvent.change(screen.getByLabelText("게이트웨이 시리얼"), { target: { value: "GW-NO-ADDRESS" } });
    fireEvent.click(screen.getByRole("button", { name: "초기 설정 완료" }));

    await waitFor(() => expect(createInitialSiteSetupMock).toHaveBeenCalledTimes(1));
    expect(createInitialSiteSetupMock.mock.calls[0][0]).toMatchObject({
      siteName: "주소 미정 현장",
      address: "미입력"
    });
  });

  it("층 level을 직접 수정하고 payload에 반영한다", async () => {
    createInitialSiteSetupMock.mockResolvedValue(setupDashboard);
    renderWizard();

    fireEvent.change(screen.getByLabelText("현장명"), { target: { value: "레벨 편집 현장" } });
    fireEvent.change(screen.getByLabelText("주소"), { target: { value: "서울시 중구" } });
    fireEvent.change(screen.getByLabelText("게이트웨이 시리얼"), { target: { value: "GW-LEVEL-EDIT" } });
    fireEvent.change(screen.getByLabelText("층 level 1"), { target: { value: "-3" } });
    fireEvent.change(screen.getByLabelText("층 이름 1"), { target: { value: "B3" } });
    fireEvent.click(screen.getByRole("button", { name: "초기 설정 완료" }));

    await waitFor(() => expect(createInitialSiteSetupMock).toHaveBeenCalledTimes(1));
    expect(createInitialSiteSetupMock.mock.calls[0][0]).toMatchObject({
      floors: [
        { name: "B3", level: -3 },
        { name: "B1", level: -1 }
      ]
    });
  });

  it("중복 층 이름이나 level이면 제출을 막고 오류를 알린다", () => {
    renderWizard();

    fireEvent.change(screen.getByLabelText("현장명"), { target: { value: "중복 현장" } });
    fireEvent.change(screen.getByLabelText("주소"), { target: { value: "서울시 중구" } });
    fireEvent.change(screen.getByLabelText("층 이름 2"), { target: { value: "B2" } });

    expect(screen.getByText("층 이름은 중복될 수 없습니다.")).toHaveAttribute("role", "alert");
    expect(screen.getByRole("button", { name: "초기 설정 완료" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("층 이름 2"), { target: { value: "B1" } });
    fireEvent.change(screen.getByLabelText("층 level 2"), { target: { value: "-2" } });

    expect(screen.getByText("층 level은 중복될 수 없습니다.")).toHaveAttribute("role", "alert");
    expect(screen.getByRole("button", { name: "초기 설정 완료" })).toBeDisabled();
  });

  it("무한대나 과도하게 큰 층수와 단가를 validation으로 막는다", () => {
    renderWizard();

    fireEvent.change(screen.getByLabelText("현장명"), { target: { value: "검증 현장" } });
    fireEvent.change(screen.getByLabelText("주소"), { target: { value: "서울시 중구" } });
    fireEvent.change(screen.getByLabelText("kWh 단가"), { target: { value: "Infinity" } });
    expect(screen.getByText("kWh 단가는 0보다 큰 100000 이하의 숫자여야 합니다.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("kWh 단가"), { target: { value: "160" } });
    fireEvent.change(screen.getByLabelText("지하 층수"), { target: { value: "1000000000" } });
    fireEvent.change(screen.getByLabelText("지상 층수"), { target: { value: "Infinity" } });

    expect(() => fireEvent.click(screen.getByRole("button", { name: "층 자동 생성" }))).not.toThrow();
    expect(screen.getByText("층수는 지하와 지상 각각 20층 이하의 숫자여야 합니다.")).toHaveAttribute("role", "alert");
    expect(screen.getByRole("button", { name: "초기 설정 완료" })).toBeDisabled();
  });

  it("초기 설정 성공 응답을 dashboard cache에 즉시 반영하고 invalidate한다", async () => {
    const invalidateQueriesSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    const nextDashboard: Dashboard = {
      ...setupDashboard,
      site: { id: "site-cache", name: "캐시 현장" }
    };
    createInitialSiteSetupMock.mockResolvedValue(nextDashboard);
    const { queryClient } = renderWizard();

    fireEvent.change(screen.getByLabelText("현장명"), { target: { value: "캐시 현장" } });
    fireEvent.change(screen.getByLabelText("주소"), { target: { value: "서울시 중구" } });
    fireEvent.change(screen.getByLabelText("게이트웨이 시리얼"), { target: { value: "GW-CACHE" } });
    fireEvent.click(screen.getByRole("button", { name: "초기 설정 완료" }));

    await waitFor(() => expect(queryClient.getQueryData(["dashboard"])).toEqual(nextDashboard));
    expect(invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey: ["dashboard"] });
    invalidateQueriesSpy.mockRestore();
  });
});
