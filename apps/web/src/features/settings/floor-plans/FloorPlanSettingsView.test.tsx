import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockDashboard } from "../../../test/fixtures";
import { FloorPlanSettingsView } from "./FloorPlanSettingsView";

const useDashboard = vi.hoisted(() => vi.fn());

vi.mock("../../../api/queries", () => ({ useDashboard }));

describe("FloorPlanSettingsView", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("links an admin to the floor editor while preserving siteId", async () => {
    const dashboard = { ...mockDashboard, floors: [mockDashboard.floors[0]] };
    useDashboard.mockReturnValue({ data: dashboard, isLoading: false, error: null });

    render(
      <MemoryRouter initialEntries={["/settings/floor-plans?siteId=site-2"]}>
        <Routes>
          <Route path="/settings/floor-plans" element={<FloorPlanSettingsView siteId="site-2" userRole="admin" />} />
          <Route path="/settings/floor-plans/:floorId/edit" element={<h2>B2 도면 편집</h2>} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText("B2")).toBeInTheDocument();
    expect(screen.getByText("도면 등록됨")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "B2 도면 편집" })).toHaveAttribute(
      "href",
      `/settings/floor-plans/${dashboard.floors[0].id}/edit?siteId=site-2`
    );

    fireEvent.click(screen.getByRole("link", { name: "B2 도면 편집" }));

    expect(await screen.findByRole("heading", { name: "B2 도면 편집" })).toBeInTheDocument();
  });

  it("keeps the floor-plan list read only for viewers", async () => {
    const dashboard = { ...mockDashboard, floors: [mockDashboard.floors[0]] };
    useDashboard.mockReturnValue({ data: dashboard, isLoading: false, error: null });

    render(
      <MemoryRouter>
        <FloorPlanSettingsView userRole="viewer" />
      </MemoryRouter>
    );

    expect(await screen.findByText("B2")).toBeInTheDocument();
    expect(screen.getByText("도면 등록됨")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "B2 도면 편집" })).not.toBeInTheDocument();
  });
});
