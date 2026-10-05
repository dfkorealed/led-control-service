import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as UI from "./index";

afterEach(cleanup);
function pageSizeTypeContract() {
  const valid = <UI.PageSizeSelect value={50} options={[50, 100] as const} onChange={(size: 50 | 100) => void size} />;
  // @ts-expect-error Selection cannot widen the options domain.
  const mismatch = <UI.PageSizeSelect value={500} options={[50, 100] as const} onChange={() => {}} />;
  // @ts-expect-error Narrow handlers cannot consume extended sizes.
  const handler = <UI.PageSizeSelect value={50} options={[50, 500] as const} onChange={(size: 50) => void size} />;
  // @ts-expect-error Unsupported sizes are not part of the public domain.
  const unsupported = <UI.PageSizeSelect value={25} options={[25] as const} onChange={() => {}} />;
  return [valid, mismatch, handler, unsupported];
}
void pageSizeTypeContract;
describe("PageSizeSelect", () => {
  it.each([500, 1000] as const)("emits numeric %s once through the shared control", async size => {
    expect(UI.PageSizeSelect).toBeTypeOf("function");
    const change = vi.fn();
    render(<UI.PageSizeSelect value={50} options={[50, 100, 500, 1000] as const} onChange={change} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "페이지당 항목 수" }), { key: "ArrowDown" });
    const option = await screen.findByRole("option", { name: `${size}개` });
    fireEvent.keyDown(option, { key: "Enter" }); fireEvent.keyUp(document.activeElement!, { key: "Enter" });
    expect(change).toHaveBeenCalledOnce(); expect(change).toHaveBeenCalledWith(size);
  });
  it.each([{ options: [] }, { options: [50, 50] }, { options: [25] }, { options: [100] }])("rejects malformed options $options without silently selecting a default", ({ options }) => {
    expect(UI.PageSizeSelect).toBeTypeOf("function");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // @ts-expect-error Malformed JavaScript input must fail at runtime too.
      expect(() => render(<UI.PageSizeSelect value={50} options={options} onChange={() => {}} />)).toThrow(RangeError);
    } finally { error.mockRestore(); }
  });
});
