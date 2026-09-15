import { createRef, useState, type ReactElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import axe from "axe-core";
import * as UI from "../index";
import { axeViolations } from "../../../test/a11y";

afterEach(cleanup);
// JSDOM cannot measure pseudo elements. Keep the contrast rule enabled, but
// leave pseudo-element geometry to browser verification rather than fabricate it.
beforeAll(() => axe.configure({ checks: [{ id: "color-contrast", options: { ignorePseudo: true } }] }));
afterAll(() => axe.reset());

const names = ["FormField", "TextField", "SearchField", "PasswordField", "TextArea", "NumberField", "FileField", "SelectBox", "ComboBox", "Checkbox", "CheckboxGroup", "RadioGroup", "Switch", "Slider"] as const;
const items = [{ id: "one", label: "1층" }, { id: "blocked", label: "금지", isDisabled: true }, { id: "two", label: "2층" }];
const options = [{ value: "one", label: "1층" }, { value: "blocked", label: "금지", isDisabled: true }, { value: "two", label: "2층" }];
type Family = typeof names[number];
function field(name: Family, props: Record<string, unknown> = {}): ReactElement {
  expect(UI[name], `${name} public export`).toBeDefined();
  const common = { label: "대상", description: "도움말", ...props };
  switch (name) {
    case "FormField": return <UI.FormField {...common}>{(aria) => <input {...aria} />}</UI.FormField>;
    case "SelectBox": return <UI.SelectBox items={items} {...common} />;
    case "ComboBox": return <UI.ComboBox items={items} {...common} />;
    case "CheckboxGroup": return <UI.CheckboxGroup items={options} {...common} />;
    case "RadioGroup": return <UI.RadioGroup items={options} {...common} />;
    default: {
      const Component = UI[name];
      return <Component {...common} />;
    }
  }
}
function control(name: Family): HTMLElement {
  if (name === "ComboBox") return screen.getByRole("combobox", { name: "대상" });
  if (name === "SelectBox") return screen.getByRole("button", { name: /대상/ });
  if (name === "CheckboxGroup") return screen.getByRole("group", { name: "대상" });
  if (name === "RadioGroup") return screen.getByRole("radiogroup", { name: "대상" });
  if (name === "Slider") return screen.getByRole("slider", { name: "대상" });
  return screen.getByLabelText("대상");
}

describe.each(names)("%s family", (name) => {
  it("links its label and description and forwards its documented control/root ref", () => {
    const ref = createRef<HTMLElement>();
    render(field(name, { ref, className: "w-full" }));
    const target = control(name);
    expect(target).toHaveAccessibleName("대상");
    expect(target).toHaveAccessibleDescription("도움말");
    if (["FormField", "CheckboxGroup", "RadioGroup"].includes(name)) expect(ref.current).toContainElement(target);
    else expect(ref.current).toBe(target);
    expect(screen.getByText("도움말").closest("[data-field]" )).toHaveClass("w-full");
  });
  it.each(["sm", "md", "lg"])("supports %s and all closed visual variants", (size) => {
    const variants = ["FormField", "TextField", "SearchField", "PasswordField", "TextArea", "NumberField", "FileField"].includes(name) ? ["outline", "filled", "ghost"] : ["outline", "filled"];
    for (const variant of variants) {
      const { unmount } = render(field(name, { size, variant }));
      const root = screen.getByText("도움말").closest("[data-field]");
      expect(root).toHaveAttribute("data-size", size);
      expect(root).toHaveAttribute("data-variant", variant);
      const styledControl = ["Checkbox", "Switch"].includes(name) ? control(name).closest("label")
        : ["CheckboxGroup", "RadioGroup"].includes(name) ? control(name).querySelector("label")
        : name === "Slider" ? root?.querySelector(".rounded-control.border") : control(name);
      expect(styledControl).toHaveClass(variant === "filled" ? "bg-surface-inset" : variant === "ghost" ? "bg-transparent" : "bg-surface-panel");
      expect(styledControl).toHaveClass(size === "sm" ? "text-body-sm" : size === "lg" ? "text-body-lg" : "text-body");
      unmount();
    }
  });
  it("makes disabled controls unavailable", () => {
    render(field(name, { isDisabled: true }));
    const target = control(name);
    if (["CheckboxGroup", "RadioGroup"].includes(name)) {
      for (const input of within(target).getAllByRole(name === "CheckboxGroup" ? "checkbox" : "radio")) expect(input).toBeDisabled();
    } else expect(target).toBeDisabled();
  });
  it("links invalid errors to the correct control/group and announces them", () => {
    render(field(name, { isInvalid: true, errorMessage: "입력 확인" }));
    expect(control(name)).toHaveAccessibleDescription(expect.stringContaining("입력 확인"));
    // CheckboxGroup exposes invalidity on each checkbox; the shared description
    // remains on the group, rather than being repeated as an option label.
    // The Select trigger is a button, with a described error and visual state;
    // React Aria deliberately does not give the button input validation ARIA.
    const invalidTargets = name === "SelectBox" ? [] : name === "CheckboxGroup" ? within(control(name)).getAllByRole("checkbox") : [control(name)];
    if (name === "SelectBox") expect(control(name)).toHaveAttribute("data-invalid", "true");
    for (const target of invalidTargets) expect(target).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("입력 확인");
    expect(screen.getByText("도움말").closest("[data-field]")).toHaveAttribute("data-invalid", "true");
  });
  it("has no serious or critical axe violations", async () => {
    const { container } = render(field(name, { isInvalid: true, errorMessage: "입력 확인" }));
    expect(await axeViolations(container, ["serious", "critical"])).toEqual([]);
  });
});

describe("domain and keyboard contracts", () => {
  it("keeps public domain and variant types closed", () => {
    expectTypeOf<UI.TextFieldProps["value"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<UI.NumberFieldProps["value"]>().toEqualTypeOf<number | null | undefined>();
    expectTypeOf<Parameters<NonNullable<UI.FileFieldProps["onChange"]>>[0]>().toEqualTypeOf<FileList | null>();
    expectTypeOf<UI.SelectBoxProps<0 | 1>["selectedKey"]>().toEqualTypeOf<0 | 1 | null | undefined>();
    expectTypeOf<Parameters<NonNullable<UI.ComboBoxProps<"a" | "b">["onSelectionChange"]>>[0]>().toEqualTypeOf<"a" | "b" | null>();
    expectTypeOf<UI.CheckboxGroupProps["value"]>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<UI.RadioGroupProps["value"]>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<UI.SliderProps["value"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<NonNullable<UI.TextFieldProps["variant"]>>().toEqualTypeOf<"outline" | "filled" | "ghost">();
    expectTypeOf<NonNullable<UI.CheckboxProps["variant"]>>().toEqualTypeOf<"outline" | "filled">();
    expectTypeOf<NonNullable<UI.FieldVisualProps["size"]>>().toEqualTypeOf<"sm" | "md" | "lg">();
    // @ts-expect-error File selection cannot be controlled by a value prop.
    const file = <UI.FileField value="plan.png" />;
    // @ts-expect-error Numeric intermediate strings belong to TextField.
    const number = <UI.NumberField value="1." />;
    // @ts-expect-error Generic keys cannot silently widen to strings.
    const select = <UI.SelectBox<0 | 1> items={[]} selectedKey="0" />;
    void [file, number, select];
  });
  it("preserves external ARIA labels and combines caller and field descriptions", () => {
    render(<><span id="external-label">외부 이름</span><span id="external-help">외부 도움</span><UI.TextField aria-labelledby="external-label" aria-describedby="external-help" description="필드 도움" /></>);
    expect(screen.getByRole("textbox", { name: "외부 이름" })).toHaveAccessibleDescription("필드 도움 외부 도움");
  });
  it.each(["CheckboxGroup", "RadioGroup"] as const)("%s separates option names from option descriptions", (name) => {
    const Component = UI[name];
    render(<Component label="층" items={[{ value: "one", label: "1층", description: "입구" }]} />);
    expect(screen.getByRole(name === "CheckboxGroup" ? "checkbox" : "radio", { name: "1층" })).toHaveAccessibleDescription("입구");
    expect(screen.getByText("입구")).toHaveClass("text-content-primary");
  });
  it("lays out horizontal radio options horizontally", () => {
    render(<UI.RadioGroup label="층" orientation="horizontal" items={options} />);
    expect(screen.getByRole("radiogroup", { name: "층" })).toHaveClass("flex-row");
  });
  it.each(["Checkbox", "Switch"] as const)("%s honors readOnly and exposes selected state styling", (name) => {
    const onChange = vi.fn();
    render(field(name, { isReadOnly: true, isSelected: true, onChange }));
    fireEvent.click(control(name));
    expect(onChange).not.toHaveBeenCalled();
    expect(control(name)).toBeChecked();
    expect(control(name).closest("label")).toHaveAttribute("data-selected", "true");
    expect(control(name).closest("label")).toHaveClass("data-selected:bg-action-primary-soft", "data-focus-visible:shadow-focus");
  });
  it("TextArea emits an exact multiline string and forwards rows", () => {
    const onChange = vi.fn();
    render(<UI.TextArea label="메모" rows={4} onChange={onChange} />);
    fireEvent.change(screen.getByRole("textbox", { name: "메모" }), { target: { value: "첫째\n둘째" } });
    expect(onChange.mock.calls).toEqual([["첫째\n둘째"]]);
    expect(screen.getByRole("textbox", { name: "메모" })).toHaveAttribute("rows", "4");
  });
  it.each(["Checkbox", "Switch"] as const)("%s renders one visible label in its clickable surface", (name) => {
    render(field(name));
    expect(screen.getAllByText("대상")).toHaveLength(1);
    expect(control(name).closest("label")).toHaveTextContent("대상");
  });
  it("filters ComboBox options as the user edits the visible query", async () => {
    render(<UI.ComboBox label="검색" items={items} />);
    const input = screen.getByRole("combobox", { name: "검색" });
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "2" } });
    const list = await screen.findByRole("listbox");
    expect(within(list).getAllByRole("option")).toHaveLength(1);
    expect(within(list).getByRole("option", { name: "2층" })).toBeVisible();
  });
  it.each(["", "-", "1.", "99999"])("keeps intermediate numeric text %j as an exact string once", (value) => {
    const onChange = vi.fn();
    render(<UI.TextField label="요금" inputMode="decimal" defaultValue="8" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("요금"), { target: { value } });
    expect(onChange.mock.calls).toEqual([[value]]);
    expect(screen.getByLabelText("요금")).toHaveValue(value);
  });
  it("keeps controlled text authoritative and forwards native input constraints", async () => {
    const onChange = vi.fn();
    render(<UI.TextField label="메일" value="a@b.kr" onChange={onChange} type="email" name="email" placeholder="주소" autoComplete="email" minLength={3} maxLength={30} inputMode="email" autoFocus isRequired />);
    const input = screen.getByLabelText("메일");
    // React Aria defers autoFocus after a virtual click until transitions end.
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveAttribute("type", "email");
    expect(input).toHaveAttribute("autocomplete", "email");
    expect(input).toHaveAttribute("minlength", "3");
    expect(input).toHaveAttribute("maxlength", "30");
    expect(input).toHaveAttribute("name", "email");
    expect(input).toHaveAttribute("placeholder", "주소");
    expect(input).toBeRequired();
    fireEvent.change(input, { target: { value: "c@d.kr" } });
    expect(onChange.mock.calls).toEqual([["c@d.kr"]]);
    expect(input).toHaveValue("a@b.kr");
  });
  it.each(["TextField", "SearchField", "PasswordField", "TextArea"] as const)("%s forwards readOnly and its native element type", (name) => {
    render(field(name, { isReadOnly: true, defaultValue: "초기" }));
    const input = control(name);
    expect(input).toHaveAttribute("readonly");
    expect(input).toHaveValue("초기");
    if (name === "TextArea") expect(input.tagName).toBe("TEXTAREA");
    if (name === "SearchField") expect(input).toHaveAttribute("type", "search");
    if (name === "PasswordField") expect(input).toHaveAttribute("type", "password");
  });
  it("emits committed number or null once, with limits and keyboard steps", () => {
    const onChange = vi.fn();
    function Example() {
      const [value, setValue] = useState<number | null>(2);
      return <UI.NumberField label="수량" value={value} minValue={0} maxValue={4} step={2} onChange={(next) => { setValue(next); onChange(next); }} />;
    }
    render(<Example />);
    const input = screen.getByRole("textbox", { name: "수량" });
    expect(input).toHaveAttribute("aria-roledescription", "Number field");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(onChange.mock.calls).toEqual([[4]]);
    onChange.mockClear();
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onChange.mock.calls).toEqual([[null]]);
  });
  it("forwards the browser FileList by identity and allows reset/reselection", () => {
    const ref = createRef<HTMLInputElement>();
    const onChange = vi.fn();
    render(<form><UI.FileField ref={ref} label="도면" accept="image/*" multiple isRequired onChange={onChange} /><button type="reset">초기화</button></form>);
    const input = screen.getByLabelText("도면");
    const files = { 0: new File(["plan"], "plan.png", { type: "image/png" }), length: 1, item: () => null } as unknown as FileList;
    fireEvent.change(input, { target: { files } });
    expect(onChange.mock.calls).toEqual([[files]]);
    expect(onChange.mock.calls[0][0]).toBe(files);
    expect(ref.current).toBe(input);
    expect(input).toHaveAttribute("accept", "image/*");
    expect(input).toHaveAttribute("multiple");
    expect(input).toBeRequired();
    fireEvent.click(screen.getByRole("button", { name: "초기화" }));
    expect(input).toHaveValue("");
    fireEvent.change(input, { target: { files } });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1][0]).toBe(files);
    fireEvent.change(input, { target: { files: null } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
  it.each(["SelectBox", "ComboBox"] as const)("%s preserves numeric keys and excludes disabled options using keyboard", async (name) => {
    const onSelectionChange = vi.fn();
    render(field(name, { items: [{ id: 1, label: "1층" }, { id: 2, label: "금지", isDisabled: true }, { id: 3, label: "3층" }], defaultSelectedKey: 1, onSelectionChange }));
    const input = control(name);
    act(() => input.focus());
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const list = await screen.findByRole("listbox");
    expect(within(list).getByRole("option", { name: "금지" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    fireEvent.keyUp(document.activeElement!, { key: "Enter" });
    expect(onSelectionChange.mock.calls).toEqual([[3]]);
    await waitFor(() => expect(input).toHaveFocus());
  });
  it("keeps ComboBox query separate from selected keys", () => {
    const onInputChange = vi.fn();
    const onSelectionChange = vi.fn();
    render(<UI.ComboBox label="검색" items={items} inputValue="1" onInputChange={onInputChange} selectedKey={null} onSelectionChange={onSelectionChange} />);
    const input = screen.getByRole("combobox", { name: "검색" });
    fireEvent.change(input, { target: { value: "2" } });
    expect(onInputChange.mock.calls).toEqual([["2"]]);
    expect(input).toHaveValue("1");
    expect(onSelectionChange).not.toHaveBeenCalled();
  });
  it.each(["Checkbox", "Switch"] as const)("%s emits boolean once and preserves controlled selection", (name) => {
    const onChange = vi.fn();
    render(field(name, { isSelected: false, onChange }));
    fireEvent.click(control(name));
    expect(onChange.mock.calls).toEqual([[true]]);
    expect(control(name)).not.toBeChecked();
  });
  it("CheckboxGroup emits the exact string array once and labels the group", () => {
    const onChange = vi.fn();
    render(<UI.CheckboxGroup label="층" items={options} defaultValue={["one"]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "2층" }));
    expect(onChange.mock.calls).toEqual([[["one", "two"]]]);
    expect(screen.getByRole("checkbox", { name: "금지" })).toBeDisabled();
  });
  it("RadioGroup supports arrows, skipping disabled options and emitting the exact string once", () => {
    const onChange = vi.fn();
    render(<UI.RadioGroup label="층" items={options} defaultValue="one" onChange={onChange} />);
    const first = screen.getByRole("radio", { name: "1층" });
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(onChange.mock.calls).toEqual([["two"]]);
    expect(screen.getByRole("radio", { name: "2층" })).toBeChecked();
  });
  it("Slider emits a number once on arrow and respects limits and step", () => {
    const onChange = vi.fn();
    render(<UI.Slider label="밝기" defaultValue={90} minValue={0} maxValue={100} step={10} onChange={onChange} />);
    const slider = screen.getByRole("slider", { name: "밝기" });
    act(() => slider.focus());
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onChange.mock.calls).toEqual([[100]]);
    onChange.mockClear();
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onChange).not.toHaveBeenCalled();
    expect(slider).toHaveValue("100");
  });
});
