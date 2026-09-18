import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DiscoveredRegistrationNode,
  type RegistrationEligibility,
  type RegistrationSession,
  cancelRegistrationSession,
  completeRegistrationSession,
  createRegistrationSession,
  excludeRegistrationNode,
  getActiveRegistrationSessions,
  getRegistrationSession,
  identifyRegistrationNode,
  registerFixtureBatch,
  retryRegistrationScan
} from "../../api/registration";
import { mockDashboard, mockRegistrationSession } from "../../test/fixtures";
import {
  RegistrationPanel,
  isPreExistingRegistrationNode,
  mergeRegistrationNodeProgress,
  registrationSteps,
  shouldPollRegistrationSession
} from "./RegistrationPanel";

vi.mock("../../api/registration", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api/registration")>(),
  completeRegistrationSession: vi.fn(),
  cancelRegistrationSession: vi.fn(),
  createRegistrationSession: vi.fn(),
  excludeRegistrationNode: vi.fn(),
  getActiveRegistrationSessions: vi.fn(),
  getRegistrationSession: vi.fn(),
  identifyRegistrationNode: vi.fn(),
  registerFixtureBatch: vi.fn(),
  retryRegistrationScan: vi.fn()
}));

const createSessionMock = vi.mocked(createRegistrationSession);
const activeSessionsMock = vi.mocked(getActiveRegistrationSessions);
const getSessionMock = vi.mocked(getRegistrationSession);
const identifyNodeMock = vi.mocked(identifyRegistrationNode);
const excludeNodeMock = vi.mocked(excludeRegistrationNode);
const cancelSessionMock = vi.mocked(cancelRegistrationSession);
const registerBatchMock = vi.mocked(registerFixtureBatch);
const retryScanMock = vi.mocked(retryRegistrationScan);
const statusLabelsForTest = {
  provisioning: "등록 중",
  provisioned: "등록 완료",
  reconcile_required: "확인 필요"
} as const;

