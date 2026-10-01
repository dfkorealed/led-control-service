import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, PropsWithChildren } from "react";
import { useSessionStatusState } from "./SessionStatusProvider";
import { useMemo, useRef, useState } from "react";
import { act, cleanup, fireEvent, render as renderUI, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SessionStatusCenter,
  SessionStatusProvider,
  ToastRegion,
  useSessionStatus,
  useSessionToast,
  type SessionStatusCenterHandle,
  type SessionStatusItem
} from "../index";

const clients = new Set<QueryClient>();
function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.add(client);
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderUI(ui, { wrapper });
}

afterEach(() => {
  clients.forEach(client => client.clear());
  clients.clear();
  cleanup();
  vi.useRealTimers();
});

function QueryStatusProducer({ fingerprint, revision = 0 }: { fingerprint: string | null; revision?: number }) {
  const items = useMemo<SessionStatusItem[]>(() => fingerprint ? [{
    id: "query:dashboard:site-1",
    fingerprint,
    source: "query",
    tone: "warning",
    title: "현장 정보를 갱신하지 못했습니다.",
    description: `revision ${fingerprint}`
  }] : [], [fingerprint, revision]);
  useSessionStatus("dashboard:site-1", items);
  return null;
}

function QueryStatusHarness(props: { fingerprint: string | null; revision?: number }) {
  return <><QueryStatusProducer {...props} /><ScreenStatusObserver /><SessionStatusCenter /><ToastRegion /></>;
}

function ScreenStatusObserver() {
  const { statuses } = useSessionStatusState();
  return <output data-testid="screen-status-count">{statuses.length}</output>;
}

function ToastHarness() {
  const toast = useSessionToast();
  return <>
    <button onClick={() => toast.publish({ dedupeKey: "save", tone: "success", title: "저장 완료" })}>저장 알림</button>
    <button onClick={() => toast.publish({ dedupeKey: "save", tone: "warning", title: "저장 지연" })}>저장 갱신</button>
    {(["하나", "둘", "셋", "넷"] as const).map((title) => <button key={title} onClick={() => toast.publish({ dedupeKey: title, tone: "info", title })}>{title}</button>)}
    <button onClick={() => toast.publish({ dedupeKey: "danger", tone: "danger", title: "연결 실패" })}>위험</button>
    <ToastRegion />
  </>;
}

function ImperativeOpenHarness() {
  const centerRef = useRef<SessionStatusCenterHandle>(null);
  const sourceRef = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={sourceRef} onClick={() => centerRef.current?.open(sourceRef.current)}>게이트웨이 상태</button>
    <SessionStatusCenter ref={centerRef} />
  </>;
}

