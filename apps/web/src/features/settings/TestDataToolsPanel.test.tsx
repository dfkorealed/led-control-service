import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockDashboard } from "../../test/fixtures";
import { ApiError } from "../../api/client";
import { createSiteTestData, deleteSiteTestData } from "../../api/test-data";
import { TestDataToolsPanel } from "./TestDataToolsPanel";

vi.mock("../../api/test-data", () => ({
  createSiteTestData: vi.fn(),
  deleteSiteTestData: vi.fn()
}));

const createSiteTestDataMock = vi.mocked(createSiteTestData);
const deleteSiteTestDataMock = vi.mocked(deleteSiteTestData);

describe("TestDataToolsPanel", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_TEST_DATA_TOOLS_ENABLED", "true");
    vi.clearAllMocks();
    createSiteTestDataMock.mockResolvedValue(testDataResult({ created: 16 }));
    deleteSiteTestDataMock.mockResolvedValue(testDataResult({ deleted: 16 }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it("does not render when the feature flag is disabled", () => {
    vi.stubEnv("VITE_TEST_DATA_TOOLS_ENABLED", "false");

    renderPanel();

    expect(screen.queryByRole("region", { name: "테스트 데이터" })).not.toBeInTheDocument();
  });

  it("allows only an admin at an installed site to manage test data", () => {
    renderPanel({ userRole: "admin" });
    expect(screen.getByRole("button", { name: "테스트 데이터 생성" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "테스트 데이터 삭제" })).toBeEnabled();

    cleanup();
    renderPanel({ userRole: "viewer" });
    expect(screen.queryByRole("region", { name: "테스트 데이터" })).not.toBeInTheDocument();

    cleanup();
    renderPanel({ userRole: "operator" });
    expect(screen.queryByRole("region", { name: "테스트 데이터" })).not.toBeInTheDocument();
  });

  it("creates test data, disables duplicate actions while pending, and refreshes affected caches", async () => {
    let resolveCreate: ((value: ReturnType<typeof testDataResult>) => void) | undefined;
    createSiteTestDataMock.mockReturnValueOnce(new Promise((resolve) => { resolveCreate = resolve; }));
    const { queryClient } = renderPanel();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    fireEvent.click(screen.getByRole("button", { name: "테스트 데이터 생성" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "테스트 데이터 생성 중" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "테스트 데이터 삭제" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "테스트 데이터 생성 중" }));
    expect(createSiteTestDataMock).toHaveBeenCalledOnce();

    resolveCreate?.(testDataResult({ created: 16 }));
    expect(await screen.findByRole("status")).toHaveTextContent("테스트 데이터 16개를 생성했습니다.");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard", "default"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard", mockDashboard.site.id] });
    for (const floor of mockDashboard.floors) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["floor-fixtures", mockDashboard.site.id, floor.id] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["floor-map", mockDashboard.site.id, floor.id] });
    }
  });

  it("keeps a general deletion API failure inside the confirmation dialog and clears it when closed", async () => {
    deleteSiteTestDataMock.mockRejectedValueOnce(new Error("delete failed"));
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "테스트 데이터 삭제" }));
    const dialog = screen.getByRole("dialog", { name: "테스트 데이터 삭제 확인" });
    expect(deleteSiteTestDataMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "삭제" }));

    await waitFor(() => expect(deleteSiteTestDataMock).toHaveBeenCalledWith(mockDashboard.site.id));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("테스트 데이터를 삭제하지 못했습니다.");
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog", { name: "테스트 데이터 삭제 확인" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "테스트 데이터 삭제" }));
    expect(within(screen.getByRole("dialog", { name: "테스트 데이터 삭제 확인" })).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("explains a 409 deletion block inside the confirmation dialog", async () => {
    deleteSiteTestDataMock.mockRejectedValueOnce(new ApiError("DELETE failed", 409, { message: "test data has dependencies" }));
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "테스트 데이터 삭제" }));
    const dialog = screen.getByRole("dialog", { name: "테스트 데이터 삭제 확인" });
    fireEvent.click(within(dialog).getByRole("button", { name: "삭제" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "테스트 데이터에 연결된 사용 데이터가 있어 삭제할 수 없습니다. 연결된 구역·명령·통계 데이터를 먼저 확인하세요."
    );
  });

  it("deletes only after confirmation and uses the deleted count in its completion feedback", async () => {
    deleteSiteTestDataMock.mockResolvedValueOnce(testDataResult({ deleted: 9 }));
    const { queryClient } = renderPanel();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    fireEvent.click(screen.getByRole("button", { name: "테스트 데이터 삭제" }));
    expect(deleteSiteTestDataMock).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog", { name: "테스트 데이터 삭제 확인" })).getByRole("button", { name: "삭제" }));

    expect(await screen.findByRole("status")).toHaveTextContent("테스트 데이터 9개를 삭제했습니다.");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard", "default"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard", mockDashboard.site.id] });
  });
});

function renderPanel({
  userRole = "admin",
  dashboard = mockDashboard
}: {
  userRole?: "operator" | "admin" | "viewer";
  dashboard?: typeof mockDashboard;
} = {}) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TestDataToolsPanel userRole={userRole} dashboard={dashboard} />
    </QueryClientProvider>
  );
  return { queryClient };
}

function testDataResult({ created = 0, deleted = 0 }: { created?: number; deleted?: number }) {
  return {
    floors: { total: 2, created: 0, existing: 2, deleted: 0 },
    gateways: { created: 0, existing: 0, deleted: 0 },
    fixtures: { created, existing: 0, deleted }
  };
}
