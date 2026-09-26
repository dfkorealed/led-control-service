import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardPreview } from "./DashboardPreview";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("illustrative dashboard preview", () => {
  it("names the figure and discloses sample data without the removed captions", () => {
    const { container } = render(<DashboardPreview />);
    const figure = screen.getByRole("figure", { name: "킨다 관제 구성 예시" });

    expect(figure).toHaveAccessibleDescription(/실제 운영 데이터가 아닙니다/);
    expect(container).not.toHaveTextContent("제품 화면 예시");
    expect(container).not.toHaveTextContent("현장 · 도면 · 조명을 한 화면에서");
  });

  it("starts with a monitoring map and recent fixture status", () => {
    render(<DashboardPreview />);
    const figure = screen.getByRole("figure", { name: "킨다 관제 구성 예시" });

    expect(within(figure).getByRole("button", { name: "모니터링" })).toHaveAttribute("aria-pressed", "true");
    expect(within(figure).getByRole("heading", { name: "도면에서 위치와 상태 확인" })).toBeVisible();
    expect(within(figure).getByText("최근 확인 상태")).toBeVisible();
    expect(within(figure).getByText("연결됨")).toBeVisible();
  });

  it("switches directly between monitoring, control, and records with selected state in sync", () => {
    render(<DashboardPreview />);
    const figure = screen.getByRole("figure", { name: "킨다 관제 구성 예시" });
    const monitoring = within(figure).getByRole("button", { name: "모니터링" });
    const control = within(figure).getByRole("button", { name: "제어" });
    const records = within(figure).getByRole("button", { name: "기록" });

    for (const button of [monitoring, control, records]) {
      expect(button).toHaveAttribute("type", "button");
      expect(button).toHaveAttribute("aria-controls");
    }

    control.focus();
    fireEvent.click(control);
    expect(control).toHaveFocus();
    expect(control).toHaveAttribute("aria-pressed", "true");
    expect(monitoring).toHaveAttribute("aria-pressed", "false");
    expect(within(figure).getByRole("heading", { name: "대상을 고르고 조명 제어" })).toBeVisible();
    expect(within(figure).getByText("개별 제어")).toBeVisible();
    expect(within(figure).getByText("그룹 제어")).toBeVisible();
    expect(within(figure).getByText("일정 운영")).toBeVisible();
    expect(within(figure).queryByRole("heading", { name: "도면에서 위치와 상태 확인" })).not.toBeInTheDocument();

    fireEvent.click(records);
    expect(records).toHaveAttribute("aria-pressed", "true");
    expect(control).toHaveAttribute("aria-pressed", "false");
    expect(within(figure).getByRole("heading", { name: "명령 이력과 추정 전력 확인" })).toBeVisible();
    expect(within(figure).getByText("명령 처리 이력")).toBeVisible();
    expect(within(figure).getByText("상태 기반 추정 전력")).toBeVisible();
    expect(within(figure).queryByRole("heading", { name: "대상을 고르고 조명 제어" })).not.toBeInTheDocument();

    fireEvent.click(monitoring);
    expect(monitoring).toHaveAttribute("aria-pressed", "true");
    expect(records).toHaveAttribute("aria-pressed", "false");
    expect(within(figure).getByRole("heading", { name: "도면에서 위치와 상태 확인" })).toBeVisible();
  });

  it("keeps all preview interaction local without auth or device requests", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<DashboardPreview />);

    fireEvent.click(screen.getByRole("button", { name: "제어" }));
    fireEvent.click(screen.getByRole("button", { name: "기록" }));
    fireEvent.click(screen.getByRole("button", { name: "모니터링" }));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