describe("session status feedback", () => {
  it("does not treat a transient query issue as a durable alarm count", () => {
    render(<SessionStatusProvider><QueryStatusHarness fingerprint="1" /></SessionStatusProvider>);
    expect(screen.getByRole("button", { name: "알람센터, 현장 미선택" })).toBeVisible();
    expect(screen.getByTestId("screen-status-count")).toHaveTextContent("1");
    expect(screen.queryByTestId("alarm-unread-badge")).not.toBeInTheDocument();
  });
  it("shows gateway context in the drawer without counting it as unresolved", () => {
    render(
      <SessionStatusProvider>
        <SessionStatusCenter contextItems={[{
          id: "gateway-summary",
          title: "Gateway 연결",
          description: "게이트웨이 2/2대 연결",
          tone: "success"
        }]} />
      </SessionStatusProvider>
    );
    const trigger = screen.getByRole("button", { name: "알람센터, 현장 미선택" });
    expect(within(trigger).queryByTestId("alarm-unread-badge")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    const drawer = screen.getByRole("dialog", { name: "알람센터" });
    expect(drawer).toHaveTextContent("게이트웨이 2/2대 연결");
    expect(drawer).toHaveTextContent("화면에 보인 알람만 읽음으로 저장하며 장애 처리 상태는 유지됩니다.");
  });

  it("keeps transient statuses available without inventing an alarm badge", () => {
    render(<SessionStatusProvider><QueryStatusHarness fingerprint="1" /></SessionStatusProvider>);
    const trigger = screen.getByRole("button", { name: "알람센터, 현장 미선택" });
    expect(trigger).toHaveAttribute("title", "알람센터, 현장 미선택");
    expect(within(trigger).queryByTestId("alarm-unread-badge")).not.toBeInTheDocument();
    expect(screen.getByTestId("screen-status-count")).toHaveTextContent("1");
  });

  it("deduplicates a current query issue, resolves it, and announces a later episode again", async () => {
    const { rerender } = render(<SessionStatusProvider><QueryStatusHarness fingerprint="1" /></SessionStatusProvider>);

    const region = await screen.findByRole("region", { name: "알림" });
    expect(within(region).getAllByRole("status")).toHaveLength(1);
    expect(within(region).getByRole("status")).toHaveTextContent("revision 1");
    expect(screen.getByRole("button", { name: "알람센터, 현장 미선택" })).toBeVisible();

    rerender(<SessionStatusProvider><QueryStatusHarness fingerprint="1" /></SessionStatusProvider>);
    expect(within(region).getAllByRole("status")).toHaveLength(1);
    expect(screen.getByTestId("screen-status-count")).toHaveTextContent("1");

    rerender(<SessionStatusProvider><QueryStatusHarness fingerprint="2" /></SessionStatusProvider>);
    expect(await within(region).findByText("revision 2")).toBeVisible();
    expect(within(region).getAllByRole("status")).toHaveLength(1);
    expect(screen.getByTestId("screen-status-count")).toHaveTextContent("1");

    rerender(<SessionStatusProvider><QueryStatusHarness fingerprint={null} /></SessionStatusProvider>);
    await waitFor(() => expect(within(region).queryByRole("status")).not.toBeInTheDocument());
    expect(screen.getByTestId("screen-status-count")).toHaveTextContent("0");

    rerender(<SessionStatusProvider><QueryStatusHarness fingerprint="2" /></SessionStatusProvider>);
    expect(await within(region).findByRole("status")).toHaveTextContent("revision 2");
    expect(screen.getByTestId("screen-status-count")).toHaveTextContent("1");
  });

  it("does not announce a sustained id and fingerprint again when polling creates a new items array", async () => {
    const { rerender } = render(<SessionStatusProvider><QueryStatusHarness fingerprint="1" revision={1} /></SessionStatusProvider>);
    const region = await screen.findByRole("region", { name: "알림" });
    const toast = within(region).getByRole("status");
    fireEvent.click(within(toast).getByRole("button", { name: "알림 닫기" }));
    expect(within(region).queryByRole("status")).not.toBeInTheDocument();

    rerender(<SessionStatusProvider><QueryStatusHarness fingerprint="1" revision={2} /></SessionStatusProvider>);

    expect(screen.getByTestId("screen-status-count")).toHaveTextContent("1");
    expect(within(region).queryByRole("status")).not.toBeInTheDocument();
  });

  it("updates a dedupe key, caps visible toasts, and removes them after five seconds", async () => {
    vi.useFakeTimers();
    render(<SessionStatusProvider><ToastHarness /></SessionStatusProvider>);
    fireEvent.click(screen.getByRole("button", { name: "저장 알림" }));
    fireEvent.click(screen.getByRole("button", { name: "저장 갱신" }));

    const region = screen.getByRole("region", { name: "알림" });
    expect(within(region).queryByText("저장 완료")).not.toBeInTheDocument();
    expect(within(region).getByRole("status")).toHaveTextContent("저장 지연");

    for (const title of ["하나", "둘", "셋", "넷"]) fireEvent.click(screen.getByRole("button", { name: title }));
    expect(within(region).getAllByRole("status")).toHaveLength(3);
    expect(within(region).queryByText("저장 지연")).not.toBeInTheDocument();
    expect(within(region).queryByText("하나")).not.toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
    expect(within(region).getAllByRole("status")).toHaveLength(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(within(region).queryByRole("status")).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses an alert only for danger and supports manual dismissal", () => {
    render(<SessionStatusProvider><ToastHarness /></SessionStatusProvider>);
    fireEvent.click(screen.getByRole("button", { name: "위험" }));

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("연결 실패");
    fireEvent.click(within(alert).getByRole("button", { name: "알림 닫기" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("opens the status center as a named dialog and returns focus after Escape", async () => {
    render(<SessionStatusProvider><QueryStatusHarness fingerprint="1" /></SessionStatusProvider>);
    const trigger = screen.getByRole("button", { name: "알람센터, 현장 미선택" });
    expect(trigger).toHaveClass("min-h-13", "min-w-13");
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "알람센터" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(dialog).toHaveTextContent("현장 정보를 갱신하지 못했습니다.");
    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "알람센터" })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    const reopened = await screen.findByRole("dialog", { name: "알람센터" });
    fireEvent.click(within(reopened).getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("opens through an explicit ref and returns focus to the requesting status control", async () => {
    render(<SessionStatusProvider><ImperativeOpenHarness /></SessionStatusProvider>);
    const source = screen.getByRole("button", { name: "게이트웨이 상태" });

    fireEvent.click(source);
    const dialog = await screen.findByRole("dialog", { name: "알람센터" });
    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(source).toHaveFocus());
  });

  it("unregisters source items when their producer unmounts", async () => {
    function Toggle() {
      const [visible, setVisible] = useState(true);
      return <><button onClick={() => setVisible(false)}>producer 제거</button>{visible ? <QueryStatusProducer fingerprint="1" /> : null}<ScreenStatusObserver /><SessionStatusCenter /><ToastRegion /></>;
    }
    render(<SessionStatusProvider><Toggle /></SessionStatusProvider>);
    expect(screen.getByTestId("screen-status-count")).toHaveTextContent("1");
    fireEvent.click(screen.getByRole("button", { name: "producer 제거" }));

    await waitFor(() => expect(screen.getByTestId("screen-status-count")).toHaveTextContent("0"));
    expect(within(screen.getByRole("region", { name: "알림" })).queryByRole("status")).not.toBeInTheDocument();
  });
});
