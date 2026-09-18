import type { FloorMapSnapshot } from "@led-control/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FixtureGroupMetadata } from "@led-control/shared";
import { useRef, useState } from "react";
import type { Dashboard } from "../../api/queries";
import { FixtureGroupDialog } from "./FixtureGroupDialog";

const mocks = vi.hoisted(() => ({
  listFixtureGroups: vi.fn(),
  createFixtureGroup: vi.fn(),
  updateFixtureGroup: vi.fn(),
  deleteFixtureGroup: vi.fn(),
  resyncFixtureGroup: vi.fn()
}));
const floorMapQuery = vi.hoisted(() => vi.fn());

vi.mock("../../api/fixture-groups", () => ({
  fixtureGroupQueryKey: (siteId: string) => ["fixture-groups", siteId],
  ...mocks
}));
vi.mock("../../api/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/queries")>()),
  useFloorMapSnapshot: floorMapQuery
}));

const ids = {
  site: "00000000-0000-4000-8000-000000000101",
  floor: "00000000-0000-4000-8000-000000000102",
  gateway: "00000000-0000-4000-8000-000000000103",
  firstFixture: "00000000-0000-4000-8000-000000000104",
  secondFixture: "00000000-0000-4000-8000-000000000105",
  group: "00000000-0000-4000-8000-000000000106"
};

const failedGroup: FixtureGroupMetadata = {
  id: ids.group,
  name: "B2 입구",
  floorId: ids.floor,
  gatewayId: ids.gateway,
  lifecycleStatus: "active",
  fixtureCount: 1,
  meshControlGroup: { status: "failed", version: 2, error: "구독 설정 응답 시간 초과" }
};

const dashboard = createDashboard();
const snapshot: FloorMapSnapshot = { floorId: ids.floor, revision: 1, width: 600, height: 400, floorPlan: null, objects: [] };

