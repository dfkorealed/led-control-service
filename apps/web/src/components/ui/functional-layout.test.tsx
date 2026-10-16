import { createRef, type ReactElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, Card, CardGrid, IconButton, PageHeader, PageStack, SidePanel, panelPaddingClass, type FunctionalLayoutProps, type PanelPadding, type TitleRole } from ".";

afterEach(cleanup);

describe("functional layout contracts", () => {
  it.each([ ["none", ""], ["customer", "p-5 max-compact:p-4"], ["regular", "p-5 max-compact:p-4"], ["compact", "p-4"] ] as const)("renders %s panel insets consistently", (padding, expected) => {
    render(<><Card padding={padding} data-testid="card">카드</Card><SidePanel padding={padding} data-testid="panel">상세</SidePanel></>);
    expect(panelPaddingClass(padding)).toBe(expected);
    for (const name of ["card", "panel"]) {
      const element = screen.getByTestId(name);
      if (expected) expect(element).toHaveClass(...expected.split(" "));
      else expect(element.className.split(" ").filter(value => /^p[xytrbl]?-[\w]+/.test(value))).toEqual([]);
    }
  });

  it.each([[PageStack, "gap-5"], [CardGrid, "gap-4.5"]] as const)("forwards layout semantics and keeps parent-owned columns", (Layout, gap) => {
    const ref = createRef<HTMLElement>(), onClick = vi.fn();
    render(<Layout as="section" ref={ref} aria-label="설비 목록" data-testid="layout" id="layout" className="grid-cols-2" onClick={onClick}><button>항목</button></Layout>);
    const element = screen.getByRole("region", { name: "설비 목록" });
    expect(element).toBe(ref.current);
    expect(element.tagName).toBe("SECTION");
    expect(element).toHaveClass("grid", "min-w-0", gap, "grid-cols-2");
    expect(element).toHaveAttribute("id", "layout");
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("uses a div by default and aligns PageStack content to the start", () => {
    render(<PageStack data-testid="stack"><CardGrid data-testid="grid">내용</CardGrid></PageStack>);
    expect(screen.getByTestId("stack").tagName).toBe("DIV");
    expect(screen.getByTestId("stack")).toHaveClass("content-start");
    expect(screen.getByTestId("grid").tagName).toBe("DIV");
  });

  it.each([["page", "text-customer-page-title"], ["section", "text-card-title"], ["card", "text-body-lg"]] as const)("keeps h3 semantics with explicit %s role", (titleRole, textClass) => {
    const ref = createRef<HTMLElement>();
    render(<PageHeader ref={ref} title="현장 구성" headingLevel={3} titleRole={titleRole} data-testid="header" />);
    expect(screen.getByRole("heading", { level: 3, name: "현장 구성" })).toHaveClass(textClass);
    expect(ref.current).toBe(screen.getByTestId("header"));
    expect(ref.current).not.toHaveAttribute("titleRole");
  });

  it("preserves omitted legacy title roles and lets explicit roles override customer presentation", () => {
    render(<><PageHeader title="기본" /><PageHeader title="고객" variant="customer" /><PageHeader title="하위" variant="customer" titleRole="section" /></>);
    expect(screen.getByRole("heading", { name: "기본", level: 2 })).toHaveClass("text-section-title");
    expect(screen.getByRole("heading", { name: "고객", level: 2 })).toHaveClass("text-customer-page-title");
    expect(screen.getByRole("heading", { name: "하위", level: 2 })).toHaveClass("text-card-title");
  });

  it("preserves plain SidePanel surfaces and Card tone/variant defaults", () => {
    render(<><SidePanel surface="plain" data-testid="plain">내용</SidePanel><Card tone="danger" data-testid="danger">주의</Card><Card tone="danger" variant="selected" data-testid="selected">선택</Card></>);
    expect(screen.getByTestId("plain")).not.toHaveClass("rounded-panel", "bg-surface-panel");
    expect(screen.getByTestId("danger")).toHaveAttribute("data-variant", "danger");
    expect(screen.getByTestId("selected")).toHaveAttribute("data-variant", "selected");
  });

  it.each(["sm", "md", "lg"] as const)("gives ordinary %s buttons a minimum width without shrinking caller geometry", size => {
    render(<><Button size={size}>확인</Button><Button size={size} className="min-w-16 min-h-13">큰 버튼</Button><IconButton aria-label="아이콘">+</IconButton><Button variant="landingMapMarker" aria-label="브랜드 점">점</Button></>);
    expect(screen.getByRole("button", { name: "확인" })).toHaveClass("min-w-11");
    expect(screen.getByRole("button", { name: "큰 버튼" })).toHaveClass("min-w-16", "min-h-13");
    expect(screen.getByRole("button", { name: "큰 버튼" })).not.toHaveClass("min-w-11");
    expect(screen.getByRole("button", { name: "아이콘" })).toHaveClass("min-w-11", "aspect-square");
    expect(screen.getByRole("button", { name: "브랜드 점" })).not.toHaveClass("min-w-11");
  });
});

// This fixture is compiled by the Web typecheck, protecting the public barrel
// API that downstream consumers need (including HTMLElement refs and rest props).
export function compileFunctionalContract(props: FunctionalLayoutProps, padding: PanelPadding, titleRole: TitleRole): ReactElement {
  const ref = createRef<HTMLElement>();
  return <PageStack {...props} ref={ref}><CardGrid as="section" ref={ref}><Card padding={padding}><PageHeader title="계약" titleRole={titleRole} headingLevel={3} /></Card><SidePanel padding={padding} surface="plain">패널</SidePanel></CardGrid></PageStack>;
}
