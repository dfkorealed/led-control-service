import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LandingPage } from "./LandingPage";
import { FeaturesPage } from "./FeaturesPage";
import { PricingPage } from "./PricingPage";
import { FieldDayConceptPage } from "./FieldDayConceptPage";

afterEach(cleanup);

describe("public field-day landing narrative", () => {
  it.each([LandingPage, FieldDayConceptPage])("keeps the merged public and concept report PDF-only across replay (%#)", (Page) => {
    const { container } = render(<Page />);
    const report = within(container.querySelector<HTMLElement>("#report")!);
    const replay = report.getByRole("button", { name: "보고서 예시 다시 보기" });
    const assertPdf = () => {
      expect(report.getByText("PDF 보고서", { exact: true })).toBeVisible();
      expect(report.getByText("PDF 형식", { exact: true })).toBeVisible();
      expect(report.queryByRole("group", { name: "보고서 파일 형식 미리보기" })).not.toBeInTheDocument();
      expect(report.queryByRole("button", { name: /PDF|XLSX|CSV|Excel/ })).not.toBeInTheDocument();
      expect(report.getByText(/설명용 PDF 보고서.*파일을 만들거나 내려받지 않습니다/)).toBeVisible();
    };
    assertPdf();
    fireEvent.click(replay);
    assertPdf();
    expect(report.getByRole("button", { name: "보고서 예시 다시 보기" })).toBe(replay);
  });

  it("opens with the approved field-day story and consultation action", () => {
    render(<LandingPage />);
    expect(screen.getByRole("heading", { level: 1, name: /현장의 하루.*한눈에 이어지다/ })).toBeVisible();
    expect(screen.getByText(/다섯 장면으로 킨다의 관제 흐름/)).toBeVisible();
    expect(screen.getAllByRole("button", { name: /도입 상담/ })).toHaveLength(3);
    expect(screen.getByRole("link", { name: /하루 따라가기/ })).toHaveAttribute("href", "#monitoring");
  });

  it("keeps the five scene explanations and example disclaimers together", () => {
    const { container } = render(<LandingPage />);
    const scenes = [...container.querySelectorAll(".scene")];
    expect(scenes).toHaveLength(5);
    const [monitoring, control, statistics, report, map] = scenes.map(scene => within(scene as HTMLElement));
    expect(monitoring.getByRole("heading", { name: /찾는 조명은.*도면 위에/ })).toBeVisible();
    expect(monitoring.getByText(/실제 현장 데이터가 아닙니다/)).toBeVisible();
    expect(control.getByRole("heading", { name: /필요한 만큼.*밝기를 맞추다/ })).toBeVisible();
    expect(control.getByText(/실제 장비에 명령을 보내지 않습니다/)).toBeVisible();
    expect(statistics.getByRole("heading", { name: /운영의 흐름을.*그래프로 보다/ })).toBeVisible();
    expect(statistics.getByText(/실측 전력이 아닙니다/)).toBeVisible();
    expect(report.getByRole("heading", { name: /정리한 기록을.*보고서로/ })).toBeVisible();
    expect(report.getByText(/파일을 만들거나 내려받지 않습니다/)).toBeVisible();
    expect(report.queryByRole("button", { name: /XLSX|Excel/ })).not.toBeInTheDocument();
    expect(map.getByRole("heading", { name: /도면도 조명도.*직접, 쉽게 배치/ })).toBeVisible();
    expect(map.getByText(/자동 등록이나 실제 저장은 수행하지 않습니다/)).toBeVisible();
  });

  it("keeps direct login navigation and a skip link", () => {
    render(<LandingPage />);
    expect(screen.getByRole("link", { name: /로그인/ })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: "본문으로 이동" })).toHaveAttribute("href", "#main");
    expect(document.getElementById("main")).toBeInTheDocument();
  });

  it("places the hero's second sentence on a new line and links the fixed navigation", () => {
    render(<LandingPage />);
    const secondSentence = screen.getByText("다섯 장면으로 킨다의 관제 흐름을 살펴보세요.");
    expect(secondSentence.tagName).toBe("SPAN");
    expect(secondSentence).toHaveClass("hero-copy__second-line");
    expect(screen.getByRole("link", { name: "주요 기능" })).toHaveAttribute("href", "/features");
    expect(screen.getByRole("link", { name: "요금제" })).toHaveAttribute("href", "/pricing");
  });

  it("summarizes four product capabilities with benefits and scene links", () => {
    render(<FeaturesPage />);
    const section = document.getElementById("features");
    expect(section).not.toBeNull();
    if (!section) return;
    const features = within(section);
    expect(features.getByRole("heading", { name: "현장 운영에 필요한 네 가지 흐름" })).toBeVisible();
    for (const [name, id] of [["모니터링", "monitoring"], ["제어", "control"], ["통계", "statistics"], ["맵 편집", "map-editor"]] as const) {
      const card = features.getByRole("article", { name });
      expect(card).toHaveTextContent(/확인|조정|비교|배치/);
      expect(within(card).getByRole("link", { name: /자세히 보기/ })).toHaveAttribute("href", `#feature-${id}`);
    }
  });

  it("shows Basic and Plus monthly consultation plans without claiming active limits", () => {
    render(<PricingPage />);
    const section = document.getElementById("pricing");
    expect(section).not.toBeNull();
    if (!section) return;
    const pricing = within(section);
    const basic = within(pricing.getByRole("article", { name: "Basic" }));
    expect(basic.getByText("99,000원")).toBeVisible();
    expect(basic.getByText("모든 기본 기능")).toBeVisible();
    expect(basic.getByText("로그 3개월 보존")).toBeVisible();
    expect(basic.getByText("보고서 월 10회 생성")).toBeVisible();
    const plus = within(pricing.getByRole("article", { name: "Plus" }));
    expect(plus.getByText("199,000원")).toBeVisible();
    expect(plus.getByText("모든 기본 기능")).toBeVisible();
    expect(plus.getByText("로그 1년 보존")).toBeVisible();
    expect(plus.getByText("보고서 무제한 생성")).toBeVisible();
    expect(plus.getByText(/AI 기능.*도입 상담 시 안내/)).toBeVisible();
    expect(pricing.getByText(/상품별 적용 범위와 제공 일정은 상담에서 확인/)).toBeVisible();
    expect(basic.getByRole("button", { name: "Basic 도입 상담" })).toBeVisible();
    expect(plus.getByRole("button", { name: "Plus 도입 상담" })).toBeVisible();
  });

  it("uses the company homepage's verified footer contact details", () => {
    render(<LandingPage />);
    const footer = within(screen.getByRole("contentinfo"));
    expect(footer.getByText("(주)디에프코리아")).toBeVisible();
    expect(footer.getByRole("link", { name: "032-528-2953" })).toHaveAttribute("href", "tel:0325282953");
    expect(footer.getByText("032-551-2954")).toBeVisible();
    expect(footer.getByRole("link", { name: "kjukym@dfkorealed.com" })).toHaveAttribute("href", "mailto:kjukym@dfkorealed.com");
    expect(footer.getByText("인천광역시 부평구 평천로 199번길 53 A동 2층")).toBeVisible();
    expect(footer.getByRole("link", { name: "회사 소개" })).toHaveAttribute("href", "https://dfkorealed.com/about");
    expect(footer.getByRole("link", { name: "제품 소개" })).toHaveAttribute("href", "https://dfkorealed.com/products");
    expect(footer.getByText(/조명과 수치는 기능 설명을 위한 예시/)).toBeVisible();
  });
});
