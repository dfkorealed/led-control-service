import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeRegistrationSession,
  createRegistrationSession,
  getRegistrationSession,
  registerFixtureBatch,
  retryRegistrationScan
} from "../../api/registration";
import { mockDashboard, mockRegistrationSession } from "../../test/fixtures";
import { RegistrationPanel, shouldPollRegistrationSession } from "./RegistrationPanel";

vi.mock("../../api/registration", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api/registration")>(),
  completeRegistrationSession: vi.fn(),
  createRegistrationSession: vi.fn(),
  getRegistrationSession: vi.fn(),
  registerFixtureBatch: vi.fn(),
  retryRegistrationScan: vi.fn()
}));

const createSessionMock = vi.mocked(createRegistrationSession);
const getSessionMock = vi.mocked(getRegistrationSession);
const registerBatchMock = vi.mocked(registerFixtureBatch);
const retryScanMock = vi.mocked(retryRegistrationScan);

describe("RegistrationPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createSessionMock.mockResolvedValue(scanningSession());
    getSessionMock.mockResolvedValue(scanningSession());
    retryScanMock.mockResolvedValue(scanningSession());
    vi.mocked(completeRegistrationSession).mockResolvedValue({ ...mockRegistrationSession, status: "completed" });
  });

  afterEach(() => cleanup());

  it("선택한 여러 조명을 일괄 설정 payload로 등록한다", async () => {
    registerBatchMock.mockResolvedValue({
      items: mockRegistrationSession.discoveredNodes.slice(0, 2).map((node, index) => ({
        nodeId: node.id,
        status: "accepted",
        fixtureName: `B2-L00${index + 1}`
      }))
    });
    await renderStartedPanel();

    fireEvent.click(screen.getByLabelText("조명 1 선택"));
    fireEvent.click(screen.getByLabelText("조명 2 선택"));
    fireEvent.change(screen.getByLabelText("이름 접두어"), { target: { value: "B2-L" } });
    fireEvent.click(screen.getByRole("button", { name: "선택 조명 등록" }));

    await waitFor(() => expect(registerBatchMock).toHaveBeenCalledWith(
      mockRegistrationSession.id,
      expect.objectContaining({
        mode: "batch",
        defaults: expect.objectContaining({ namePrefix: "B2-L", ratedWatt: "40.00", size: 20 }),
        nodes: [
          { nodeId: mockRegistrationSession.discoveredNodes[0].id, placement: { mode: "auto" } },
          { nodeId: mockRegistrationSession.discoveredNodes[1].id, placement: { mode: "auto" } }
        ]
      })
    ));
    expect(screen.getByLabelText("조명 1 선택")).not.toBeChecked();
    expect(screen.getByLabelText("조명 2 선택")).not.toBeChecked();
    expect(screen.getAllByText("등록 중")).toHaveLength(2);
  });

  it("개별 설정에서 조명별 이름과 좌표를 입력한다", async () => {
    registerBatchMock.mockResolvedValue({ items: [] });
    await renderStartedPanel();

    fireEvent.click(screen.getByLabelText("조명 1 선택"));
    fireEvent.click(screen.getByRole("radio", { name: "개별 설정" }));
    fireEvent.change(screen.getByLabelText("조명 1 이름"), { target: { value: "입구 조명" } });
    fireEvent.change(screen.getByLabelText("조명 1 X 좌표"), { target: { value: "120" } });
    fireEvent.change(screen.getByLabelText("조명 1 Y 좌표"), { target: { value: "240" } });
    fireEvent.click(screen.getByRole("button", { name: "선택 조명 등록" }));

    expect(screen.getByDisplayValue("입구 조명")).toBeInTheDocument();
    await waitFor(() => expect(registerBatchMock).toHaveBeenCalledWith(
      mockRegistrationSession.id,
      expect.objectContaining({
        mode: "individual",
        nodes: [expect.objectContaining({
          fixtureName: "입구 조명",
          placement: { mode: "manual", x: 120, y: 240 }
        })]
      })
    ));
  });

  it("서버 검증 실패 노드의 선택과 오류를 유지한다", async () => {
    const node = mockRegistrationSession.discoveredNodes[0];
    registerBatchMock.mockResolvedValue({
      items: [{ nodeId: node.id, status: "validation_failed", error: "이미 등록이 진행 중입니다." }]
    });
    await renderStartedPanel();

    fireEvent.click(screen.getByLabelText("조명 1 선택"));
    fireEvent.click(screen.getByRole("button", { name: "선택 조명 등록" }));

    expect(await screen.findByText("이미 등록이 진행 중입니다.")).toBeInTheDocument();
    expect(screen.getByLabelText("조명 1 선택")).toBeChecked();
  });

  it("검색 완료 후 후보가 없으면 다시 검색 동작을 안내한다", async () => {
    createSessionMock.mockResolvedValue(completedSession([]));
    getSessionMock.mockResolvedValue(completedSession([]));
    await renderStartedPanel();

    expect(await screen.findByText("검색된 미등록 조명이 없습니다.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 검색" }));

    await waitFor(() => expect(retryScanMock).toHaveBeenCalledWith(mockRegistrationSession.id));
  });

  it("검색 실패 메시지를 표시하고 다시 검색한다", async () => {
    const failed = {
      ...completedSession([]),
      scanStatus: "failed" as const,
      scanFailureMessage: "Bluetooth 어댑터를 사용할 수 없습니다."
    };
    createSessionMock.mockResolvedValue(failed);
    getSessionMock.mockResolvedValue(failed);
    await renderStartedPanel();

    expect(await screen.findByText("Bluetooth 어댑터를 사용할 수 없습니다.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 검색" }));

    await waitFor(() => expect(retryScanMock).toHaveBeenCalledWith(mockRegistrationSession.id));
  });

  it("다시 검색이 시작되면 이전 검색 후보를 등록 대상으로 남기지 않는다", async () => {
    const terminal = completedSession(mockRegistrationSession.discoveredNodes);
    const restarted = { ...terminal, scanStatus: "scanning" as const, discoveredNodes: [] };
    createSessionMock.mockResolvedValue(terminal);
    getSessionMock.mockResolvedValue(terminal);
    retryScanMock.mockResolvedValue(restarted);
    await renderStartedPanel();

    fireEvent.click(screen.getByRole("button", { name: "다시 검색" }));
    await waitFor(() => expect(retryScanMock).toHaveBeenCalledWith(mockRegistrationSession.id));

    expect(screen.queryByLabelText("조명 1 선택")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "선택 조명 등록" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "점멸 확인" })).not.toBeInTheDocument();
  });

  it("provisioning 완료를 관측하면 정확한 현황 query를 갱신한다", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const provisioning = {
      ...scanningSession(),
      discoveredNodes: [{ ...mockRegistrationSession.discoveredNodes[0], status: "provisioning" as const }]
    };
    const provisioned = {
      ...provisioning,
      discoveredNodes: [{ ...provisioning.discoveredNodes[0], status: "provisioned" as const }]
    };
    createSessionMock.mockResolvedValue(provisioning);
    getSessionMock.mockResolvedValueOnce(provisioning).mockResolvedValueOnce(provisioned);
    render(
      <QueryClientProvider client={queryClient}>
        <RegistrationPanel dashboard={mockDashboard} />
      </QueryClientProvider>
    );
    fireEvent.change(screen.getByLabelText("등록 층"), { target: { value: mockDashboard.floors[0].id } });
    fireEvent.change(screen.getByLabelText("등록 게이트웨이"), { target: { value: mockDashboard.gateways[0].id } });
    fireEvent.click(screen.getByRole("button", { name: "조명 검색 시작" }));
    await waitFor(() => expect(getSessionMock).toHaveBeenCalledTimes(1));

    await queryClient.fetchQuery({
      queryKey: ["registration-session", mockRegistrationSession.id],
      queryFn: () => getSessionMock(mockRegistrationSession.id)
    });

    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard", mockDashboard.site.id] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["floor-fixtures", mockDashboard.site.id, mockDashboard.floors[0].id] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["floor-map", mockDashboard.site.id, mockDashboard.floors[0].id] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["registration-session", mockRegistrationSession.id] });
    });
  });

  it("검색 terminal에서는 polling을 멈추고 provisioning 중에는 다시 시작한다", () => {
    expect(shouldPollRegistrationSession(completedSession([]), [])).toBe(false);
    expect(shouldPollRegistrationSession(
      completedSession([]),
      [{ ...mockRegistrationSession.discoveredNodes[0], status: "provisioning" }]
    )).toBe(true);
    expect(shouldPollRegistrationSession(
      completedSession([{ ...mockRegistrationSession.discoveredNodes[0], status: "provisioning" }]),
      []
    )).toBe(true);
  });
});

async function renderStartedPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RegistrationPanel dashboard={mockDashboard} />
    </QueryClientProvider>
  );
  fireEvent.change(screen.getByLabelText("등록 층"), { target: { value: mockDashboard.floors[0].id } });
  fireEvent.change(screen.getByLabelText("등록 게이트웨이"), { target: { value: mockDashboard.gateways[0].id } });
  fireEvent.click(screen.getByRole("button", { name: "조명 검색 시작" }));
  await screen.findByText(/개 후보 발견/);
}

function scanningSession() {
  return { ...mockRegistrationSession, scanStatus: "scanning" as const, scanFailureMessage: null };
}

function completedSession(discoveredNodes: typeof mockRegistrationSession.discoveredNodes) {
  return {
    ...mockRegistrationSession,
    scanStatus: "completed" as const,
    scanFailureMessage: null,
    discoveredNodes
  };
}
