import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRef, useRef, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalDialog } from "../ModalDialog";
import { ConfirmDialog, type ConfirmDialogProps } from "../ConfirmDialog";
import { ConfirmDialog as LegacyConfirmDialog, useDialogFocus } from "../../ConfirmDialog";
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
  it("contains no production DOM enumeration in the three dialog entry points", () => {
    const directory = resolve("src/components/ui/overlays");
    const sources = readdirSync(directory).filter(path => /\.tsx?$/.test(path) && !path.includes(".test."));
    for (const path of ["../ModalDialog.tsx", "../ConfirmDialog.tsx", "../../ConfirmDialog.tsx", ...sources]) {
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
    expect(initial.current).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "안내 닫기" })).toBeVisible();
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
    expect(confirm).toHaveClass("ui-button-danger");
    expect(screen.getByRole("dialog")).not.toHaveAttribute("confirmDisabled");
    await userEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("locks every dismissal and confirmation route while pending", async () => {
    const close = vi.fn(); const confirm = vi.fn();
    render(<LegacyConfirmDialog open title="대기" confirmLabel="실행" isPending onClose={close} onConfirm={confirm} />);
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
