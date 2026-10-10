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

  it("keeps the current row and remaining five-second interval across equivalent query rows", () => {
    vi.useFakeTimers();
    const { rerender } = render(ticker({ scopeKey: "floor-a" }));
    const region = screen.getByRole("region", { name: "최근 운영 로그" });
    act(() => vi.advanceTimersByTime(8_000));
    expect(region).toHaveTextContent("B-05");
    rerender(ticker({ scopeKey: "floor-a", items: items.map(item => ({ ...item })) }));
    expect(region).toHaveTextContent("B-05");
    act(() => vi.advanceTimersByTime(1_999));
    expect(region).toHaveTextContent("B-05");
    act(() => vi.advanceTimersByTime(1));
    expect(region).toHaveTextContent("B-04");
    act(() => vi.advanceTimersByTime(5_000));
    rerender(ticker({ scopeKey: "floor-a", items: [{ ...items[0], displayName: "changed event" }, items[1]] }));
    expect(region).toHaveTextContent("changed event");
    act(() => vi.advanceTimersByTime(5_000));
    expect(region).toHaveTextContent("B-05");
    rerender(ticker({ scopeKey: "floor-b", items: [{ ...items[0], displayName: "changed event" }, items[1]] }));
    expect(region).toHaveTextContent("changed event");
  });

  it("rotates fetched events every five seconds and pauses while hovered", () => {
    vi.useFakeTimers();
    render(ticker());
    const region = screen.getByRole("region", { name: "최근 운영 로그" });
    expect(region).toHaveTextContent("B-04");
    act(() => vi.advanceTimersByTime(4_999));
    expect(region).toHaveTextContent("B-04");
    act(() => vi.advanceTimersByTime(1));
    expect(region).toHaveTextContent("B-05");
    fireEvent.mouseEnter(screen.getByRole("region", { name: "최근 활동" }));
    act(() => vi.advanceTimersByTime(6_000));
    expect(region).toHaveTextContent("B-05");
    fireEvent.mouseLeave(screen.getByRole("region", { name: "최근 활동" }));
    act(() => vi.advanceTimersByTime(5_000));
    expect(region).toHaveTextContent("B-04");
    expect(screen.getByRole("button", { name: "전체 보기" })).toBeInTheDocument();
  });

  it("pauses for focus and document inactivity, resets scope and cleans its timer", () => {
    vi.useFakeTimers();
    const { rerender, unmount } = render(ticker({ scopeKey: "floor-a" }));
    const region = screen.getByRole("region", { name: "최근 운영 로그" });
    act(() => vi.advanceTimersByTime(5_000));
    expect(region).toHaveTextContent("B-05");
    const trigger = screen.getByRole("button", { name: "전체 보기" });
    fireEvent.focus(trigger);
    act(() => vi.advanceTimersByTime(10_000));
    expect(region).toHaveTextContent("B-05");
    fireEvent.blur(trigger, { relatedTarget: document.body });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    act(() => vi.advanceTimersByTime(10_000));
    expect(region).toHaveTextContent("B-05");
    rerender(ticker({ scopeKey: "floor-b" }));
    expect(region).toHaveTextContent("B-04");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    vi.restoreAllMocks();
  });

  it("keeps true empty, first error and cached refetch error distinct", () => {
    const { rerender } = render(ticker({ items: [], generatedAt: "2026-09-25T00:02:00.000Z" }));
    expect(screen.getByText("최근 3개월의 운영 활동 기록이 없습니다.")).toBeVisible();
    expect(screen.queryByText("3개월 이전 기록은 보관되지 않습니다.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "전체 보기" })).toBeVisible();
    rerender(ticker({ items: [], generatedAt: null, error: new Error("offline") }));
    expect(screen.getByText("운영 활동을 불러오지 못했습니다.")).toBeVisible();
    expect(screen.getByRole("button", { name: "다시 조회" })).toBeVisible();
    rerender(ticker({ error: new Error("offline"), isRefetchError: true }));
    expect(screen.getByText(/갱신에 실패/)).toBeVisible();
    expect(screen.queryByText(/B-04/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 조회" })).toBeVisible();
  });

  it("shows the recorded unknown result as neutral rather than a completed activity", () => {
    render(ticker({ items: [{ ...items[0], kind: "command_result", commandOutcome: "unknown" }] }));
    const region = screen.getByRole("region", { name: "최근 활동" });
    expect(region).toHaveTextContent("결과 확인 불가");
    expect(region.querySelector('[data-tone="neutral"]')).not.toBeNull();
    expect(region).not.toHaveTextContent("적용 완료");
  });
});
