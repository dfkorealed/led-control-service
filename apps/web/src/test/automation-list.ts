import { fireEvent, screen } from "@testing-library/react";
import { vi } from "vitest";

/** jsdom has no layout. Supply the same measured container width that the
 * real DataGrid consumes without replacing its table/card rendering.
 */
export function measureAutomationContainer(width: number) {
  vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) { this.callback([{ target, contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
    unobserve() {}
    disconnect() {}
  });
}

export function chooseRowAction(name: string, action: "수정" | "삭제") {
  fireEvent.click(screen.getByRole("button", { name: `${name} 작업` }));
  fireEvent.click(screen.getByRole("menuitem", { name: action }));
}
