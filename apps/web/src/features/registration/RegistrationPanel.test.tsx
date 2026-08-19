import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeRegistrationSession,
  createRegistrationSession,
  getRegistrationSession,
  identifyRegistrationNode,
  registerFixtureBatch
} from "../../api/registration";
import { mockDashboard, mockRegistrationSession } from "../../test/fixtures";
import { RegistrationPanel } from "./RegistrationPanel";

vi.mock("../../api/registration", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api/registration")>(),
  completeRegistrationSession: vi.fn(),
  createRegistrationSession: vi.fn(),
  getRegistrationSession: vi.fn(),
  identifyRegistrationNode: vi.fn(),
  registerFixtureBatch: vi.fn()
}));

const createSessionMock = vi.mocked(createRegistrationSession);
const getSessionMock = vi.mocked(getRegistrationSession);
const registerBatchMock = vi.mocked(registerFixtureBatch);

describe("RegistrationPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createSessionMock.mockResolvedValue(mockRegistrationSession);
    getSessionMock.mockResolvedValue(mockRegistrationSession);
    vi.mocked(identifyRegistrationNode).mockResolvedValue(mockRegistrationSession.discoveredNodes[0]);
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
  await screen.findByText(mockRegistrationSession.discoveredNodes[0].serialNumber);
}
