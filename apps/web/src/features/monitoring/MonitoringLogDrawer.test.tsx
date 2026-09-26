import type { MonitoringActivityItem, MonitoringActivityResponse } from "@led-control/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

  it("uses five-item server cursors for next and previous without inventing totals", async () => {
    useMonitoringActivity.mockImplementation(({ cursor }: { cursor: string }) => ({
      data: cursor ? { ...firstPage, items: [{ ...firstItems[0], id: "00000000-0000-4000-8000-000000000010", displayName: "B-5" }], nextCursor: null } : firstPage,
      error: null, isPending: false, isRefetchError: false, refetch: vi.fn()
    }));
    render(drawer());
    const dialog = await screen.findByRole("dialog", { name: "전체 로그" });
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(5);
    expect(dialog).not.toHaveTextContent("총 6건");
    fireEvent.click(within(dialog).getByRole("button", { name: "다음" }));
    expect(await within(dialog).findByText(/B-5/)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "다음" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "이전" }));
    expect(await within(dialog).findByText(/B-0/)).toBeVisible();
  });

  it("shows an expired cursor only as a 410 recovery, never a fabricated page", async () => {
    useMonitoringActivity.mockImplementation(({ cursor }: { cursor: string }) => ({
      data: cursor ? undefined : firstPage,
      error: cursor ? new ApiError("Expired cursor", 410, { code: "monitoring_activity_cursor_expired" }) : null,
      isPending: false, isRefetchError: false, refetch: vi.fn()
    }));
    render(drawer());
    const dialog = await screen.findByRole("dialog", { name: "전체 로그" });
    fireEvent.click(within(dialog).getByRole("button", { name: "다음" }));
    expect(await within(dialog).findByText("보관 기간이 지나 이 페이지를 볼 수 없습니다.")).toBeVisible();
    expect(within(dialog).queryByText(/B-0/)).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "최신 기록 보기" }));
    expect(await within(dialog).findByText(/B-0/)).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: /재전송/ })).not.toBeInTheDocument();
  });
});
