import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TargetSelectionToolbar } from "./TargetSelectionToolbar";

afterEach(cleanup);

it("fidelity reads floor before manual target modes and actions while preserving their handlers", () => {
  const onModeChange = vi.fn();
  const onOpenList = vi.fn();
  render(<TargetSelectionToolbar presentation="manual-workspace" allowedModes={["fixtures", "floor", "group"]}
    selection={{ mode: "fixtures", fixtureIds: [] }} activeFloorId="" floors={[]}
    onModeChange={onModeChange} onFloorChange={vi.fn()} onOpenList={onOpenList} />);
  const floor = screen.getByRole("button", { name: "표시 층" });
  const mode = screen.getByRole("button", { name: "개별 조명" });
  const list = screen.getByRole("button", { name: "조명 목록" });
  expect(floor.compareDocumentPosition(mode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(list.compareDocumentPosition(mode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(mode).toHaveAttribute("aria-current", "true");
  fireEvent.click(screen.getByRole("button", { name: "층 전체" }));
  expect(onModeChange).toHaveBeenCalledWith("floor");
  fireEvent.click(list);
  expect(onOpenList).toHaveBeenCalledOnce();
});
