import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as UI from "../index";
afterEach(cleanup);

it("publishes the actual insertText day before auto-advance blur can constrain the previous impossible day", () => {
  const change = vi.fn();
  function Editing() {
    const controller = UI.useDateRangeDraft("range", null);
    const [open, setOpen] = useState(false);
    return <><button onClick={() => { controller.onDraftChange({ start: { year: 2026, month: 2, day: 31 }, end: { year: 2026, month: 9, day: 21 } }); setOpen(true); }}>편집</button>
      <output aria-label="원문">{JSON.stringify(controller.draft)}</output>
      {open && <UI.DateRangePicker label="기간" value={null} draftController={controller} onChange={change} validationBehavior="aria" />}</>;
  }
  render(<Editing />); fireEvent.click(screen.getByRole("button", { name: "편집" }));
  const day = screen.getAllByRole("spinbutton")[2]; act(() => day.focus());
  fireEvent(day, new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "20" }));
  expect(change.mock.calls).toEqual([[{ start: "2026-02-20", end: "2026-09-21" }]]);
  expect(screen.getByRole("status", { name: "원문" })).toHaveTextContent('{"start":{"year":2026,"month":2,"day":20},"end":{"year":2026,"month":9,"day":21}}');
  expect(screen.getAllByRole("spinbutton")[2]).toHaveAttribute("aria-valuenow", "20");
});

it.each(["pointer", "keyboard"])("keeps public %s calendar selection and both raw endpoints atomic", mode => {
  const change = vi.fn();
  function Editing() {
    const controller = UI.useDateRangeDraft("range", { start: "2026-09-01", end: "2026-09-02" });
    return <><output aria-label="원문">{JSON.stringify(controller.draft)}</output>
      <UI.DateRangePicker label="기간" value={null} draftController={controller} onChange={change} /></>;
  }
  render(<Editing />); fireEvent.click(screen.getByRole("button"));
  for (const name of [/2026년 9월 3일/, /2026년 9월 4일/]) {
    const cell = screen.getByRole("button", { name });
    if (mode === "pointer") fireEvent.click(cell);
    else { act(() => cell.focus()); fireEvent.keyDown(cell, { key: "Enter", code: "Enter" }); fireEvent.keyUp(cell, { key: "Enter", code: "Enter" }); }
  }
  expect(change.mock.calls).toEqual([[{ start: "2026-09-03", end: "2026-09-04" }]]);
  expect(screen.getByRole("status", { name: "원문" })).toHaveTextContent('{"start":{"year":2026,"month":9,"day":3},"end":{"year":2026,"month":9,"day":4}}');
});