describe("FixtureGroupDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    floorMapQuery.mockReturnValue({ data: snapshot, error: null, isLoading: false, isFetching: false });
    mocks.listFixtureGroups.mockResolvedValue([failedGroup]);
    mocks.createFixtureGroup.mockResolvedValue({
      ...failedGroup,
      id: "00000000-0000-4000-8000-000000000107",
      name: "B2 출구",
      fixtureCount: 2,
      meshControlGroup: { status: "configuring", version: 1, error: null }
    });
    mocks.updateFixtureGroup.mockResolvedValue({
      ...failedGroup,
      name: "B2 입구 수정",
      meshControlGroup: { status: "configuring", version: 3, error: null }
    });
    mocks.deleteFixtureGroup.mockResolvedValue({ id: ids.group, lifecycleStatus: "retiring" });
    mocks.resyncFixtureGroup.mockResolvedValue({
      ...failedGroup,
      meshControlGroup: { status: "configuring", version: 3, error: null }
    });
  });

  afterEach(cleanup);

  it("submits full replacement membership from the map editor", async () => {
    renderDialog(true);

    await screen.findByText("B2 입구");
    fireEvent.click(screen.getByRole("button", { name: "새 구역" }));
    fireEvent.change(screen.getByLabelText("구역 이름"), { target: { value: "B2 출구" } });
    fireEvent.click(await screen.findByRole("button", { name: /B2-L001/ }));
    fireEvent.click(screen.getByRole("button", { name: /B2-L002/ }));
    fireEvent.click(screen.getByRole("button", { name: "구역 만들기" }));

    await waitFor(() => expect(mocks.createFixtureGroup).toHaveBeenCalledWith(ids.site, {
      name: "B2 출구",
      floorId: ids.floor,
      gatewayId: ids.gateway,
      fixtureIds: [ids.firstFixture, ids.secondFixture]
    }));
    expect(await screen.findByText("Mesh 설정 중")).toBeInTheDocument();
  });

  it("shows explicit floor and gateway boundary controls beside the map", async () => {
    renderDialog(true);
    await screen.findByText("B2 입구");
    fireEvent.click(screen.getByRole("button", { name: "새 구역" }));

    expect(screen.getByRole("button", { name: "층" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "게이트웨이" })).toBeInTheDocument();
  });

  it("uses the shared spatial selector instead of a group-owned checkbox list", async () => {
    renderDialog(true);
    await screen.findByText("B2 입구");
    fireEvent.click(screen.getByRole("button", { name: "새 구역" }));
    expect(screen.getByRole("region", { name: "공간 대상 선택" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /B2-L001/ })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "구역 조명 목록" })).not.toBeInTheDocument();
  });

  it("rejects an empty map membership before mutation", async () => {
    renderDialog(true);
    await screen.findByText("B2 입구");
    fireEvent.click(screen.getByRole("button", { name: "새 구역" }));
    fireEvent.change(screen.getByLabelText("구역 이름"), { target: { value: "빈 구역" } });
    await selectOption("층", "B2");
    await selectOption("게이트웨이", "Gateway B2");
    fireEvent.click(screen.getByRole("button", { name: "구역 만들기" }));

    expect(screen.getByRole("alert")).toHaveTextContent("조명을 한 개 이상 선택하세요.");
    expect(mocks.createFixtureGroup).not.toHaveBeenCalled();
  });

  it("rejects an externally supplied membership of 101 fixtures before mutation", async () => {
    renderDialog(true, dashboardWithMembership(Array.from({ length: 101 }, (_, index) => `fixture-${index + 1}`)));
    await screen.findByText("B2 입구");
    fireEvent.click(screen.getByRole("button", { name: "B2 입구 수정" }));
    fireEvent.click(screen.getByRole("button", { name: "변경 저장" }));

    expect(screen.getByRole("alert")).toHaveTextContent("구역에는 최대 100개 조명만 포함할 수 있습니다.");
    expect(mocks.updateFixtureGroup).not.toHaveBeenCalled();
  });

  it("rejects duplicate fixture ids before emitting a replacement payload", async () => {
    renderDialog(true, dashboardWithMembership([ids.firstFixture, ids.firstFixture]));
    await screen.findByText("B2 입구");
    fireEvent.click(screen.getByRole("button", { name: "B2 입구 수정" }));
    fireEvent.click(screen.getByRole("button", { name: "변경 저장" }));

    expect(screen.getByRole("alert")).toHaveTextContent("같은 조명을 중복해 선택할 수 없습니다.");
    expect(mocks.updateFixtureGroup).not.toHaveBeenCalled();
  });

  it("locks every group editor action until a pending save resolves", async () => {
    const pendingSave = deferred<FixtureGroupMetadata>();
    mocks.createFixtureGroup.mockReturnValue(pendingSave.promise);
    renderDialog(true);
    await screen.findByText("B2 입구");
    fireEvent.click(screen.getByRole("button", { name: "새 구역" }));
    fireEvent.change(screen.getByLabelText("구역 이름"), { target: { value: "B2 출구" } });
    fireEvent.click(screen.getByRole("button", { name: /B2-L001/ }));
    fireEvent.click(screen.getByRole("button", { name: "구역 만들기" }));

    await waitFor(() => expect(mocks.createFixtureGroup).toHaveBeenCalled());
    expect(screen.getByLabelText("구역 이름")).toBeDisabled();
    expect(screen.getByRole("button", { name: "층" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "게이트웨이" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /B2-L001/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "조명 목록 열기" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "목록으로" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "취소" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "저장 중" })).toBeDisabled();

    pendingSave.resolve({
      ...failedGroup,
      id: "00000000-0000-4000-8000-000000000107",
      name: "B2 출구",
      fixtureCount: 1,
      meshControlGroup: { status: "configuring", version: 1, error: null }
    });
    expect(await screen.findByText("Mesh 설정 중")).toBeInTheDocument();
  });

  it("updates membership, resyncs a failed group, and confirms deletion", async () => {
    renderDialog(true);
    await screen.findByText("구독 설정 응답 시간 초과");

    fireEvent.click(screen.getByRole("button", { name: "B2 입구 재동기화" }));
    await waitFor(() => expect(mocks.resyncFixtureGroup).toHaveBeenCalledWith(ids.site, ids.group));

    fireEvent.click(screen.getByRole("button", { name: "B2 입구 수정" }));
    expect(screen.getByLabelText("구역 이름")).toHaveValue("B2 입구");
    expect(screen.getByRole("button", { name: /B2-L001/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByLabelText("구역 이름"), { target: { value: "B2 입구 수정" } });
    fireEvent.click(screen.getByRole("button", { name: /B2-L002/ }));
    fireEvent.click(screen.getByRole("button", { name: "변경 저장" }));

    await waitFor(() => expect(mocks.updateFixtureGroup).toHaveBeenCalledWith(ids.site, ids.group, {
      name: "B2 입구 수정",
      floorId: ids.floor,
      gatewayId: ids.gateway,
      fixtureIds: [ids.firstFixture, ids.secondFixture]
    }));

    fireEvent.click(screen.getByRole("button", { name: "B2 입구 수정 삭제" }));
    const confirmation = screen.getByRole("dialog", { name: "구역 삭제 확인" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "삭제 확인" }));
    await waitFor(() => expect(mocks.deleteFixtureGroup).toHaveBeenCalledWith(ids.site, ids.group));
  });

  it("keeps viewer accounts read-only while exposing lifecycle and mesh status", async () => {
    renderDialog(false);

    expect(await screen.findByText("Mesh 설정 실패")).toBeInTheDocument();
    expect(screen.getByText("구독 설정 응답 시간 초과")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "새 구역" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "B2 입구 수정" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "B2 입구 재동기화" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "B2 입구 삭제" })).not.toBeInTheDocument();
  });

  it("저장 구역 dialog는 CRUD와 포커스 계약을 유지한다", async () => {
    renderDialog(true);

    expect(screen.getByRole("heading", { name: "구역 관리" })).toBeInTheDocument();
    expect(await screen.findByText("확인 필요")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "현재 저장 구역" })).toBeInTheDocument();
    expect(screen.getByText("Mesh 구성 v2 · 주소 정보 없음")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "B2 입구 수정" }));
    expect(screen.getByRole("dialog", { name: "구역 수정" })).toBeInTheDocument();
    expect(screen.getByTestId("fixture-group-map-editor")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.queryByTestId("fixture-group-map-editor")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "현재 저장 구역" })).toBeInTheDocument();
  });

  it("삭제 확인 Escape는 부모 dialog를 유지하고 삭제 trigger로 포커스를 복귀한다", async () => {
    renderDialog(true);
    const deleteTrigger = await screen.findByRole("button", { name: "B2 입구 삭제" });

    deleteTrigger.focus();
    fireEvent.click(deleteTrigger);
    expect(screen.getByRole("dialog", { name: "구역 삭제 확인" })).toBeInTheDocument();

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "구역 삭제 확인" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "구역 관리" })).toBeInTheDocument();
    await waitFor(() => expect(deleteTrigger).toHaveFocus());
  });

  it("삭제 요청 중 Escape는 확인 dialog와 포커스를 유지한다", async () => {
    const pendingDelete = deferred<{ id: string; lifecycleStatus: "retiring" }>();
    mocks.deleteFixtureGroup.mockReturnValue(pendingDelete.promise);
    renderDialog(true);
    const deleteTrigger = await screen.findByRole("button", { name: "B2 입구 삭제" });

    deleteTrigger.focus();
    fireEvent.click(deleteTrigger);
    const confirmation = screen.getByRole("dialog", { name: "구역 삭제 확인" });
    const confirmButton = within(confirmation).getByRole("button", { name: "삭제 확인" });
    confirmButton.focus();
    fireEvent.click(confirmButton);
    await waitFor(() => expect(mocks.deleteFixtureGroup).toHaveBeenCalledWith(ids.site, ids.group));

    const focusedBeforeEscape = document.activeElement;
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });

    expect(screen.getByRole("dialog", { name: "구역 삭제 확인" })).toBeInTheDocument();
    expect(document.activeElement).toBe(focusedBeforeEscape);
    expect(within(confirmation).queryByRole("button", { name: "구역 삭제 확인 닫기" })).not.toBeInTheDocument();
    expect(within(confirmation).getByRole("button", { name: "취소" })).toBeDisabled();

    pendingDelete.resolve({ id: ids.group, lifecycleStatus: "retiring" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "구역 삭제 확인" })).not.toBeInTheDocument());
  });

  it("저장 구역 Mesh 오류의 ACK는 화면에서 장비 응답으로 표시한다", async () => {
    mocks.listFixtureGroups.mockResolvedValue([{
      ...failedGroup,
      meshControlGroup: { ...failedGroup.meshControlGroup!, error: "Gateway ACK를 확인하지 못했습니다." }
    }]);

    renderDialog(true);

    expect(await screen.findByText("게이트웨이 장비 응답을 확인하지 못했습니다.")).toBeInTheDocument();
    expect(screen.queryByText(/ACK/i)).not.toBeInTheDocument();
  });

  it("traps keyboard focus, closes on Escape, and restores the opener", async () => {
    renderDialogHarness();
    const opener = screen.getByRole("button", { name: "구역 관리 열기" });
    opener.focus();
    fireEvent.click(opener);

    const closeButton = await screen.findByRole("button", { name: "구역 관리 닫기" });
    await waitFor(() => expect(screen.getByRole("dialog", { name: "구역 관리" })).toContainElement(document.activeElement as HTMLElement));
    const dialog = screen.getByRole("dialog", { name: "구역 관리" });
    const focusableButtons = within(dialog).getAllByRole("button").filter((button) => !button.hasAttribute("disabled"));
    const lastButton = focusableButtons.at(-1)!;

    lastButton.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(closeButton).toHaveFocus();

    closeButton.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(lastButton).toHaveFocus();

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "구역 관리" })).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });
});

