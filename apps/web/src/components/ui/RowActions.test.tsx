import { createRef } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as UI from "./index";

afterEach(cleanup);
describe("RowActions", () => {
  it.each([0, "0"])("row actions preserve numeric keys and focus: %s", async key => {
    expect(UI.RowActions).toBeDefined();
    const action = vi.fn(); const ref = createRef<HTMLButtonElement>();
    render(<UI.RowActions rowLabel="A 조명" ref={ref} items={[{ id: key, label: "수정" }, { id: "delete", label: "삭제", isDisabled: true }]} onAction={action} />);
    const trigger = screen.getByRole("button", { name: "A 조명 작업" });
    expect(ref.current).toBe(trigger); expect(trigger).toHaveClass("min-h-11", "min-w-11");
    trigger.focus(); fireEvent.click(trigger);
    const menu = await screen.findByRole("menu");
    expect(screen.getByRole("menuitem", { name: "삭제" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("menuitem", { name: "수정" }));
    expect(action).toHaveBeenCalledOnce(); expect(action).toHaveBeenCalledWith(key);
    await waitFor(() => expect(menu).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
  it("removed row trigger closes menu without stealing new scope focus", async () => {
    expect(UI.RowActions).toBeDefined();
    const view = render(<UI.RowActions rowLabel="이전 현장" items={[{ id: "edit", label: "수정" }]} onAction={() => {}} />);
    const trigger = screen.getByRole("button"); trigger.focus(); fireEvent.click(trigger);
    await screen.findByRole("menu");
    view.rerender(<button autoFocus>새 현장</button>);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "새 현장" })).toHaveFocus());
  });
  it("does not activate pending rows", () => {
    expect(UI.RowActions).toBeDefined();
    render(<UI.RowActions rowLabel="대기" isDisabled items={[{ id: "edit", label: "수정" }]} onAction={() => {}} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toBeDisabled(); expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
  it("locks actions when an already open row becomes pending", async () => {
    const action = vi.fn();
    const props = { rowLabel: "진행 중", items: [{ id: "edit", label: "수정" }], onAction: action };
    const view = render(<UI.RowActions {...props} />);
    fireEvent.click(screen.getByRole("button")); await screen.findByRole("menu");
    view.rerender(<UI.RowActions {...props} isDisabled />);
    const item = screen.getByRole("menuitem", { name: "수정" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(item);
    expect(action).not.toHaveBeenCalled();
  });
});
