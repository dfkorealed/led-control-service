import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { closeTopOverlay } from "./overlays/overlay-stack";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as UI from "./index";

function panel() {
  const component = UI.FilterPanel;
  expect(component, "public filter wrapper is exported").toBeDefined();
  return component;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("FilterPanel", () => {
  it("uses a modal bottom sheet on mobile while retaining nested calendar dismissal and focus", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    try {
      render(<UI.FilterPanel label="하단 조건" mode="popover"><UI.DatePicker label="기간" value="2026-02-28" onChange={() => {}} /></UI.FilterPanel>);
      const trigger = screen.getByRole("button", { name: /하단 조건 상세 필터/ });
      trigger.focus(); fireEvent.click(trigger);
      const dialog = await screen.findByRole("dialog", { name: "하단 조건" });
      expect(dialog).toHaveAttribute("aria-modal", "true");
      fireEvent.click(screen.getByRole("button", { name: /달력/ }));
      fireEvent.keyDown(await screen.findByRole("grid"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("grid")).not.toBeInTheDocument());
      expect(dialog).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "필터 닫기" }));
      await waitFor(() => expect(trigger).toHaveFocus());
    } finally { cleanup(); vi.unstubAllGlobals(); }
  });
  it("shows the trigger label and only a positive active count without changing the accessible count", () => {
    const view = render(<UI.FilterPanel label="조건" mode="popover"><span>내용</span></UI.FilterPanel>);
    const trigger = screen.getByRole("button", { name: "조건 상세 필터, 활성 조건 0개" });
    expect(trigger).toHaveTextContent("필터");
    expect(within(trigger).queryByText("0")).not.toBeInTheDocument();
    view.rerender(<UI.FilterPanel label="조건" mode="popover" triggerLabel="조건 선택" activeFilterCount={2}><span>내용</span></UI.FilterPanel>);
    expect(trigger).toHaveAccessibleName("조건 상세 필터, 활성 조건 2개");
    expect(trigger).toHaveTextContent("조건 선택");
    expect(within(trigger).getByText("2")).toBeInTheDocument();
  });
  it("reserves a 64px-wide trigger while keeping the 44px height for its rounded continuous hit area", () => {
    render(<UI.FilterPanel label="실제 hit" mode="popover"><UI.TextField label="조건" /></UI.FilterPanel>);
    const trigger = screen.getByRole("button", { name: "실제 hit 상세 필터, 활성 조건 0개" });
    // Geometry/hit testing belongs to Chromium; this fixes the public spacing-token contract.
    expect(trigger).toHaveClass("min-w-16", "min-h-11");
    expect(trigger).not.toHaveClass("min-w-11");
  });
  it("supports compact inline density while preserving the legacy default", () => {
    const view = render(<UI.FilterPanel label="밀도" variant="compact"><span>조건</span></UI.FilterPanel>);
    expect(screen.getByRole("region", { name: "밀도" })).toHaveClass("gap-2");
    view.rerender(<UI.FilterPanel label="밀도"><span>조건</span></UI.FilterPanel>);
    expect(screen.getByRole("region", { name: "밀도" })).toHaveClass("gap-3");
  });
  it("legacy filter panel remains inline", () => {
    render(<UI.FilterPanel label="기존"><UI.TextField label="조건" /></UI.FilterPanel>);
    expect(screen.getByRole("textbox", { name: "조건" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("keeps search and logical summary outside and preserves search on filter reset", async () => {
    function Example() {
      const [query, setQuery] = useState("조명"); const [filtered, setFiltered] = useState(true);
      return <UI.FilterPanel label="목록" mode="popover" activeFilterCount={filtered ? 1 : 0}
        search={<UI.SearchField label="검색" value={query} onChange={setQuery} />}
        summary={<span>기간 한 쌍</span>} chips={<span>중복 요약</span>}
        filterReset={<UI.Button onClick={() => setFiltered(false)}>필터 초기화</UI.Button>}>
        <UI.TextField label="시작일" />
      </UI.FilterPanel>;
    }
    render(<Example />);
    expect(screen.getByRole("searchbox", { name: "검색" })).toHaveValue("조명");
    expect(screen.queryByRole("textbox", { name: "시작일" })).not.toBeInTheDocument();
    expect(screen.queryByText("중복 요약")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
    expect(screen.getByRole("searchbox", { name: "검색" })).toHaveValue("조명");
    const trigger = screen.getByRole("button", { name: /목록 상세 필터/ });
    trigger.focus(); fireEvent.click(trigger);
    expect(await screen.findByRole("dialog", { name: "목록" })).toHaveTextContent("필터 초기화");
    fireEvent.click(screen.getByRole("button", { name: "필터 닫기" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(closeTopOverlay()).toBe(false);
  });
  it.each([false, true])("nested select back closes topmost first and leaves closed collections unregistered (mobile=%s)", async mobile => {
    vi.stubGlobal("matchMedia", () => ({ matches: mobile, addEventListener() {}, removeEventListener() {} }));
    render(<UI.FilterPanel label="중첩" mode="popover"><UI.SelectBox label="상태" items={[{ id: "all", label: "전체" }]} selectedKey="all" /></UI.FilterPanel>);
    expect(closeTopOverlay()).toBe(false);
    const trigger = screen.getByRole("button", { name: /중첩 상세 필터/ }); trigger.focus(); fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "상태" }));
    await screen.findByRole("listbox");
    act(() => expect(closeTopOverlay()).toBe(true));
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "중첩" })).toBeInTheDocument();
    act(() => expect(closeTopOverlay()).toBe(true));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(closeTopOverlay()).toBe(false);
  });
  it.each([false, true])("retains controlled open state and pending dismissal locks (mobile=%s)", mobile => {
    vi.stubGlobal("matchMedia", () => ({ matches: mobile, addEventListener() {}, removeEventListener() {} }));
    const change = vi.fn();
    render(<UI.FilterPanel label="잠금" mode="popover" isOpen isDismissDisabled onOpenChange={change}><UI.TextField label="입력" /></UI.FilterPanel>);
    const dialog = screen.getByRole("dialog", { name: "잠금" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    act(() => closeTopOverlay());
    fireEvent.click(screen.getByRole("button", { name: "필터 닫기" }));
    expect(change).not.toHaveBeenCalled(); expect(dialog).toBeInTheDocument();
  });
  it("nested calendar Escape closes topmost first and returns final focus to the filter trigger", async () => {
    render(<UI.FilterPanel label="날짜 필터" mode="popover"><UI.DatePicker label="날짜" value="2026-02-28" onChange={() => {}} /></UI.FilterPanel>);
    const trigger = screen.getByRole("button", { name: /날짜 필터 상세 필터/ });
    act(() => trigger.focus()); fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: /달력/ }));
    const calendar = await screen.findByRole("grid");
    fireEvent.keyDown(calendar, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("grid")).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "날짜 필터" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "날짜 필터" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(closeTopOverlay()).toBe(false);
  });
  it("preserves field labels, errors, descriptions, callbacks and slot DOM order", () => {
    const FilterPanel = panel();
    const change = vi.fn(); const reset = vi.fn();
    render(<FilterPanel label="로그 필터" className="consumer-filter" chips={<span>선택된 층</span>}
      actions={<UI.Button onClick={reset}>초기화</UI.Button>}>
      <UI.TextField label="검색" description="조명 이름" errorMessage="다시 확인" isInvalid value="" onChange={change} />
      <UI.SelectBox label="유형" items={[{ id: "all", label: "전체" }]} selectedKey="all" />
    </FilterPanel>);
    const region = screen.getByRole("region", { name: "로그 필터" });
    expect(region).toHaveClass("min-w-0", "consumer-filter");
    const field = within(region).getByRole("textbox", { name: "검색" });
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(/조명 이름/);
    expect(field).toHaveAccessibleDescription(/다시 확인/);
    expect(within(region).getByRole("button", { name: "유형" })).toBeVisible();
    fireEvent.change(field, { target: { value: "B1" } });
    expect(change).toHaveBeenCalledOnce();
    expect(change).toHaveBeenCalledWith("B1");
    fireEvent.click(screen.getByRole("button", { name: "초기화" }));
    expect(reset).toHaveBeenCalledOnce();
    expect([...region.querySelectorAll("input, button")].map(node => node.getAttribute("aria-label") ?? node.id)).toHaveLength(3);
    expect(field.compareDocumentPosition(screen.getByText("선택된 층")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("선택된 층").compareDocumentPosition(screen.getByRole("button", { name: "초기화" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("provides wrapping shrinkable slots for long chips and actions without adding controls", () => {
    const FilterPanel = panel();
    render(<FilterPanel label="기간 필터" chips={<span>{"긴필터".repeat(40)}</span>} actions={<><button>적용</button><button>내보내기</button></>}><UI.TextField label="조건" /></FilterPanel>);
    expect(screen.getByText("긴필터".repeat(40)).parentElement).toHaveClass("flex-wrap", "min-w-0", "break-all");
    expect(screen.getByRole("button", { name: "적용" }).parentElement).toHaveClass("flex-wrap", "min-w-0");
    expect(screen.queryByRole("button", { name: "초기화" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });
});
