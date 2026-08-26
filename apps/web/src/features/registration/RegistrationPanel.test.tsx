import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    createSessionMock.mockResolvedValue(completedSession(mockRegistrationSession.discoveredNodes));
    getSessionMock.mockResolvedValue(completedSession(mockRegistrationSession.discoveredNodes));
    retryScanMock.mockResolvedValue(scanningSession());
    vi.mocked(completeRegistrationSession).mockResolvedValue({ ...mockRegistrationSession, status: "completed" });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

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

  it("retry 응답에 discoveredNodes가 없어도 후보를 비우고 canonical GET으로 수렴한다", async () => {
    const terminal = completedSession(mockRegistrationSession.discoveredNodes);
    const restarted = {
      ...terminal,
      scanStatus: "pending" as const,
      scanAttempt: 2,
      scanStartedAt: null,
      scanCompletedAt: null
    };
    const { discoveredNodes: _omitted, ...retryResponse } = restarted;
    const canonical = { ...restarted, discoveredNodes: terminal.discoveredNodes };
    createSessionMock.mockResolvedValue(terminal);
    getSessionMock.mockResolvedValue(terminal);
    retryScanMock.mockResolvedValue(retryResponse);
    await renderStartedPanel();
    getSessionMock.mockResolvedValue(canonical);

    fireEvent.click(screen.getByRole("button", { name: "다시 검색" }));
    await waitFor(() => expect(retryScanMock).toHaveBeenCalledWith(mockRegistrationSession.id));

    expect(await screen.findByText("게이트웨이가 미등록 조명을 검색하는 중입니다.")).toBeInTheDocument();
    expect(screen.queryByLabelText("조명 1 선택")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "선택 조명 등록" })).not.toBeInTheDocument();
    expect(getSessionMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("다시 검색 요청 즉시 이전 후보와 선택 및 개별 초안을 비운다", async () => {
    const retryRequest = deferred<typeof mockRegistrationSession>();
    const terminal = completedSession(mockRegistrationSession.discoveredNodes.slice(0, 1));
    const retryCorrelationId = "55555555-5555-4555-8555-555555555555";
    const rediscovered = {
      ...terminal,
      scanCorrelationId: retryCorrelationId,
      scanAttempt: 2,
      scanStartedAt: "2026-07-01T00:01:00.000Z",
      discoveredNodes: [{
        ...terminal.discoveredNodes[0],
        scanCorrelationId: retryCorrelationId,
        scanAttempt: 2,
        discoveredAt: "2026-07-01T00:01:01.000Z"
      }]
    };
    createSessionMock.mockResolvedValue(terminal);
    getSessionMock.mockResolvedValue(terminal);
    retryScanMock.mockReturnValue(retryRequest.promise);
    const queryClient = await renderStartedPanel();
    fireEvent.click(screen.getByLabelText("조명 1 선택"));
    fireEvent.click(screen.getByRole("radio", { name: "개별 설정" }));
    fireEvent.change(screen.getByLabelText("조명 1 이름"), { target: { value: "이전 검색 초안" } });

    fireEvent.click(screen.getByRole("button", { name: "다시 검색" }));

    expect(screen.queryAllByText(terminal.discoveredNodes[0].serialNumber)).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "선택 조명 등록" })).not.toBeInTheDocument();

    retryRequest.resolve({ ...rediscovered, scanStatus: "pending", scanStartedAt: null, discoveredNodes: [] });
    await act(async () => { await retryRequest.promise; });
    queryClient.setQueryData(["registration-session", terminal.id], rediscovered);
    expect(await screen.findByText(rediscovered.discoveredNodes[0].serialNumber)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("조명 1 선택"));
    expect(screen.getByLabelText("조명 1 이름")).toHaveValue("");
  });

  it("새 attempt 완료 전 등록을 막고 wall clock 대신 exact identity로 후보를 고른다", async () => {
    const oldNodes = mockRegistrationSession.discoveredNodes.slice(0, 3);
    const terminal = completedSession(oldNodes);
    const currentCorrelationId = "55555555-5555-4555-8555-555555555555";
    const pending = {
      ...terminal,
      scanStatus: "pending" as const,
      scanCorrelationId: currentCorrelationId,
      scanAttempt: 2,
      scanStartedAt: null,
      scanCompletedAt: null
    };
    createSessionMock.mockResolvedValue(terminal);
    getSessionMock.mockResolvedValue(terminal);
    const queryClient = await renderStartedPanel();

    queryClient.setQueryData(["registration-session", terminal.id], pending);
    expect(await screen.findByText("게이트웨이가 미등록 조명을 검색하는 중입니다.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "선택 조명 등록" })).not.toBeInTheDocument();

    const completed = {
      ...pending,
      scanStatus: "completed" as const,
      scanStartedAt: "2026-07-01T00:01:00.000Z",
      scanCompletedAt: "2026-07-01T00:01:10.000Z",
      discoveredNodes: [
        { ...oldNodes[0], discoveredAt: "2026-07-01T00:02:00.000Z" },
        {
          ...oldNodes[1],
          scanCorrelationId: currentCorrelationId,
          scanAttempt: 2,
          discoveredAt: "2026-07-01T00:00:59.000Z"
        },
        {
          ...oldNodes[2],
          scanCorrelationId: null,
          scanAttempt: null,
          discoveredAt: "2026-07-01T00:02:01.000Z"
        }
      ]
    };
    queryClient.setQueryData(["registration-session", terminal.id], completed);

    expect(await screen.findByText(oldNodes[1].serialNumber)).toBeInTheDocument();
    expect(screen.queryByText(oldNodes[0].serialNumber)).not.toBeInTheDocument();
    expect(screen.queryByText(oldNodes[2].serialNumber)).not.toBeInTheDocument();
    expect(screen.getByLabelText("조명 1 선택")).toBeEnabled();
  });

  it("provisioning 중에는 등록 화면을 유지하고 세션 완료 후 dashboard를 갱신한다", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const provisioning = {
      ...completedSession([]),
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
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["floor-fixtures", mockDashboard.site.id, mockDashboard.floors[0].id] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["floor-map", mockDashboard.site.id, mockDashboard.floors[0].id] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["registration-session", mockRegistrationSession.id] });
    });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["dashboard", mockDashboard.site.id] });

    fireEvent.click(screen.getByRole("button", { name: "등록 세션 완료" }));
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard", mockDashboard.site.id] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard", "default"] });
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

  it("scanning session을 실제 interval로 조회하고 completed 응답 뒤 polling을 중지한다", async () => {
    vi.useFakeTimers();
    const scanning = scanningSession();
    const completed = completedSession([]);
    createSessionMock.mockResolvedValue(scanning);
    getSessionMock.mockResolvedValueOnce(scanning).mockResolvedValue(completed);
    await renderStartedPanelWithoutWaiting();

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const initialCalls = getSessionMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(getSessionMock.mock.calls.length).toBeGreaterThan(initialCalls);

    const terminalCalls = getSessionMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(4_500); });
    expect(getSessionMock).toHaveBeenCalledTimes(terminalCalls);
  });

  it("terminal session에서 등록이 provisioning을 만들면 실제 polling을 재시작한다", async () => {
    vi.useFakeTimers();
    const terminal = completedSession(mockRegistrationSession.discoveredNodes.slice(0, 1));
    createSessionMock.mockResolvedValue(terminal);
    getSessionMock.mockResolvedValue(terminal);
    registerBatchMock.mockResolvedValue({
      items: [{ nodeId: terminal.discoveredNodes[0].id, status: "accepted", fixtureName: "B2-L001" }]
    });
    await renderStartedPanelWithoutWaiting();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const terminalCalls = getSessionMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(getSessionMock).toHaveBeenCalledTimes(terminalCalls);

    fireEvent.click(screen.getByLabelText("조명 1 선택"));
    fireEvent.click(screen.getByRole("button", { name: "선택 조명 등록" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(getSessionMock.mock.calls.length).toBeGreaterThan(terminalCalls);
  });
});

async function renderStartedPanel() {
  const queryClient = await renderStartedPanelWithoutWaiting();
  await screen.findByText(/개 후보 발견/);
  return queryClient;
}

async function renderStartedPanelWithoutWaiting() {
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
  await act(async () => { await Promise.resolve(); });
  return queryClient;
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
