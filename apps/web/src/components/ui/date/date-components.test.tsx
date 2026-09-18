import { createRef, useState, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import * as UI from "../index";
import { axeViolations } from "../../../test/a11y";

afterEach(cleanup);

describe("timezone-free public boundaries", () => {
  it.each(["0001-01-01", "9999-12-31", "2024-02-29", "2026-01-31", "2026-03-01", "2026-12-31"])("round trips %s without a timezone shift", (value) => {
    expect(UI.parseIsoDate).toBeTypeOf("function");
    expect(UI.formatIsoDate(UI.parseIsoDate(value))).toBe(value);
  });
  it.each(["00:00", "23:59", "09:05"])("round trips local time %s", (value) => {
    expect(UI.parseLocalTime).toBeTypeOf("function");
    expect(UI.formatLocalTime(UI.parseLocalTime(value))).toBe(value);
  });
  it.each(["", "0000-01-01", "0000-02-29", "2026-2-01", "2026-02-29", "2026-04-31", "2026-01-01T00:00:00Z"])("rejects malformed date %s", (value) => {
    expect(UI.parseIsoDate).toBeTypeOf("function");
    expect(() => UI.parseIsoDate(value)).toThrow(RangeError);
  });
  it.each(["", "1:00", "24:00", "12:60", "12:00:30", "12:00Z"])("rejects malformed time %s", (value) => {
    expect(UI.parseLocalTime).toBeTypeOf("function");
    expect(() => UI.parseLocalTime(value)).toThrow(RangeError);
  });
});

const families = ["DatePicker", "DateRangePicker", "TimePicker"] as const;
type Family = typeof families[number];
function field(name: Family, props: Record<string, unknown> = {}) {
  expect(UI[name], `${name} public export`).toBeDefined();
  const Component = UI[name];
  return <Component label="대상" value={null} onChange={() => {}} {...props} />;
}
describe.each(families)("%s", (name) => {
  it("rejects contradictory bounds without clamping the caller value", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => render(field(name, { minValue: name === "TimePicker" ? "23:59" : "2026-03-01", maxValue: name === "TimePicker" ? "00:00" : "2026-02-28" }))).toThrow(RangeError);
    } finally { consoleError.mockRestore(); }
  });
  it("has no serious or critical accessibility violations", async () => {
    const { container } = render(field(name, { isInvalid: true, errorMessage: "입력 확인", description: "설명" }));
    expect(await axeViolations(container, ["serious", "critical"])).toEqual([]);
  });
  it("focuses the first editable segment for null and retains a stable element on updates", () => {
    const ref = createRef<UI.FocusableFieldHandle>();
    const { rerender } = render(field(name, { ref, id: "date-control", description: "설명", "aria-describedby": "outside" }));
    const element = ref.current?.element;
    expect(element).toBeInstanceOf(HTMLElement);
    expect(element).toHaveAttribute("id", "date-control");
    act(() => ref.current?.focus());
    expect(screen.getAllByRole("spinbutton")[0]).toHaveFocus();
    expect(screen.getAllByRole("spinbutton")[0]).toHaveAccessibleDescription(expect.stringContaining("설명"));
    rerender(field(name, { ref, id: "date-control", value: name === "TimePicker" ? "23:59" : name === "DateRangePicker" ? { start: "2024-02-29", end: "2024-03-01" } : "2024-02-29" }));
    expect(ref.current?.element).toBe(element);
    act(() => ref.current?.focus());
    expect(screen.getAllByRole("spinbutton")[0]).toHaveFocus();
  });
  it.each(["isDisabled", "isReadOnly"])("does not focus or change non-editable %s segments", (state) => {
    const ref = createRef<UI.FocusableFieldHandle>();
    const onChange = vi.fn();
    render(field(name, { ref, [state]: true, onChange }));
    act(() => ref.current?.focus());
    expect(ref.current?.element).toBeInstanceOf(HTMLElement);
    expect(document.activeElement).toBe(document.body);
    for (const segment of screen.queryAllByRole("spinbutton")) fireEvent.keyDown(segment, { key: "ArrowUp" });
    expect(onChange).not.toHaveBeenCalled();
  });
  it("connects caller ARIA, invalid help, error and stable IDs without native prop leakage", () => {
    render(<><p id="external">외부 도움</p>{field(name, { id: "date-control", "aria-describedby": "external", "aria-controls": "external", description: "설명", errorMessage: "오류", isInvalid: true, isRequired: true })}</>);
    const element = document.getElementById("date-control");
    expect(element).toHaveAttribute("aria-controls", "external");
    expect(element).not.toHaveAttribute("required");
    expect(element).not.toHaveAttribute("disabled");
    expect(screen.getAllByRole("spinbutton")[0]).toHaveAttribute("aria-invalid", "true");
    expect(screen.getAllByRole("spinbutton")[0]).toHaveAccessibleDescription(expect.stringContaining("외부 도움"));
    expect(screen.getAllByRole("spinbutton")[0]).toHaveAccessibleDescription(expect.stringContaining("오류"));
    expect(screen.getByRole("alert")).toHaveTextContent("오류");
  });
  it.each(["sm", "md", "lg"])("places %s sizing and variants on the styled control", (size) => {
    for (const variant of ["outline", "filled", "ghost"]) {
      const ref = createRef<UI.FocusableFieldHandle>();
      const { unmount } = render(field(name, { ref, size, variant, className: "gap-4" }));
      expect(ref.current?.element).toHaveClass(size === "sm" ? "text-body-sm" : size === "lg" ? "text-body-lg" : "text-body");
      expect(ref.current?.element).toHaveClass(variant === "filled" ? "bg-surface-inset" : variant === "ghost" ? "bg-transparent" : "bg-surface-panel");
      expect(ref.current?.element?.closest("[data-field]")).toHaveClass("gap-4");
      unmount();
    }
  });
});

