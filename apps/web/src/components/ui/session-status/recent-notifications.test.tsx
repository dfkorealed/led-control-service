import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionStatusProvider, useSessionStatusState, useSessionToast, useSessionStatus, type SessionStatusItem } from "./SessionStatusProvider";
import { ToastRegion } from "./ToastRegion";
import { StrictMode, useMemo } from "react";
afterEach(() => { cleanup(); vi.useRealTimers(); });
let latePublish: ReturnType<typeof useSessionToast>["publish"];
function Harness({ fingerprint = "a" }: { fingerprint?: string | null }) {
  const state = useSessionStatusState(); const toast = useSessionToast(); latePublish = toast.publish;
  const items = useMemo<SessionStatusItem[]>(() => fingerprint === null ? [] : [{ id: "warning", fingerprint, source: "query", tone: "warning", title: "연결 지연" }], [fingerprint]);
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

it("records one StrictMode initial condition and preserves polling, transitions and genuine recurrence", () => {
  const view = render(<StrictMode><SessionStatusProvider><Harness /></SessionStatusProvider></StrictMode>);
  const history = () => JSON.parse(screen.getByTestId("history").textContent!);
  expect(history()).toHaveLength(1);
  expect(screen.getByTestId("unread")).toHaveTextContent("1");
  expect(screen.getByTestId("active")).toHaveTextContent("1/1");
  view.rerender(<StrictMode><SessionStatusProvider><Harness /></SessionStatusProvider></StrictMode>);
  expect(history()).toHaveLength(1);
  view.rerender(<StrictMode><SessionStatusProvider><Harness fingerprint="b" /></SessionStatusProvider></StrictMode>);
  expect(history()).toHaveLength(2);
  expect(screen.getByTestId("unread")).toHaveTextContent("2");
  view.rerender(<StrictMode><SessionStatusProvider><Harness fingerprint={null} /></SessionStatusProvider></StrictMode>);
  expect(screen.getByTestId("active")).toHaveTextContent("0/0");
  view.rerender(<StrictMode><SessionStatusProvider><Harness fingerprint="a" /></SessionStatusProvider></StrictMode>);
  expect(history()).toHaveLength(3);
  fireEvent.click(screen.getByText("publish")); fireEvent.click(screen.getByText("publish"));
  expect(history()).toHaveLength(5);
});

function StableProducer() {
  const items = useMemo<SessionStatusItem[]>(() => [{ id: "stable", fingerprint: "same", source: "query", tone: "warning", title: "stable warning" }], []);
  useSessionStatus("stable-source", items);
  return null;
}
function LifecycleHarness({ visible }: { visible: boolean }) {
  const state = useSessionStatusState();
  return <>{visible ? <StableProducer /> : null}<output data-testid="lifecycle">{state.statuses.length}/{state.recentNotifications.length}/{state.recentUnreadCount}</output></>;
}
it("records a genuine unmount and later recurrence despite the same fingerprint", async () => {
  const view = render(<StrictMode><SessionStatusProvider><LifecycleHarness visible /></SessionStatusProvider></StrictMode>);
  expect(screen.getByTestId("lifecycle")).toHaveTextContent("1/1/1");
  await act(async () => {
    view.rerender(<StrictMode><SessionStatusProvider><LifecycleHarness visible={false} /></SessionStatusProvider></StrictMode>);
  });
  expect(screen.getByTestId("lifecycle")).toHaveTextContent("0/1/1");
  view.rerender(<StrictMode><SessionStatusProvider><LifecycleHarness visible /></SessionStatusProvider></StrictMode>);
  expect(screen.getByTestId("lifecycle")).toHaveTextContent("1/2/2");
});
