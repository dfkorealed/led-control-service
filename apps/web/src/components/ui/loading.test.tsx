import { createRef } from "react";
import { RefreshCw } from "lucide-react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Button } from "./Button";
import { IconTooltipButton } from "./IconTooltipButton";
import { RouteLoadingState } from "./RouteLoadingState";
import { DataGrid } from "./DataGrid";
import { LoadingIndicator } from "./LoadingIndicator";
import { LoadingState } from "./LoadingState";

afterEach(cleanup);

it("shows paused panel and inline waiting without presenting an active request", () => {
  const view = render(<LoadingIndicator isPaused>목록 조회 중</LoadingIndicator>);
  expect(screen.getByRole("status")).toHaveTextContent("네트워크 연결을 기다리고 있습니다.");
  expect(screen.getByRole("status")).not.toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("status").querySelector("svg")).toBeNull();
  view.rerender(<LoadingState isPaused title="목록 조회 중" />);
  expect(screen.getByRole("status")).toHaveTextContent("네트워크 연결을 기다리고 있습니다.");
  expect(screen.getByRole("status")).not.toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("status").querySelector("svg")).not.toHaveClass("animate-spin");
});

it("shows the shared spinner and action label without permitting a second submit", () => {
  const action = vi.fn();
  const ref = createRef<HTMLButtonElement>();
  const view = render(<Button ref={ref} isLoading loadingLabel="파일 준비 중" onClick={action}>다운로드</Button>);
  const button = screen.getByRole("button", { name: "파일 준비 중" });
  expect(ref.current).toBe(button);
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(button.querySelector("svg")).toHaveClass("animate-spin", "motion-reduce:animate-none");
  expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  fireEvent.click(button);
  expect(action).not.toHaveBeenCalled();
  view.rerender(<Button ref={ref} onClick={action}>다운로드</Button>);
  expect(screen.getByRole("button", { name: "다운로드" })).not.toBeDisabled();
  expect(button.querySelector("svg")).toBeNull();
  fireEvent.click(button);
  expect(action).toHaveBeenCalledTimes(1);
});

it("replaces an icon-only pending action with the shared spinner without growing its control", () => {
  const view = render(<IconTooltipButton icon={RefreshCw} label="새로고침" isLoading loadingLabel="상태 확인 중" size="sm" />);
  const button = screen.getByRole("button", { name: "상태 확인 중" });
  expect(button).toBeDisabled();
  expect(button).toHaveClass("size-11");
  expect(button.querySelector("svg")).toHaveClass("animate-spin", "motion-reduce:animate-none");
  view.rerender(<IconTooltipButton icon={RefreshCw} label="새로고침" size="sm" />);
  expect(screen.getByRole("button", { name: "새로고침" }).querySelector("svg")).not.toHaveClass("animate-spin");
});

it("announces route loading with a motion-safe spinner and preserves the page landmark", () => {
  render(<RouteLoadingState variant="page" />);
  expect(screen.getAllByRole("main")).toHaveLength(1);
  const status = screen.getByRole("status");
  expect(status).toHaveAttribute("aria-busy", "true");
  expect(status.querySelector("svg")).toHaveClass("animate-spin", "motion-reduce:animate-none");
});

it("shows loading for an empty busy grid but preserves cached rows during refresh", () => {
  const props = { caption: "조회 목록", columns: [{ id: "name", header: "이름", minWidth: 100, renderCell: (row: { id: string; name: string }) => row.name }], getRowKey: (row: { id: string; name: string }) => row.id };
  const view = render(<DataGrid {...props} rows={[]} isBusy />);
  expect(screen.getByRole("status")).toHaveTextContent("불러오는 중");
  expect(screen.getByRole("status").querySelector("svg")).toHaveClass("animate-spin");
  view.rerender(<DataGrid {...props} rows={[{ id: "one", name: "기존 조명" }]} isBusy />);
  expect(screen.getByText("기존 조명")).toBeVisible();
  expect(screen.queryByRole("status")).toBeNull();
  view.rerender(<DataGrid {...props} rows={[]} />);
  expect(screen.getByText("항목이 없습니다.")).toBeVisible();
  expect(screen.queryByRole("status")).toBeNull();
});
