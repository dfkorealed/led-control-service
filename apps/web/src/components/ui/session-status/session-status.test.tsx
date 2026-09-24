import { useMemo, useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function QueryStatusHarness({ fingerprint, revision = 0 }: { fingerprint: string | null; revision?: number }) {
  const items = useMemo<SessionStatusItem[]>(() => fingerprint ? [{
    id: "query:dashboard:site-1",
    fingerprint,
    source: "query",
    tone: "warning",
    title: "현장 정보를 갱신하지 못했습니다.",
    description: `revision ${fingerprint}`
  }] : [], [fingerprint, revision]);
  useSessionStatus("dashboard:site-1", items);
  return <><SessionStatusCenter /><ToastRegion /></>;
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
  it("deduplicates a current query issue, resolves it, and announces a later episode again", async () => {
    const { rerender } = render(<SessionStatusProvider><QueryStatusHarness fingerprint="1" /></SessionStatusProvider>);

    const region = await screen.findByRole("region", { name: "알림" });
    expect(within(region).getAllByRole("status")).toHaveLength(1);
    expect(within(region).getByRole("status")).toHaveTextContent("revision 1");
    expect(screen.getByRole("button", { name: "상태 센터, 미해결 1건" })).toBeVisible();

    rerender(<SessionStatusProvider><QueryStatusHarness fingerprint="1" /></SessionStatusProvider>);
    expect(within(region).getAllByRole("status")).toHaveLength(1);

    rerender(<SessionStatusProvider><QueryStatusHarness fingerprint="2" /></SessionStatusProvider>);
    expect(await within(region).findByText("revision 2")).toBeVisible();
    expect(within(region).getAllByRole("status")).toHaveLength(1);

    rerender(<SessionStatusProvider><QueryStatusHarness fingerprint={null} /></SessionStatusProvider>);
    await waitFor(() => expect(within(region).queryByRole("status")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "상태 센터, 미해결 0건" })).toBeVisible();

    rerender(<SessionStatusProvider><QueryStatusHarness fingerprint="2" /></SessionStatusProvider>);
    expect(await within(region).findByRole("status")).toHaveTextContent("revision 2");
  });

  it("does not announce a sustained id and fingerprint again when polling creates a new items array", async () => {
    const { rerender } = render(<SessionStatusProvider><QueryStatusHarness fingerprint="1" revision={1} /></SessionStatusProvider>);
    const region = await screen.findByRole("region", { name: "알림" });
    const toast = within(region).getByRole("status");
    fireEvent.click(within(toast).getByRole("button", { name: "알림 닫기" }));
    expect(within(region).queryByRole("status")).not.toBeInTheDocument();

    rerender(<SessionStatusProvider><QueryStatusHarness fingerprint="1" revision={2} /></SessionStatusProvider>);

    expect(screen.getByRole("button", { name: "상태 센터, 미해결 1건" })).toBeVisible();
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
    const trigger = screen.getByRole("button", { name: "상태 센터, 미해결 1건" });
    expect(trigger).toHaveClass("min-h-13", "min-w-13");
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "현재 세션 상태" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(dialog).toHaveTextContent("현장 정보를 갱신하지 못했습니다.");
    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "현재 세션 상태" })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("opens through an explicit ref and returns focus to the requesting status control", async () => {
    render(<SessionStatusProvider><ImperativeOpenHarness /></SessionStatusProvider>);
    const source = screen.getByRole("button", { name: "게이트웨이 상태" });

    fireEvent.click(source);
    const dialog = await screen.findByRole("dialog", { name: "현재 세션 상태" });
    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(source).toHaveFocus());
  });

  it("unregisters source items when their producer unmounts", async () => {
    function Toggle() {
      const [visible, setVisible] = useState(true);
      return <><button onClick={() => setVisible(false)}>producer 제거</button>{visible ? <QueryStatusHarness fingerprint="1" /> : <><SessionStatusCenter /><ToastRegion /></>}</>;
    }
    render(<SessionStatusProvider><Toggle /></SessionStatusProvider>);
    expect(await screen.findByRole("button", { name: "상태 센터, 미해결 1건" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "producer 제거" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "상태 센터, 미해결 0건" })).toBeVisible());
    expect(within(screen.getByRole("region", { name: "알림" })).queryByRole("status")).not.toBeInTheDocument();
  });
});
