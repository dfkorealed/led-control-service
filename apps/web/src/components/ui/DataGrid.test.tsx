import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as UI from "./index";

let resize: ResizeObserverCallback;
let observed: Element;
const disconnect = vi.fn();
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { if (target.tagName === "SECTION") { observed = target; resize = this.callback; } }
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
  it("keeps table sort headers rectangular without changing ordinary or card buttons", () => {
    render(<><UI.Button>일반 버튼</UI.Button><UI.DataGrid caption="조작 영역" rows={[{ id: "one", value: 1 }]} columns={[
      { id: "value", header: "값", minWidth: 100, sortValue: row => row.value, renderCell: row => row.id }
    ]} getRowKey={row => row.id} /></>);
    expect(screen.getByRole("button", { name: "오름차순으로 변경" })).toHaveClass("rounded-control");
    measure(100);
    // JSDOM checks the emitted geometry declaration; native continuous44 is a browser contract.
    expect(screen.getByRole("button", { name: "값 오름차순 정렬" })).toHaveClass("rounded-none", "min-w-11", "max-w-full", "px-0");
    expect(screen.getByRole("button", { name: "일반 버튼" })).toHaveClass("rounded-control");
  });
  it("keeps compact card sorting in one accessible control row without a separate label", async () => {
    render(<UI.DataGrid variant="compact" caption="작은 목록" rows={[{ id: "ten", amount: 10 }, { id: "two", amount: 2 }]} columns={[
      { id: "amount", header: "수량", minWidth: 200, sortValue: row => row.amount, renderCell: row => row.id },
      { id: "actions", header: "작업", minWidth: 200, renderCell: row => <button>상세 {row.id}</button> }
    ]} getRowKey={row => row.id} />);
    expect(screen.queryByText("정렬 기준")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /정렬 기준.*현재 목록 안에서 정렬/ }));
    expect(screen.queryByRole("option", { name: "작업" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("option", { name: "수량" }));
    const order = () => within(screen.getByRole("list", { name: "작은 목록" })).getAllByRole("listitem").map(row => within(row).getAllByRole("definition")[0].textContent);
    expect(order()).toEqual(["two", "ten"]);
    fireEvent.click(screen.getByRole("button", { name: "내림차순으로 변경" }));
    expect(order()).toEqual(["ten", "two"]);
    expect(screen.getByRole("button", { name: "상세 two" })).toBeInTheDocument();
    measure(500);
    expect(screen.getByRole("columnheader", { name: /수량/ })).toHaveAttribute("aria-sort", "descending");
  });
  it.each([
    { values: ["조명10", "조명2", "가나다", "ABC", "abc"], ascending: ["2", "1", "0", "3", "4"], descending: ["3", "4", "0", "1", "2"] },
    { values: [10, null, 2, 2, undefined, NaN, Infinity], ascending: ["2", "3", "0", "1", "4", "5", "6"], descending: ["0", "2", "3", "1", "4", "5", "6"] },
    { values: [new Date("2026-10-02"), new Date("invalid"), new Date("2026-10-01"), null], ascending: ["2", "0", "1", "3"], descending: ["0", "2", "1", "3"] },
    { values: [true, false, true, null], ascending: ["1", "0", "2", "3"], descending: ["0", "2", "1", "3"] }
  ])("sorts typed values stably and keeps missing/invalid values last: $values", ({ values, ascending, descending }) => {
    const rows = Object.freeze(values.map((value, index) => Object.freeze({ id: String(index), value })));
    render(<UI.DataGrid caption="정렬 목록" rows={rows} columns={[
      { id: "value", header: "값", minWidth: 100, sortValue: row => row.value, renderCell: row => row.id },
      { id: "actions", header: "작업", minWidth: 100, renderCell: () => <button>상세</button> }
    ]} getRowKey={row => row.id} />);
    measure(400);
    const order = () => within(screen.getByRole("table")).getAllByRole("row").slice(1).map(row => within(row).getAllByRole("cell")[0].textContent);
    const header = screen.getByRole("columnheader", { name: /값/ });
    const sort = within(header).getByRole("button", { name: "값 오름차순 정렬" });
    expect(within(screen.getByRole("columnheader", { name: "작업" })).queryByRole("button")).not.toBeInTheDocument();
    fireEvent.click(sort);
    expect(order()).toEqual(ascending);
    expect(header).toHaveAttribute("aria-sort", "ascending");
    expect(sort).toHaveAccessibleName("값 내림차순 정렬");
    fireEvent.click(sort);
    expect(order()).toEqual(descending);
    expect(header).toHaveAttribute("aria-sort", "descending");
    expect(rows.map(row => row.id)).toEqual(values.map((_, index) => String(index)));
  });

  it("shares card/table sorting, re-sorts refreshed rows, and clears unavailable columns", async () => {
    const actions = vi.fn();
    const sortable: UI.DataGridColumn<{ id: string; amount: number }>[] = [
      { id: "amount", header: "수량", minWidth: 100, sortValue: row => row.amount, renderCell: row => row.id },
      { id: "actions", header: "작업", minWidth: 100, renderCell: row => <button onClick={() => actions(row.id)}>상세 {row.id}</button> }
    ];
    const rows = [{ id: "ten", amount: 10 }, { id: "two", amount: 2 }];
    const { rerender } = render(<UI.DataGrid caption="목록" rows={rows} columns={sortable} getRowKey={row => row.id} />);
    fireEvent.click(screen.getByRole("button", { name: /정렬 기준/ }));
    expect(screen.queryByRole("option", { name: "작업" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("option", { name: "수량" }));
    const order = () => within(screen.getByRole("list", { name: "목록" })).getAllByRole("listitem").map(row => within(row).getAllByRole("definition")[0].textContent);
    expect(order()).toEqual(["two", "ten"]);
    fireEvent.click(screen.getByRole("button", { name: "내림차순으로 변경" }));
    expect(order()).toEqual(["ten", "two"]);
    measure(400);
    expect(screen.getByRole("columnheader", { name: /수량/ })).toHaveAttribute("aria-sort", "descending");
    fireEvent.click(screen.getByRole("button", { name: "상세 ten" }));
    expect(actions).toHaveBeenCalledWith("ten");
    const refreshed = [{ id: "one", amount: 1 }, ...rows];
    rerender(<UI.DataGrid caption="목록" rows={refreshed} columns={[...sortable]} getRowKey={row => row.id} />);
    measure(100);
    expect(order()).toEqual(["ten", "two", "one"]);
    rerender(<UI.DataGrid caption="목록" rows={refreshed} columns={sortable.map(({ sortValue: _sortValue, ...column }) => column)} getRowKey={row => row.id} />);
    expect(order()).toEqual(["one", "ten", "two"]);
    expect(screen.queryByRole("button", { name: /정렬 기준/ })).not.toBeInTheDocument();
  });
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
