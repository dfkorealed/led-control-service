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