it("does not interpret navigation or focus changes as endpoint edits", () => {
  const change = vi.fn();
  function Editing() {
    const controller = UI.useDateRangeDraft("range", { start: "2026-09-01", end: "2026-09-21" });
    return <><button>외부</button><output aria-label="원문">{JSON.stringify(controller.draft)}</output>
      <UI.DateRangePicker label="기간" value={null} draftController={controller} onChange={change} /></>;
  }
  render(<Editing />); const year = screen.getAllByRole("spinbutton")[0];
  act(() => year.focus()); fireEvent.keyDown(year, { key: "ArrowRight", code: "ArrowRight" });
  fireEvent.keyDown(document.activeElement!, { key: "Tab", code: "Tab" });
  act(() => screen.getByRole("button", { name: "외부" }).focus());
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByRole("status", { name: "원문" })).toHaveTextContent('{"start":{"year":2026,"month":9,"day":1},"end":{"year":2026,"month":9,"day":21}}');
});
it.each([
  { endpoint: "start" as const, name: "partial", raw: { year: 2026, month: null, day: 15 }, expected: ["2026", null, "15", "2026", "9", "1"] },
  { endpoint: "end" as const, name: "partial", raw: { year: 2026, month: null, day: 15 }, expected: ["2026", "9", "1", "2026", null, "15"] },
  { endpoint: "start" as const, name: "impossible", raw: { year: 2026, month: 2, day: 31 }, expected: ["2026", "2", "31", "2026", "9", "1"] },
  { endpoint: "end" as const, name: "impossible", raw: { year: 2026, month: 2, day: 31 }, expected: ["2026", "9", "1", "2026", "2", "31"] }
])("retains editable cold $endpoint $name raw range through blur and remount", async ({ endpoint, raw, expected }) => {
  const change = vi.fn();
  const draft = { start: { year: 2026, month: 9, day: 1 }, end: { year: 2026, month: 9, day: 1 }, [endpoint]: raw };
  function PublicRange() {
    const controller = UI.useDateRangeDraft("public-range", null);
    const [open, setOpen] = useState(false);
    return <><button onClick={() => controller.onDraftChange(draft)}>초기 raw</button>
      <button onClick={() => setOpen(current => !current)}>기간 표시</button>
      <output aria-label="공개 raw">{JSON.stringify(controller.draft)}</output>
      {open && <UI.DateRangePicker label="공개 기간" value={null} draftController={controller} onChange={change} validationBehavior="aria" />}</>;
  }
  render(<PublicRange />);
  fireEvent.click(screen.getByRole("button", { name: "초기 raw" }));
  fireEvent.click(screen.getByRole("button", { name: "기간 표시" }));
  await waitFor(() => expect(screen.getAllByRole("spinbutton").map(field => field.getAttribute("aria-valuenow"))).toEqual(expected));
  act(() => screen.getAllByRole("spinbutton")[endpoint === "start" ? 0 : 3].focus());
  act(() => screen.getByRole("button", { name: "기간 표시" }).focus());
  fireEvent.click(screen.getByRole("button", { name: "기간 표시" }));
  fireEvent.click(screen.getByRole("button", { name: "기간 표시" }));
  expect(screen.getByRole("status", { name: "공개 raw" })).toHaveTextContent(JSON.stringify(draft));
  expect(screen.getAllByRole("spinbutton").map(field => field.getAttribute("aria-valuenow"))).toEqual(expected);
  expect(change).not.toHaveBeenCalled();
});

