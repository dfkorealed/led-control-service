import { CircleAlert, CircleCheck, LogOut } from "lucide-react";
import { createRef, useRef, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  Button,
  Card,
  IconButton,
  FeedbackState,
  IconTooltipButton,
  MetricCard,
  ModalDialog,
  PageHeader,
  ProgressSteps,
  RouteLoadingState,
  SidePanel,
  StatusBadge,
  UnderlineNavigation,
  UnderlineNavigationLabel
} from ".";

describe("Calm Operations UI primitives", () => {
  afterEach(cleanup);

  it.each(["primary", "secondary", "ghost", "danger", "link"] as const)("supports the %s button variant and merges caller padding", (variant) => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref} variant={variant} size="lg" className="px-3 w-full">저장</Button>);
    expect(ref.current).toBe(screen.getByRole("button", { name: "저장" }));
    expect(ref.current).toHaveClass("px-3", "w-full", "text-body-lg");
    expect(ref.current).not.toHaveClass("px-6");
  });

  it.each([["sm", "text-body-sm"], ["md", "text-body"], ["lg", "text-body-lg"]] as const)("shares %s size and an actual interactive ref with IconButton", (size, typographyClass) => {
    const ref = createRef<HTMLButtonElement>();
    render(<IconButton ref={ref} aria-label="새로고침" size={size} variant="ghost" className="w-full"><CircleCheck /></IconButton>);
    expect(ref.current).toBe(screen.getByRole("button", { name: "새로고침" }));
    expect(ref.current).toHaveClass("w-full", typographyClass);
  });

  it.each([{ disabled: true }, { isDisabled: true }, { isLoading: true }])("prevents native activation for %j", (state) => {
    let clicks = 0;
    render(<Button {...state} onClick={() => { clicks += 1; }}>저장</Button>);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toBeDisabled();
    expect(clicks).toBe(0);
  });

  it("preserves native form submit and caller click behavior", () => {
    let submits = 0;
    let clicks = 0;
    render(<form onSubmit={(event) => { event.preventDefault(); submits += 1; }}><Button type="submit" onClick={() => { clicks += 1; }}>저장</Button></form>);
    fireEvent.click(screen.getByRole("button"));
    expect(clicks).toBe(1);
    expect(submits).toBe(1);
  });

  it("preserves the implicit native submit type", () => {
    let submits = 0;
    render(<form onSubmit={(event) => { event.preventDefault(); submits += 1; }}><Button>저장</Button></form>);
    fireEvent.click(screen.getByRole("button"));
    expect(submits).toBe(1);
  });

  it.each([0, 1])("delivers one native click and one press for click detail %s without adding a tab index", (detail) => {
    const events: string[] = [];
    render(<Button onClick={() => events.push("click")} onPress={(event) => events.push(`press:${event.pointerType}`)}>실행</Button>);
    const button = screen.getByRole("button");
    fireEvent.click(button, { detail });
    expect(events).toEqual(["click", detail === 0 ? "press:virtual" : "press:mouse"]);
    expect(button).not.toHaveAttribute("tabindex");
  });

  it.each(["Enter", " "])("maps the browser %s activation click to one keyboard press", (key) => {
    const events: string[] = [];
    render(<Button onClick={() => events.push("click")} onPress={(event) => events.push(`${event.pointerType}:${event.key}`)}>실행</Button>);
    const button = screen.getByRole("button");
    fireEvent.keyDown(button, { key });
    // JSDOM does not perform keyboard default actions; the browser emits this
    // single click (Enter on keydown, Space on keyup) for a native button.
    fireEvent.click(button, { detail: 0 });
    fireEvent.keyUp(button, { key });
    expect(events).toEqual(["click", `keyboard:${key}`]);
  });

  it("lets native click cancellation prevent press and form submission", () => {
    let submits = 0;
    let presses = 0;
    render(<form onSubmit={(event) => { event.preventDefault(); submits += 1; }}><Button onClick={(event) => event.preventDefault()} onPress={() => { presses += 1; }}>저장</Button></form>);
    fireEvent.click(screen.getByRole("button"));
    expect(presses).toBe(0);
    expect(submits).toBe(0);
  });

  it.each([false, true])("respects press propagation opt-in %s without altering native-only clicks", (propagate) => {
    let parentClicks = 0;
    render(<div onClick={() => { parentClicks += 1; }}><Button onPress={(event) => { if (propagate) event.continuePropagation(); }}>실행</Button></div>);
    fireEvent.click(screen.getByRole("button"));
    expect(parentClicks).toBe(propagate ? 1 : 0);
  });

  it.each(["default", "selected", "danger"] as const)("preserves Card tone %s as a compatibility alias for variant", (tone) => {
    const { rerender } = render(<Card tone={tone} data-testid="card">카드</Card>);
    const classes = screen.getByTestId("card").className;
    rerender(<Card variant={tone} data-testid="card">카드</Card>);
    expect(screen.getByTestId("card").className).toBe(classes);
  });

  it("forwards every presentation primitive root with a closed default variant and merged className", () => {
    const refs = [createRef<HTMLElement>(), createRef<HTMLElement>(), createRef<HTMLSpanElement>(), createRef<HTMLElement>(), createRef<HTMLElement>(), createRef<HTMLOListElement>(), createRef<HTMLElement>(), createRef<HTMLElement>(), createRef<HTMLElement>(), createRef<HTMLSpanElement>(), createRef<HTMLElement>()] as const;
    render(<>
      <Card ref={refs[0]} variant="default" className="p-6" data-testid="primitive-0">카드</Card>
      <FeedbackState ref={refs[1]} variant="default" className="p-6" data-testid="primitive-1" icon={CircleCheck} title="알림" />
      <StatusBadge ref={refs[2]} variant="default" className="p-6" data-testid="primitive-2" tone="success" icon={CircleCheck}>정상</StatusBadge>
      <MetricCard ref={refs[3]} variant="default" className="p-6" data-testid="primitive-3" label="조명" value={42} />
      <PageHeader ref={refs[4]} variant="default" className="p-6" data-testid="primitive-4" title="현황" />
      <ProgressSteps ref={refs[5]} variant="default" className="p-6" data-testid="primitive-5" label="진행" steps={[]} />
      <RouteLoadingState ref={refs[6]} variant="panel" className="p-6" data-testid="primitive-6" />
      <SidePanel ref={refs[7]} variant="default" className="p-6" data-testid="primitive-7">상세</SidePanel>
      <UnderlineNavigation ref={refs[8]} variant="default" className="p-6" data-testid="primitive-8">메뉴</UnderlineNavigation>
      <UnderlineNavigationLabel ref={refs[9]} variant="default" className="p-6" data-testid="primitive-9">탭</UnderlineNavigationLabel>
      <RouteLoadingState ref={refs[10]} variant="page" className="p-6" data-testid="primitive-10" />
    </>);
    refs.forEach((ref, index) => {
      expect(ref.current).toBe(screen.getByTestId(`primitive-${index}`));
      expect(ref.current).toHaveClass("p-6");
      expect(ref.current).not.toHaveClass("p-3.5", "p-4");
      expect(ref.current).not.toHaveAttribute("variant");
    });
    expect(screen.getByText("42")).toHaveClass("text-metric", "tabular-nums");
    expect(screen.getByTestId("primitive-3")).toHaveAttribute("data-metric-card", "");
    expect(screen.getByText("조명").parentElement).toHaveAttribute("data-metric-label", "");
  });

  it("resolves nested CSS aliases while preserving unresolved and circular references", () => {
    const resolved = resolveStylesheetVariables(`
      :root {
        --brand-blue: #256fa1;
        --primary: var(--brand-blue);
        --cycle-a: var(--cycle-b);
        --cycle-b: var(--cycle-a);
      }
      .alias { color: var(--primary); }
      .missing { color: var(--missing); }
      .cycle { color: var(--cycle-a); }
    `);

    expect(resolved).toContain(".alias { color: #256fa1; }");
    expect(resolved).toContain(".missing { color: var(--missing); }");
    expect(resolved).toMatch(/\.cycle \{ color: var\(--cycle-[ab]\); \}/);
  });

  it("keeps button semantics while exposing variant and loading state", () => {
    render(<Button variant="primary" isLoading>저장</Button>);

    expect(screen.getByRole("button", { name: "저장 중" })).toBeDisabled();
    expect(screen.getByRole("button")).toHaveAttribute("data-variant", "primary");
  });

  it("announces a route transition with a polite, understandable Korean loading state", () => {
    render(<RouteLoadingState />);

    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("status")).toHaveTextContent("화면을 불러오는 중입니다.");
  });

  it("forwards a button ref to the native control", () => {
    const ref = createRef<HTMLButtonElement>();

    render(<Button ref={ref}>저장</Button>);

    expect(ref.current).toBe(screen.getByRole("button", { name: "저장" }));
  });

  it("exposes an icon-only action through a reusable labelled tooltip", () => {
    render(<IconTooltipButton icon={LogOut} label="로그아웃" />);

    const button = screen.getByRole("button", { name: "로그아웃" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.focus(button);
    const tooltip = screen.getByRole("tooltip");

    expect(button.className.split(" ").every((className) => !className.startsWith("ui-"))).toBe(true);
    expect(button).toHaveAttribute("aria-describedby", tooltip.id);
    expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(tooltip).toHaveTextContent("로그아웃");

    fireEvent.keyDown(button, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("merges tooltip trigger classes, forwards its interactive ref and normalizes isDisabled", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<IconTooltipButton ref={ref} variant="default" icon={LogOut} label="로그아웃" className="p-2" isDisabled />);
    expect(ref.current).toBe(screen.getByRole("button", { name: "로그아웃" }));
    expect(ref.current).toBeDisabled();
    expect(ref.current).toHaveClass("p-2", "text-action-primary");
    expect(ref.current).not.toHaveClass("p-0");
  });

  it("keeps the 52px icon action target with Tailwind sizing utilities", () => {
    render(<IconTooltipButton icon={LogOut} label="로그아웃" />);

    expect(screen.getByRole("button", { name: "로그아웃" })).toHaveClass("size-13");
  });

  it("renders the opened tooltip with semantic surface and text tokens", () => {
    render(<IconTooltipButton icon={LogOut} label="로그아웃" />);
    fireEvent.focus(screen.getByRole("button"));
    expect(screen.getByRole("tooltip")).toHaveClass("bg-surface-inverse", "text-content-inverse", "text-caption");
  });

  it("renders status with an icon and visible label", () => {
    render(<StatusBadge tone="success" icon={CircleCheck}>정상</StatusBadge>);

    const label = screen.getByText("정상");
    const badge = label.parentElement;

    expect(label).toBeVisible();
    expect(badge).toHaveAttribute("data-tone", "success");
    expect(badge?.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(label).not.toHaveAttribute("data-tone");
  });

  it.each([
    ["success", "bg-status-success-background", "text-status-success-foreground"],
    ["warning", "bg-status-warning-background", "text-status-warning-badge"],
    ["danger", "bg-status-danger-background", "text-status-danger-badge"],
    ["neutral", "bg-status-neutral-background", "text-status-neutral-foreground"],
    ["info", "bg-status-info-background", "text-status-info-foreground"]
  ] as const)("keeps the %s status badge tone in Tailwind utilities", (tone, backgroundClass, foregroundClass) => {
    render(<StatusBadge tone={tone} icon={CircleCheck}>{tone}</StatusBadge>);

    expect(screen.getByText(tone).parentElement).toHaveClass(backgroundClass, foregroundClass);
  });

  it("keeps the spaced value, unit and optional status inside the metric group", () => {
    render(
      <MetricCard
        label="전체 조명"
        value="2,354"
        unit="개"
        helper="선택 층 기준"
        status={<StatusBadge tone="success" icon={CircleCheck}>수집 완료</StatusBadge>}
      />
    );

    const group = screen.getByRole("group", { name: "전체 조명" });
    expect(group).toHaveTextContent("2,354 개");
    expect(group).toHaveTextContent("수집 완료");
    expect(group.querySelector('[data-tone="success"]')).toBe(screen.getByText("수집 완료").parentElement);
  });

  it("renders page actions and feedback semantics", () => {
    render(
      <>
        <PageHeader title="운영 현황" actions={<button>새로고침</button>} />
        <FeedbackState tone="danger" icon={CircleAlert} title="불러오지 못했습니다" />
      </>
    );

    expect(screen.getByRole("heading", { name: "운영 현황" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("불러오지 못했습니다");
  });

  it("renders right-side information as a reusable complementary panel", () => {
    render(<SidePanel aria-label="선택 조명 상세" className="detail-panel"><div>상세 정보</div></SidePanel>);

    const panel = screen.getByRole("complementary", { name: "선택 조명 상세" });
    expect(panel).toHaveAttribute("data-variant", "default");
    expect(panel).toHaveClass("detail-panel");
    expect(panel).toHaveClass("[&>*]:min-w-0", "[&>*]:max-w-full");
  });

  it("renders ordered progress without using color as the only state", () => {
    render(<ProgressSteps label="명령 진행" steps={[
      { id: "queued", label: "명령 접수", state: "complete" },
      { id: "accepted", label: "장비 응답", state: "current" },
      { id: "applied", label: "조명 적용", state: "pending" }
    ]} />);

    const list = screen.getAllByRole("list", { name: "명령 진행" }).at(-1)!;
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getByText("장비 응답").closest("li")).toHaveAttribute("data-state", "current");
  });

  it("gives current, pending and error progress a visible icon and state label", () => {
    render(<ProgressSteps label="명령 진행" steps={[
      { id: "accepted", label: "장비 응답", state: "current" },
      { id: "applied", label: "조명 적용", state: "pending" },
      { id: "failed", label: "결과 확인", state: "error" }
    ]} />);

    const list = screen.getAllByRole("list", { name: "명령 진행" }).at(-1)!;
    for (const [label, stateLabel] of [["장비 응답", "진행 중"], ["조명 적용", "대기"], ["결과 확인", "오류"]] as const) {
      const item = within(list).getByText(label).closest("li")!;
      expect(within(item).getByText(stateLabel)).toBeVisible();
      expect(item.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    }
  });

  it.each(["info", "success", "warning"] as const)("exposes the %s feedback tone", (tone) => {
    render(<FeedbackState tone={tone} icon={CircleCheck} title={`${tone} 상태`} />);
    expect(screen.getByText(`${tone} 상태`).closest("section")).toHaveAttribute("data-tone", tone);
  });

  it.each([
    ["neutral", "bg-status-neutral-background", "text-content-secondary"],
    ["info", "bg-status-info-feedback-background", "text-status-info-feedback-foreground"],
    ["success", "bg-status-success-background", "text-status-success-feedback-foreground"],
    ["warning", "bg-status-warning-feedback-background", "text-status-warning-feedback-foreground"],
    ["danger", "bg-status-danger-background", "text-status-danger-feedback-foreground"]
  ] as const)("uses Tailwind surface and foreground utilities for the %s feedback tone", (tone, backgroundClass, foregroundClass) => {
    render(<FeedbackState tone={tone} icon={CircleCheck} title={`${tone} 상태`} />);
    const title = screen.getAllByText(`${tone} 상태`).at(-1)!;
    expect(title.closest("section")).toHaveClass(backgroundClass, foregroundClass);
  });

  it("renders a reusable page heading level", () => {
    render(
      <div className="control-screen">
        <PageHeader title="스케줄 제어" headingLevel={3} />
      </div>
    );

    const heading = screen.getByRole("heading", { name: "스케줄 제어", level: 3 });
    expect(heading).toHaveClass("m-0", "text-section-title", "font-bold");
  });

  it("keeps navigation semantics while supporting an optional decorative icon", () => {
    render(
      <>
        <UnderlineNavigation aria-label="통계 메뉴">
          <a href="/statistics/overview">
            <UnderlineNavigationLabel>개요</UnderlineNavigationLabel>
          </a>
        </UnderlineNavigation>
        <UnderlineNavigation as="div" role="tablist" aria-label="제어 방식">
          <button type="button" role="tab" aria-selected="true">
            <UnderlineNavigationLabel icon={<CircleCheck data-testid="control-tab-icon" />}>
              수동 제어
            </UnderlineNavigationLabel>
          </button>
        </UnderlineNavigation>
      </>
    );

    const statisticsNavigation = screen.getByRole("navigation", { name: "통계 메뉴" });
    const controlNavigation = screen.getByRole("tablist", { name: "제어 방식" });
    expect(within(statisticsNavigation).getByRole("link", { name: "개요" }).querySelector("svg")).toBeNull();
    expect(within(controlNavigation).getByRole("tab", { name: "수동 제어" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("control-tab-icon").closest("span")).toHaveAttribute("aria-hidden", "true");
  });

  it("expresses compact page action layout with responsive utility classes", () => {
    render(<PageHeader title="제어" actions={<Button>저장</Button>} />);

    const header = screen.getByRole("banner");
    expect(header).toHaveClass("max-compact:flex-col", "max-compact:items-stretch");
    expect(screen.getByRole("button", { name: "저장" }).parentElement).toHaveClass("max-compact:w-full");
  });

  it("provides modal semantics, traps focus and restores the trigger after Escape", async () => {
    render(<ModalHarness />);

    const trigger = screen.getByRole("button", { name: "대화상자 열기" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "사용자 수정" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "처음" }));

    const closeButton = within(dialog).getByRole("button", { name: "닫기" });
    closeButton.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "마지막" }));
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(closeButton);

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on the backdrop but keeps pending work safe from backdrop, Escape and close controls", () => {
    const { rerender } = render(<ModalHarness />);
    fireEvent.click(screen.getByRole("button", { name: "대화상자 열기" }));
    fireEvent.mouseDown(screen.getByTestId("modal-backdrop"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    rerender(<ModalHarness pending />);
    fireEvent.click(screen.getByRole("button", { name: "대화상자 열기" }));
    const dialog = screen.getByRole("dialog", { name: "사용자 수정" });
    expect(within(dialog).getByRole("button", { name: "닫기" })).toBeDisabled();

    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.mouseDown(screen.getByTestId("modal-backdrop"));
    expect(dialog).toBeInTheDocument();
  });

  it("focuses a stable fallback when the original trigger disappears", async () => {
    render(<RemovedTriggerModalHarness />);
    const trigger = screen.getByRole("button", { name: "삭제 열기" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "삭제 완료" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "사용자 추가" }));
  });
});

function ModalHarness({ pending = false }: { pending?: boolean }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)}>대화상자 열기</button>
    {open ? (
      <ModalDialog title="사용자 수정" onClose={() => setOpen(false)} isPending={pending}>
        <button type="button">처음</button>
        <button type="button">마지막</button>
      </ModalDialog>
    ) : null}
  </>;
}

function RemovedTriggerModalHarness() {
  const [open, setOpen] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const fallback = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={fallback} type="button">사용자 추가</button>
    {!deleted ? <button type="button" onClick={() => setOpen(true)}>삭제 열기</button> : null}
    {open ? <ModalDialog title="삭제" onClose={() => setOpen(false)} fallbackFocusElement={fallback.current}>
      <button type="button" onClick={() => { setDeleted(true); setOpen(false); }}>삭제 완료</button>
    </ModalDialog> : null}
  </>;
}

function resolveStylesheetVariables(source: string) {
  const variables = new Map(
    Array.from(source.matchAll(/(--[\w-]+):\s*([^;]+);/g), ([, name, value]) => [name, value.trim()])
  );

  function resolveVariable(name: string, resolving = new Set<string>()): string {
    const value = variables.get(name);
    if (!value || resolving.has(name)) return `var(${name})`;

    const nestedResolving = new Set(resolving).add(name);
    return value.replace(/var\((--[\w-]+)\)/g, (declaration, nestedName: string) => (
      variables.has(nestedName) ? resolveVariable(nestedName, nestedResolving) : declaration
    ));
  }

  return source.replace(/var\((--[\w-]+)\)/g, (declaration, name: string) => (
    variables.has(name) ? resolveVariable(name) : declaration
  ));
}
