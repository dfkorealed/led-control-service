import { readFileSync } from "node:fs";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KindaLogo } from "./KindaLogo";

describe("KindaLogo", () => {
  it("마크와 한글 브랜드명을 하나의 접근성 이름으로 조합한다", () => {
    render(<KindaLogo context="관제 센터" />);
    const logo = screen.getByRole("img", { name: "킨다 관제 센터" });
    expect(within(logo).getByText("킨다")).toBeInTheDocument();
    expect(within(logo).getByText("관제 센터")).toBeInTheDocument();
    expect(logo.querySelector("img")).toHaveAttribute("src", "/brand/kinda-mark.svg");
    expect(logo.querySelector("img")).toHaveAttribute("alt", "");
  });

  it("compact 변형도 HTML 브랜드명을 제거하지 않는다", () => {
    render(<KindaLogo compact />);
    const logo = screen.getByRole("img", { name: "킨다" });
    expect(logo).toHaveAttribute("data-compact", "true");
    expect(within(logo).getByText("킨다")).toBeInTheDocument();
  });

  it("brand token을 주요 UI alias에 연결하고 상태 token은 분리한다", () => {
    const styles = readFileSync("src/styles.css", "utf8");
    expect(styles).toContain("--primary: var(--brand-blue);");
    expect(styles).toContain("--primary-hover: #1d5c86;");
    expect(styles).toContain("--primary-soft: #e8f2f8;");
    expect(styles).toContain("--surface: var(--brand-paper);");
    expect(styles).toContain("--text: var(--brand-navy);");
    expect(styles).toContain("--focus-ring: 0 0 0 3px rgba(37, 111, 161, 0.28);");
    expect(styles).toContain(".ui-button-primary:hover:not(:disabled)");
    expect(styles).toContain("background: var(--primary-hover);");
    expect(styles).toContain("--success: #15803d;");
    expect(styles).toContain("--warning: #b45309;");
    expect(styles).toContain("--danger: #dc2626;");
  });
});