describe("RegistrationPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeSessionsMock.mockResolvedValue([]);
    createSessionMock.mockResolvedValue(completedSession(mockRegistrationSession.discoveredNodes));
    getSessionMock.mockResolvedValue(completedSession(mockRegistrationSession.discoveredNodes));
    retryScanMock.mockResolvedValue(scanningSession());
    vi.mocked(completeRegistrationSession).mockResolvedValue({ ...mockRegistrationSession, status: "completed" });
    cancelSessionMock.mockResolvedValue({ ...mockRegistrationSession, status: "cancelled" });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("새로고침 뒤 현장의 최근 active 등록 세션을 자동 복구한다", async () => {
    const activeSession = completedSession(mockRegistrationSession.discoveredNodes.slice(0, 1));
    activeSessionsMock.mockResolvedValue([activeSession]);
    getSessionMock.mockResolvedValue(activeSession);

    renderPanel();

    expect(await screen.findByText("1개 등록 가능")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "등록 층" })).toHaveTextContent(mockDashboard.floors[0].name);
    expect(screen.getByRole("button", { name: "등록 게이트웨이" })).toHaveTextContent(mockDashboard.gateways[0].name);
    await waitFor(() => expect(getSessionMock).toHaveBeenCalledWith(activeSession.id));
    expect(screen.getByRole("button", { name: "조명 검색 시작" })).toBeDisabled();
  });

  it("교정 UI에서 검색 중 상태를 실제 session 상태로 표현한다", async () => {
    const activeSession = { ...mockRegistrationSession, scanStatus: "scanning" as const, discoveredNodes: [] };
    activeSessionsMock.mockResolvedValue([activeSession]);
    getSessionMock.mockResolvedValue(activeSession);

    renderPanel();

    expect(await screen.findByRole("status", { name: "조명 검색 상태" })).toHaveTextContent("검색 중");
  });

  it("등록 실패와 확인 필요 노드를 장비 상태 확인 단계로 표현한다", async () => {
    const node = { ...mockRegistrationSession.discoveredNodes[0], status: "reconcile_required" as const };
    const activeSession = completedSession([node]);
    activeSessionsMock.mockResolvedValue([activeSession]);
    getSessionMock.mockResolvedValue(activeSession);

    renderPanel();

    expect(await screen.findByRole("list", { name: "조명 등록 진행" })).toHaveTextContent("상태 확인");
  });

  it("실제 등록 session 상태를 하나의 단계 상태 머신으로 표현한다", () => {
    const cases = [
      { session: scanningSession(), states: ["current", "pending", "pending", "pending"] },
      {
        session: completedSession(mockRegistrationSession.discoveredNodes.slice(0, 1)),
        states: ["complete", "current", "pending", "pending"]
      },
      {
        session: completedSession([{ ...mockRegistrationSession.discoveredNodes[0], status: "provisioning" as const }]),
        states: ["complete", "complete", "current", "pending"]
      },
      {
        session: completedSession([{ ...mockRegistrationSession.discoveredNodes[0], status: "reconcile_required" as const }]),
        states: ["complete", "complete", "complete", "current"]
      },
      {
        session: { ...completedSession([{ ...mockRegistrationSession.discoveredNodes[0], status: "provisioned" as const }]), status: "completed" as const },
        states: ["complete", "complete", "complete", "complete"]
      },
      {
        session: { ...completedSession([]), status: "cancelled" as const },
        states: ["complete", "pending", "pending", "pending"]
      },
      {
        session: { ...completedSession(mockRegistrationSession.discoveredNodes.slice(0, 1)), status: "failed" as const },
        states: ["complete", "error", "pending", "pending"]
      },
      {
        session: {
          ...completedSession([{ ...mockRegistrationSession.discoveredNodes[0], status: "reconcile_required" as const }]),
          status: "failed" as const
        },
        states: ["complete", "complete", "complete", "error"]
      },
      {
        session: { ...completedSession([]), scanStatus: "failed" as const },
        states: ["error", "pending", "pending", "pending"]
      },
      {
        session: completedSession([{ ...mockRegistrationSession.discoveredNodes[0], status: "failed" as const }]),
        states: ["complete", "complete", "error", "pending"]
      }
    ] as const;

    for (const { session, states } of cases) {
      const stateValues: readonly string[] = states;
      expect(registrationSteps(session, session.discoveredNodes).map((step) => step.state)).toEqual(states);
      expect(stateValues.filter((state) => state === "current"))
        .toHaveLength(session.status === "active" && !stateValues.includes("error") ? 1 : 0);
    }
  });

  it("node 오류의 ACK 원문을 표시 전용 한국어로 바꾼다", async () => {
    const rawMessage = "Gateway ACK 확인 필요";
    const reconcile = completedSession([{
      ...mockRegistrationSession.discoveredNodes[0],
      status: "reconcile_required" as const,
      errorMessage: rawMessage
    }]);
    activeSessionsMock.mockResolvedValue([reconcile]);
    getSessionMock.mockResolvedValue(reconcile);
    renderPanel();
    expect(await screen.findByText("게이트웨이 장비 응답 확인 필요")).toBeInTheDocument();
    expect(screen.queryByText(rawMessage)).not.toBeInTheDocument();
  });

  it("개별 검증 오류의 ACK 원문을 표시 전용 한국어로 바꾼다", async () => {
    const rawMessage = "Gateway ACK 확인 필요";
    const discovered = completedSession(mockRegistrationSession.discoveredNodes.slice(0, 1));
    activeSessionsMock.mockResolvedValue([discovered]);
    getSessionMock.mockResolvedValue(discovered);
    registerBatchMock.mockResolvedValue({
      items: [{ nodeId: discovered.discoveredNodes[0].id, status: "validation_failed", error: rawMessage }]
    });
    renderPanel();
    await screen.findByText(discovered.discoveredNodes[0].serialNumber);
    fireEvent.click(screen.getByLabelText("조명 1 선택"));
    fireEvent.click(screen.getByRole("radio", { name: "개별 설정" }));
    fireEvent.click(screen.getByRole("button", { name: "선택 조명 등록" }));
    expect(await within(screen.getByTestId("fixture-config-form")).findByText("게이트웨이 장비 응답 확인 필요")).toBeInTheDocument();
    expect(screen.queryByText(rawMessage)).not.toBeInTheDocument();
  });

  it("scan 실패의 ACK 원문을 표시 전용 한국어로 바꾼다", async () => {
    const rawMessage = "Gateway ACK 확인 필요";
    const scanFailed = { ...completedSession([]), scanStatus: "failed" as const, scanFailureMessage: rawMessage };
    activeSessionsMock.mockResolvedValue([scanFailed]);
    getSessionMock.mockResolvedValue(scanFailed);
    renderPanel();
    expect(await screen.findByText("게이트웨이 장비 응답 확인 필요")).toBeInTheDocument();
    expect(screen.queryByText(rawMessage)).not.toBeInTheDocument();
  });

  it("확인 필요 노드는 명시적 확인 후 세션에서 제외하고 성공 장비가 없으면 세션을 취소한다", async () => {
    const reconcileNode = {
      ...mockRegistrationSession.discoveredNodes[0],
      status: "reconcile_required" as const,
      errorMessage: "게이트웨이 ACK를 확인하지 못했습니다."
    };
    const activeSession = completedSession([reconcileNode]);
    const excludedNode = { ...reconcileNode, status: "failed" as const, errorMessage: "현재 세션에서 제외됨" };
    activeSessionsMock.mockResolvedValue([activeSession]);
    getSessionMock.mockResolvedValue(activeSession);
    excludeNodeMock.mockResolvedValue(excludedNode);
    cancelSessionMock.mockResolvedValue({ ...activeSession, status: "cancelled", discoveredNodes: [excludedNode] });

    renderPanel();

    expect(await screen.findByText("확인 필요")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "다시 검색" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "현재 세션에서 제외" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("장비 상태를 확인했으며 현재 세션에서 제외"));
    fireEvent.click(screen.getByRole("button", { name: "현재 세션에서 제외" }));
    await waitFor(() => expect(excludeNodeMock).toHaveBeenCalledWith(activeSession.id, reconcileNode.id));

    fireEvent.click(await screen.findByRole("button", { name: "등록 세션 취소" }));
    await waitFor(() => expect(cancelSessionMock).toHaveBeenCalledWith(activeSession.id));
  });

  it("확인 필요 노드의 서버 상태를 사용자가 다시 조회할 수 있다", async () => {
    const reconcileNode = { ...mockRegistrationSession.discoveredNodes[0], status: "reconcile_required" as const };
    const activeSession = completedSession([reconcileNode]);
    activeSessionsMock.mockResolvedValue([activeSession]);
    getSessionMock.mockResolvedValueOnce(activeSession).mockResolvedValue({
      ...activeSession,
      discoveredNodes: [{ ...reconcileNode, status: "provisioned" as const }]
    });

    renderPanel();
    const refreshButton = await screen.findByRole("button", { name: "상태 다시 확인" });
    await waitFor(() => expect(getSessionMock).toHaveBeenCalledTimes(1));
    fireEvent.click(refreshButton);

    await waitFor(() => expect(getSessionMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("등록 완료")).toBeInTheDocument();
  });

  it("이전 검색 attempt의 등록 완료 노드가 있으면 현재 검색이 0건이어도 세션을 완료한다", async () => {
    const previousNode = {
      ...mockRegistrationSession.discoveredNodes[0],
      status: "provisioned" as const,
      scanCorrelationId: "55555555-5555-4555-8555-555555555555",
      scanAttempt: 1
    };
    const activeSession = {
      ...completedSession([previousNode]),
      scanCorrelationId: "66666666-6666-4666-8666-666666666666",
      scanAttempt: 2
    };
    activeSessionsMock.mockResolvedValue([activeSession]);
    getSessionMock.mockResolvedValue(activeSession);

    renderPanel();

    expect(await screen.findByText("검색된 미등록 조명이 없습니다.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "등록 세션 완료" }));
    await waitFor(() => expect(completeRegistrationSession).toHaveBeenCalledWith(activeSession.id));
    expect(cancelSessionMock).not.toHaveBeenCalled();
  });

  it("이전 검색 attempt의 확인 필요 노드도 숨기지 않고 복구 동작을 제공한다", async () => {
    const previousNode = {
      ...mockRegistrationSession.discoveredNodes[0],
      status: "reconcile_required" as const,
      scanCorrelationId: "55555555-5555-4555-8555-555555555555",
      scanAttempt: 1
    };
    const activeSession = {
      ...completedSession([previousNode]),
      scanCorrelationId: "66666666-6666-4666-8666-666666666666",
      scanAttempt: 2
    };
    activeSessionsMock.mockResolvedValue([activeSession]);
    getSessionMock.mockResolvedValue(activeSession);

    renderPanel();

    expect(await screen.findByText(previousNode.serialNumber)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "현재 세션에서 제외" })).toBeDisabled();
  });

  it("상태 다시 확인 실패를 표시하고 확인 전 제외를 차단한다", async () => {
    const reconcileNode = { ...mockRegistrationSession.discoveredNodes[0], status: "reconcile_required" as const };
    const activeSession = completedSession([reconcileNode]);
    activeSessionsMock.mockResolvedValue([activeSession]);
    getSessionMock.mockResolvedValueOnce(activeSession).mockRejectedValue(new Error("network unavailable"));

    renderPanel();
    const refreshButton = await screen.findByRole("button", { name: "상태 다시 확인" });
    await waitFor(() => expect(getSessionMock).toHaveBeenCalledTimes(1));
    fireEvent.click(refreshButton);

    expect(await screen.findByText("등록 세션 상태를 다시 확인하지 못했습니다.")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("장비 상태를 확인했으며 현재 세션에서 제외"));
    expect(screen.getByRole("button", { name: "현재 세션에서 제외" })).toBeDisabled();
  });

  it("여러 active 세션 중 현재 세션을 취소하면 다음 세션을 바로 복구한다", async () => {
    const current = completedSession([]);
    const next = {
      ...completedSession(mockRegistrationSession.discoveredNodes.slice(0, 1)),
      id: "99999999-9999-4999-8999-999999999999",
      floorId: mockDashboard.floors[1].id
    };
    activeSessionsMock.mockResolvedValue([current, next]);
    getSessionMock.mockImplementation(async (sessionId) => sessionId === next.id ? next : current);
    cancelSessionMock.mockResolvedValue({ ...current, status: "cancelled" });

    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "등록 세션 취소" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "등록 층" })).toHaveTextContent(mockDashboard.floors[1].name));
    expect(within(screen.getByLabelText("등록 세션 정보")).getByText(next.id.slice(0, 8))).toBeInTheDocument();
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
    const namePrefix = screen.getByLabelText("이름 접두어");
    expect(namePrefix.closest("[data-field]")).toBeInTheDocument();
    fireEvent.change(namePrefix, { target: { value: "주차-" } });
    fireEvent.change(screen.getByLabelText("시작 번호"), { target: { value: "7" } });
    fireEvent.blur(screen.getByLabelText("시작 번호"));
    fireEvent.change(screen.getByLabelText("자릿수"), { target: { value: "" } });
    expect(screen.getByLabelText("자릿수")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("자릿수"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("정격 전력(W)"), { target: { value: "55.50" } });
    fireEvent.change(screen.getByLabelText("조명 크기"), { target: { value: "24" } });
    fireEvent.blur(screen.getByLabelText("조명 크기"));
    fireEvent.click(screen.getByRole("button", { name: "선택 조명 등록" }));

    await waitFor(() => expect(registerBatchMock).toHaveBeenCalledWith(
      mockRegistrationSession.id,
      expect.objectContaining({
        mode: "batch",
        defaults: {
          namePrefix: "주차-",
          startNumber: 7,
          digits: 4,
          ratedWatt: "55.50",
          size: 24
        },
        nodes: [
          { nodeId: mockRegistrationSession.discoveredNodes[0].id },
          { nodeId: mockRegistrationSession.discoveredNodes[1].id }
        ]
      })
    ));
    expect(screen.getByLabelText("조명 1 선택")).not.toBeChecked();
    expect(screen.getByLabelText("조명 2 선택")).not.toBeChecked();
    expect(screen.getAllByText("등록 중")).toHaveLength(2);
  });

  it("등록 가능 조명만 기본 후보와 전체 선택 및 등록 payload에 포함한다", async () => {
    const [firstAvailable, explicitAvailable, registeredInSite, registeredElsewhere] = mockRegistrationSession.discoveredNodes;
    const session = completedSession([
      firstAvailable,
      { ...explicitAvailable, registrationEligibility: "available" as const, existingRegistration: null },
      {
        ...registeredInSite,
        registrationEligibility: "registered_in_site" as const,
        existingRegistration: {
          fixtureId: "fixture-existing",
          fixtureName: "기존 복도등",
          floorId: "floor-existing",
          floorName: "지하 1층"
        }
      },
      { ...registeredElsewhere, registrationEligibility: "registered_elsewhere" as const, existingRegistration: null }
    ]);
    activeSessionsMock.mockResolvedValue([session]);
    getSessionMock.mockResolvedValue(session);
    registerBatchMock.mockResolvedValue({
      items: [firstAvailable, explicitAvailable].map((node) => ({ nodeId: node.id, status: "accepted" as const }))
    });

    renderPanel();

    expect(await screen.findByText("2개 등록 가능")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "등록 가능 조명 전체 선택" }));
    expect(screen.getByText("2개 선택")).toBeInTheDocument();
    expect(screen.getByLabelText("조명 1 선택")).toBeChecked();
    expect(screen.getByLabelText("조명 2 선택")).toBeChecked();
    expect(screen.queryByLabelText("조명 3 선택")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "선택 조명 등록" }));

    await waitFor(() => expect(registerBatchMock).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({
        nodes: [{ nodeId: firstAvailable.id }, { nodeId: explicitAvailable.id }]
      })
    ));
  });

  it("누락 및 알 수 없는 eligibility 장치의 identity를 숨기고 generic 제외 문구만 표시한다", async () => {
    const missingEligibility = withoutRegistrationContract(mockRegistrationSession.discoveredNodes[0]);
    const unknownEligibility = {
      ...mockRegistrationSession.discoveredNodes[1],
      registrationEligibility: "future_eligibility" as RegistrationEligibility,
      existingRegistration: null
    };
    const session = completedSession([missingEligibility, unknownEligibility]);
    activeSessionsMock.mockResolvedValue([session]);
    getSessionMock.mockResolvedValue(session);

    renderPanel();

    await screen.findByRole("status", { name: "조명 검색 상태" });
    expect(screen.queryByText(missingEligibility.serialNumber)).not.toBeInTheDocument();
    expect(screen.queryByText(missingEligibility.deviceUuid)).not.toBeInTheDocument();
    expect(screen.queryByText(`RSSI ${missingEligibility.rssi} dBm`)).not.toBeInTheDocument();
    expect(screen.queryByText(unknownEligibility.serialNumber)).not.toBeInTheDocument();
    expect(screen.queryByText(unknownEligibility.deviceUuid)).not.toBeInTheDocument();
    expect(screen.getByText("등록 상태를 확인할 수 없는 장치 2개를 제외했습니다.")).toBeInTheDocument();
    expect(screen.queryByText(/다른 현장 등록/)).not.toBeInTheDocument();
    expect(screen.queryByText("다른 현장에 등록된 장치입니다. 보안을 위해 상세 정보는 표시하지 않습니다.")).not.toBeInTheDocument();
  });

  it.each([
    ["provisioning", "missing"],
    ["provisioned", "unknown"],
    ["reconcile_required", "missing"]
  ] as const)(
    "%s 상태의 eligibility가 %s여도 진행 행은 generic 정보로 유지한다",
    async (status, eligibilityState) => {
      const sourceNode = {
        ...mockRegistrationSession.discoveredNodes[0],
        status,
        existingRegistration: {
          fixtureId: "fixture-secret",
          fixtureName: "기존 현장 조명",
          floorId: "floor-secret",
          floorName: "기존 현장 층"
        }
      };
      const progressNode = eligibilityState === "missing"
        ? withoutRegistrationContract(sourceNode)
        : { ...sourceNode, registrationEligibility: "future_eligibility" as RegistrationEligibility };
      const session = completedSession([progressNode]);
      activeSessionsMock.mockResolvedValue([session]);
      getSessionMock.mockResolvedValue(session);

      renderPanel();

      expect(await screen.findByText("등록 상태를 확인할 수 없는 장치입니다. 식별 정보는 표시하지 않습니다.")).toBeInTheDocument();
      expect(screen.getByText(statusLabelsForTest[status])).toBeInTheDocument();
      expect(screen.queryByText(progressNode.serialNumber)).not.toBeInTheDocument();
      expect(screen.queryByText(progressNode.deviceUuid)).not.toBeInTheDocument();
      expect(screen.queryByText(`RSSI ${progressNode.rssi} dBm`)).not.toBeInTheDocument();
      expect(screen.queryByText("기존 현장 조명")).not.toBeInTheDocument();
      expect(screen.queryByText("기존 현장 층")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("조명 1 선택")).not.toBeInTheDocument();
      expect(screen.queryByRole("checkbox", { name: "등록 가능 조명 전체 선택" })).not.toBeInTheDocument();
      expect(screen.queryByRole("radiogroup", { name: "조명 설정 방식" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "선택 조명 등록" })).not.toBeInTheDocument();
      expect(screen.queryByText("1개 제외")).not.toBeInTheDocument();
      expect(screen.queryByText("등록 상태를 확인할 수 없는 장치 1개를 제외했습니다.")).not.toBeInTheDocument();
    }
  );

  it("새로고침으로 복구한 unknown reconcile 행은 복구 동작을 유지하고 완료와 재등록을 차단한다", async () => {
    const unknownReconcile = {
      ...mockRegistrationSession.discoveredNodes[0],
      status: "reconcile_required" as const,
      registrationEligibility: "future_eligibility" as RegistrationEligibility,
      existingRegistration: {
        fixtureId: "fixture-secret",
        fixtureName: "복구 전 기존 조명",
        floorId: "floor-secret",
        floorName: "복구 전 기존 층"
      }
    };
    const provisioned = {
      ...mockRegistrationSession.discoveredNodes[1],
      status: "provisioned" as const
    };
    const session = completedSession([unknownReconcile, provisioned]);
    activeSessionsMock.mockResolvedValue([session]);
    getSessionMock.mockResolvedValue(session);

    renderPanel();

    expect(await screen.findByText("등록 상태를 확인할 수 없는 장치입니다. 식별 정보는 표시하지 않습니다.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "상태 다시 확인" })).toBeEnabled();
    expect(screen.getByLabelText("장비 상태를 확인했으며 현재 세션에서 제외")).toBeEnabled();
    expect(screen.getByRole("button", { name: "현재 세션에서 제외" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "등록 세션 완료" })).toBeDisabled();
    expect(screen.queryByLabelText("조명 1 선택")).not.toBeInTheDocument();
    expect(screen.queryByText(unknownReconcile.serialNumber)).not.toBeInTheDocument();
    expect(screen.queryByText(unknownReconcile.deviceUuid)).not.toBeInTheDocument();
    expect(screen.queryByText(`RSSI ${unknownReconcile.rssi} dBm`)).not.toBeInTheDocument();
    expect(screen.queryByText("복구 전 기존 조명")).not.toBeInTheDocument();
    expect(screen.queryByText("복구 전 기존 층")).not.toBeInTheDocument();
    expect(screen.queryByText("1개 제외")).not.toBeInTheDocument();
    expect(screen.queryByText("등록 상태를 확인할 수 없는 장치 1개를 제외했습니다.")).not.toBeInTheDocument();
    expect(registerBatchMock).not.toHaveBeenCalled();
  });

  it("eligibility가 누락된 장치를 전체 선택과 설정 form 대상에서 제외한다", async () => {
    const missingEligibility = withoutRegistrationContract(mockRegistrationSession.discoveredNodes[0]);
    const available = {
      ...mockRegistrationSession.discoveredNodes[1],
      registrationEligibility: "available" as const,
      existingRegistration: null
    };
    const session = completedSession([missingEligibility, available]);
    activeSessionsMock.mockResolvedValue([session]);
    getSessionMock.mockResolvedValue(session);

    renderPanel();

    fireEvent.click(await screen.findByRole("checkbox", { name: "등록 가능 조명 전체 선택" }));
    expect(screen.getByText("1개 선택")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "개별 설정" }));
    expect(screen.getByRole("group", { name: available.serialNumber })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: missingEligibility.serialNumber })).not.toBeInTheDocument();
  });

  it("eligibility가 누락된 장치를 등록 payload에서 제외한다", async () => {
    const missingEligibility = withoutRegistrationContract(mockRegistrationSession.discoveredNodes[0]);
    const available = {
      ...mockRegistrationSession.discoveredNodes[1],
      registrationEligibility: "available" as const,
      existingRegistration: null
    };
    const session = completedSession([missingEligibility, available]);
    activeSessionsMock.mockResolvedValue([session]);
    getSessionMock.mockResolvedValue(session);
    registerBatchMock.mockResolvedValue({
      items: [{ nodeId: available.id, status: "accepted" }]
    });
    renderPanel();

    fireEvent.click(await screen.findByRole("checkbox", { name: "등록 가능 조명 전체 선택" }));
    fireEvent.click(screen.getByRole("button", { name: "선택 조명 등록" }));

    await waitFor(() => expect(registerBatchMock).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ nodes: [{ nodeId: available.id }] })
    ));
  });

  it("기존 등록 조명을 접힌 영역으로 분리하고 다른 현장 장치 식별자는 DOM에 렌더링하지 않는다", async () => {
    const [available, registeredWithInfo, registeredWithoutInfo, registeredElsewhere] = mockRegistrationSession.discoveredNodes;
    const foreignSerial = "FOREIGN-SERIAL-MUST-NOT-RENDER";
    const foreignDeviceUuid = "foreign-device-uuid-must-not-render";
    const session = completedSession([
      { ...available, registrationEligibility: "available" as const, existingRegistration: null },
      {
        ...registeredWithInfo,
        registrationEligibility: "registered_in_site" as const,
        existingRegistration: {
          fixtureId: "fixture-existing",
          fixtureName: "기존 계단등",
          floorId: "floor-existing",
          floorName: "지상 2층"
        }
      },
      {
        ...registeredWithoutInfo,
        registrationEligibility: "registered_in_site" as const,
        existingRegistration: { fixtureId: null, fixtureName: null, floorId: null, floorName: null }
      },
      {
        ...registeredElsewhere,
        serialNumber: foreignSerial,
        deviceUuid: foreignDeviceUuid,
        registrationEligibility: "registered_elsewhere" as const,
        existingRegistration: null
      }
    ]);
    activeSessionsMock.mockResolvedValue([session]);
    getSessionMock.mockResolvedValue(session);

    renderPanel();

    expect(await screen.findByText("1개 등록 가능")).toBeInTheDocument();
    expect(screen.getByText("3개 제외")).toBeInTheDocument();
    const summary = screen.getByText("기존 등록 조명 3개 제외됨");
    const details = summary.closest("details");
    expect(details).not.toHaveAttribute("open");
    expect(within(details!).getByText("기존 계단등")).toBeInTheDocument();
    expect(within(details!).getByText("지상 2층")).toBeInTheDocument();
    expect(within(details!).getByText("조명 정보 없음")).toBeInTheDocument();
    expect(within(details!).getByText("층 정보 없음")).toBeInTheDocument();
    expect(within(details!).getByText("다른 현장 등록 1개")).toBeInTheDocument();
    expect(within(details!).getByText("다른 현장에 등록된 장치입니다. 보안을 위해 상세 정보는 표시하지 않습니다.")).toBeInTheDocument();
    expect(screen.queryByText(foreignSerial)).not.toBeInTheDocument();
    expect(screen.queryByText(foreignDeviceUuid)).not.toBeInTheDocument();
  });

  it("제외된 기존 등록 조명만 검색되면 설정을 숨기고 다시 검색을 유지한다", async () => {
    const [registeredInSite, registeredElsewhere] = mockRegistrationSession.discoveredNodes;
    const session = completedSession([
      {
        ...registeredInSite,
        registrationEligibility: "registered_in_site" as const,
        existingRegistration: { fixtureId: null, fixtureName: null, floorId: null, floorName: null }
      },
      { ...registeredElsewhere, registrationEligibility: "registered_elsewhere" as const, existingRegistration: null }
    ]);
    activeSessionsMock.mockResolvedValue([session]);
    getSessionMock.mockResolvedValue(session);

    renderPanel();

    expect(await screen.findByText("새로 등록할 수 있는 조명이 없습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "조명 설정 방식" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "선택 조명 등록" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 검색" }));
    await waitFor(() => expect(retryScanMock).toHaveBeenCalledWith(session.id));
  });

  it("선택 뒤 등록 상태로 바뀐 stale 노드를 선택 수와 payload에서 제거한다", async () => {
    const [staleNode, availableNode] = mockRegistrationSession.discoveredNodes;
    const initial = completedSession([
      { ...staleNode, registrationEligibility: "available" as const, existingRegistration: null },
      { ...availableNode, registrationEligibility: "available" as const, existingRegistration: null }
    ]);
    activeSessionsMock.mockResolvedValue([initial]);
    getSessionMock.mockResolvedValue(initial);
    registerBatchMock.mockResolvedValue({
      items: [{ nodeId: availableNode.id, status: "accepted" }]
    });
    const queryClient = renderPanel();
    fireEvent.click(await screen.findByLabelText("조명 1 선택"));

    const reclassified = completedSession([
      {
        ...staleNode,
        registrationEligibility: "registered_in_site" as const,
        existingRegistration: { fixtureId: null, fixtureName: null, floorId: null, floorName: null }
      },
      { ...availableNode, registrationEligibility: "available" as const, existingRegistration: null }
    ]);
    await act(async () => {
      queryClient.setQueryData(["registration-session", initial.id], reclassified);
    });

    expect(await screen.findByText("0개 선택")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "선택 조명 등록" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("조명 1 선택"));
    fireEvent.click(screen.getByRole("button", { name: "선택 조명 등록" }));
    await waitFor(() => expect(registerBatchMock).toHaveBeenCalledWith(
      initial.id,
      expect.objectContaining({ nodes: [{ nodeId: availableNode.id }] })
    ));
  });

  it("이 세션의 진행 및 완료와 복구 필요 노드는 eligibility가 바뀌어도 기본 진행 목록에 유지한다", async () => {
    const statuses = ["provisioning", "provisioned", "reconcile_required"] as const;
    const session = completedSession(statuses.map((status, index) => ({
      ...mockRegistrationSession.discoveredNodes[index],
      status,
      registrationEligibility: "registered_in_site" as const,
      existingRegistration: null
    })));
    activeSessionsMock.mockResolvedValue([session]);
    getSessionMock.mockResolvedValue(session);

    renderPanel();

    await screen.findByText("0개 등록 가능");
    statuses.forEach((_, index) => {
      expect(screen.getByText(mockRegistrationSession.discoveredNodes[index].serialNumber)).toBeInTheDocument();
    });
    expect(screen.queryByText(/기존 등록 조명 .* 제외됨/)).not.toBeInTheDocument();
  });

  it("다른 현장 판정으로 바뀐 진행 노드는 상태만 유지하고 식별 정보는 숨긴다", async () => {
    const foreignSerial = "FOREIGN-PROGRESS-SERIAL";
    const foreignDeviceUuid = "foreign-progress-device-uuid";
    const session = completedSession([{
      ...mockRegistrationSession.discoveredNodes[0],
      serialNumber: foreignSerial,
      deviceUuid: foreignDeviceUuid,
      status: "reconcile_required" as const,
      errorMessage: `private error for ${foreignDeviceUuid}`,
      registrationEligibility: "registered_elsewhere" as const,
      existingRegistration: null
    }]);
    activeSessionsMock.mockResolvedValue([session]);
    getSessionMock.mockResolvedValue(session);

    renderPanel();

    expect(await screen.findByText("확인 필요")).toBeInTheDocument();
    expect(screen.getByText("다른 현장에 등록된 장치입니다. 보안을 위해 상세 정보는 표시하지 않습니다.")).toBeInTheDocument();
    expect(screen.queryByText(foreignSerial)).not.toBeInTheDocument();
    expect(screen.queryByText(foreignDeviceUuid)).not.toBeInTheDocument();
    expect(screen.queryByText(`private error for ${foreignDeviceUuid}`)).not.toBeInTheDocument();
  });

  it.each([
    ["discovered", "registered_in_site", true],
    ["discovered", "registered_elsewhere", true],
    ["discovered", "available", false],
    ["provisioning", "registered_in_site", false],
    ["provisioned", "registered_in_site", false],
    ["reconcile_required", "registered_elsewhere", false]
  ] as const)("status=%s eligibility=%s의 사전 등록 제외 여부를 판정한다", (status, registrationEligibility, expected) => {
    expect(isPreExistingRegistrationNode({
      ...mockRegistrationSession.discoveredNodes[0],
      status,
      registrationEligibility,
      existingRegistration: null
    })).toBe(expected);
  });

  it("개별 등록은 이름만 설정하고 초기 좌표 입력 없이 미배치로 요청한다", async () => {
    registerBatchMock.mockResolvedValue({ items: [] });
    await renderStartedPanel();

    fireEvent.click(screen.getByLabelText("조명 1 선택"));
    fireEvent.click(screen.getByRole("radio", { name: "개별 설정" }));
    fireEvent.change(screen.getByLabelText("조명 1 이름"), { target: { value: "입구 조명" } });
    fireEvent.change(screen.getByLabelText("자동 이름 자릿수"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("조명 1 정격 전력"), { target: { value: "48.25" } });
    fireEvent.change(screen.getByLabelText("조명 1 크기"), { target: { value: "32" } });
    fireEvent.blur(screen.getByLabelText("조명 1 크기"));
    expect(screen.queryByLabelText("조명 1 X 좌표")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("조명 1 Y 좌표")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "선택 조명 등록" }));

    expect(screen.getByDisplayValue("입구 조명")).toBeInTheDocument();
    await waitFor(() => expect(registerBatchMock).toHaveBeenCalledWith(
      mockRegistrationSession.id,
      expect.objectContaining({
        mode: "individual",
        defaults: expect.objectContaining({ digits: 5 }),
        nodes: [expect.objectContaining({
          fixtureName: "입구 조명",
          ratedWatt: "48.25",
          size: 32
        })]
      })
    ));
    expect(registerBatchMock.mock.calls[0][1].nodes[0]).not.toHaveProperty("placement");
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

  it.each([
    ["fixture already registered in this site", "이미 이 현장에 등록된 조명입니다."],
    ["fixture already registered in another site", "이미 다른 현장에 등록된 장치입니다."]
  ])("등록 검증 오류 %s를 사용자 문구로 표시한다", async (rawError, expectedMessage) => {
    const node = mockRegistrationSession.discoveredNodes[0];
    const session = completedSession([node]);
    activeSessionsMock.mockResolvedValue([session]);
    getSessionMock.mockResolvedValue(session);
    registerBatchMock.mockResolvedValue({
      items: [{ nodeId: node.id, status: "validation_failed", error: rawError }]
    });
    renderPanel();

    fireEvent.click(await screen.findByLabelText("조명 1 선택"));
    fireEvent.click(screen.getByRole("button", { name: "선택 조명 등록" }));

    expect(await screen.findByText(expectedMessage)).toBeInTheDocument();
    expect(screen.queryByText(rawError)).not.toBeInTheDocument();
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
    await waitFor(() => expect(activeSessionsMock).toHaveBeenCalledWith(mockDashboard.site.id));
    selectRegistrationTargets();
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

  it("검색된 조명을 한 번 식별 요청하고 identifying 상태를 polling한다", async () => {
    const discovered = completedSession(mockRegistrationSession.discoveredNodes.slice(0, 1));
    const identifyingNode = {
      ...discovered.discoveredNodes[0],
      status: "identifying" as const,
      identifyState: "pending"
    };
    activeSessionsMock.mockResolvedValue([discovered]);
    getSessionMock.mockResolvedValue(discovered);
    identifyNodeMock.mockResolvedValue({ status: "accepted", operationId: "op-1", node: identifyingNode });

    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "조명 1 식별" }));
    await waitFor(() => expect(identifyNodeMock).toHaveBeenCalledWith(discovered.id, identifyingNode.id));
    expect(screen.getByRole("button", { name: "조명 1 식별 중" })).toBeDisabled();
    expect(shouldPollRegistrationSession(discovered, [identifyingNode])).toBe(true);
  });

  it.each([
    ["confirmed", null, "식별 완료"],
    ["failed", "sensor mode restore timeout", "sensor mode restore 시간 초과"]
  ] as const)("accepted 식별이 remote %s에 도달하면 polling을 끝내고 결과를 표시한다", async (identifyState, errorMessage, expected) => {
    const discovered = completedSession(mockRegistrationSession.discoveredNodes.slice(0, 1));
    const acceptedNode = { ...discovered.discoveredNodes[0], status: "identifying" as const, identifyState: "pending", identifyOperationId: "op-1", identifyOperationStartedAt: "2026-09-14T01:00:00Z", updatedAt: "2026-09-14T01:00:00Z" };
    const terminalNode = { ...discovered.discoveredNodes[0], status: "discovered" as const, identifyState, errorMessage, identifyOperationId: "op-1", identifyOperationStartedAt: "2026-09-14T01:00:00Z", updatedAt: "2026-09-14T01:00:01Z" };
    const terminal = completedSession([terminalNode]);
    activeSessionsMock.mockResolvedValue([discovered]);
    getSessionMock.mockResolvedValueOnce(discovered).mockResolvedValue(terminal);
    identifyNodeMock.mockResolvedValue({ status: "accepted", operationId: "op-1", node: acceptedNode });
    const queryClient = renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "조명 1 식별" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "조명 1 식별 중" })).toBeDisabled());
    await queryClient.fetchQuery({
      queryKey: ["registration-session", discovered.id],
      queryFn: () => getSessionMock(discovered.id)
    });

    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "조명 1 식별" })).toBeEnabled();
    expect(shouldPollRegistrationSession(terminal, [acceptedNode])).toBe(false);
  });

  it("mutation operationId를 보존하여 이전 요청의 terminal poll이 새 retry UI를 완료하지 못한다", async () => {
    const discovered = completedSession(mockRegistrationSession.discoveredNodes.slice(0, 1));
    const base = discovered.discoveredNodes[0];
    const accepted = { ...base, status: "identifying" as const, identifyState: "pending", identifyOperationStartedAt: "2026-09-14T01:00:02Z", updatedAt: "2026-09-14T01:00:02Z" };
    const stale = { ...base, status: "discovered" as const, identifyState: "confirmed", identifyOperationId: "op-1", identifyOperationStartedAt: "2026-09-14T01:00:00Z", updatedAt: "2026-09-14T01:00:01Z" };
    activeSessionsMock.mockResolvedValue([discovered]);
    getSessionMock.mockResolvedValue(discovered);
    identifyNodeMock.mockResolvedValue({ status: "accepted", operationId: "op-2", node: accepted });
    const client = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "조명 1 식별" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "조명 1 식별 중" })).toBeDisabled());
    expect(client.getQueryData<RegistrationSession>(["registration-session", discovered.id])?.discoveredNodes[0]).toHaveProperty("identifyOperationId", "op-2");
    await act(async () => { await client.fetchQuery({ queryKey: ["registration-session", discovered.id], queryFn: async () => completedSession([stale]) }); });
    expect(screen.getByRole("button", { name: "조명 1 식별 중" })).toBeDisabled();
    expect(screen.queryByText("식별 완료")).not.toBeInTheDocument();
    const current = { ...stale, identifyOperationId: "op-2", identifyOperationStartedAt: accepted.identifyOperationStartedAt, updatedAt: "2026-09-14T01:00:03Z" };
    await act(async () => { await client.fetchQuery({ queryKey: ["registration-session", discovered.id], queryFn: async () => completedSession([current]) }); });
    expect(await screen.findByText("식별 완료")).toBeInTheDocument();
  });

  it.each(["confirmed", "failed"])("이전 operation의 지연 %s poll은 accepted retry를 완료하지 않고 polling을 유지한다", (identifyState) => {
    const base = mockRegistrationSession.discoveredNodes[0];
    const retry = { ...base, status: "identifying" as const, identifyState: "pending", identifyOperationId: "op-2", identifyOperationStartedAt: "2026-09-14T01:00:02Z", updatedAt: "2026-09-14T01:00:02Z" };
    const stale = { ...base, status: "discovered" as const, identifyState, identifyOperationId: "op-1", identifyOperationStartedAt: "2026-09-14T01:00:00Z", updatedAt: "2026-09-14T01:00:01Z" };
    expect(mergeRegistrationNodeProgress(retry, stale)).toEqual(retry);
    expect(shouldPollRegistrationSession(completedSession([stale]), [retry])).toBe(true);
    const current = { ...stale, identifyOperationId: "op-2", identifyOperationStartedAt: retry.identifyOperationStartedAt, updatedAt: "2026-09-14T01:00:03Z" };
    expect(mergeRegistrationNodeProgress(retry, current)).toEqual(current);
    expect(shouldPollRegistrationSession(completedSession([current]), [retry])).toBe(false);
  });

  it("동일 operation의 오래된 revision은 무시하고 명시적으로 새로운 operation은 수용한다", () => {
    const base = { ...mockRegistrationSession.discoveredNodes[0], identifyOperationId: "op-2", identifyOperationStartedAt: "2026-09-14T01:00:02Z", updatedAt: "2026-09-14T01:00:03Z" };
    const local = { ...base, status: "identifying" as const, identifyState: "running" };
    const stale = { ...base, status: "discovered" as const, identifyState: "failed", updatedAt: "2026-09-14T01:00:01Z" };
    expect(mergeRegistrationNodeProgress(local, stale)).toEqual(local);
    const terminal = { ...base, status: "discovered" as const, identifyState: "confirmed" };
    const newer = { ...local, identifyOperationId: "op-3", identifyOperationStartedAt: "2026-09-14T01:00:04Z", updatedAt: "2026-09-14T01:00:04Z" };
    expect(mergeRegistrationNodeProgress(terminal, newer)).toEqual(newer);
  });

  it("terminal identify를 stale identifying poll보다 우선하고 provision 상태는 낮추지 않는다", () => {
    const base = mockRegistrationSession.discoveredNodes[0];
    const confirmed = { ...base, status: "discovered" as const, identifyState: "confirmed", errorMessage: null };
    const stale = { ...base, status: "identifying" as const, identifyState: "running" };
    const provisioned = { ...base, status: "provisioned" as const, identifyState: "confirmed" };

    expect(mergeRegistrationNodeProgress(confirmed, stale)).toEqual(confirmed);
    expect(mergeRegistrationNodeProgress(provisioned, confirmed)).toEqual(provisioned);
  });
});

