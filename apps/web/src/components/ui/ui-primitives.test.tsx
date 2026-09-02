import { CircleAlert, CircleCheck } from "lucide-react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button, FeedbackState, MetricCard, PageHeader, StatusBadge } from ".";

describe("Calm Operations UI primitives", () => {
  it("keeps button semantics while exposing variant and loading state", () => {
    render(<Button variant="primary" isLoading>저장</Button>);

    expect(screen.getByRole("button", { name: "저장 중" })).toBeDisabled();
    expect(screen.getByRole("button")).toHaveClass("ui-button", "ui-button-primary");
  });

  it("renders status with an icon and visible label", () => {
    render(<StatusBadge tone="success" icon={CircleCheck}>정상</StatusBadge>);

    expect(screen.getByText("정상")).toBeVisible();
    expect(screen.getByText("정상").closest("span")).toHaveAttribute("data-tone", "success");
  });

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
});
