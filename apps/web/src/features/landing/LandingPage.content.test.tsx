import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LandingPage } from "./LandingPage";

afterEach(cleanup);

describe("public landing narrative", () => {
  it("opens with a concrete locate, control, and verify promise", () => {
    render(<LandingPage />);
    expect(screen.getByRole("img", { name: "킨다" })).toBeVisible();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/위치.*제어.*결과/);
    expect(screen.getByRole("link", { name: /도입 상담하기/ })).toHaveAttribute("href", "#contact");
  });

  it("tells each product story through a buyer question, supported capability, and operational use", () => {
    const { container } = render(<LandingPage />);
    const stories = [...container.querySelectorAll("[data-landing-story]")];
    expect(stories).toHaveLength(3);

    const [location, control, verification] = stories;
    expect(within(location as HTMLElement).getByRole("heading", { name: /어디에.*있/ })).toBeVisible();
    expect(location).toHaveTextContent(/도면.*위치|위치.*도면/);
    expect(location).toHaveTextContent(/연결.*상태/);
    expect(location).toHaveTextContent(/찾/);

    expect(within(control as HTMLElement).getByRole("heading", { name: /무엇을.*바꿀/ })).toBeVisible();
    expect(control).toHaveTextContent(/개별.*그룹.*일정/);
    expect(control).toHaveTextContent(/점등.*밝기/);

    expect(within(verification as HTMLElement).getByRole("heading", { name: /어떻게.*확인/ })).toBeVisible();
    expect(verification).toHaveTextContent(/명령.*이력/);
    expect(verification).toHaveTextContent(/상태 기반 추정.*전력/);
    expect(verification).toHaveTextContent(/판단|검토/);
  });

  it("offers equally detailed workflows for facility operators and installation partners", () => {
    render(<LandingPage />);
    for (const name of [/시설 운영 담당자/, /시공·유통 파트너/]) {
      const heading = screen.getByRole("heading", { name });
      const section = heading.closest("section")!;
      expect(within(section).getAllByRole("listitem")).toHaveLength(3);
      expect(within(section).getByRole("link", { name: /상담/ })).toHaveAttribute("href", "#contact");
      expect(section).toHaveTextContent(/시작|현장/);
    }
    expect(screen.getByText(/검토.*CAD.*배치|CAD.*검토.*배치/)).toBeVisible();
  });

  it("sets concrete consultation expectations and repeats the contact path", () => {
    render(<LandingPage />);
    const checklist = screen.getByRole("region", { name: /상담 전/ });
    expect(checklist).toHaveTextContent(/현장.*층.*규모/);
    expect(checklist).toHaveTextContent(/도면.*보유/);
    expect(checklist).toHaveTextContent(/설치.*운영.*역할/);
    expect(screen.getAllByRole("link").filter((link) => link.getAttribute("href") === "#contact").length).toBeGreaterThanOrEqual(4);
  });

  it("keeps the example clearly illustrative without unsupported promises", () => {
    const { container } = render(<LandingPage />);
    expect(screen.getByRole("figure", { name: "킨다 관제 구성 예시" })).toHaveAccessibleDescription(/실제 운영 데이터가 아닙니다/);
    expect(screen.queryByText("제품 화면 예시", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("현장 · 도면 · 조명을 한 화면에서", { exact: true })).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\d+(?:\.\d+)?\s*%|\d+\s*(?:만원|억원)|고객사\s*\d+|실시간|자동\s*CAD|절감\s*보장/);
  });

  it("provides discoverable navigation, login, and working anchor destinations", () => {
    render(<LandingPage />);
    const navigation = screen.getByRole("navigation", { name: "주요 메뉴" });
    for (const [name, id] of [["제품 소개", "product"], ["활용 안내", "benefits"], ["상담 문의", "contact"]]) {
      expect(within(navigation).getByRole("link", { name })).toHaveAttribute("href", `#${id}`);
      expect(document.getElementById(id)).toBeInTheDocument();
    }
    expect(screen.getAllByRole("link", { name: /로그인/ }).every((link) => link.getAttribute("href") === "/login")).toBe(true);
    expect(screen.getByRole("link", { name: "본문으로 이동" })).toHaveAttribute("href", "#main-content");
    expect(document.getElementById("main-content")).toBeInTheDocument();
  });
});
