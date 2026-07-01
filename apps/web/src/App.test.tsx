import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("renders the four primary navigation items", () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(screen.getByRole("button", { name: "모니터링" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "제어" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "통계" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "설정" })).toBeInTheDocument();
  });
});
