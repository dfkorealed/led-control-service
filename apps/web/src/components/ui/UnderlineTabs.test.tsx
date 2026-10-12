import { useId, useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UnderlineTabs, UnderlineTabPanel } from "./UnderlineTabs";

const items = [{ value: "first", label: "첫째" }, { value: "second", label: "둘째" }, { value: "third", label: "셋째" }] as const;
function Harness({ label }: { label: string }) {
  const id = useId();
  const [value, setValue] = useState<string>("first");
  return <><UnderlineTabs id={id} label={label} items={items} value={value} onChange={setValue} />
    {items.map(item => <UnderlineTabPanel key={item.value} tabsId={id} value={item.value} activeValue={value}>{item.label} 내용</UnderlineTabPanel>)}</>;
}
afterEach(cleanup);
describe("UnderlineTabs", () => {
  it("wraps arrows, Home and End with automatic selection and one tab stop", () => {
    render(<Harness label="탭" />);
    const [first, second, third] = screen.getAllByRole("tab");
    expect(first).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(third).toHaveFocus();
    expect(third).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(third, { key: "ArrowRight" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "End" });
    expect(third).toHaveFocus();
    fireEvent.keyDown(third, { key: "Home" });
    expect(first).toHaveFocus();
    fireEvent.click(second);
    expect(second).toHaveClass("border-action-primary");
    expect(first).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", second.id);
    expect(screen.getByRole("tabpanel")).toHaveTextContent("둘째 내용");
  });

  it("keeps IDs and selection independent across instances with identical values", () => {
    render(<><Harness label="왼쪽" /><Harness label="오른쪽" /></>);
    const left = within(screen.getByRole("tablist", { name: "왼쪽" }));
    const right = within(screen.getByRole("tablist", { name: "오른쪽" }));
    fireEvent.keyDown(left.getByRole("tab", { name: "첫째" }), { key: "End" });
    expect(right.getByRole("tab", { name: "첫째" })).toHaveAttribute("aria-selected", "true");
    const tabs = screen.getAllByRole("tab");
    expect(new Set(tabs.map(tab => tab.id)).size).toBe(tabs.length);
    for (const tab of tabs) {
      expect(document.getElementById(tab.getAttribute("aria-controls")!)).toHaveAttribute("aria-labelledby", tab.id);
      expect(tab).toHaveClass("min-w-0", "basis-0", "px-1");
    }
  });
});
