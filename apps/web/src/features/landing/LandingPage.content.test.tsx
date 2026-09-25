import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LandingPage } from "./LandingPage";

afterEach(cleanup);

describe("public landing narrative", () => {
  it("identifies the brand and clearly labels the illustrative product view", () => {
    render(<LandingPage />);
    expect(screen.getByRole("img", { name: "킨다" })).toBeVisible();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText("제품 화면 예시")).toBeVisible();
    expect(screen.getByRole("figure", { name: /제품 화면 예시/ })).toHaveAccessibleDescription(/실제 운영 데이터가 아닙니다/);
  });

  it("offers equally detailed workflows for operators and installation partners", () => {
    render(<LandingPage />);
    for (const name of [/시설 운영 담당자/, /시공·유통 파트너/]) {
      const heading = screen.getByRole("heading", { name });
      const section = heading.closest("section")!;
      expect(within(section).getAllByRole("listitem")).toHaveLength(3);
      expect(within(section).getByRole("link", { name: /상담/ })).toHaveAttribute("href", "#contact");
    }
  });

  it("provides discoverable navigation and working anchor destinations", () => {
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

  it("makes no numeric savings or availability claims", () => {
    const { container } = render(<LandingPage />);
    expect(container.textContent).not.toMatch(/\d+(?:\.\d+)?\s*%|\d+\s*(?:만원|억원)|고객사\s*\d+/);
  });
});
