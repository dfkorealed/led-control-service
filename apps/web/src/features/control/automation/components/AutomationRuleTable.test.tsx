import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationRuleActions } from "./AutomationRuleTable";

describe("AutomationRuleActions BIO activation boundary", () => {
  afterEach(cleanup);

  it("blocks activation alone while keeping edit and delete available", async () => {
    const onToggle = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(<AutomationRuleActions name="미준비 BIO" enabled={false} disabled={false} toggleDisabled
      onToggle={onToggle} onEdit={onEdit} onDelete={onDelete} />);
    expect(screen.getByRole("button", { name: "미준비 BIO 활성화" })).toBeDisabled();
    const actions = screen.getByRole("button", { name: "미준비 BIO 작업" });
    expect(actions).toBeEnabled();
    fireEvent.click(actions);
    expect(await screen.findByRole("menuitem", { name: "수정" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "삭제" })).toBeEnabled();
    fireEvent.click(screen.getByRole("menuitem", { name: "수정" }));
    expect(onEdit).toHaveBeenCalledWith(actions);
    fireEvent.click(actions);
    fireEvent.click(await screen.findByRole("menuitem", { name: "삭제" }));
    expect(onDelete).toHaveBeenCalledWith(actions);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("global auth or mutation lock disables both operations", () => {
    render(<AutomationRuleActions name="잠긴 BIO" enabled disabled toggleDisabled={false}
      onToggle={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByRole("button", { name: "잠긴 BIO 비활성화" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "잠긴 BIO 작업" })).toBeDisabled();
  });

  it("preserves disable requests and existing consumers without an activation restriction", () => {
    const onToggle = vi.fn();
    render(<AutomationRuleActions name="기존 활성 규칙" enabled disabled={false}
      onToggle={onToggle} onEdit={vi.fn()} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "기존 활성 규칙 비활성화" }));
    expect(onToggle).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "기존 활성 규칙 작업" })).toBeEnabled();
  });
});