it("renders Korean time segments in 24 hour format and emits one local-time update", () => {
  expect(UI.TimePicker).toBeDefined();
  const change = vi.fn();
  function Example() {
    const [value, setValue] = useState<string | null>("23:58");
    return <UI.TimePicker label="시작 시각" value={value} onChange={(next) => { change(next); setValue(next); }} />;
  }
  render(<Example />);
  const segments = screen.getAllByRole("spinbutton");
  expect(segments).toHaveLength(2);
  expect(segments[0]).toHaveAccessibleName(expect.stringContaining("시"));
  expect(segments[0]).toHaveTextContent("23");
  fireEvent.keyDown(segments[1], { key: "ArrowUp" });
  expect(change.mock.calls).toEqual([["23:59"]]);
});

it("renders a Korean calendar and emits the selected date once", () => {
  expect(UI.Calendar).toBeDefined();
  const change = vi.fn();
  render(<UI.Calendar label="선택 날짜" value="2024-02-29" minValue="2024-02-28" maxValue="2024-03-01" onChange={change} />);
  expect(screen.getByRole("heading")).toHaveTextContent("2024년 2월");
  expect(screen.getByRole("button", { name: /이전/ })).toBeInTheDocument();
  const grid = screen.getByRole("grid");
  const selected = within(grid).getByRole("button", { name: /2024년 2월 28일/ });
  fireEvent.click(selected);
  expect(change.mock.calls).toEqual([["2024-02-28"]]);
});

it("keeps the date range API as strings and closes visual choices", () => {
  expectTypeOf<ComponentProps<typeof UI.DateRangePicker>["value"]>().toEqualTypeOf<UI.DateRangeValue | null>();
  expectTypeOf<ComponentProps<typeof UI.DatePicker>["variant"]>().toEqualTypeOf<"outline" | "filled" | "ghost" | undefined>();
  expectTypeOf<ComponentProps<typeof UI.Calendar>["variant"]>().toEqualTypeOf<"outline" | "filled" | undefined>();
});

