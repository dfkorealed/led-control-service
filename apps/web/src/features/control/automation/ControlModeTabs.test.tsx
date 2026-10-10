import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ControlModeTabs, type ControlPageMode } from "./ControlModeTabs";

function ControlModeTabsHarness() {
  const [mode, setMode] = useState<ControlPageMode>("manual");
  return <ControlModeTabs mode={mode} onChange={setMode} allowAutomation allowGroups />;
}

describe("ControlModeTabs", () => {
  afterEach(cleanup);
  it("keeps group reading independent of automation permission and includes it in roving focus", () => {
    function ReadonlyGroups() {
      const [mode, setMode] = useState<ControlPageMode>("manual");
      return <ControlModeTabs mode={mode} onChange={setMode} allowAutomation={false} allowGroups />;
    }
    render(<ReadonlyGroups />);
    expect(screen.queryByRole("tab", { name: "스케줄 제어" })).not.toBeInTheDocument();
    const manual = screen.getByRole("tab", { name: "수동 제어" });
    const group = screen.getByRole("tab", { name: "그룹/구역" });
    manual.focus(); fireEvent.keyDown(manual, { key: "End" });
    expect(group).toHaveFocus(); expect(group).toHaveAttribute("aria-controls", "control-mode-panel-group");
    expect(group).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(manual).toHaveFocus(); expect(manual).toHaveAttribute("tabindex", "0");
  });
  it("keeps tab semantics and moves the underline style with the active mode", () => {
    render(<ControlModeTabsHarness />);

    const manualTab = screen.getByRole("tab", { name: "수동 제어" });
    const scheduleTab = screen.getByRole("tab", { name: "스케줄 제어" });

    expect(manualTab).toHaveAttribute("aria-selected", "true");
    expect(manualTab).toHaveAttribute("tabindex", "0");
    expect(manualTab).toHaveClass("bg-action-primary-soft", "text-action-primary");
    expect(scheduleTab).toHaveAttribute("aria-selected", "false");
    expect(scheduleTab).toHaveAttribute("tabindex", "-1");
    expect(scheduleTab).toHaveClass("border-transparent", "text-content-secondary");

    fireEvent.click(scheduleTab);

    expect(manualTab).toHaveAttribute("aria-selected", "false");
    expect(manualTab).toHaveClass("border-transparent", "text-content-secondary");
    expect(scheduleTab).toHaveAttribute("aria-selected", "true");
    expect(scheduleTab).toHaveClass("bg-action-primary-soft", "text-action-primary");
  });
});
