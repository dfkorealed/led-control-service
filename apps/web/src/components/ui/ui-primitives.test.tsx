import { CircleAlert, CircleCheck } from "lucide-react";
import { readFileSync } from "node:fs";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button, FeedbackState, MetricCard, PageHeader, StatusBadge } from ".";
import type { StatusTone } from ".";

const styles = readFileSync("src/styles.css", "utf8");

describe("Calm Operations UI primitives", () => {
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
    "keeps the %s status badge at WCAG AA text contrast",
    (tone) => {
      render(<StatusBadge tone={tone} icon={CircleCheck}>{tone}</StatusBadge>);
      const declaration = styles.match(new RegExp(`\\.ui-status-badge\\[data-tone="${tone}"\\]\\s*\\{([^}]+)\\}`))?.[1] ?? "";
      const foreground = resolveCssColor(declaration.match(/color:\s*([^;]+)/i)?.[1] ?? "");
      const background = resolveCssColor(declaration.match(/background:\s*([^;]+)/i)?.[1] ?? "");

      expect(screen.getByText(tone)).toBeVisible();
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
  );

  it("gives metric cards an accessible label and stable value", () => {
    render(<MetricCard label="전체 조명" value="2,354" unit="개" helper="선택 층 기준" />);

    expect(screen.getByRole("group", { name: "전체 조명" })).toHaveTextContent("2,354개");
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

  it("renders a reusable page heading level", () => {
    render(<PageHeader title="스케줄 제어" headingLevel={3} />);

    expect(screen.getByRole("heading", { name: "스케줄 제어", level: 3 })).toBeInTheDocument();
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

function resolveCssColor(value: string) {
  const variable = value.trim().match(/^var\((--[^)]+)\)$/)?.[1];
  if (!variable) return value.trim();
  return styles.match(new RegExp(`${variable}:\\s*([^;]+)`))?.[1].trim() ?? "";
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
