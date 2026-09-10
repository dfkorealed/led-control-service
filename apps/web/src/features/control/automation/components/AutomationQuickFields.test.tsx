import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AutomationAdvancedSection,
  AutomationPresetGroup,
  AutomationSelectionCard,
  AutomationSummaryBar
} from "./AutomationQuickFields";

describe("automation quick fields", () => {
  it("exposes the selected preset and reports a new selection", () => {
    const onChange = vi.fn();
    render(<AutomationPresetGroup
      label="반복 프리셋"
      value="weekday"
      options={[
        { value: "daily", label: "매일" },
        { value: "weekday", label: "평일" }
      ]}
      disabled={false}
      onChange={onChange}
    />);

    expect(screen.getByRole("button", { name: "평일" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "매일" }));
    expect(onChange).toHaveBeenCalledWith("daily");
  });

  it("keeps selection descriptions bounded and labels the change action", () => {
    const onOpen = vi.fn();
    render(<AutomationSelectionCard
      label="제어 대상"
      title="2개 조명"
      description="B1 · 개별 선택"
      empty={false}
      disabled={false}
      onOpen={onOpen}
    />);

    expect(screen.getByText("B1 · 개별 선택")).toHaveClass("automation-selection-description");
    fireEvent.click(screen.getByRole("button", { name: "제어 대상 변경" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("reveals advanced content only after its disclosure is opened", () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(<AutomationAdvancedSection label="세부 일정 설정" open={false} onOpenChange={onOpenChange}>
      <label>스케줄 이름<input aria-label="스케줄 이름" /></label>
    </AutomationAdvancedSection>);

    expect(screen.queryByRole("region", { name: "세부 일정 설정" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "세부 일정 설정" }));
    expect(onOpenChange).toHaveBeenCalledWith(true);

    rerender(<AutomationAdvancedSection label="세부 일정 설정" open onOpenChange={onOpenChange}>
      <label>스케줄 이름<input aria-label="스케줄 이름" /></label>
    </AutomationAdvancedSection>);
    expect(screen.getByRole("region", { name: "세부 일정 설정" })).toBeVisible();
  });

  it("announces the live configuration summary", () => {
    render(<AutomationSummaryBar>매일 18:00–23:00 · B1-L001 · 밝기 70%</AutomationSummaryBar>);

    expect(screen.getByRole("status")).toHaveTextContent("매일 18:00–23:00 · B1-L001 · 밝기 70%");
  });
});
