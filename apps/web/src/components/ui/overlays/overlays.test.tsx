import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRef, useRef, useState, type Ref } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalDialog } from "../ModalDialog";
import { ConfirmDialog, type ConfirmDialogProps } from "../ConfirmDialog";
import { useDialogFocus } from "./useDialogFocus";
import * as UI from "../index";

afterEach(cleanup);

// Typecheck exercises the public contract; these fixtures are never mounted.
function confirmationDismissalTypeContract() {
  const base = { title: "확인", confirmLabel: "실행", onConfirm: () => {} };
  const cancelOnly: ConfirmDialogProps = { ...base, onCancel: () => {} };
  const closeOnly: ConfirmDialogProps = { ...base, onClose: () => {} };
  const both: ConfirmDialogProps = { ...base, onCancel: () => {}, onClose: () => {} };
  // @ts-expect-error A confirmation must provide at least one dismissal callback.
  const neither: ConfirmDialogProps = base;
  // @ts-expect-error The JSX entry point must preserve the same dismissal contract.
  const missingCallback = <ConfirmDialog {...base} />;
  return [cancelOnly, closeOnly, both, neither, missingCallback];
}
void confirmationDismissalTypeContract;

// Real keyboard sequences are covered by Chromium. Unit clicks explicitly focus
// their target, matching browser activation rather than relying on JSDOM layout.
const userEvent = {
  click(element: HTMLElement) { element.focus(); fireEvent.click(element); },
  keyboard(_key: "{Escape}") { fireEvent.keyDown(document.activeElement!, { key: "Escape" }); },
  setup() { return this; }
};

