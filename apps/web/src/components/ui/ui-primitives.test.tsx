import { CircleAlert, CircleCheck } from "lucide-react";
import { readFileSync } from "node:fs";
import { createRef } from "react";
import { render, screen, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Button, FeedbackState, MetricCard, PageHeader, ProgressSteps, StatusBadge } from ".";
import type { StatusTone } from ".";

const styles = readFileSync("src/styles.css", "utf8");
let stylesheet: HTMLStyleElement;

describe("Calm Operations UI primitives", () => {
  beforeAll(() => {
    stylesheet = document.createElement("style");
    stylesheet.textContent = resolveStylesheetVariables(styles);
    document.head.append(stylesheet);
  });

  afterAll(() => stylesheet.remove());

  it("keeps button semantics while exposing variant and loading state", () => {
    render(<Button variant="primary" isLoading>저장</Button>);

    expect(screen.getByRole("button", { name: "저장 중" })).toBeDisabled();
    expect(screen.getByRole("button")).toHaveClass("ui-button", "ui-button-primary");
  });

  it("forwards a button ref to the native control", () => {
    const ref = createRef<HTMLButtonElement>();

    render(<Button ref={ref}>저장</Button>);

    expect(ref.current).toBe(screen.getByRole("button", { name: "저장" }));
  });

  it("renders status with an icon and visible label", () => {
    render(<StatusBadge tone="success" icon={CircleCheck}>정상</StatusBadge>);

    const label = screen.getByText("정상");
    const badge = label.closest(".ui-status-badge");

    expect(label).toBeVisible();
    expect(badge).toHaveAttribute("data-tone", "success");
    expect(badge?.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(label).not.toHaveAttribute("data-tone");
  });

  it.each<StatusTone>(["success", "warning", "danger", "neutral", "info"])(
    "keeps the %s status badge at WCAG AA text contrast after the CSS cascade",
    (tone) => {
      render(
        <>
          <StatusBadge tone={tone} icon={CircleCheck}>{`${tone}-root`}</StatusBadge>
          <div className="monitoring-screen">
            <StatusBadge tone={tone} icon={CircleCheck}>{`${tone}-monitoring`}</StatusBadge>
          </div>
        </>
      );

      for (const context of ["root", "monitoring"]) {
        const badge = screen.getByText(`${tone}-${context}`).closest(".ui-status-badge");
        const computedStyle = getComputedStyle(badge!);

        expect(badge).toBeVisible();
        const foreground = computedStyle.color;
        const background = computedStyle.backgroundColor;
        const ratio = contrastRatio(foreground, background);

        expect(ratio, `${tone}-${context}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  );

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
    expect(group.querySelector(".ui-status-badge")).toBe(screen.getByText("수집 완료").closest(".ui-status-badge"));
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
    ["neutral", "rgb(241, 245, 249)"],
    ["info", "rgb(233, 242, 255)"],
    ["success", "rgb(236, 253, 243)"],
    ["warning", "rgb(255, 247, 230)"],
    ["danger", "rgb(255, 241, 242)"]
  ] as const)("uses the exact %s feedback background", (tone, background) => {
    render(<FeedbackState tone={tone} icon={CircleCheck} title={`${tone} 상태`} />);
    const title = screen.getAllByText(`${tone} 상태`).at(-1)!;
    expect(getComputedStyle(title.closest("section")!).backgroundColor).toBe(background);
  });

  it.each(["monitoring-screen", "settings-screen", "statistics-screen"] as const)(
    "keeps feedback tone backgrounds exact in the %s cascade",
    (screenClass) => {
      render(
        <div className={screenClass}>
          <FeedbackState tone="neutral" icon={CircleCheck} title={`${screenClass} 기본`} />
          <FeedbackState tone="info" icon={CircleCheck} title={`${screenClass} 정보`} />
          <FeedbackState tone="success" icon={CircleCheck} title={`${screenClass} 성공`} />
          <FeedbackState tone="warning" icon={CircleCheck} title={`${screenClass} 경고`} />
          <FeedbackState tone="danger" icon={CircleCheck} title={`${screenClass} 오류`} />
        </div>
      );

      const expectedBackgrounds = [
        [`${screenClass} 기본`, "rgb(241, 245, 249)"],
        [`${screenClass} 정보`, "rgb(233, 242, 255)"],
        [`${screenClass} 성공`, "rgb(236, 253, 243)"],
        [`${screenClass} 경고`, "rgb(255, 247, 230)"],
        [`${screenClass} 오류`, "rgb(255, 241, 242)"]
      ] as const;
      for (const [title, background] of expectedBackgrounds) {
        const state = screen.getByText(title).closest("section")!;
        expect(getComputedStyle(state).backgroundColor).toBe(background);
      }
    }
  );

  it("renders a reusable page heading level", () => {
    render(
      <div className="control-screen">
        <PageHeader title="스케줄 제어" headingLevel={3} />
      </div>
    );

    const heading = screen.getByRole("heading", { name: "스케줄 제어", level: 3 });
    const computedStyle = getComputedStyle(heading);

    expect(computedStyle.margin).toBe("0px");
    expect(computedStyle.fontSize).toBe("24px");
    expect(computedStyle.lineHeight).toBe("1.22");
  });

  it("stacks control page actions at the mobile breakpoint", () => {
    const mobileStyles = styles.slice(styles.lastIndexOf("@media (max-width: 760px)"));

    expect(mobileStyles).toMatch(/\.control-screen \.ui-page-header\s*\{[^}]*align-items:\s*stretch;[^}]*flex-direction:\s*column;/s);
    expect(mobileStyles).toMatch(/\.control-screen \.ui-page-actions\s*\{[^}]*width:\s*100%;/s);
    expect(mobileStyles).toMatch(/\.control-screen \.ui-page-actions \.ui-button\s*\{[^}]*justify-content:\s*center;[^}]*width:\s*100%;/s);
  });
});

function contrastRatio(foreground: string, background: string) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function resolveStylesheetVariables(source: string) {
  const variables = new Map(
    Array.from(source.matchAll(/(--[\w-]+):\s*([^;]+);/g), ([, name, value]) => [name, value.trim()])
  );

  return source.replace(/var\((--[\w-]+)\)/g, (declaration, name: string) => variables.get(name) ?? declaration);
}

function relativeLuminance(color: string) {
  const hex = color.match(/^#([\da-f]{6})$/i)?.[1];
  const channels = hex
    ? [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)].map((channel) => Number.parseInt(channel, 16))
    : color.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) ?? [];
  if (channels.length !== 3) throw new Error(`Expected an RGB color, received ${color}`);
  const [red, green, blue] = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