function renderDialog(canManage: boolean, viewDashboard = dashboard) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FixtureGroupDialog
        open
        siteId={ids.site}
        dashboard={viewDashboard}
        canManage={canManage}
        onClose={vi.fn()}
      />
    </QueryClientProvider>
  );
}

async function selectOption(label: string, option: string) {
  fireEvent.click(screen.getByRole("button", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

function DialogHarness() {
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <button ref={openerRef} type="button" onClick={() => setOpen(true)}>구역 관리 열기</button>
      <FixtureGroupDialog
        open={open}
        siteId={ids.site}
        dashboard={dashboard}
        canManage
        returnFocusRef={openerRef}
        onClose={() => setOpen(false)}
      />
    </QueryClientProvider>
  );
}

function renderDialogHarness() {
  return render(<DialogHarness />);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createDashboard(): Dashboard {
  const fixture = (id: string, name: string): Dashboard["floors"][number]["fixtures"][number] => ({
    id,
    name,
    x: 0,
    y: 0,
    ratedWatt: 40,
    brightness: 70,
    status: "online",
    health: { faultCodes: [], observedAt: "2026-08-26T00:00:00.000Z" },
    rssi: -55,
    hopCount: 1,
    commandSuccessRate: 1,
    lastSeenAt: "2026-08-26T00:00:00.000Z",
    gateway: { id: ids.gateway, name: "Gateway B2", connectionStatus: "online" },
    controllable: true,
    controlBlockReason: null
  });
  return {
    generatedAt: "2026-09-12T00:00:00.000Z",
    monitoringPolicy: { gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 180 },
    site: {
      id: ids.site,
      name: "테스트 현장",
      customerName: "테스트 고객사",
      installationStatus: "installed",
      address: "서울시 강남구",
      tariffKwhRate: 160,
      timeZone: "Asia/Seoul"
    },
    summary: { totalFixtures: 2, onlineFixtures: 2, faultFixtures: 0, averageBrightness: 70 },
    floors: [{
      id: ids.floor,
      name: "B2",
      level: -2,
      floorPlan: null,
      meshControlGroups: [{ gatewayId: ids.gateway, status: "ready", version: 1, error: null }],
      fixtures: [fixture(ids.firstFixture, "B2-L001"), fixture(ids.secondFixture, "B2-L002")]
    }],
    groups: [{ ...failedGroup, fixtureIds: [ids.firstFixture] }],
    gateways: [{
      id: ids.gateway,
      name: "Gateway B2",
      serialNumber: "GW-001",
      firmwareVersion: "1.0.0",
      lastHeartbeatAt: "2026-08-26T00:00:00.000Z",
      connectionStatus: "online"
    }]
  };
}

function dashboardWithMembership(fixtureIds: string[]): Dashboard {
  const fixtures = [...new Set(fixtureIds)].map((id, index) => ({
    ...dashboard.floors[0].fixtures[0],
    id,
    name: `B2-L${String(index + 1).padStart(3, "0")}`,
    x: (index % 10) * 50,
    y: Math.floor(index / 10) * 30
  }));
  return {
    ...dashboard,
    summary: { ...dashboard.summary, totalFixtures: fixtures.length, onlineFixtures: fixtures.length },
    floors: [{ ...dashboard.floors[0], fixtures }],
    groups: [{ ...failedGroup, fixtureCount: fixtureIds.length, fixtureIds }]
  };
}
