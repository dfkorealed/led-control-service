import { CircleCheck, CircleAlert } from "lucide-react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KindaLogo } from "./KindaLogo";
import { Button, StatusBadge } from "../ui";

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

  it("주요 버튼은 브랜드 Blue token을 사용하고 상태 badge의 의미색을 보존한다", () => {
    render(<><Button variant="primary">저장</Button><StatusBadge tone="success" icon={CircleCheck}>정상</StatusBadge><StatusBadge tone="danger" icon={CircleAlert}>오류</StatusBadge></>);

    expect(screen.getByRole("button", { name: "저장" })).toHaveClass("bg-action-primary", "text-content-inverse");
    expect(screen.getByText("정상").parentElement).toHaveClass("bg-status-success-background", "text-status-success-foreground");
    expect(screen.getByText("오류").parentElement).toHaveClass("bg-status-danger-background", "text-status-danger-badge");
  });
});