it("retains the untouched endpoint after a valid range becomes partial and is blurred and remounted", () => {
  const change = vi.fn();
  function PublicRange() {
    const controller = UI.useDateRangeDraft("site", { start: "2026-09-01", end: "2026-09-21" });
    const [open, setOpen] = useState(true);
    return <><button onClick={() => setOpen(current => !current)}>기간 표시</button>
      <output aria-label="공개 raw">{JSON.stringify(controller.draft)}</output>
      {open && <UI.DateRangePicker label="공개 기간" value={null} draftController={controller} onChange={change} />}</>;
  }
  render(<PublicRange />);
  const month = screen.getAllByRole("spinbutton")[1];
  act(() => month.focus()); fireEvent.keyDown(month, { key: "Backspace", code: "Backspace" });
  act(() => screen.getAllByRole("spinbutton")[3].focus());
  act(() => screen.getByRole("button", { name: "기간 표시" }).focus());
  fireEvent.click(screen.getByRole("button", { name: "기간 표시" }));
  fireEvent.click(screen.getByRole("button", { name: "기간 표시" }));
  expect(screen.getByRole("status", { name: "공개 raw" })).toHaveTextContent('{"start":{"year":2026,"month":null,"day":1},"end":{"year":2026,"month":9,"day":21}}');
  expect(screen.getAllByRole("spinbutton").map(field => field.getAttribute("aria-valuenow"))).toEqual(["2026", null, "1", "2026", "9", "21"]);
  expect(change).not.toHaveBeenCalled();
});
it.each([
  { flag: "isDisabled" as const, endpoint: "start" as const, raw: { year: 2055, month: null, day: 15 } },
  { flag: "isReadOnly" as const, endpoint: "start" as const, raw: { year: 2055, month: null, day: 15 } },
  { flag: "isDisabled" as const, endpoint: "end" as const, raw: { year: 2055, month: null, day: 15 } },
  { flag: "isReadOnly" as const, endpoint: "end" as const, raw: { year: 2055, month: null, day: 15 } },
  { flag: "isDisabled" as const, endpoint: "start" as const, raw: { year: 2026, month: 2, day: 30 } },
  { flag: "isReadOnly" as const, endpoint: "start" as const, raw: { year: 2026, month: 2, day: 30 } },
  { flag: "isDisabled" as const, endpoint: "end" as const, raw: { year: 2026, month: 2, day: 30 } },
  { flag: "isReadOnly" as const, endpoint: "end" as const, raw: { year: 2026, month: 2, day: 30 } }
])("keeps cold $flag range $endpoint raw $raw visible through reopen and later editability", ({ flag, endpoint, raw }) => {
  const change = vi.fn();
  const draft = { start: { year: 2026, month: 3, day: 1 }, end: { year: 2026, month: 3, day: 1 }, [endpoint]: raw };
  function Prohibited({ blocked }: { blocked: boolean }) {
    const controller = UI.useDateRangeDraft("site", null);
    const [open, setOpen] = useState(false);
    return <><button onClick={() => controller.onDraftChange(draft)}>초안</button>
      <button onClick={() => setOpen(value => !value)}>전환</button>
      <output aria-label="원문">{JSON.stringify(controller.draft)}</output>
      {open && <UI.DateRangePicker label="기간" value={null} draftController={controller} onChange={change}
        {...{ [flag]: blocked }} isInvalid errorMessage="기간 확인" />}</>;
  }
  const view = render(<Prohibited blocked />);
  fireEvent.click(screen.getByRole("button", { name: "초안" }));
  const expectPreserved = () => {
    [draft.start, draft.end].forEach((expected, index) => {
      (["year", "month", "day"] as const).forEach(part => {
        const segment = view.container.querySelectorAll(`[data-type="${part}"]`)[index];
        expect(segment).toBeVisible();
        const label = { year: "연도", month: "월", day: "일" }[part];
        expect(segment).toHaveTextContent(new RegExp(`^${expected[part] === null ? "월" : `${label} ${expected[part]}`}$`));
        if (expected[part] === null) expect(segment).toHaveAttribute("data-placeholder", "true");
        else expect(segment).not.toHaveAttribute("data-placeholder");
        expect(segment).toHaveAttribute(flag === "isDisabled" ? "data-disabled" : "data-readonly", "true");
        expect(segment.closest('[role="group"]')).toHaveAccessibleName(/기간/);
        expect(segment.closest('[role="group"]')).toHaveAccessibleDescription(/기간 확인/);
        expect(segment.closest('[aria-hidden="true"]')).toBeNull();
        expect(segment).not.toHaveAttribute("contenteditable", "true");
        fireEvent.keyDown(segment, { key: "ArrowUp" });
        fireEvent.keyDown(segment, { key: "Backspace" });
      });
    });
    expect(screen.getByRole("alert")).toHaveTextContent("기간 확인");
    expect(view.container.querySelector('[aria-describedby]')?.getAttribute("aria-describedby")).toContain(screen.getByRole("alert").id);
    expect(screen.getByRole("status", { name: "원문" })).toHaveTextContent(JSON.stringify(draft));
    expect(change).not.toHaveBeenCalled();
  };
  fireEvent.click(screen.getByRole("button", { name: "전환" }));
  expectPreserved();
  fireEvent.click(screen.getByRole("button", { name: "전환" }));
  fireEvent.click(screen.getByRole("button", { name: "전환" }));
  expectPreserved();
  view.rerender(<Prohibited blocked={false} />);
  expect(screen.getAllByRole("spinbutton").map(node => node.getAttribute("aria-valuenow"))).toEqual(
    [draft.start.year, draft.start.month, draft.start.day, draft.end.year, draft.end.month, draft.end.day].map(value => value === null ? null : String(value)));
  expect(screen.getByRole("alert")).toHaveTextContent("기간 확인");
  expect(screen.getByRole("status", { name: "원문" })).toHaveTextContent(JSON.stringify(draft));
  expect(change).not.toHaveBeenCalled();
  view.rerender(<Prohibited blocked />);
  expectPreserved();
});
it("restores both range endpoints without overwriting partial input or emitting a query change", async () => {
  expect(UI.useDateRangeDraft).toBeTypeOf("function");
  const change = vi.fn();
  function Example() {
    const controller = UI.useDateRangeDraft("user/site/range", null); const [open, setOpen] = useState(false);
    return <><button onClick={() => controller.onDraftChange({ start: { year: 2055, month: null, day: 15 }, end: { year: 2026, month: 3, day: 1 } })}>초안</button>
      <button onClick={() => setOpen(value => !value)}>전환</button>
      {open && <UI.DateRangePicker label="기간" value={null} draftController={controller} onChange={change} isInvalid errorMessage="기간 확인" />}</>;
  }
  render(<Example />);
  fireEvent.click(screen.getByRole("button", { name: "초안" })); fireEvent.click(screen.getByRole("button", { name: "전환" }));
  await waitFor(() => expect(screen.getAllByRole("spinbutton")[5]).toHaveAttribute("aria-valuenow", "1"));
  expect(screen.getAllByRole("spinbutton").map(node => node.getAttribute("aria-valuenow"))).toEqual(["2055", null, "15", "2026", "3", "1"]);
  fireEvent.click(screen.getByRole("button", { name: "전환" })); fireEvent.click(screen.getByRole("button", { name: "전환" }));
  expect(screen.getAllByRole("spinbutton").map(node => node.getAttribute("aria-valuenow"))).toEqual(["2055", null, "15", "2026", "3", "1"]);
  expect(screen.getByRole("alert")).toHaveTextContent("기간 확인"); expect(change).not.toHaveBeenCalled();
});
it("retains a real incomplete start edit without clearing the other endpoint", async () => {
  const change = vi.fn();
  function Editing() {
    const controller = UI.useDateRangeDraft("site", { start: "2026-02-27", end: "2026-03-01" });
    return <><output aria-label="원문">{JSON.stringify(controller.draft)}</output>
      <UI.DateRangePicker label="기간" value={null} draftController={controller} onChange={change} /></>;
  }
  render(<Editing />);
  const month = screen.getAllByRole("spinbutton")[1];
  act(() => month.focus()); fireEvent.keyDown(month, { key: "Backspace", code: "Backspace" });
  await waitFor(() => expect(screen.getByRole("status", { name: "원문" })).toHaveTextContent('{"start":{"year":2026,"month":null,"day":27},"end":{"year":2026,"month":3,"day":1}}'));
  expect(screen.getAllByRole("spinbutton").map(node => node.getAttribute("aria-valuenow"))).toEqual(["2026", null, "27", "2026", "3", "1"]);
  expect(change).not.toHaveBeenCalled();
});
it("emits a reversed complete edit once without sorting endpoints", () => {
  const change = vi.fn();
  function Editing() {
    const controller = UI.useDateRangeDraft("site", { start: "2024-02-28", end: "2024-02-29" });
    return <><output aria-label="원문">{JSON.stringify(controller.draft)}</output>
      <UI.DateRangePicker label="기간" value={null} draftController={controller} onChange={change} validationBehavior="aria" /></>;
  }
  render(<Editing />);
  fireEvent.keyDown(screen.getAllByRole("spinbutton")[0], { key: "ArrowUp" });
  expect(change.mock.calls).toEqual([[{ start: "2025-02-28", end: "2024-02-29" }]]);
  expect(screen.getAllByRole("spinbutton")[0]).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByRole("status", { name: "원문" })).toHaveTextContent('{"start":{"year":2025,"month":2,"day":28},"end":{"year":2024,"month":2,"day":29}}');
});
it("clearing both raw endpoints emits null once", () => {
  const change = vi.fn();
  function Editing() {
    const controller = UI.useDateRangeDraft("site", { start: "0001-01-01", end: "0001-01-01" });
    return <UI.DateRangePicker label="기간" value={null} draftController={controller} onChange={change} />;
  }
  render(<Editing />);
  for (const segment of screen.getAllByRole("spinbutton")) {
    act(() => segment.focus());
    fireEvent.keyDown(segment, { key: "Backspace", code: "Backspace" });
  }
  expect(change.mock.calls).toEqual([[null]]);
});