describe("overlay migration contracts", () => {
  it("opts into a centered modal without changing default mobile placement", () => {
    const view = render(<ModalDialog title="중앙 CAD" placement="center" onClose={() => {}}>도면</ModalDialog>);
    expect(screen.getByTestId("modal-backdrop")).toHaveClass("items-center!");
    expect(screen.getByTestId("modal-backdrop")).not.toHaveClass("items-end!");
    view.unmount();
    render(<ModalDialog title="기존 모달" onClose={() => {}}>본문</ModalDialog>);
    expect(screen.getByTestId("modal-backdrop")).toHaveClass("items-end!", "compact:items-center!");
  });
  function sheet() {
    const component = UI.DetailSheet;
    expect(component, "public detail sheet is exported").toBeDefined();
    return component;
  }

  it("keeps sheet header/actions out of the scrolling body with one safe-area owner", () => {
    const DetailSheet = sheet(); const initial = createRef<HTMLInputElement>(); const root = createRef<HTMLElement>();
    render(<DetailSheet ref={root} title="조명 상세" description="선택 조명" onClose={() => {}} initialFocusRef={initial} className="consumer-sheet" bodyClassName="consumer-body" actions={<button>저장</button>}>
      <input ref={initial} aria-label="상세 입력" />{Array.from({ length: 1000 }, (_, i) => <p key={i}>상세 {i}</p>)}
    </DetailSheet>);
    const dialog = screen.getByRole("dialog", { name: "조명 상세" });
    expect(root.current).toBe(dialog); expect(dialog).toHaveAccessibleDescription("선택 조명");
    expect(dialog).toHaveAttribute("data-dialog-variant", "sheet");
    expect(dialog).toHaveClass("max-h-dvh", "min-h-0", "overflow-hidden", "consumer-sheet");
    expect(dialog).not.toHaveClass("overflow-y-auto");
    const body = dialog.querySelector("[data-dialog-body]")!;
    expect(body).toHaveClass("min-h-0", "overflow-y-auto", "consumer-body");
    expect(body).not.toContainElement(screen.getByRole("button", { name: "저장" }));
    expect(body).not.toContainElement(screen.getByRole("button", { name: "닫기" }));
    expect(dialog.querySelectorAll(".pb-safe-area-bottom")).toHaveLength(1);
    expect(initial.current).toHaveFocus();
  });

  it("opts a drawer into one top/bottom safe-area owner without moving actions into its body", () => {
    const props = { title: "안전 영역 알람", onClose: () => {}, safeArea: true };
    render(<UI.DrawerDialog {...props} className="flex min-h-0 flex-col overflow-hidden" bodyClassName="min-h-0 flex-1 overflow-y-auto" actions={<button>완료</button>}>알람 목록</UI.DrawerDialog>);
    const dialog = screen.getByRole("dialog", { name: "안전 영역 알람" });
    const owner = dialog.querySelector("[data-dialog-safe-area]");
    expect(dialog.querySelectorAll("[data-dialog-safe-area]")).toHaveLength(1);
    expect(owner).toBeInTheDocument();
    expect(owner).toHaveClass("pt-safe-area-top", "pb-safe-area-bottom");
    expect(dialog.querySelectorAll(".pb-safe-area-bottom")).toHaveLength(1);
    expect(dialog).toHaveClass("p-0!", "compact:p-0!");
    expect(dialog).not.toHaveClass("p-4.5!", "compact:p-6!");
    expect(dialog.querySelector("[data-dialog-body]")).not.toContainElement(screen.getByRole("button", { name: "완료" }));
    expect(owner).toContainElement(screen.getByRole("button", { name: "닫기" }));
    expect(owner).toContainElement(screen.getByRole("button", { name: "완료" }));
  });

  it("does not stack the sheet bottom inset when explicitly opting into top/bottom safe-area", () => {
    const props = { title: "안전 영역 상세", onClose: () => {}, safeArea: true };
    const DetailSheet = sheet();
    render(<DetailSheet {...props} actions={<button>완료</button>}>상세</DetailSheet>);
    const dialog = screen.getByRole("dialog", { name: "안전 영역 상세" });
    expect(dialog.querySelectorAll("[data-dialog-safe-area]")).toHaveLength(1);
    expect(dialog.querySelector("[data-dialog-safe-area]")).toHaveClass("pt-safe-area-top", "pb-safe-area-bottom");
    expect(dialog.querySelectorAll(".pb-safe-area-bottom")).toHaveLength(1);
  });

  it.each(["modal", "drawer", "sheet"] as const)("keeps the ordinary %s layout default isolated from safe-area opt-in", surface => {
    const Component = surface === "modal" ? ModalDialog : surface === "drawer" ? UI.DrawerDialog : sheet();
    render(<Component title="기본 레이아웃" onClose={() => {}}>본문</Component>);
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("[data-dialog-safe-area]")).not.toBeInTheDocument();
    if (surface !== "sheet") {
      expect(dialog).toHaveClass("p-5", "max-compact:p-4", "overflow-y-auto");
      expect(dialog.querySelector("[data-dialog-body]")).not.toHaveClass("overflow-y-auto");
    } else expect(dialog.querySelectorAll(".pb-safe-area-bottom")).toHaveLength(1);
  });

  it.each(["escape", "outside", "close"])("dismisses sheet via %s once and blocks it during pending", (method) => {
    const DetailSheet = sheet(); const close = vi.fn();
    const content = (pending: boolean) => <DetailSheet title="상세" isPending={pending} onClose={close}>본문</DetailSheet>;
    const { rerender } = render(content(true));
    const dismiss = () => {
      if (method === "escape") fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      if (method === "outside") fireEvent.mouseDown(screen.getByTestId("modal-backdrop"));
      if (method === "close") fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    };
    dismiss(); expect(close).not.toHaveBeenCalled();
    rerender(content(false)); dismiss(); expect(close).toHaveBeenCalledOnce();
  });

  it("preserves sheet focus on rerender and returns to a connected fallback after opener removal", async () => {
    const DetailSheet = sheet(); const initial = createRef<HTMLInputElement>(); const fallback = createRef<HTMLButtonElement>();
    const opener = document.createElement("button"); document.body.append(opener); opener.focus();
    const content = (title: string) => <><button ref={fallback}>지도</button><DetailSheet title={title} onClose={() => {}} initialFocusRef={initial} fallbackFocusRef={fallback}><input ref={initial} aria-label="첫 항목" /><button>다른 항목</button></DetailSheet></>;
    const { rerender, unmount } = render(content("처음"));
    const original = screen.getByRole("dialog"); screen.getByRole("button", { name: "다른 항목" }).focus();
    rerender(content("변경"));
    expect(screen.getByRole("dialog")).toBe(original); expect(screen.getByRole("button", { name: "다른 항목" })).toHaveFocus();
    opener.remove();
    rerender(<button ref={fallback}>지도</button>);
    await waitFor(() => expect(screen.getByRole("button", { name: "지도" })).toHaveFocus()); unmount();
  });

  it("returns a nested child overlay to its sheet trigger", async () => {
    const DetailSheet = sheet();
    function Parent() {
      const [open, setOpen] = useState(false);
      return <DetailSheet title="부모 시트" onClose={() => {}}><button onClick={() => setOpen(true)}>자식 열기</button>
        {open && <ConfirmDialog title="자식 확인" confirmLabel="확인" onCancel={() => setOpen(false)} onConfirm={() => {}} />}</DetailSheet>;
    }
    render(<Parent />); const trigger = screen.getByRole("button", { name: "자식 열기" });
    userEvent.click(trigger); expect(screen.getByRole("button", { name: "취소" })).toHaveFocus();
    userEvent.keyboard("{Escape}"); await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "부모 시트" })).toBeVisible();
  });

  it("keeps portalled child input focus when its parent draft rerenders the physical dialog", async () => {
    const root = createRef<HTMLElement>();
    render(<DraftInNestedFilter root={root} />);
    const original = root.current;
    userEvent.click(screen.getByRole("button", { name: /중첩 필터 상세 필터/ }));
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
    const input = screen.getByRole("textbox", { name: "원시 입력" });
    userEvent.click(input); fireEvent.change(input, { target: { value: "2026" } });
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
    expect(root.current).toBe(original);
    expect(screen.getByRole("dialog", { name: "중첩 필터" })).toBeVisible();
    expect(input).toHaveValue("2026"); expect(input).toHaveFocus();
  });

  it.each(["object", "callback"] as const)("replaces and cleans the forwarded %s ref without refocusing over a portalled child", async kind => {
    const oldObject = createRef<HTMLElement>(), newObject = createRef<HTMLElement>();
    const oldCallback = vi.fn(), newCallback = vi.fn();
    const oldRef = kind === "object" ? oldObject : oldCallback;
    const newRef = kind === "object" ? newObject : newCallback;
    const view = render(<DraftInNestedFilter root={oldRef} />);
    const original = screen.getByRole("dialog", { name: "부모 원시 입력" });
    if (kind === "object") expect(oldObject.current).toBe(original);
    else expect(oldCallback).toHaveBeenLastCalledWith(original);
    userEvent.click(screen.getByRole("button", { name: /중첩 필터 상세 필터/ }));
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
    const input = screen.getByRole("textbox", { name: "원시 입력" }); userEvent.click(input);
    view.rerender(<DraftInNestedFilter root={newRef} />);
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
    expect(screen.getByRole("dialog", { name: "부모 원시 입력", hidden: true })).toBe(original);
    if (kind === "object") { expect(oldObject.current).toBeNull(); expect(newObject.current).toBe(original); }
    else { expect(oldCallback).toHaveBeenLastCalledWith(null); expect(newCallback).toHaveBeenLastCalledWith(original); }
    expect(screen.getByRole("dialog", { name: "중첩 필터" })).toBeVisible(); expect(input).toHaveFocus();
    view.unmount();
    if (kind === "object") expect(newObject.current).toBeNull();
    else expect(newCallback).toHaveBeenLastCalledWith(null);
  });

  it("focuses the sheet root when no body field is focusable, with no actions required", () => {
    const DetailSheet = sheet();
    render(<DetailSheet title="읽기 전용 상세" onClose={() => {}}>상태 정보</DetailSheet>);
    expect(screen.getByRole("dialog", { name: "읽기 전용 상세" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "닫기" })).toBeEnabled();
  });
  it("contains no production DOM enumeration in the three dialog entry points", () => {
    const directory = resolve("src/components/ui/overlays");
    const sources = readdirSync(directory).filter(path => /\.tsx?$/.test(path) && !path.includes(".test."));
    for (const path of ["../ModalDialog.tsx", "../ConfirmDialog.tsx", ...sources]) {
      expect(readFileSync(resolve(directory, path), "utf8")).not.toMatch(/\.querySelector(?:All)?(?:<[^>]+>)?\(/);
    }
  });

  it("honors isOpen before open and preserves conditional mounting defaults", () => {
    const close = vi.fn();
    const { rerender } = render(<ModalDialog title="열림" isOpen={false} open onClose={close}>본문</ModalDialog>);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    rerender(<ModalDialog title="열림" isOpen open={false} onClose={close}>본문</ModalDialog>);
    expect(screen.getByRole("dialog", { name: "열림" })).toBeVisible();
    rerender(<ModalDialog title="열림" open={false} onClose={close}>본문</ModalDialog>);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("portals the named and described dialog, forwards its root and honors explicit initial focus", () => {
    const initial = createRef<HTMLInputElement>();
    const root = createRef<HTMLDivElement>();
    const { container } = render(<ModalDialog ref={root} title="안내" description="설명" role="alertdialog" closeLabel="안내 닫기" onClose={() => {}} initialFocusRef={initial}>
      <input ref={initial} aria-label="입력" />
    </ModalDialog>);
    const dialog = screen.getByRole("alertdialog", { name: "안내" });
    expect(container).not.toContainElement(dialog);
    expect(root.current).toBe(dialog);
    expect(dialog).toHaveAccessibleDescription("설명");
    expect(dialog).toHaveAttribute("data-dialog-surface", "");
    expect(initial.current).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "안내 닫기" })).toBeVisible();
  });

  it("forwards a caller body layout class without changing the dialog surface contract", () => {
    render(<ModalDialog title="본문 레이아웃" bodyClassName="min-h-0 overflow-hidden" onClose={() => {}}>내용</ModalDialog>);
    const dialog = screen.getByRole("dialog", { name: "본문 레이아웃" });
    expect(dialog).toHaveAttribute("data-dialog-surface", "");
    expect(dialog.querySelector("[data-dialog-body]")).toHaveClass("min-h-0", "overflow-hidden");
  });

  it("renders a right drawer with modal focus and returns focus to its opener", async () => {
    render(<DrawerReturnFocus />);
    fireEvent.click(screen.getByRole("button", { name: "상태 열기" }));
    const drawer = screen.getByRole("dialog", { name: "상태 센터" });
    expect(drawer).toHaveAttribute("data-dialog-variant", "drawer");
    expect(drawer).toHaveClass("max-w-status-drawer");
    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("button", { name: "상태 열기" })).toHaveFocus());
  });

  it("dismisses a drawer from its backdrop and returns focus to the opener", async () => {
    render(<DrawerReturnFocus />);
    const opener = screen.getByRole("button", { name: "상태 열기" });
    fireEvent.click(opener);

    fireEvent.mouseDown(screen.getByTestId("modal-backdrop"));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "상태 센터" })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it("locks every drawer dismissal route while pending", () => {
    const close = vi.fn();
    render(<UI.DrawerDialog title="처리 중 상태" closeLabel="상태 닫기" isPending onClose={close}>본문</UI.DrawerDialog>);
    const drawer = screen.getByRole("dialog", { name: "처리 중 상태" });
    const closeButton = screen.getByRole("button", { name: "상태 닫기" });

    expect(closeButton).toBeDisabled();
    fireEvent.keyDown(drawer, { key: "Escape" });
    fireEvent.mouseDown(screen.getByTestId("modal-backdrop"));
    fireEvent.click(closeButton);

    expect(close).not.toHaveBeenCalled();
    expect(drawer).toBeVisible();
  });

  it("defaults confirmation focus to safe cancel and prefers onCancel over the legacy callback", async () => {
    const onCancel = vi.fn(); const onClose = vi.fn(); const onConfirm = vi.fn();
    render(<ConfirmDialog title="확인" description="되돌릴 수 없음" confirmLabel="실행" onCancel={onCancel} onClose={onClose} onConfirm={onConfirm} />);
    expect(screen.getByRole("button", { name: "취소" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "실행" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each(["escape", "outside", "close"])("dismisses via %s exactly once using onCancel precedence", async (method) => {
    const cancel = vi.fn(); const close = vi.fn();
    render(<ConfirmDialog title="정확한 닫기" confirmLabel="확인" closeLabel="검토 닫기" onCancel={cancel} onClose={close} onConfirm={() => {}} />);
    if (method === "escape") fireEvent.keyDown(screen.getByRole("button", { name: "취소" }), { key: "Escape" });
    if (method === "outside") {
      fireEvent.mouseDown(screen.getByTestId("modal-backdrop"));
      fireEvent.mouseUp(screen.getByTestId("modal-backdrop"));
    }
    if (method === "close") fireEvent.click(screen.getByRole("button", { name: "검토 닫기" }));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it("preserves a live root and user focus across rerenders, honoring Confirm open aliases", () => {
    const root = createRef<HTMLElement>();
    const renderDialog = (isOpen: boolean, open: boolean, title: string) => <ConfirmDialog ref={root} isOpen={isOpen} open={open} title={title} confirmLabel="확인" onCancel={() => {}} onConfirm={() => {}} />;
    const { rerender } = render(renderDialog(false, true, "처음"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    rerender(renderDialog(true, false, "처음"));
    const original = root.current;
    screen.getByRole("button", { name: "확인" }).focus();
    rerender(renderDialog(true, false, "변경"));
    expect(root.current).toBe(original);
    expect(root.current).toHaveAccessibleName("변경");
    expect(screen.getByRole("button", { name: "확인" })).toHaveFocus();
  });

  it.each(["disabled", "confirmDisabled"] as const)("normalizes %s without disabling cancellation or leaking props", async (alias) => {
    const onConfirm = vi.fn(); const onClose = vi.fn();
    render(<ConfirmDialog title="확인" confirmLabel="실행" {...{ [alias]: true }} destructive onClose={onClose} onConfirm={onConfirm} />);
    const confirm = screen.getByRole("button", { name: "실행" });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute("data-variant", "danger");
    expect(screen.getByRole("dialog")).not.toHaveAttribute("confirmDisabled");
    await userEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("locks every dismissal and confirmation route while pending", async () => {
    const close = vi.fn(); const confirm = vi.fn();
    render(<ConfirmDialog open title="대기" closeLabel="대기 닫기" confirmLabel="실행" isPending onClose={close} onConfirm={confirm} />);
    const dialog = screen.getByRole("dialog");
    expect(screen.getByRole("button", { name: "대기 닫기" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "취소" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "처리 중" })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.mouseDown(dialog.parentElement!);
    await userEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(close).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
  });

  it("returns child focus to its parent trigger and then returns parent focus to its opener", async () => {
    render(<Nested />);
    const user = userEvent.setup();
    const opener = screen.getByRole("button", { name: "부모 열기" });
    await user.click(opener);
    const childTrigger = screen.getByRole("button", { name: "자식 열기" });
    await user.click(childTrigger);
    expect(screen.getByRole("button", { name: "취소" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(childTrigger).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "부모" })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it.each(["ref", "element", "opener", "fallback-ref", "fallback-element"] as const)("restores the highest connected focus target: %s", async (target) => {
    render(<ReturnFocus target={target} />);
    await userEvent.click(screen.getByRole("button", { name: "opener" }));
    await userEvent.click(screen.getByRole("button", { name: "완료" }));
    await waitFor(() => expect(screen.getByRole("button", { name: target })).toHaveFocus());
  });

  it.each([0, "0"])("preserves exact dropdown item identity %s", async (key) => {
    const onAction = vi.fn(); const ref = createRef<HTMLButtonElement>();
    render(<UI.DropdownMenu ref={ref} label="동작" items={[{ id: key, label: "선택", description: "설명" }, { id: "disabled", label: "사용 불가", isDisabled: true }]} onAction={onAction} />);
    const trigger = screen.getByRole("button", { name: "동작" });
    expect(ref.current).toBe(trigger);
    fireEvent.click(trigger);
    expect(await screen.findByRole("menu", { name: "동작" })).toBeVisible();
    const item = screen.getByRole("menuitem", { name: "선택" });
    expect(item).toHaveAccessibleDescription("설명");
    expect(screen.getByRole("menuitem", { name: "사용 불가" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(item);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith(key);
  });

  it("does not open a disabled dropdown", () => {
    render(<UI.DropdownMenu label="동작" isDisabled items={[{ id: 0, label: "선택" }]} onAction={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "동작" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("forwards the actual popover root with controlled state and accessible panel content", async () => {
    const ref = createRef<HTMLDivElement>(); const anchor = createRef<HTMLButtonElement>();
    const close = vi.fn();
    const { rerender } = render(<><button ref={anchor}>기준</button><UI.Popover ref={ref} triggerRef={anchor} isOpen label="상세" onOpenChange={close}>내용</UI.Popover></>);
    expect(await screen.findByRole("dialog", { name: "상세" })).toHaveTextContent("내용");
    expect(ref.current).toContainElement(screen.getByRole("dialog"));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(false);
    rerender(<><button ref={anchor}>기준</button><UI.Popover ref={ref} triggerRef={anchor} isOpen={false} label="상세">내용</UI.Popover></>);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("lets a new child overlay own focus inside a legacy parent and cleans up its Escape listener", async () => {
    const close = vi.fn();
    const { unmount } = render(<LegacyParent close={close} />);
    const trigger = screen.getByRole("button", { name: "자식 열기" });
    await userEvent.click(trigger);
    expect(screen.getByRole("button", { name: "취소" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(close).not.toHaveBeenCalled();
    const tab = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
    unmount();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
  });
});

function DraftInNestedFilter({ root }: { root: Ref<HTMLElement> }) {
  const [draft, setDraft] = useState("");
  return <UI.DrawerDialog ref={root} title="부모 원시 입력" onClose={() => {}}>
    <UI.FilterPanel label="중첩 필터" mode="popover">
      <input aria-label="원시 입력" value={draft} onChange={event => setDraft(event.target.value)} />
    </UI.FilterPanel>
  </UI.DrawerDialog>;
}

function LegacyParent({ close }: { close(): void }) {
  const dialog = useRef<HTMLDivElement>(null); const initial = useRef<HTMLButtonElement>(null);
  const [child, setChild] = useState(false);
  useDialogFocus({ open: true, dialogRef: dialog, initialFocusRef: initial, onClose: close });
  return <div ref={dialog} tabIndex={-1} role="dialog" aria-label="이전 부모">
    <button ref={initial} onClick={() => setChild(true)}>자식 열기</button>
    <button>이전 마지막</button>
    {child && <ConfirmDialog title="자식" confirmLabel="확인" onCancel={() => setChild(false)} onConfirm={() => {}} />}
  </div>;
}

function Nested() {
  const [parent, setParent] = useState(false); const [child, setChild] = useState(false);
  return <><button onClick={() => setParent(true)}>부모 열기</button>
    {parent && <ModalDialog title="부모" onClose={() => setParent(false)}>
      <button onClick={() => setChild(true)}>자식 열기</button><button>부모 마지막</button>
      {child && <ConfirmDialog title="자식" confirmLabel="확인" onCancel={() => setChild(false)} onConfirm={() => {}} />}
    </ModalDialog>}</>;
}

function ReturnFocus({ target }: { target: "ref" | "element" | "opener" | "fallback-ref" | "fallback-element" }) {
  const [open, setOpen] = useState(false); const [removed, setRemoved] = useState(false);
  const preferred = useRef<HTMLButtonElement>(null); const element = useRef<HTMLButtonElement>(null);
  const fallback = useRef<HTMLButtonElement>(null); const fallbackElement = useRef<HTMLButtonElement>(null);
  return <>
    {target === "ref" && <button ref={preferred}>ref</button>}
    {["ref", "element"].includes(target) && <button ref={element}>element</button>}
    {!removed && <button onClick={() => setOpen(true)}>opener</button>}
    {target !== "fallback-element" && <button ref={fallback}>fallback-ref</button>}
    <button ref={fallbackElement}>fallback-element</button>
    {open && <ModalDialog title="반환" onClose={() => setOpen(false)} returnFocusRef={preferred} returnFocusElement={element.current} fallbackFocusRef={fallback} fallbackFocusElement={fallbackElement.current}>
      <button onClick={() => { setRemoved(target.startsWith("fallback")); setOpen(false); }}>완료</button>
    </ModalDialog>}
  </>;
}

function DrawerReturnFocus() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={trigger} onClick={() => setOpen(true)}>상태 열기</button>
    <UI.DrawerDialog isOpen={open} title="상태 센터" returnFocusRef={trigger} onClose={() => setOpen(false)}>
      <button>첫 action</button>
    </UI.DrawerDialog>
  </>;
}
