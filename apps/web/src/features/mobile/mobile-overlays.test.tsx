import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalDialog } from "../../components/ui/ModalDialog";
import { DropdownMenu } from "../../components/ui/overlays/DropdownMenu";
import { DatePicker } from "../../components/ui/date/DatePicker";
import { SelectBox } from "../../components/ui/fields/SelectBox";
import { ComboBox } from "../../components/ui/fields/ComboBox";
import { DateRangePicker } from "../../components/ui/date/DateRangePicker";
import { handleMobileBack, registerMobileBackGuard } from "./mobile-back";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function DialogExample({ pending = false }: { pending?: boolean }) {
  const [open, setOpen] = useState(true);
  return open ? <ModalDialog title="변경 확인" isPending={pending} onClose={() => setOpen(false)}>본문</ModalDialog> : <p>닫힘</p>;
}
describe("back closes real common overlays", () => {
  it.each([
    ["select", <SelectBox label="층" items={[{ id: "one", label: "1층" }]} />],
    ["combobox", <ComboBox label="층 검색" items={[{ id: "one", label: "1층" }]} />],
    ["date", <DatePicker label="날짜" value="2026-10-04" onChange={() => {}} />],
    ["date range", <DateRangePicker label="기간" value={{ start: "2026-10-04", end: "2026-10-05" }} onChange={() => {}} />]
  ])("lets the page guard handle closed %s collections before and after dismissing the live popup", (name, element) => {
    let calls = 0;
    const unregister = registerMobileBackGuard(() => { calls++; return true; });
    try {
      render(element);
      act(() => { handleMobileBack(); });
      expect(calls).toBe(1);
      fireEvent.click(screen.getByRole("button"));
      const role = name === "date" || name === "date range" ? "dialog" : "listbox";
      expect(screen.getByRole(role)).toBeVisible();
      act(() => { handleMobileBack(); });
      expect(screen.queryByRole(role)).not.toBeInTheDocument();
      expect(calls).toBe(1);
      act(() => { handleMobileBack(); });
      expect(calls).toBe(2);
    } finally { cleanup(); unregister(); }
  });
  it("dismisses a dialog without navigating and preserves its pending lock", () => {
    render(<DialogExample />); act(() => { handleMobileBack(); });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); cleanup();
    render(<DialogExample pending />); expect(handleMobileBack().handled).toBe(true); expect(screen.getByRole("dialog")).toBeVisible();
  });
  it("closes an open dropdown rather than exiting the app", () => {
    render(<DropdownMenu label="메뉴" items={[{ id: "one", label: "항목" }]} onAction={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "메뉴" })); expect(screen.getByRole("menu")).toBeVisible();
    act(() => { handleMobileBack(); });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
  it("closes a calendar before moving router history", () => {
    render(<DatePicker label="날짜" value="2026-10-04" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button")); expect(screen.getByRole("dialog")).toBeVisible();
    act(() => { handleMobileBack(); });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("closes a selection list before moving router history", () => {
    render(<SelectBox label="층" items={[{ id: "one", label: "1층" }]} />);
    fireEvent.click(screen.getByRole("button")); expect(screen.getByRole("listbox")).toBeVisible();
    act(() => { handleMobileBack(); }); expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
