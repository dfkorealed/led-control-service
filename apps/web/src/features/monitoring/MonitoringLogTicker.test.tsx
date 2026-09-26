import type { MonitoringActivityItem } from "@led-control/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MonitoringLogTicker } from "./MonitoringLogTicker";

const items: MonitoringActivityItem[] = [
  { id: "00000000-0000-4000-8000-000000000001", kind: "fixture_online", recordedAt: "2026-09-25T00:00:00.000Z", displayName: "B-04" },
  { id: "00000000-0000-4000-8000-000000000002", kind: "fixture_offline", recordedAt: "2026-09-25T00:01:00.000Z", displayName: "B-05" }
];

function ticker(overrides: Partial<Parameters<typeof MonitoringLogTicker>[0]> = {}) {
  return <MonitoringLogTicker items={items} generatedAt="2026-09-25T00:02:00.000Z" retainedFrom="2026-06-25T00:02:00.000Z" isPending={false} error={null} isRefetchError={false} timeZone="Asia/Seoul" onOpen={vi.fn()} onRetry={vi.fn()} {...overrides} />;
}

describe("MonitoringLogTicker", () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("rotates fetched events every three seconds and pauses while hovered", () => {
    vi.useFakeTimers();
    render(ticker());
    const region = screen.getByRole("region", { name: "최근 운영 로그" });
    expect(region).toHaveTextContent("B-04");
    act(() => vi.advanceTimersByTime(3_000));
    expect(region).toHaveTextContent("B-05");
    fireEvent.mouseEnter(region);
    act(() => vi.advanceTimersByTime(6_000));
    expect(region).toHaveTextContent("B-05");
    fireEvent.mouseLeave(region);
    act(() => vi.advanceTimersByTime(3_000));
    expect(region).toHaveTextContent("B-04");
    expect(screen.getByRole("button", { name: "전체 보기" })).toBeInTheDocument();
  });

  it("keeps true empty, first error and cached refetch error distinct", () => {
    const { rerender } = render(ticker({ items: [], generatedAt: "2026-09-25T00:02:00.000Z" }));
    expect(screen.getByText("최근 3개월의 운영 활동 기록이 없습니다.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "전체 보기" })).not.toBeInTheDocument();
    rerender(ticker({ items: [], generatedAt: null, error: new Error("offline") }));
    expect(screen.getByText("운영 활동을 불러오지 못했습니다.")).toBeVisible();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeVisible();
    rerender(ticker({ error: new Error("offline"), isRefetchError: true }));
    expect(screen.getByText(/갱신에 실패/)).toBeVisible();
    expect(screen.getByText(/B-04/)).toBeVisible();
    expect(screen.getByRole("button", { name: "전체 보기" })).toBeVisible();
  });
});
