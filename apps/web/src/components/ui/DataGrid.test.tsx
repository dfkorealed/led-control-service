import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as UI from "./index";

let resize: ResizeObserverCallback;
let observed: Element;
const disconnect = vi.fn();
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe(target: Element) { observed = target; }
    unobserve() {}
    disconnect = disconnect;
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
function measure(width: number) {
  act(() => resize([{ target: observed, contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver));
}
const columns = [
  { id: "name", header: "이름", minWidth: 200, renderCell: (row: { id: string; name: string }) => row.name },
  { id: "amount", header: "수량", minWidth: 100, align: "right" as const, renderCell: () => "1000" },
  { id: "action", header: "작업", minWidth: 100, align: "center" as const, renderCell: () => <button>상세</button> }
];
describe("DataGrid", () => {
  it("container width selects cards independently of viewport and retains every column", () => {
    expect(UI.DataGrid).toBeTypeOf("function");
    render(<UI.DataGrid caption="조명 목록" rows={[{ id: "A", name: "긴 조명 이름" }]} columns={columns} getRowKey={row => row.id} className="consumer-grid" />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    measure(0); measure(399);
    const cards = screen.getByRole("list", { name: "조명 목록" });
    expect(within(cards).getAllByRole("term").map(node => node.textContent)).toEqual(["이름", "수량", "작업"]);
    expect(within(cards).getByRole("button", { name: "상세" })).toBeInTheDocument();
    measure(400);
    const table = screen.getByRole("table", { name: "조명 목록" });
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(within(table).getAllByRole("columnheader").every(node => node.classList.contains("text-center"))).toBe(true);
    expect(within(table).getByText("1000")).toHaveClass("text-right");
    expect(table).not.toHaveClass("min-w-5xl");
    measure(399);
    expect(screen.getByRole("list", { name: "조명 목록" })).toHaveTextContent("긴 조명 이름");
  });
  it("uses the render surface and preserves busy empty presentation and observer cleanup", () => {
    expect(UI.DataGrid).toBeTypeOf("function");
    const { rerender, unmount } = render(<UI.DataGrid caption="목록" rows={[0]} columns={[{ id: "surface", header: "상태", minWidth: 100, renderCell: (_, surface) => surface }]} getRowKey={row => row} />);
    expect(screen.getByText("card")).toBeInTheDocument();
    measure(100);
    expect(screen.getByText("table")).toBeInTheDocument();
    rerender(<UI.DataGrid caption="목록" rows={[]} columns={columns} getRowKey={() => "none"} isBusy emptyState={<span>확인 중</span>} />);
    expect(screen.getByText("확인 중")).toBeInTheDocument();
    expect(screen.getByText("확인 중").closest("[aria-busy]")).toHaveAttribute("aria-busy", "true");
    unmount(); expect(disconnect).toHaveBeenCalledOnce();
  });
});
