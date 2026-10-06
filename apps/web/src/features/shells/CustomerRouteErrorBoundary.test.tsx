import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { CustomerRouteErrorBoundary } from "./CustomerRouteErrorBoundary";

it("directs a failed non-settings route to the Settings account without exposing injected error details", () => {
  const diagnostics: unknown[][] = [];
  const original = console.error;
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const message = args.map(String).join(" ");
    if (message.includes("synthetic route failure") || message.includes("The above error occurred in the <BrokenRoute>")) diagnostics.push(args);
    else original(...args);
  });
  function BrokenRoute(): never { throw new Error("synthetic route failure"); }
  try {
    render(<CustomerRouteErrorBoundary scope="monitoring"><BrokenRoute /></CustomerRouteErrorBoundary>);
    expect(screen.getByText(/설정의 내 계정/)).toBeVisible();
    expect(screen.getByRole("button", { name: "화면 새로고침" })).toBeVisible();
    expect(screen.queryByText("synthetic route failure")).not.toBeInTheDocument();
    expect(diagnostics).toHaveLength(3);
  } finally { spy.mockRestore(); }
});
