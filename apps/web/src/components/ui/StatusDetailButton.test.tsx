import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusDetailButton } from "./StatusDetailButton";

describe("StatusDetailButton", () => {
  afterEach(cleanup);

  it("discloses a full warning without placing it in the page until requested", async () => {
    render(<StatusDetailButton label="이력 제외" description="이전 구조 이력은 현장 총계에만 포함됩니다." />);

    const trigger = screen.getByRole("button", { name: "이력 제외 안내" });
    trigger.focus();
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("이전 구조 이력은 현장 총계에만 포함됩니다.")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    const details = await screen.findByRole("dialog", { name: "이력 제외 안내" });
    expect(details).toHaveTextContent("이전 구조 이력은 현장 총계에만 포함됩니다.");
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(details, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "이력 제외 안내" })).not.toBeInTheDocument());
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps a recovery action inside the dialog and invokes it once", async () => {
    const retry = vi.fn();
    render(<StatusDetailButton label="목록 갱신 실패" description="기존 결과를 표시합니다."
      action={{ label: "다시 시도", onClick: retry }} />);

    const trigger = screen.getByRole("button", { name: "목록 갱신 실패 안내" });
    trigger.focus();
    fireEvent.click(trigger);
    const details = await screen.findByRole("dialog", { name: "목록 갱신 실패 안내" });
    fireEvent.click(within(details).getByRole("button", { name: "다시 시도" }));

    expect(retry).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledWith(trigger);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "목록 갱신 실패 안내" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("accepts a semantic danger variant and caller layout class on its trigger", () => {
    render(<StatusDetailButton label="목록 갱신 실패" description="기존 결과를 표시합니다."
      variant="danger" className="justify-self-end" />);

    expect(screen.getByRole("button", { name: "목록 갱신 실패 안내" }))
      .toHaveClass("border-status-danger-border", "bg-status-danger-background", "justify-self-end");
  });

  it("shows a pending recovery status without an actionable retry", async () => {
    const retry = vi.fn();
    render(<StatusDetailButton label="목록 갱신 실패" description="기존 결과를 표시합니다."
      action={{ label: "다시 시도", onClick: retry, isBusy: true }} />);

    fireEvent.click(screen.getByRole("button", { name: "목록 갱신 실패 안내" }));
    const details = await screen.findByRole("dialog", { name: "목록 갱신 실패 안내" });
    expect(within(details).getByRole("status")).toHaveTextContent("확인 중");
    expect(within(details).queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();
    expect(retry).not.toHaveBeenCalled();
  });
});
