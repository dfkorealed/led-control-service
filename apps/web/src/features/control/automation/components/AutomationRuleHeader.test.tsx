import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "../../../../components/ui";
import { AutomationRuleHeader } from "./AutomationRuleHeader";

afterEach(cleanup);
describe("shared automation header", () => {
  it("keeps the sole Add in the same action slot across list, calendar and event", () => {
    const change = vi.fn();
    const view = render(<AutomationRuleHeader view="list" onViewChange={change} addAction={<Button>스케줄 추가</Button>} />);
    const header = screen.getByRole("group", { name: "자동화 작업" });
    expect(within(header).getAllByRole("button", { name: "스케줄 추가" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "목록" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "달력" }));
    expect(change).toHaveBeenCalledWith("calendar");
    const action = header.querySelector("[data-automation-add-action]");
    expect(action).toContainElement(screen.getByRole("button", { name: "스케줄 추가" }));
    view.rerender(<AutomationRuleHeader view="calendar" onViewChange={change} addAction={<Button>스케줄 추가</Button>} />);
    expect(header.querySelector("[data-automation-add-action]")).toBe(action);
    view.rerender(<AutomationRuleHeader addAction={<Button>이벤트 추가</Button>} />);
    expect(header.querySelector("[data-automation-add-action]")).toContainElement(screen.getByRole("button", { name: "이벤트 추가" }));
    expect(screen.queryByRole("button", { name: "달력" })).not.toBeInTheDocument();
  });
});
