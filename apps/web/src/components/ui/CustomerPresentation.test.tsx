import { createRef } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import * as UI from "./index";

afterEach(cleanup);

it.each([
  ["customer-page-title", "text-customer-page-title", "max-compact:text-section-title"],
  ["customer-section-title", "text-card-title", undefined],
  ["customer-card-title", "text-body-lg", undefined],
  ["customer-metric", "text-customer-metric", "max-compact:text-metric"],
] as const)("keeps %s size and caller foreground together", (variant, size, compact) => {
  render(<UI.Heading variant={variant} className="text-content-secondary">제목</UI.Heading>);
  const title = screen.getByRole("heading", { name: "제목" });
  expect(title).toHaveClass(size, "text-content-secondary");
  if (compact) expect(title).toHaveClass(compact);
  expect(title).not.toHaveClass("text-content-primary");
});

it("opts PageHeader into the customer title while retaining heading level, slots and ref", () => {
  const ref = createRef<HTMLElement>();
  const view = render(<UI.PageHeader ref={ref} variant="customer" headingLevel={1} title="고객"
    aria-label="페이지" description="설명" actions={<UI.Button>수정</UI.Button>} />);
  expect(ref.current).toBe(screen.getByRole("banner", { name: "페이지" }));
  expect(screen.getByRole("heading", { level: 1 })).toHaveClass("text-customer-page-title");
  expect(within(ref.current!).getByText("설명")).toBeInTheDocument();
  expect(within(ref.current!).getByRole("button", { name: "수정" })).toBeEnabled();
  view.rerender(<UI.PageHeader title="기본" />);
  expect(screen.getByRole("heading", { level: 2 })).toHaveClass("text-section-title");
});

it("retains caller children and ref for opt-in card inset and plain embedded side panels", () => {
  const ref = createRef<HTMLElement>();
  const view = render(<UI.Card ref={ref} padding="customer" aria-label="내용"><UI.Text>원본</UI.Text></UI.Card>);
  expect(ref.current).toBe(screen.getByRole("region", { name: "내용" }));
  expect(ref.current).toHaveClass("p-5", "max-compact:p-4");
  view.rerender(<UI.SidePanel ref={ref} surface="plain" aria-label="상세">원본</UI.SidePanel>);
  expect(ref.current).toBe(screen.getByRole("complementary", { name: "상세" }));
  expect(ref.current).not.toHaveClass("border", "bg-surface-panel");
  view.rerender(<UI.SidePanel aria-label="상세">기본</UI.SidePanel>);
  expect(screen.getByRole("complementary")).toHaveClass("border", "bg-surface-panel");
});

it("preserves navigation children, accessible label and ref across opt-in presentation", () => {
  const ref = createRef<HTMLElement>();
  const view = render(<UI.UnderlineNavigation ref={ref} variant="customer" aria-label="하위 메뉴"><button>탭</button></UI.UnderlineNavigation>);
  const tab = screen.getByRole("button", { name: "탭" });
  expect(ref.current).toBe(screen.getByRole("navigation", { name: "하위 메뉴" }));
  expect(ref.current).not.toHaveClass("border-b");
  view.rerender(<UI.UnderlineNavigation ref={ref} aria-label="하위 메뉴"><button>탭</button></UI.UnderlineNavigation>);
  expect(screen.getByRole("button", { name: "탭" })).toBe(tab);
  expect(ref.current).toHaveClass("border-b");
});

it("renders one whole navigation link with destination, accessible attributes and ref", () => {
  expect(UI.NavigationCard).toBeDefined();
  const ref = createRef<HTMLAnchorElement>();
  render(<MemoryRouter><UI.NavigationCard ref={ref} to="/settings/site" icon={<span>아이콘</span>}
    title="현장 관리" description="현장 정보" summary={<span>2개 층</span>} aria-label="현장 열기" /></MemoryRouter>);
  const link = screen.getByRole("link", { name: "현장 열기" });
  expect(ref.current).toBe(link);
  expect(link).toHaveAttribute("href", "/settings/site");
  expect(within(link).getByText("현장 정보")).toBeInTheDocument();
  expect(within(link).getByText("2개 층")).toBeInTheDocument();
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
