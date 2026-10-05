import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as UI from "../index";

afterEach(cleanup);
describe("DatePicker draft bridge", () => {
  function Example({ change, impossible = false }: { change: (value: string | null) => void; impossible?: boolean }) {
    const controller = UI.useDateDraft("user/site/field", null);
    const [open, setOpen] = useState(false);
    return <>
      <button onClick={() => controller.onDraftChange(impossible ? { year: 2026, month: 2, day: 30 } : { year: 2055, month: null, day: 15 })}>초안</button>
      <button onClick={() => setOpen(value => !value)}>전환</button>
      <output aria-label="원문">{JSON.stringify(controller.draft)}</output>
      {open && <UI.DatePicker label="조회 날짜" value={null} draftController={controller} onChange={change} isInvalid errorMessage="입력 확인" />}
    </>;
  }
  it("restoring a draft emits no domain change and preserves null placeholders across close and reopen", async () => {
    expect(UI.useDateDraft).toBeTypeOf("function");
    const change = vi.fn(); render(<Example change={change} />);
    fireEvent.click(screen.getByRole("button", { name: "초안" })); fireEvent.click(screen.getByRole("button", { name: "전환" }));
    await waitFor(() => expect(screen.getAllByRole("spinbutton")[0]).toHaveAttribute("aria-valuenow", "2055"));
    expect(screen.getAllByRole("spinbutton")[1]).not.toHaveAttribute("aria-valuenow");
    expect(screen.getAllByRole("spinbutton")[2]).toHaveAttribute("aria-valuenow", "15");
    fireEvent.click(screen.getByRole("button", { name: "전환" })); fireEvent.click(screen.getByRole("button", { name: "전환" }));
    expect(screen.getAllByRole("spinbutton")[0]).toHaveAttribute("aria-valuenow", "2055");
    expect(screen.getByRole("alert")).toHaveTextContent("입력 확인");
    expect(change).not.toHaveBeenCalled();
    expect(screen.getByRole("status", { name: "원문" })).toHaveTextContent('{"year":2055,"month":null,"day":15}');
  });
  it("invalid February 30 survives blur and reopening without a normalized callback", async () => {
    expect(UI.useDateDraft).toBeTypeOf("function");
    const change = vi.fn(); render(<Example change={change} impossible />);
    fireEvent.click(screen.getByRole("button", { name: "초안" })); fireEvent.click(screen.getByRole("button", { name: "전환" }));
    const day = screen.getAllByRole("spinbutton")[2];
    await waitFor(() => expect(day).toHaveAttribute("aria-valuenow", "30"));
    act(() => { day.focus(); screen.getByRole("button", { name: "초안" }).focus(); });
    await waitFor(() => expect(day).toHaveAttribute("aria-valuenow", "30"));
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "전환" })); fireEvent.click(screen.getByRole("button", { name: "전환" }));
    expect(screen.getAllByRole("spinbutton")[2]).toHaveAttribute("aria-valuenow", "30");
  });
  it.each([
    { flag: "isDisabled" as const, raw: { year: 2055, month: null, day: 15 } },
    { flag: "isReadOnly" as const, raw: { year: 2055, month: null, day: 15 } },
    { flag: "isDisabled" as const, raw: { year: 2026, month: 2, day: 30 } },
    { flag: "isReadOnly" as const, raw: { year: 2026, month: 2, day: 30 } }
  ])("keeps cold $flag raw $raw visible through reopen and later editability", ({ flag, raw }) => {
    const change = vi.fn();
    function Prohibited({ blocked }: { blocked: boolean }) {
      const controller = UI.useDateDraft("site", null);
      const [open, setOpen] = useState(false);
      return <><button onClick={() => controller.onDraftChange(raw)}>초안</button>
        <button onClick={() => setOpen(value => !value)}>전환</button>
        <output aria-label="원문">{JSON.stringify(controller.draft)}</output>
        {open && <UI.DatePicker label="날짜" value={null} draftController={controller} onChange={change}
          {...{ [flag]: blocked }} isInvalid errorMessage="입력 확인" />}</>;
    }
    const view = render(<Prohibited blocked />);
    fireEvent.click(screen.getByRole("button", { name: "초안" }));
    const expectPreserved = () => {
      const parts = ["year", "month", "day"] as const;
      parts.forEach(part => {
        const segment = view.container.querySelector(`[data-type="${part}"]`)!;
        expect(segment).toBeVisible();
        const label = { year: "연도", month: "월", day: "일" }[part];
        expect(segment).toHaveTextContent(new RegExp(`^${raw[part] === null ? "월" : `${label} ${raw[part]}`}$`));
        if (raw[part] === null) expect(segment).toHaveAttribute("data-placeholder", "true");
        else expect(segment).not.toHaveAttribute("data-placeholder");
        expect(segment).toHaveAttribute(flag === "isDisabled" ? "data-disabled" : "data-readonly", "true");
        expect(segment.closest('[role="group"]')).toHaveAccessibleName(/날짜/);
        expect(segment.closest('[role="group"]')).toHaveAccessibleDescription(/입력 확인/);
        expect(segment.closest('[aria-hidden="true"]')).toBeNull();
        expect(segment).not.toHaveAttribute("contenteditable", "true");
        fireEvent.keyDown(segment, { key: "ArrowUp" });
        fireEvent.keyDown(segment, { key: "Backspace" });
      });
      expect(screen.getByRole("alert")).toHaveTextContent("입력 확인");
      expect(screen.getByRole("alert")).toHaveAttribute("id");
      expect(view.container.querySelector('[aria-describedby]')?.getAttribute("aria-describedby")).toContain(screen.getByRole("alert").id);
      expect(screen.getByRole("status", { name: "원문" })).toHaveTextContent(JSON.stringify(raw));
      expect(change).not.toHaveBeenCalled();
    };
    fireEvent.click(screen.getByRole("button", { name: "전환" }));
    expectPreserved();
    fireEvent.click(screen.getByRole("button", { name: "전환" }));
    fireEvent.click(screen.getByRole("button", { name: "전환" }));
    expectPreserved();
    view.rerender(<Prohibited blocked={false} />);
    expect(screen.getAllByRole("spinbutton").map(node => node.getAttribute("aria-valuenow"))).toEqual(
      [String(raw.year), raw.month === null ? null : String(raw.month), String(raw.day)]);
    expect(screen.getByRole("alert")).toHaveTextContent("입력 확인");
    expect(screen.getByRole("status", { name: "원문" })).toHaveTextContent(JSON.stringify(raw));
    expect(change).not.toHaveBeenCalled();
    view.rerender(<Prohibited blocked />);
    expectPreserved();
  });
  it("retains a real partial keyboard edit through canonical value clearing and remount", async () => {
    const change = vi.fn();
    function Editing() {
      const controller = UI.useDateDraft("site", "2026-02-28");
      const [open, setOpen] = useState(true);
      return <><button onClick={() => setOpen(value => !value)}>전환</button>
        <output aria-label="원문">{JSON.stringify(controller.draft)}</output>
        {open && <UI.DatePicker label="날짜" value="2026-02-28" draftController={controller} onChange={change} />}</>;
    }
    render(<Editing />);
    const month = screen.getAllByRole("spinbutton")[1];
    act(() => month.focus());
    fireEvent.keyDown(month, { key: "Backspace", code: "Backspace" });
    await waitFor(() => expect(screen.getByRole("status", { name: "원문" })).toHaveTextContent('{"year":2026,"month":null,"day":28}'));
    fireEvent.click(screen.getByRole("button", { name: "전환" })); fireEvent.click(screen.getByRole("button", { name: "전환" }));
    expect(screen.getAllByRole("spinbutton").map(node => node.getAttribute("aria-valuenow"))).toEqual(["2026", null, "28"]);
    expect(change).not.toHaveBeenCalled();
  });
  it("emits a complete real edit exactly once and updates the parent raw draft", () => {
    const change = vi.fn();
    function Editing() {
      const controller = UI.useDateDraft("site", "2026-02-27");
      return <><output aria-label="원문">{JSON.stringify(controller.draft)}</output>
        <UI.DatePicker label="날짜" value="2026-02-27" draftController={controller} onChange={change} /></>;
    }
    render(<Editing />);
    fireEvent.keyDown(screen.getAllByRole("spinbutton")[2], { key: "ArrowUp" });
    expect(change.mock.calls).toEqual([["2026-02-28"]]);
    expect(screen.getByRole("status", { name: "원문" })).toHaveTextContent('{"year":2026,"month":2,"day":28}');
  });
  it("calendar selection updates the controller and domain exactly once", async () => {
    const change = vi.fn();
    function Editing() {
      const controller = UI.useDateDraft("site", "2024-02-28");
      return <><output aria-label="원문">{JSON.stringify(controller.draft)}</output>
        <UI.DatePicker label="날짜" value={null} draftController={controller} onChange={change} /></>;
    }
    render(<Editing />);
    fireEvent.click(screen.getByRole("button", { name: /달력/ }));
    fireEvent.click(await screen.findByRole("button", { name: /2024년 2월 29일/ }));
    expect(change.mock.calls).toEqual([["2024-02-29"]]);
    expect(screen.getByRole("status", { name: "원문" })).toHaveTextContent('{"year":2024,"month":2,"day":29}');
  });
  it("clearing every raw segment emits null once rather than retaining the committed query value", () => {
    const change = vi.fn();
    function Editing() {
      const controller = UI.useDateDraft("site", "0001-01-01");
      return <UI.DatePicker label="날짜" value="0001-01-01" draftController={controller} onChange={change} />;
    }
    render(<Editing />);
    for (const segment of screen.getAllByRole("spinbutton")) {
      act(() => segment.focus());
      fireEvent.keyDown(segment, { key: "Backspace", code: "Backspace" });
    }
    expect(change.mock.calls).toEqual([[null]]);
  });
});
