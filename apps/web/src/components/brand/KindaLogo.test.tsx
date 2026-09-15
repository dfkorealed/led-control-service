import { readFileSync } from "node:fs";
import { CircleCheck, CircleAlert } from "lucide-react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KindaLogo } from "./KindaLogo";
import { Button, StatusBadge } from "../ui";
import { prepareLegacyStylesheetForJsdom } from "../../test/legacy-stylesheet";

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

  it("주요 버튼은 브랜드 Blue를 사용하고 상태 badge의 의미색을 보존한다", () => {
    const source = readFileSync("src/styles/theme.css", "utf8").replace("@theme static", ":root")
      + prepareLegacyStylesheetForJsdom(readFileSync("src/styles.css", "utf8"));
    const variables = new Map(Array.from(source.matchAll(/(--[\w-]+):\s*([^;]+);/g), ([, name, value]) => [name, value.trim()]));
    // JSDOM의 custom property 계산 한계를 보완하되 기대 색상은 실제 컴포넌트의
    // 계산된 스타일에서 확인한다. 선언 순서나 alias의 중간 이름에는 의존하지 않는다.
    let resolved = source;
    for (let depth = 0; depth < variables.size; depth++) {
      const next = resolved.replace(/var\((--[\w-]+)\)/g, (match, name: string) => variables.get(name) ?? match);
      if (next === resolved) break;
      resolved = next;
    }
    const stylesheet = document.createElement("style");
    stylesheet.textContent = resolved;
    document.head.append(stylesheet);
    try {
      render(<><Button variant="primary">저장</Button><StatusBadge tone="success" icon={CircleCheck}>정상</StatusBadge><StatusBadge tone="danger" icon={CircleAlert}>오류</StatusBadge></>);
      expect(getComputedStyle(screen.getByRole("button", { name: "저장" })).backgroundColor).toBe("rgb(37, 111, 161)");
      expect(getComputedStyle(screen.getByText("정상").closest(".ui-status-badge")!).color).toBe("rgb(21, 128, 61)");
      expect(getComputedStyle(screen.getByText("오류").closest(".ui-status-badge")!).color).toBe("rgb(190, 18, 60)");
    } finally {
      stylesheet.remove();
    }
  });
});
