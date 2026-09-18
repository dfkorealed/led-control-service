import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ControlModeTabs, type ControlPageMode } from "./ControlModeTabs";

function ControlModeTabsHarness() {
  const [mode, setMode] = useState<ControlPageMode>("manual");
  return <ControlModeTabs mode={mode} onChange={setMode} allowAutomation />;
}

describe("ControlModeTabs", () => {
  it("keeps tab semantics and moves the underline style with the active mode", () => {
    render(<ControlModeTabsHarness />);

    const manualTab = screen.getByRole("tab", { name: "수동 제어" });
    const scheduleTab = screen.getByRole("tab", { name: "스케줄 제어" });

    expect(manualTab).toHaveAttribute("aria-selected", "true");
    expect(manualTab).toHaveAttribute("tabindex", "0");
    expect(manualTab).toHaveClass("border-action-primary", "text-action-primary");
    expect(scheduleTab).toHaveAttribute("aria-selected", "false");
    expect(scheduleTab).toHaveAttribute("tabindex", "-1");
    expect(scheduleTab).toHaveClass("border-transparent", "text-content-secondary");

    fireEvent.click(scheduleTab);

    expect(manualTab).toHaveAttribute("aria-selected", "false");
    expect(manualTab).toHaveClass("border-transparent", "text-content-secondary");
    expect(scheduleTab).toHaveAttribute("aria-selected", "true");
    expect(scheduleTab).toHaveClass("border-action-primary", "text-action-primary");
  });
});
