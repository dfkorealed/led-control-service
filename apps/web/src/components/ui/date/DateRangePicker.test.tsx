import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as UI from "../index";
afterEach(cleanup);
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
