import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as UI from "./index";

function panel() {
  const component = UI.FilterPanel;
  expect(component, "public filter wrapper is exported").toBeDefined();
  return component;
}
afterEach(cleanup);

describe("FilterPanel", () => {
  it("preserves field labels, errors, descriptions, callbacks and slot DOM order", () => {
    const FilterPanel = panel();
    const change = vi.fn(); const reset = vi.fn();
    render(<FilterPanel label="로그 필터" className="consumer-filter" chips={<span>선택된 층</span>}
      actions={<UI.Button onClick={reset}>초기화</UI.Button>}>
      <UI.TextField label="검색" description="조명 이름" errorMessage="다시 확인" isInvalid value="" onChange={change} />
      <UI.SelectBox label="유형" items={[{ id: "all", label: "전체" }]} selectedKey="all" />
    </FilterPanel>);
    const region = screen.getByRole("region", { name: "로그 필터" });
    expect(region).toHaveClass("min-w-0", "consumer-filter");
    const field = within(region).getByRole("textbox", { name: "검색" });
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(/조명 이름/);
    expect(field).toHaveAccessibleDescription(/다시 확인/);
    expect(within(region).getByRole("button", { name: "유형" })).toBeVisible();
    fireEvent.change(field, { target: { value: "B1" } });
    expect(change).toHaveBeenCalledOnce();
    expect(change).toHaveBeenCalledWith("B1");
    fireEvent.click(screen.getByRole("button", { name: "초기화" }));
    expect(reset).toHaveBeenCalledOnce();
    expect([...region.querySelectorAll("input, button")].map(node => node.getAttribute("aria-label") ?? node.id)).toHaveLength(3);
    expect(field.compareDocumentPosition(screen.getByText("선택된 층")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("선택된 층").compareDocumentPosition(screen.getByRole("button", { name: "초기화" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("provides wrapping shrinkable slots for long chips and actions without adding controls", () => {
    const FilterPanel = panel();
    render(<FilterPanel label="기간 필터" chips={<span>{"긴필터".repeat(40)}</span>} actions={<><button>적용</button><button>내보내기</button></>}><UI.TextField label="조건" /></FilterPanel>);
    expect(screen.getByText("긴필터".repeat(40)).parentElement).toHaveClass("flex-wrap", "min-w-0", "break-all");
    expect(screen.getByRole("button", { name: "적용" }).parentElement).toHaveClass("flex-wrap", "min-w-0");
    expect(screen.queryByRole("button", { name: "초기화" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });
});
