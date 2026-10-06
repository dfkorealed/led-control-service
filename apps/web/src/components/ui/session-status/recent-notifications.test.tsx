import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionStatusProvider, useSessionStatusState, useSessionToast, useSessionStatus, type SessionStatusItem } from "./SessionStatusProvider";
import { ToastRegion } from "./ToastRegion";
import { useMemo } from "react";
afterEach(() => { cleanup(); vi.useRealTimers(); });
let latePublish: ReturnType<typeof useSessionToast>["publish"];
function Harness({ fingerprint = "a" }: { fingerprint?: string }) {
  const state = useSessionStatusState(); const toast = useSessionToast(); latePublish = toast.publish;
  const items = useMemo<SessionStatusItem[]>(() => [{ id: "warning", fingerprint, source: "query", tone: "warning", title: "연결 지연" }], [fingerprint]);
  useSessionStatus("query", items);
  return <><button onClick={() => toast.publish({ title: "저장", tone: "success" })}>publish</button>
    <button onClick={() => state.markRecentRead(state.recentNotifications[0]!.id)}>read</button>
    <output data-testid="history">{JSON.stringify(state.recentNotifications)}</output><output data-testid="unread">{state.recentUnreadCount}</output>
    <output data-testid="active">{state.statuses.length}/{state.toasts.length}</output><ToastRegion suppressVisual /></>;
}
it("keeps mobile history after toast expiry, preserves polling reads and increments on fingerprint changes", async () => {
  vi.useFakeTimers(); const view = render(<SessionStatusProvider><Harness /></SessionStatusProvider>);
  expect(screen.getByTestId("unread")).toHaveTextContent("1");
  expect(screen.getByRole("region", { name: "알림" })).toHaveClass("sr-only");
  expect(screen.queryByRole("button", { name: "알림 닫기" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("read")); expect(screen.getByTestId("unread")).toHaveTextContent("0");
  view.rerender(<SessionStatusProvider><Harness /></SessionStatusProvider>);
  expect(screen.getByTestId("unread")).toHaveTextContent("0");
  view.rerender(<SessionStatusProvider><Harness fingerprint="b" /></SessionStatusProvider>);
  expect(screen.getByTestId("unread")).toHaveTextContent("1");
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByTestId("active")).toHaveTextContent("1/0"); expect(screen.getByTestId("history")).toHaveTextContent("연결 지연");
});
it("bounds history at fifty and isolates old callbacks after scope remount", () => {
  const view = render(<SessionStatusProvider key="site-a"><Harness /></SessionStatusProvider>);
  const oldPublish = latePublish;
  for (let index = 0; index < 60; index++) fireEvent.click(screen.getByText("publish"));
  expect(JSON.parse(screen.getByTestId("history").textContent!)).toHaveLength(50);
  view.rerender(<SessionStatusProvider key="site-b"><Harness /></SessionStatusProvider>);
  act(() => { oldPublish({ title: "old scope", tone: "danger" }); });
  expect(JSON.parse(screen.getByTestId("history").textContent!)).toHaveLength(1);
  expect(screen.getByTestId("history")).not.toHaveTextContent("old scope");
});
