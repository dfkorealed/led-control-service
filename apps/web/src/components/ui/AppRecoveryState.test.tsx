import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppRecoveryState } from "./AppRecoveryState";

afterEach(cleanup);
it.each(["service_unavailable", "forbidden", "chunk_error"] as const)("catches missing main/alert/focus for %s", (variant) => {
  render(<AppRecoveryState variant={variant} onRetry={vi.fn()} onRelogin={vi.fn()} onReload={vi.fn()} />);
  expect(screen.getAllByRole("main")).toHaveLength(1);
  expect(screen.getByRole("alert")).toBeVisible();
  const heading = screen.getByRole("heading", { level: 1 });
  expect(heading).toHaveFocus();
  expect(heading).toHaveAttribute("tabindex", "-1");
  expect(heading).toHaveClass("text-section-title", "compact:text-page-title");
  expect(heading.className).not.toContain("[");
});
it("catches disconnected recovery actions or duplicate requests while pending", () => {
  const retry = vi.fn();
  const relogin = vi.fn();
  const { rerender } = render(<AppRecoveryState variant="service_unavailable" onRetry={retry} onRelogin={relogin} />);
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  fireEvent.click(screen.getByRole("button", { name: "다시 로그인" }));
  expect(retry).toHaveBeenCalledOnce();
  expect(relogin).toHaveBeenCalledOnce();
  rerender(<AppRecoveryState variant="service_unavailable" isPending onRetry={retry} onRelogin={relogin} />);
  expect(screen.getByRole("group", { name: "복구 작업" })).toHaveAttribute("data-recovery-actions", "true");
  for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
});
