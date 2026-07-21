import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SettingsShell } from "./SettingsShell";

vi.mock("../../api/queries", () => ({
  useSites: () => ({ data: [{ id: "site-1", name: "본사 주차장" }] })
}));

describe("SettingsShell", () => {
  it("renders only the admin settings navigation", () => {
    render(
      <MemoryRouter initialEntries={["/settings/floor-plans?siteId=site-1"]}>
        <Routes>
          <Route path="/settings" element={<SettingsShell userRole="admin" selectedSiteId="site-1" />}>
            <Route path="floor-plans" element={<h2>도면 관리</h2>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByRole("link", { name: "도면 관리" })).toHaveAttribute("href", "/settings/floor-plans?siteId=site-1");
    expect(screen.queryByRole("link", { name: "설치 및 시운전" })).not.toBeInTheDocument();
  });
});
