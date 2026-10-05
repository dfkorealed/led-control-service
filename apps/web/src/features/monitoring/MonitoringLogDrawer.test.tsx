import type { MonitoringActivityItem, MonitoringActivityResponse } from "@led-control/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { MonitoringLogDrawer } from "./MonitoringLogDrawer";

const { useMonitoringActivity } = vi.hoisted(() => ({ useMonitoringActivity: vi.fn() }));
vi.mock("./useMonitoringActivity", () => ({ useMonitoringActivity }));

const firstItems: MonitoringActivityItem[] = Array.from({ length: 5 }, (_, index) => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  kind: "fixture_online" as const,
  recordedAt: `2026-09-25T00:0${index}:00.000Z`,
  displayName: `B-${index}`
}));
const firstPage: MonitoringActivityResponse = {
  generatedAt: "2026-09-25T00:06:00.000Z", retainedFrom: "2026-06-25T00:06:00.000Z", items: firstItems, nextCursor: "page-2"
};

function drawer() {
  return <MonitoringLogDrawer isOpen onClose={vi.fn()} returnFocusRef={{ current: null }} fallbackFocusRef={{ current: null }} principal="user-1:org-1" siteId="site-1" floorId="floor-1" timeZone="Asia/Seoul" />;
}

describe("MonitoringLogDrawer", () => {
  afterEach(() => { cleanup(); useMonitoringActivity.mockReset(); });

  it("log filter close preserves partial dates and scoped cursor without applying a query", async () => {
    useMonitoringActivity.mockReturnValue({ data: firstPage, error: null, isPending: false, isFetching: false, isPaused: false, refetch: vi.fn() });
    render(drawer());
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    const filter = screen.getByRole("button", { name: /운영 로그 필터 상세 필터/ });
    act(() => filter.focus());
    fireEvent.click(filter);
    // Allow the nested dialog's initial focus to settle before date input.
    await waitFor(() => expect(screen.getByRole("dialog", { name: "운영 로그 필터" })).toHaveFocus());
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
    const year = screen.getAllByRole("spinbutton")[0]!;
    act(() => year.focus()); fireEvent.keyDown(year, { key: "ArrowUp", code: "ArrowUp" });
    const partialYear = year.getAttribute("aria-valuenow");
    expect(partialYear).not.toBeNull();
    await waitFor(() => expect(useMonitoringActivity).toHaveBeenLastCalledWith(expect.objectContaining({ principal: null, cursor: "page-2" })));
    fireEvent.click(screen.getByRole("button", { name: "필터 닫기" }));
    expect(filter).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(filter);
    expect(screen.getAllByRole("spinbutton")[0]).toHaveAttribute("aria-valuenow", partialYear);
    expect(screen.getAllByRole("spinbutton")[1]).not.toHaveAttribute("aria-valuenow");
    expect(useMonitoringActivity).toHaveBeenLastCalledWith(expect.objectContaining({ principal: null, cursor: "page-2", fromDate: undefined, toDate: undefined }));
  });

  it("recovers an invalid scoped cursor at page one without recovering unrelated first-page errors", async () => {
    useMonitoringActivity.mockImplementation(({ cursor }: { cursor: string }) => ({ data: cursor ? undefined : firstPage,
      error: cursor ? new ApiError("Invalid cursor", 400, {}) : null, isPending: false, isFetching: false, refetch: vi.fn() }));
    render(drawer());
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    await waitFor(() => expect(screen.getByText("1페이지")).toBeVisible());
    expect(useMonitoringActivity).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "", limit: 50 }));
    expect(screen.getByText(/B-0/)).toBeVisible();
  });

  it("opts the full log into one safe-area owner without replacing its body and pager", () => {
    useMonitoringActivity.mockReturnValue({ data: firstPage, error: null, isPending: false, isFetching: false, refetch: vi.fn() });
    render(drawer());
    const dialog = screen.getByRole("dialog", { name: "전체 로그" });
    const owners = dialog.querySelectorAll("[data-dialog-safe-area]");
    expect(owners).toHaveLength(1);
    expect(owners[0]).toContainElement(screen.getByRole("button", { name: "전체 로그 닫기" }));
    expect(owners[0]).toContainElement(screen.getByRole("region", { name: "운영 로그 본문" }));
    expect(owners[0]).toContainElement(screen.getByRole("group", { name: "운영 로그 페이지 조작" }));
  });

  it("requests fifty rows by default and never renders zero success while fetching", () => {
    useMonitoringActivity.mockReturnValue({ data: undefined, error: null, isPending: false, isFetching: true, refetch: vi.fn() });
    render(drawer());
    expect(useMonitoringActivity).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 50 }));
    expect(screen.getByRole("dialog", { name: "전체 로그" })).toHaveTextContent("불러오는 중");
    expect(screen.queryByText(/현재 0건|기록이 없습니다/)).not.toBeInTheDocument();
  });

  it("resets a visited cursor when changing to a thousand rows", async () => {
    useMonitoringActivity.mockReturnValue({ data: firstPage, error: null, isPending: false, isFetching: false, refetch: vi.fn() });
    render(drawer());
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    expect(useMonitoringActivity).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "page-2", limit: 50 }));
    fireEvent.click(screen.getByRole("button", { name: /운영 로그 필터 상세 필터/ }));
    fireEvent.click(screen.getByRole("button", { name: "페이지당 항목 수" }));
    fireEvent.click(await screen.findByRole("option", { name: "1000개" }));
    expect(useMonitoringActivity).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "", limit: 1000 }));
    fireEvent.click(screen.getByRole("button", { name: "필터 닫기" }));
    expect(screen.getByRole("button", { name: "이전 페이지" })).toBeDisabled();
    expect(screen.getByText("1페이지")).toBeVisible();
  });

  it("does not request the previous floor cursor even during the first new-scope render", () => {
    useMonitoringActivity.mockReturnValue({ data: firstPage, error: null, isPending: false, isFetching: false, refetch: vi.fn() });
    const view = render(drawer());
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    useMonitoringActivity.mockClear();
    view.rerender(<MonitoringLogDrawer isOpen onClose={vi.fn()} returnFocusRef={{ current: null }} fallbackFocusRef={{ current: null }} principal="user-2" siteId="site-2" floorId="floor-2" timeZone="Asia/Seoul" />);
    expect(useMonitoringActivity.mock.calls.every(([scope]) => scope.cursor === "" && scope.floorId === "floor-2")).toBe(true);
  });

  it.each(["principal", "siteId", "floorId"] as const)("discards a visited cursor on a %s round trip", (field) => {
    useMonitoringActivity.mockReturnValue({ data: firstPage, error: null, isPending: false, isFetching: false, refetch: vi.fn() });
    const props = { isOpen: true, onClose: vi.fn(), returnFocusRef: { current: null }, fallbackFocusRef: { current: null }, principal: "user-1", siteId: "site-1", floorId: "floor-1", timeZone: "Asia/Seoul" };
    const view = render(<MonitoringLogDrawer {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    expect(screen.getByText("2페이지")).toBeVisible();
    useMonitoringActivity.mockClear();
    view.rerender(<MonitoringLogDrawer {...props} {...{ [field]: "other-scope" }} />);
    expect(useMonitoringActivity.mock.calls.every(([scope]) => scope.cursor === "")).toBe(true);
    expect(screen.getByText("1페이지")).toBeVisible();
    useMonitoringActivity.mockClear();
    view.rerender(<MonitoringLogDrawer {...props} />);
    expect(useMonitoringActivity.mock.calls.every(([scope]) => scope.cursor === "")).toBe(true);
    expect(screen.getByText("1페이지")).toBeVisible();
  });

  it("discards a visited cursor when the drawer closes and reopens", () => {
    useMonitoringActivity.mockReturnValue({ data: firstPage, error: null, isPending: false, isFetching: false, refetch: vi.fn() });
    const props = { isOpen: true, onClose: vi.fn(), returnFocusRef: { current: null }, fallbackFocusRef: { current: null }, principal: "user-1", siteId: "site-1", floorId: "floor-1", timeZone: "Asia/Seoul" };
    const view = render(<MonitoringLogDrawer {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    view.rerender(<MonitoringLogDrawer {...props} isOpen={false} />);
    useMonitoringActivity.mockClear();
    view.rerender(<MonitoringLogDrawer {...props} />);
    expect(useMonitoringActivity.mock.calls.every(([scope]) => scope.cursor === "")).toBe(true);
    expect(screen.getByText("1페이지")).toBeVisible();
  });

  it("keeps pager controls mounted and disabled during pending without a fabricated row count", () => {
    useMonitoringActivity.mockReturnValue({ data: firstPage, error: null, isPending: false, isFetching: false, refetch: vi.fn() });
    const view = render(drawer());
    const next = screen.getByRole("button", { name: "다음 페이지" });
    next.focus();
    fireEvent.click(next);
    useMonitoringActivity.mockReturnValue({ data: undefined, error: null, isPending: false, isFetching: true, refetch: vi.fn() });
    view.rerender(drawer());
    expect(next.isConnected).toBe(true);
    expect(screen.getByRole("button", { name: "다음 페이지" })).toBe(next);
    expect(next).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /운영 로그 필터 상세 필터/ }));
    expect(screen.getByRole("button", { name: "페이지당 항목 수" })).toBeDisabled();
    expect(screen.queryByText(/현재 0건|현재 5건|기록이 없습니다/)).not.toBeInTheDocument();
  });

  it("keeps pending focus in a named pager and restores an enabled originating control", () => {
    useMonitoringActivity.mockReturnValue({ data: firstPage, error: null, isPending: false, isFetching: false, refetch: vi.fn() });
    const view = render(drawer());
    const next = screen.getByRole("button", { name: "다음 페이지" });
    next.focus(); fireEvent.click(next);
    useMonitoringActivity.mockReturnValue({ data: undefined, error: null, isPending: false, isFetching: true, refetch: vi.fn() });
    view.rerender(drawer());
    expect(screen.getByRole("group", { name: "운영 로그 페이지 조작" })).toHaveFocus();
    useMonitoringActivity.mockReturnValue({ data: firstPage, error: null, isPending: false, isFetching: false, refetch: vi.fn() });
    view.rerender(drawer());
    expect(next).toHaveFocus();
  });

  it("uses an enabled pager fallback after an expired Next and does not restore over intentional focus", () => {
    useMonitoringActivity.mockReturnValue({ data: firstPage, error: null, isPending: false, isFetching: false, refetch: vi.fn() });
    const view = render(drawer());
    const next = screen.getByRole("button", { name: "다음 페이지" });
    next.focus(); fireEvent.click(next);
    useMonitoringActivity.mockReturnValue({ data: undefined, error: new ApiError("Expired", 410, {}), isPending: false, isFetching: false, refetch: vi.fn() });
    view.rerender(drawer());
    expect(screen.getByRole("button", { name: "이전 페이지" })).toHaveFocus();
    const body = screen.getByRole("region", { name: "운영 로그 본문" });
    body.focus();
    useMonitoringActivity.mockReturnValue({ data: firstPage, error: null, isPending: false, isFetching: false, refetch: vi.fn() });
    view.rerender(drawer());
    expect(body).toHaveFocus();
  });

  it("uses server cursors for next and previous without inventing totals", async () => {
    useMonitoringActivity.mockImplementation(({ cursor }: { cursor: string }) => ({
      data: cursor ? { ...firstPage, items: [{ ...firstItems[0], id: "00000000-0000-4000-8000-000000000010", displayName: "B-5" }], nextCursor: null } : firstPage,
      error: null, isPending: false, isRefetchError: false, refetch: vi.fn()
    }));
    render(drawer());
    const dialog = await screen.findByRole("dialog", { name: "전체 로그" });
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(5);
    expect(dialog).not.toHaveTextContent("총 6건");
    fireEvent.click(within(dialog).getByRole("button", { name: "다음 페이지" }));
    expect(await within(dialog).findByText(/B-5/)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "다음 페이지" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "이전 페이지" }));
    expect(await within(dialog).findByText(/B-0/)).toBeVisible();
  });

  it.each([403, 404, 500])("hides cached operations after background HTTP %s", (status) => {
    useMonitoringActivity.mockReturnValue({ data: firstPage, error: new ApiError("Unavailable", status, {}), isPending: false, refetch: vi.fn() });
    render(drawer());
    expect(screen.queryByText(/B-0/)).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("불러오지 못했습니다");
  });

  it("shows an expired cursor only as a 410 recovery, never a fabricated page", async () => {
    useMonitoringActivity.mockImplementation(({ cursor }: { cursor: string }) => ({
      data: cursor ? undefined : firstPage,
      error: cursor ? new ApiError("Expired cursor", 410, { code: "monitoring_activity_cursor_expired" }) : null,
      isPending: false, isRefetchError: false, refetch: vi.fn()
    }));
    render(drawer());
    const dialog = await screen.findByRole("dialog", { name: "전체 로그" });
    fireEvent.click(within(dialog).getByRole("button", { name: "다음 페이지" }));
    expect(await within(dialog).findByText("보관 기간이 지나 이 페이지를 볼 수 없습니다.")).toBeVisible();
    expect(within(dialog).queryByText(/B-0/)).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "최신 기록 보기" }));
    expect(await within(dialog).findByText(/B-0/)).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: /재전송/ })).not.toBeInTheDocument();
  });
});
