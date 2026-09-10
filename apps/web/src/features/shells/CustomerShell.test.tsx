import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomerShell } from "./CustomerShell";

vi.mock("../settings/floor-plans/FloorEditorRoute", () => ({ FloorEditorRoute: () => null }));
vi.mock("../../api/queries", async (original) => ({
  ...await original<typeof import("../../api/queries")>(),
  useDashboard: () => ({
    data: { site: { id: "site", name: "현장", installationStatus: "installed" }, gateways: [], floors: [{ id: "floor-b2", name: "B2" }, { id: "floor-b1", name: "B1" }] },
    isLoading: false
  })
}));

describe("customer shell editor floor context", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it.each(["b1", "b2", "unknown"])("uses the %s editor route, not the first dashboard floor", (floor) => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    render(<QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[`/settings/floor-plans/floor-${floor}/edit?siteId=site`]}>
        <CustomerShell user={{ id: "user", organizationId: "org", organizationType: "customer", loginId: "admin", name: "관리자", role: "admin", status: "active" }} />
      </MemoryRouter>
    </QueryClientProvider>);
    if (floor === "unknown") {
      expect(screen.queryByTestId("active-floor-badge")).not.toBeInTheDocument();
    } else {
      expect(screen.getByTestId("active-floor-badge")).toHaveTextContent(`${floor.toUpperCase()} 주차장`);
    }
  });

  it("links the primary statistics item to overview and keeps it active on statistics child routes", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    render(<QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/statistics/overview?siteId=site"]}>
        <CustomerShell user={{ id: "user", organizationId: "org", organizationType: "customer", loginId: "admin", name: "관리자", role: "admin", status: "active" }} />
      </MemoryRouter>
    </QueryClientProvider>);

    const statisticsLink = await screen.findByRole("link", { name: "통계" });
    expect(statisticsLink).toHaveAttribute("href", "/statistics/overview?siteId=site");
    expect(statisticsLink).toHaveClass("active");
  });

  it("preserves the selected site and hash in the legacy statistics redirect", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    render(<QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/statistics?siteId=site#summary"]}>
        <CustomerShell user={{ id: "user", organizationId: "org", organizationType: "customer", loginId: "admin", name: "관리자", role: "admin", status: "active" }} />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>);

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(
      "/statistics/overview?siteId=site#summary"
    ));
  });
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</output>;
}
