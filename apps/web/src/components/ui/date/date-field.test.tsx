import { StrictMode, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DatePicker, useDateDraft } from "../index";

afterEach(cleanup);
it("the public segment bridge survives StrictMode, resize rerenders and explicit reset without a domain change", () => {
  const change = vi.fn();
  function Example() {
    const draft = useDateDraft("site", null);
    const [compact, setCompact] = useState(false);
    return <><button onClick={() => draft.onDraftChange({ year: 2055, month: null, day: 15 })}>초안</button>
      <button onClick={() => setCompact(value => !value)}>폭 전환</button>
      <button onClick={() => draft.reset("2024-02-29")}>URL 복원</button>
      <DatePicker label="날짜" value={null} draftController={draft} onChange={change} className={compact ? "w-48" : "w-full"} />
      <button>외부</button></>;
  }
  render(<StrictMode><Example /></StrictMode>);
  fireEvent.click(screen.getByRole("button", { name: "초안" }));
  act(() => screen.getAllByRole("spinbutton")[0].focus());
  act(() => window.dispatchEvent(new Event("resize")));
  fireEvent.click(screen.getByRole("button", { name: "폭 전환" }));
  expect(screen.getAllByRole("spinbutton").map(node => node.getAttribute("aria-valuenow"))).toEqual(["2055", null, "15"]);
  fireEvent.click(screen.getByRole("button", { name: "URL 복원" }));
  expect(screen.getAllByRole("spinbutton").map(node => node.getAttribute("aria-valuenow"))).toEqual(["2024", "2", "29"]);
  expect(change).not.toHaveBeenCalled();
});
