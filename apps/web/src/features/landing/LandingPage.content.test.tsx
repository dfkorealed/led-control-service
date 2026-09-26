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
    expect(screen.getByText("도면에서 조명을 찾고, 제어와 기록까지 한곳에서 관리하세요.")).toBeVisible();
    expect(screen.getByRole("link", { name: /도입 상담하기/ })).toHaveAttribute("href", "#contact");
    expect(screen.queryByText("주차장·시설 조명 운영 플랫폼")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "제품 살펴보기" })).not.toBeInTheDocument();
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

  it("moves directly from the product story to the contact form", () => {
    render(<LandingPage />);
    expect(screen.queryByRole("heading", { name: /운영하는 사람도/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /상담 전/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/우리 현장의 조명 배치와 운영 방식에 맞춰/)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /우리 현장에 맞는 시작/ })).toBeVisible();
    expect(screen.getAllByRole("link").filter((link) => link.getAttribute("href") === "#contact")).toHaveLength(2);
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
    for (const [name, id] of [["제품 소개", "product"], ["상담 문의", "contact"]]) {
      expect(within(navigation).getByRole("link", { name })).toHaveAttribute("href", `#${id}`);
      expect(document.getElementById(id)).toBeInTheDocument();
    }
    expect(within(navigation).queryByRole("link", { name: "활용 안내" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /로그인/ })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "로그인" })).toHaveAttribute("href", "/login");
    expect(screen.queryByRole("link", { name: "관제 서비스 로그인" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "본문으로 이동" })).toHaveAttribute("href", "#main-content");
    expect(document.getElementById("main-content")).toBeInTheDocument();
  });
});
