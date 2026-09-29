import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceFocusProvider, useWorkspaceFocus } from "./WorkspaceFocusProvider";
afterEach(cleanup);
function Controls() {
  const focus = useWorkspaceFocus();
  return <><button onClick={event => focus.enter(event.currentTarget)}>enter</button><button onClick={focus.exit}>exit</button><span>{focus.active ? "full" : "normal"}</span></>;
}
it("restores connected trigger focus without scrolling and resets on scope change", () => {
  const { rerender } = render(<WorkspaceFocusProvider scope="a"><Controls /></WorkspaceFocusProvider>);
  const trigger = screen.getByText("enter");
  const focus = vi.spyOn(trigger, "focus");
  fireEvent.click(trigger);
  expect(screen.getByText("full")).toBeVisible();
  fireEvent.click(screen.getByText("exit"));
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  fireEvent.click(trigger);
  rerender(<WorkspaceFocusProvider scope="b"><Controls /></WorkspaceFocusProvider>);
  expect(screen.getByText("normal")).toBeVisible();
});