async function renderStartedPanel() {
  const queryClient = await renderStartedPanelWithoutWaiting();
  await screen.findByText(/개 등록 가능/);
  return queryClient;
}

async function renderStartedPanelWithoutWaiting() {
  const queryClient = renderPanel();
  await act(async () => {
    await activeSessionsMock.mock.results.at(-1)?.value;
  });
  selectRegistrationTargets();
  fireEvent.click(screen.getByRole("button", { name: "조명 검색 시작" }));
  await act(async () => { await Promise.resolve(); });
  return queryClient;
}

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RegistrationPanel dashboard={mockDashboard} />
    </QueryClientProvider>
  );
  return queryClient;
}

function selectRegistrationTargets() {
  fireEvent.click(screen.getByRole("button", { name: "등록 층" }));
  fireEvent.click(screen.getByRole("option", { name: mockDashboard.floors[0].name }));
  fireEvent.click(screen.getByRole("button", { name: "등록 게이트웨이" }));
  fireEvent.click(screen.getByRole("option", { name: mockDashboard.gateways[0].name }));
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

function withoutRegistrationContract(node: DiscoveredRegistrationNode) {
  const {
    registrationEligibility: _registrationEligibility,
    existingRegistration: _existingRegistration,
    ...malformedNode
  } = node;
  return malformedNode as unknown as DiscoveredRegistrationNode;
}