it("preserves a reversed range as invalid while editing rather than sorting or crashing", () => {
  const change = vi.fn();
  function Example() {
    const [value, setValue] = useState<UI.DateRangeValue | null>({ start: "2024-02-28", end: "2024-02-29" });
    return <UI.DateRangePicker label="기간" value={value} validationBehavior="aria" onChange={(next) => { change(next); setValue(next); }} />;
  }
  render(<Example />);
  fireEvent.keyDown(screen.getAllByRole("spinbutton")[0], { key: "ArrowUp" });
  expect(change.mock.calls).toEqual([[{ start: "2025-02-28", end: "2024-02-29" }]]);
  expect(screen.getAllByRole("spinbutton")[0]).toHaveAttribute("aria-invalid", "true");
  expect(screen.getAllByRole("spinbutton")[0]).toHaveTextContent("2025");
  expect(screen.getAllByRole("spinbutton")[3]).toHaveTextContent("2024");
});

it("retains out-of-bounds local times and exposes their validation state", () => {
  const change = vi.fn();
  render(<UI.TimePicker id="bounded-time" label="시간" value="23:59" maxValue="17:00" validationBehavior="aria" onChange={change} />);
  expect(document.getElementById("bounded-time")).toHaveAttribute("data-invalid", "true");
  expect(screen.getAllByRole("spinbutton")[0]).toHaveAttribute("aria-invalid", "true");
  expect(screen.getAllByRole("spinbutton")[0]).toHaveTextContent("23");
  expect(change).not.toHaveBeenCalled();
});

it("forwards the standalone calendar root with Korean label, help and invalid error", () => {
  const ref = createRef<HTMLDivElement>();
  render(<UI.Calendar id="standalone" ref={ref} label="날짜" description="도움" errorMessage="오류" isInvalid value="2024-02-29" onChange={() => {}} />);
  expect(ref.current).toHaveAttribute("id", "standalone");
  expect(ref.current).toHaveAccessibleName("2024년 2월 날짜");
  expect(ref.current).toHaveAccessibleDescription("도움 오류");
});

it("preserves a controlled out-of-bounds date while marking it invalid", () => {
  const change = vi.fn();
  render(<UI.DatePicker label="날짜" value="2024-02-29" minValue="2024-03-01" validationBehavior="aria" onChange={change} />);
  expect(screen.getByRole("spinbutton", { name: /일,/ })).toHaveTextContent("29");
  expect(screen.getAllByRole("spinbutton")[0]).toHaveAttribute("aria-invalid", "true");
  expect(change).not.toHaveBeenCalled();
});

it("clears a date to null exactly once and preserves the first editable ref", () => {
  const change = vi.fn();
  const ref = createRef<UI.FocusableFieldHandle>();
  function Example() {
    const [value, setValue] = useState<string | null>("0001-01-01");
    return <UI.DatePicker label="날짜" value={value} ref={ref} onChange={(next) => { change(next); setValue(next); }} />;
  }
  render(<Example />);
  act(() => ref.current?.focus());
  // React Aria retains partial edits; the public value becomes null only when
  // every editable segment is cleared, not when the year alone is incomplete.
  for (const segment of screen.getAllByRole("spinbutton")) {
    act(() => segment.focus());
    fireEvent.keyDown(segment, { key: "Backspace", code: "Backspace" });
  }
  expect(change.mock.calls).toEqual([[null]]);
  act(() => ref.current?.focus());
  expect(screen.getAllByRole("spinbutton")[0]).toHaveFocus();
});

it("does not advertise unsupported calendar native validation options", () => {
  // @ts-expect-error Calendar is a selection surface, not a native validated form field.
  const required = <UI.Calendar label="날짜" value={null} onChange={() => {}} isRequired />;
  // @ts-expect-error Calendar has no native validation mode.
  const validation = <UI.Calendar label="날짜" value={null} onChange={() => {}} validationBehavior="native" />;
  expect(required).toBeDefined();
  expect(validation).toBeDefined();
});
