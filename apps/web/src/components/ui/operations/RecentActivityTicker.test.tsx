import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RecentActivityTicker as Ticker } from "../index";

const items = [{ id: "a", timestampLabel: "10:00", content: "첫 명령", status: "성공" },
  { id: "b", timestampLabel: "10:01", content: "다음 명령", status: "일부 성공" }];
const props = { scopeKey: "site-a", items, emptyContent: "최근 이력 없음", onOpen: vi.fn() };
beforeEach(() => { vi.useFakeTimers(); Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
it("rotates only at five seconds and releases the timer on unmount", () => {
  const view = render(<Ticker {...props} />);
  expect(screen.getByText("첫 명령")).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(4999));
  expect(screen.queryByText("다음 명령")).not.toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByText("다음 명령")).toBeInTheDocument();
  expect(screen.getByText("일부 성공")).toBeInTheDocument();
  view.unmount(); expect(vi.getTimerCount()).toBe(0);
});
it("pauses for hover, keyboard focus and hidden documents without surprise advancement", () => {
  render(<Ticker {...props} />);
  const ticker = screen.getByRole("region", { name: "최근 이력" });
  fireEvent.mouseEnter(ticker); act(() => vi.advanceTimersByTime(10000));
  expect(screen.getByText("첫 명령")).toBeInTheDocument();
  fireEvent.mouseLeave(ticker); fireEvent.focus(screen.getByRole("button", { name: "전체 보기" }));
  act(() => vi.advanceTimersByTime(10000)); expect(screen.getByText("첫 명령")).toBeInTheDocument();
  fireEvent.blur(ticker, { relatedTarget: document.body });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  fireEvent(document, new Event("visibilitychange")); act(() => vi.advanceTimersByTime(10000));
  expect(screen.getByText("첫 명령")).toBeInTheDocument();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  fireEvent(document, new Event("visibilitychange")); act(() => vi.advanceTimersByTime(5000));
  expect(screen.getByText("다음 명령")).toBeInTheDocument();
});
it("resets the first row and clock for refreshed items and a new scope", () => {
  const view = render(<Ticker {...props} />);
  act(() => vi.advanceTimersByTime(5000));
  view.rerender(<Ticker {...props} items={[...items]} />);
  expect(screen.getByText("첫 명령")).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(5000));
  view.rerender(<Ticker {...props} scopeKey="site-b" />);
  expect(screen.getByText("첫 명령")).toBeInTheDocument();
});
it("delegates full-view and retry and keeps their trigger ref without owning a query", () => {
  const onOpen = vi.fn(), onRetry = vi.fn(), triggerRef = createRef<HTMLButtonElement>();
  render(<Ticker {...props} items={[]} onOpen={onOpen} onRetry={onRetry} triggerRef={triggerRef} />);
  expect(screen.getByText("최근 이력 없음")).toBeInTheDocument();
  const opener = screen.getByRole("button", { name: "전체 보기" });
  expect(triggerRef.current).toBe(opener); fireEvent.click(opener); expect(onOpen).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "다시 조회" })); expect(onRetry).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it("does not drop a supplied zero-valued status node", () => {
  render(<Ticker {...props} items={[{ id: "zero", timestampLabel: "10:00", content: "확인", status: 0 }]} />);
  expect(screen.getByText("0")).toBeInTheDocument();
});
