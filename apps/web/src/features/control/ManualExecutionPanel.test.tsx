import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManualExecutionPanel } from "./ManualExecutionPanel";

afterEach(cleanup);
function setup(locked = false, eligible = true) {
  const submit = vi.fn();
  function Draft() {
    const [brightness, setBrightness] = useState(70);
    return <ManualExecutionPanel brightness={brightness} controlsLocked={locked} canSubmit={eligible}
      applyLabel="적용" onBrightnessChange={setBrightness} onSubmit={submit} />;
  }
  render(<Draft />); return submit;
}
describe("ManualExecutionPanel", () => {
  it("C6-8 compact More keeps the raw draft and explicit Apply independent of its auxiliary content", () => {
    const submit = vi.fn();
    function CompactDraft() {
      const [brightness, setBrightness] = useState(70);
      return <ManualExecutionPanel brightness={brightness} controlsLocked={false} canSubmit applyLabel="적용 대상" compact
        moreContent={<button type="button">보조 작업</button>} onBrightnessChange={setBrightness} onSubmit={submit} />;
    }
    render(<CompactDraft />);
    const input = screen.getByRole("textbox", { name: "밝기 수치" });
    fireEvent.input(input, { target: { value: "31" } });
    const more = screen.getByRole("button", { name: "더보기" });
    expect(screen.queryByRole("button", { name: "보조 작업" })).not.toBeInTheDocument();
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("button", { name: "보조 작업" }));
    fireEvent.click(more);
    expect(screen.getByRole("textbox", { name: "밝기 수치" })).toBe(input);
    expect(input).toHaveValue("31"); expect(screen.getByRole("slider", { name: "밝기" })).toHaveValue("31");
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "적용 대상" })); expect(submit).toHaveBeenCalledOnce();
  });

  it.each([false, true])("native Home/End retain slider focus and update only the draft (compact=%s)", compact => {
    const submit = vi.fn();
    function Draft() {
      const [brightness, setBrightness] = useState(70);
      return <ManualExecutionPanel brightness={brightness} controlsLocked={false} canSubmit applyLabel="적용 대상"
        compact={compact} onBrightnessChange={setBrightness} onSubmit={submit} />;
    }
    render(<Draft />);
    const slider = screen.getByRole("slider", { name: "밝기" });
    act(() => { slider.focus(); });
    for (const [key, value] of [["Home", "0"], ["End", "100"]]) {
      fireEvent.keyDown(slider, { key });
      expect(screen.getByRole("slider", { name: "밝기" })).toBe(slider);
      expect(slider).toHaveFocus();
      expect(slider).toHaveValue(value);
      expect(screen.getByRole("textbox", { name: "밝기 수치" })).toHaveValue(value);
      expect(submit).not.toHaveBeenCalled();
    }
    if (compact) {
      const more = screen.getByRole("button", { name: "더보기" });
      fireEvent.click(more); fireEvent.click(more);
      expect(screen.getByRole("slider", { name: "밝기" })).toBe(slider);
      expect(slider).toHaveValue("100");
      expect(submit).not.toHaveBeenCalled();
    }
    fireEvent.click(screen.getByRole("button", { name: "적용 대상" }));
    expect(submit).toHaveBeenCalledOnce();
  });

  it("fidelity exposes one visible brightness label while the bare slider keeps its accessible input", () => {
    setup();
    expect(screen.getAllByText("밝기")).toHaveLength(1);
    expect(screen.queryByText("초안")).not.toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "밝기" })).toHaveValue("70");
    fireEvent.change(screen.getByRole("slider", { name: "밝기" }), { target: { value: "30" } });
    expect(screen.getByRole("textbox", { name: "밝기 수치" })).toHaveValue("30");
  });
  it("keeps presets, slider and number immediate and draft-only until explicit Apply", () => {
    const submit = setup();
    for (const value of [0, 30, 70, 100]) {
      fireEvent.click(screen.getByRole("button", { name: `${value}%` }));
      expect(screen.getByRole("textbox", { name: "밝기 수치" })).toHaveValue(String(value));
      expect(screen.getByRole("slider", { name: "밝기" })).toHaveValue(String(value));
    }
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "적용" })); expect(submit).toHaveBeenCalledOnce();
  });
  it.each(["", "42.5", "101", "-1"])("invalid blur then Apply never sends: %s", async draft => {
    const submit = setup();
    const input = screen.getByRole("textbox", { name: "밝기 수치" });
    const apply = screen.getByRole("button", { name: "적용" });
    fireEvent.input(input, { target: { value: draft } }); expect(apply).toBeDisabled();
    fireEvent.pointerDown(apply); fireEvent.blur(input, { relatedTarget: apply }); fireEvent.click(apply);
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "밝기 수치" })).toHaveValue("70");
    await act(async () => {});
    fireEvent.click(apply); expect(submit).toHaveBeenCalledOnce();
  });
  it("Enter restores an invalid draft without executing", () => {
    const submit = setup();
    const input = screen.getByRole("textbox", { name: "밝기 수치" });
    fireEvent.input(input, { target: { value: "42.5" } }); fireEvent.keyDown(input, { key: "Enter" });
    expect(submit).not.toHaveBeenCalled(); expect(screen.getByRole("textbox", { name: "밝기 수치" })).toHaveValue("70");
  });
  it("locks every brightness input and preset while preserving unavailable Apply", () => {
    const submit = setup(true, false);
    for (const value of [0, 30, 70, 100]) expect(screen.getByRole("button", { name: `${value}%` })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "밝기 수치" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "밝기" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "적용" })).toBeDisabled(); expect(submit).not.toHaveBeenCalled();
  });
});

it("keeps the execution row mounted while the compact More exposes the new execution mode", () => {
  const change = vi.fn();
  const view = render(<ManualExecutionPanel brightness={70} controlsLocked={false} canSubmit applyLabel="적용 대상" compact
    executionMode="basic" onExecutionModeChange={change} temporaryContent={<p>기간 선택</p>} onBrightnessChange={vi.fn()} onSubmit={vi.fn()} />);
  const row = document.querySelector("[data-control-execution-row]");
  fireEvent.click(screen.getByRole("button", { name: "더보기" }));
  fireEvent.click(screen.getByRole("button", { name: "시간제 제어" })); expect(change).toHaveBeenCalledWith("temporary");
  view.rerender(<ManualExecutionPanel brightness={70} controlsLocked={false} canSubmit applyLabel="적용 대상" compact
    executionMode="temporary" onExecutionModeChange={change} temporaryContent={<p>기간 선택</p>} onBrightnessChange={vi.fn()} onSubmit={vi.fn()} />);
  expect(document.querySelector("[data-control-execution-row]")).toBe(row);
});
