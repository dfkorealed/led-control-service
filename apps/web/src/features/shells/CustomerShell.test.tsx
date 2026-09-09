import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
});
